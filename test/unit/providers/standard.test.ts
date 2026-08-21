import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from '../../../src/core/encoding.js';
import type { WebhookRequest } from '../../../src/core/types.js';
import { standard } from '../../../src/providers/standard.js';
import { createTestSigner } from '../../../src/testing/index.js';
import { loadFixture } from '../../fixtures/loader.js';
import { runAdapterConformance } from '../../shared/conformance.js';

// A base64-encoded secret, in the "whsec_<base64>" shape Standard Webhooks uses —
// deliberately different from Stripe's raw-secret shape.
const SECRET = `whsec_${bytesToBase64(new TextEncoder().encode('a-32-byte-ish-signing-key-value'))}`;
const CREDS = { type: 'secret' as const, secret: SECRET };

function toReq(signed: { body: Uint8Array; headers: Record<string, string> }): WebhookRequest {
  return { body: signed.body, headers: signed.headers };
}

runAdapterConformance(standard, loadFixture('standard', 'user-created'), {
  otherFixtures: [
    loadFixture('stripe', 'checkout-completed'),
    loadFixture('github', 'pull-request-opened'),
    loadFixture('shopify', 'orders-create'),
  ],
});

describe('standard webhooks adapter (covers Svix, Clerk, Resend, Polar, WorkOS)', () => {
  it('accepts a validly signed request', async () => {
    const signer = createTestSigner(standard, CREDS);
    const signed = await signer.sign(JSON.stringify({ type: 'user.created' }));
    const result = await standard.verify(toReq(signed), CREDS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.eventId).toMatch(/^msg_/);
  });

  it('accepts the svix-* header aliases', async () => {
    const signer = createTestSigner(standard, CREDS);
    const signed = await signer.sign(JSON.stringify({ type: 'user.created' }));
    const svixHeaders = {
      'svix-id': signed.headers['webhook-id'] as string,
      'svix-timestamp': signed.headers['webhook-timestamp'] as string,
      'svix-signature': signed.headers['webhook-signature'] as string,
    };
    const result = await standard.verify({ body: signed.body, headers: svixHeaders }, CREDS);
    expect(result.ok).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const signer = createTestSigner(standard, CREDS);
    const signed = await signer.sign(JSON.stringify({ type: 'user.created' }));
    const tampered = {
      ...signed,
      body: new TextEncoder().encode(JSON.stringify({ type: 'user.deleted' })),
    };
    const result = await standard.verify(toReq(tampered), CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_signature');
  });

  it('rejects the Stripe-shaped raw-secret (proves key derivation actually differs)', async () => {
    const rawSecretNoDecode = { type: 'secret' as const, secret: 'whsec_not_base64_at_all!!' };
    const signer = createTestSigner(standard, CREDS);
    const signed = await signer.sign(JSON.stringify({ type: 'x' }));
    const result = await standard.verify(toReq(signed), rawSecretNoDecode);
    expect(result.ok).toBe(false);
  });

  it('accepts any matching v1 signature out of a space-delimited multi-sig header (rotation)', async () => {
    const signer = createTestSigner(standard, CREDS);
    const signed = await signer.sign(JSON.stringify({ type: 'x' }));
    const multi = {
      ...signed.headers,
      'webhook-signature': `v1,bm9wZQ== ${signed.headers['webhook-signature']}`,
    };
    const result = await standard.verify({ body: signed.body, headers: multi }, CREDS);
    expect(result.ok).toBe(true);
  });

  it('rejects when required headers are missing', async () => {
    const result = await standard.verify({ body: new Uint8Array(), headers: {} }, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing_signature_header');
  });

  it('rejects a timestamp outside tolerance', async () => {
    const signer = createTestSigner(standard, CREDS);
    const stale = Math.floor(Date.now() / 1000) - 10_000;
    const signed = await signer.sign(JSON.stringify({ type: 'x' }), { timestamp: stale });
    const result = await standard.verify(toReq(signed), CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timestamp_out_of_tolerance');
  });

  it('accepts a secret from additionalSecrets during rotation', async () => {
    const newSecret = `whsec_${bytesToBase64(new TextEncoder().encode('a-different-signing-key-value12'))}`;
    const signer = createTestSigner(standard, { type: 'secret', secret: newSecret });
    const signed = await signer.sign(JSON.stringify({ type: 'x' }));
    const result = await standard.verify(toReq(signed), CREDS, { additionalSecrets: [newSecret] });
    expect(result.ok).toBe(true);
  });

  describe('§4.3-4.5 key rotation / version handling', () => {
    it('4.3: space-delimited v1,sigA v1,sigB — the SECOND is the valid one, still accepted', async () => {
      const signer = createTestSigner(standard, CREDS);
      const signed = await signer.sign(JSON.stringify({ type: 'x' }));
      const real = signed.headers['webhook-signature'] as string;
      const multi = { ...signed.headers, 'webhook-signature': `v1,bogusFirstSignature== ${real}` };
      const result = await standard.verify({ body: signed.body, headers: multi }, CREDS);
      expect(result.ok).toBe(true);
    });

    it('two v1 candidates, neither valid — rejected', async () => {
      const signer = createTestSigner(standard, CREDS);
      const signed = await signer.sign(JSON.stringify({ type: 'x' }));
      const multi = { ...signed.headers, 'webhook-signature': 'v1,bogusOne== v1,bogusTwo==' };
      const result = await standard.verify({ body: signed.body, headers: multi }, CREDS);
      expect(result.ok).toBe(false);
    });

    it('4.4: an unknown version (v9,...) present alongside a valid v1 is ignored, v1 is still checked', async () => {
      const signer = createTestSigner(standard, CREDS);
      const signed = await signer.sign(JSON.stringify({ type: 'x' }));
      const real = signed.headers['webhook-signature'] as string;
      const multi = {
        ...signed.headers,
        'webhook-signature': `v9,someFutureSchemeBytes== ${real}`,
      };
      const result = await standard.verify({ body: signed.body, headers: multi }, CREDS);
      expect(result.ok).toBe(true);
    });

    it('4.5: only v1a (asymmetric) present — the symmetric adapter rejects cleanly, does not throw', async () => {
      const signer = createTestSigner(standard, CREDS);
      const signed = await signer.sign(JSON.stringify({ type: 'x' }));
      const onlyAsymmetric = {
        ...signed.headers,
        'webhook-signature': 'v1a,someEd25519SignatureBytes==',
      };
      const result = await standard.verify({ body: signed.body, headers: onlyAsymmetric }, CREDS);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
    });

    it('4.7: rejects when all additionalSecrets candidates are wrong', async () => {
      const signer = createTestSigner(standard, { type: 'secret', secret: SECRET });
      const signed = await signer.sign(JSON.stringify({ type: 'x' }));
      const wrongA = `whsec_${bytesToBase64(new TextEncoder().encode('wrong-secret-aaaaaaaaaaaaaaaaaa'))}`;
      const wrongB = `whsec_${bytesToBase64(new TextEncoder().encode('wrong-secret-bbbbbbbbbbbbbbbbbb'))}`;
      const result = await standard.verify(
        toReq(signed),
        { type: 'secret', secret: 'whsec_totally_different' },
        {
          additionalSecrets: [wrongA, wrongB],
        },
      );
      expect(result.ok).toBe(false);
    });
  });

  describe('§5.4 conflicting webhook-id / svix-id precedence', () => {
    it('when both are present and conflict, webhook-id (the primary) wins — documented precedence', async () => {
      const signer = createTestSigner(standard, CREDS);
      const signed = await signer.sign(JSON.stringify({ type: 'x' }), { eventId: 'msg_primary' });
      const headers = { ...signed.headers, 'svix-id': 'msg_conflicting_alias_value' };
      const result = await standard.verify({ body: signed.body, headers }, CREDS);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.eventId).toBe('msg_primary');
      expect(standard.extractEventId({ body: signed.body, headers })).toBe('msg_primary');
    });
  });

  describe('§6.18 (critical replay test): the timestamp is part of the signed payload', () => {
    it('rewriting only the webhook-timestamp value breaks the signature', async () => {
      const now = 1_700_000_000;
      const signer = createTestSigner(standard, CREDS);
      const signed = await signer.sign(JSON.stringify({ type: 'x' }), { timestamp: now - 100 });

      // Bump webhook-timestamp to "now" while keeping the original v1 digest — if the
      // timestamp were only compared and not signed, this would pass, letting an
      // attacker replay an old captured body indefinitely by rewriting the header.
      const rewritten = { ...signed.headers, 'webhook-timestamp': String(now) };
      const result = await standard.verify({ body: signed.body, headers: rewritten }, CREDS, {
        now: () => now * 1000,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_signature');
    });

    it('rewriting only the webhook-id value breaks the signature (id is also part of the signed payload)', async () => {
      const signer = createTestSigner(standard, CREDS);
      const signed = await signer.sign(JSON.stringify({ type: 'x' }), { eventId: 'msg_original' });
      const rewritten = { ...signed.headers, 'webhook-id': 'msg_attacker_chosen' };
      const result = await standard.verify({ body: signed.body, headers: rewritten }, CREDS);
      expect(result.ok).toBe(false);
    });
  });

  describe('coverage: branches not reachable through the normal happy/sad paths above', () => {
    it('verify() rejects a non-"secret" credentials type without throwing', async () => {
      const result = await standard.verify(
        {
          body: new Uint8Array(),
          headers: { 'webhook-id': 'x', 'webhook-timestamp': '1', 'webhook-signature': 'v1,AA==' },
        },
        { type: 'publicKey', publicKey: 'irrelevant' },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_signature');
    });

    it('sign() throws when given a non-"secret" credentials type', async () => {
      await expect(
        standard.sign?.(new Uint8Array(), { type: 'publicKey', publicKey: 'irrelevant' }),
      ).rejects.toThrow('type "secret"');
    });

    it('accepts a secret supplied as raw Uint8Array bytes, not a "whsec_"-prefixed string (deriveKeyBytes passthrough)', async () => {
      const rawKeyBytes = new TextEncoder().encode('a-32-byte-ish-signing-key-value');
      const bytesCreds = { type: 'secret' as const, secret: rawKeyBytes };
      const signer = createTestSigner(standard, bytesCreds);
      const signed = await signer.sign(JSON.stringify({ type: 'x' }));
      const result = await standard.verify(toReq(signed), bytesCreds);
      expect(result.ok).toBe(true);
    });

    it('id present but webhook-timestamp specifically missing is rejected (not just "any header missing")', async () => {
      const signer = createTestSigner(standard, CREDS);
      const signed = await signer.sign(JSON.stringify({ type: 'x' }));
      const { 'webhook-timestamp': _drop, ...headers } = signed.headers;
      const result = await standard.verify({ body: signed.body, headers }, CREDS);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('missing_signature_header');
    });

    it('id and timestamp present but webhook-signature specifically missing is rejected', async () => {
      const signer = createTestSigner(standard, CREDS);
      const signed = await signer.sign(JSON.stringify({ type: 'x' }));
      const { 'webhook-signature': _drop, ...headers } = signed.headers;
      const result = await standard.verify({ body: signed.body, headers }, CREDS);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('missing_signature_header');
    });

    it('6.15: toleranceSeconds: 0 throws synchronously at call time — replay protection must never be disabled', async () => {
      const signer = createTestSigner(standard, CREDS);
      const signed = await signer.sign(JSON.stringify({ type: 'x' }));
      await expect(standard.verify(toReq(signed), CREDS, { toleranceSeconds: 0 })).rejects.toThrow(
        RangeError,
      );
    });

    it('a malformed candidate with no comma in the space-delimited signature list is skipped, not fatal', async () => {
      const signer = createTestSigner(standard, CREDS);
      const signed = await signer.sign(JSON.stringify({ type: 'x' }));
      const real = signed.headers['webhook-signature'] as string;
      const withGarbageEntry = {
        ...signed.headers,
        'webhook-signature': `garbage-no-comma-here ${real}`,
      };
      const result = await standard.verify({ body: signed.body, headers: withGarbageEntry }, CREDS);
      expect(result.ok).toBe(true);
    });
  });

  describe('§6 timing boundaries', () => {
    it('6.2: exactly at the tolerance boundary (t = now - 300) is accepted (inclusive)', async () => {
      const now = 1_700_000_000;
      const signer = createTestSigner(standard, CREDS);
      const signed = await signer.sign(JSON.stringify({ type: 'x' }), { timestamp: now - 300 });
      const result = await standard.verify(toReq(signed), CREDS, { now: () => now * 1000 });
      expect(result.ok).toBe(true);
    });

    it('6.3: one second past the boundary is rejected', async () => {
      const now = 1_700_000_000;
      const signer = createTestSigner(standard, CREDS);
      const signed = await signer.sign(JSON.stringify({ type: 'x' }), { timestamp: now - 301 });
      const result = await standard.verify(toReq(signed), CREDS, { now: () => now * 1000 });
      expect(result.ok).toBe(false);
    });

    it('6.9: non-numeric timestamp is rejected', async () => {
      const signer = createTestSigner(standard, CREDS);
      const signed = await signer.sign(JSON.stringify({ type: 'x' }));
      const bad = { ...signed.headers, 'webhook-timestamp': 'not-a-number' };
      const result = await standard.verify({ body: signed.body, headers: bad }, CREDS);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
    });
  });
});
