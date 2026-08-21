import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../../../src/core/encoding.js';
import type { WebhookRequest } from '../../../src/core/types.js';
import { stripe } from '../../../src/providers/stripe.js';
import { createTestSigner } from '../../../src/testing/index.js';
import { loadFixture } from '../../fixtures/loader.js';
import { runAdapterConformance } from '../../shared/conformance.js';

const SECRET = 'whsec_test_secret_stripe';
const CREDS = { type: 'secret' as const, secret: SECRET };

function toReq(signed: { body: Uint8Array; headers: Record<string, string> }): WebhookRequest {
  return { body: signed.body, headers: signed.headers };
}

runAdapterConformance(stripe, loadFixture('stripe', 'checkout-completed'), {
  otherFixtures: [
    loadFixture('github', 'pull-request-opened'),
    loadFixture('shopify', 'orders-create'),
    loadFixture('standard', 'user-created'),
  ],
});

describe('stripe adapter', () => {
  it('accepts a validly signed request', async () => {
    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(
      JSON.stringify({ id: 'evt_123', type: 'checkout.session.completed' }),
    );
    const result = await stripe.verify(toReq(signed), CREDS);
    expect(result.ok).toBe(true);
  });

  it('extracts the event id from the JSON body', async () => {
    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_123', type: 'x' }));
    expect(stripe.extractEventId(toReq(signed))).toBe('evt_123');
  });

  it('rejects a tampered body', async () => {
    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_123', type: 'x' }));
    const tampered = {
      ...signed,
      body: new TextEncoder().encode(JSON.stringify({ id: 'evt_999', type: 'x' })),
    };
    const result = await stripe.verify(toReq(tampered), CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_signature');
  });

  it('rejects the wrong secret', async () => {
    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));
    const result = await stripe.verify(toReq(signed), { type: 'secret', secret: 'whsec_wrong' });
    expect(result.ok).toBe(false);
  });

  it('rejects when the stripe-signature header is missing', async () => {
    const result = await stripe.verify({ body: new Uint8Array(), headers: {} }, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing_signature_header');
  });

  it('rejects a malformed signature header', async () => {
    const result = await stripe.verify(
      { body: new Uint8Array(), headers: { 'stripe-signature': 'garbage' } },
      CREDS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
  });

  it('rejects a timestamp outside the tolerance window (replay)', async () => {
    const signer = createTestSigner(stripe, CREDS);
    const staleTimestamp = Math.floor(Date.now() / 1000) - 10_000;
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }), {
      timestamp: staleTimestamp,
    });
    const result = await stripe.verify(toReq(signed), CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timestamp_out_of_tolerance');
  });

  it('accepts a signature within a custom tolerance', async () => {
    const signer = createTestSigner(stripe, CREDS);
    const timestamp = Math.floor(Date.now() / 1000) - 500;
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }), { timestamp });
    const result = await stripe.verify(toReq(signed), CREDS, { toleranceSeconds: 600 });
    expect(result.ok).toBe(true);
  });

  it('throws synchronously if toleranceSeconds is 0 (replay protection must never be disabled)', async () => {
    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));
    await expect(stripe.verify(toReq(signed), CREDS, { toleranceSeconds: 0 })).rejects.toThrow(
      RangeError,
    );
  });

  it('accepts a secret from additionalSecrets during rotation', async () => {
    const newSecret = 'whsec_new_secret';
    const signer = createTestSigner(stripe, { type: 'secret', secret: newSecret });
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));
    const result = await stripe.verify(toReq(signed), CREDS, { additionalSecrets: [newSecret] });
    expect(result.ok).toBe(true);
  });

  it('accepts multiple v1 signatures in the header (dual-signing during rotation)', async () => {
    const signed = await createTestSigner(stripe, CREDS).sign(
      JSON.stringify({ id: 'evt_1', type: 'x' }),
    );
    const header = signed.headers['stripe-signature'] as string;
    const bogus = `${header},v1=deadbeef`;
    const result = await stripe.verify(
      { body: signed.body, headers: { 'stripe-signature': bogus } },
      CREDS,
    );
    expect(result.ok).toBe(true);
  });

  describe('§4.4 key rotation / multiple signatures', () => {
    it('4.1: two v1 values, the SECOND is the valid one — still accepted', async () => {
      const signed = await createTestSigner(stripe, CREDS).sign(
        JSON.stringify({ id: 'evt_1', type: 'x' }),
      );
      const header = signed.headers['stripe-signature'] as string;
      const withBogusFirst = header.replace(',v1=', ',v1=deadbeef,v1=');
      const result = await stripe.verify(
        { body: signed.body, headers: { 'stripe-signature': withBogusFirst } },
        CREDS,
      );
      expect(result.ok).toBe(true);
    });

    it('4.2: two v1 values, neither valid — rejected', async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const header = `t=${timestamp},v1=deadbeef,v1=cafebabe`;
      const result = await stripe.verify(
        { body: new TextEncoder().encode('{}'), headers: { 'stripe-signature': header } },
        CREDS,
      );
      expect(result.ok).toBe(false);
    });

    it('4.7: additionalSecrets — all candidates invalid — rejected', async () => {
      const signer = createTestSigner(stripe, { type: 'secret', secret: 'whsec_actual_signer' });
      const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));
      const result = await stripe.verify(toReq(signed), CREDS, {
        additionalSecrets: ['whsec_wrong_one', 'whsec_wrong_two'],
      });
      expect(result.ok).toBe(false);
    });

    it('4.8: a later additionalSecrets candidate is still found — rotation does not short-circuit after the first mismatch', async () => {
      const correctSecret = 'whsec_the_actual_new_secret';
      const signer = createTestSigner(stripe, { type: 'secret', secret: correctSecret });
      const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));
      const result = await stripe.verify(toReq(signed), CREDS, {
        additionalSecrets: ['whsec_wrong_one', 'whsec_wrong_two', correctSecret],
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('§3.10-3.16 header format edge cases', () => {
    it('3.10: uppercase hex in v1 is accepted (must decode, not string-compare)', async () => {
      const signed = await createTestSigner(stripe, CREDS).sign(
        JSON.stringify({ id: 'evt_1', type: 'x' }),
      );
      const header = signed.headers['stripe-signature'] as string;
      const uppercased = header.replace(
        /v1=([0-9a-f]+)/,
        (_m, hex: string) => `v1=${hex.toUpperCase()}`,
      );
      const result = await stripe.verify(
        { body: signed.body, headers: { 'stripe-signature': uppercased } },
        CREDS,
      );
      expect(result.ok).toBe(true);
    });

    it('3.13: valid hex but wrong length — rejects without throwing', async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const header = `t=${timestamp},v1=abcd1234`; // 8 hex chars, not 64
      await expect(
        stripe.verify(
          { body: new TextEncoder().encode('{}'), headers: { 'stripe-signature': header } },
          CREDS,
        ),
      ).resolves.toMatchObject({ ok: false });
    });

    it('3.14: non-hex characters in v1 — malformed, not a throw', async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const header = `t=${timestamp},v1=not-hex-zzzz`;
      const result = await stripe.verify(
        { body: new TextEncoder().encode('{}'), headers: { 'stripe-signature': header } },
        CREDS,
      );
      expect(result.ok).toBe(false);
    });
  });

  describe('§6 timing, replay, and clocks', () => {
    it('6.2: exactly at the tolerance boundary (t = now - 300) is accepted (inclusive)', async () => {
      const now = 1_700_000_000;
      const signer = createTestSigner(stripe, CREDS);
      const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }), {
        timestamp: now - 300,
      });
      const result = await stripe.verify(toReq(signed), CREDS, { now: () => now * 1000 });
      expect(result.ok).toBe(true);
    });

    it('6.3: one second past the boundary (t = now - 301) is rejected', async () => {
      const now = 1_700_000_000;
      const signer = createTestSigner(stripe, CREDS);
      const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }), {
        timestamp: now - 301,
      });
      const result = await stripe.verify(toReq(signed), CREDS, { now: () => now * 1000 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('timestamp_out_of_tolerance');
    });

    it('6.5: a future timestamp within tolerance (clock skew) is accepted', async () => {
      const now = 1_700_000_000;
      const signer = createTestSigner(stripe, CREDS);
      const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }), {
        timestamp: now + 10,
      });
      const result = await stripe.verify(toReq(signed), CREDS, { now: () => now * 1000 });
      expect(result.ok).toBe(true);
    });

    it('6.6: a far-future timestamp is rejected — tolerance applies both directions', async () => {
      const now = 1_700_000_000;
      const signer = createTestSigner(stripe, CREDS);
      const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }), {
        timestamp: now + 3600,
      });
      const result = await stripe.verify(toReq(signed), CREDS, { now: () => now * 1000 });
      expect(result.ok).toBe(false);
    });

    it('6.9: non-numeric timestamp is rejected without a NaN leak', async () => {
      const result = await stripe.verify(
        {
          body: new TextEncoder().encode('{}'),
          headers: { 'stripe-signature': 't=abc,v1=deadbeef' },
        },
        CREDS,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
    });

    it('6.10: "NaN" and "Infinity" timestamps are rejected, not treated as always-false-so-open', async () => {
      for (const bad of ['NaN', 'Infinity', '-Infinity']) {
        const result = await stripe.verify(
          {
            body: new TextEncoder().encode('{}'),
            headers: { 'stripe-signature': `t=${bad},v1=deadbeef` },
          },
          CREDS,
        );
        expect(result.ok).toBe(false);
      }
    });

    it('6.12: a timestamp in milliseconds (13 digits) instead of seconds is rejected', async () => {
      const nowMs = 1_700_000_000_000;
      // A millisecond value interpreted as seconds is ~53,000 years in the future —
      // guaranteed outside any sane tolerance window.
      const signer = createTestSigner(stripe, CREDS);
      const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }), {
        timestamp: nowMs,
      });
      const result = await stripe.verify(toReq(signed), CREDS, { now: () => nowMs });
      expect(result.ok).toBe(false);
    });

    it('6.18 (THE critical replay test): moving only the t= value breaks the signature, proving the timestamp is signed, not just compared', async () => {
      const now = 1_700_000_000;
      const signer = createTestSigner(stripe, CREDS);
      const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }), {
        timestamp: now - 100,
      });
      const header = signed.headers['stripe-signature'] as string;

      // Bump the t= to "now" while keeping the original v1 digest — if the library only
      // ever *compared* the timestamp instead of *signing* it, this would pass, and an
      // attacker could replay an old captured body indefinitely by rewriting t=.
      const rewrittenHeader = header.replace(/t=\d+/, `t=${now}`);
      const result = await stripe.verify(
        { body: signed.body, headers: { 'stripe-signature': rewrittenHeader } },
        CREDS,
        { now: () => now * 1000 },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_signature');
    });
  });

  describe('coverage: branches not reachable through the normal happy/sad paths above', () => {
    it('verify() rejects a non-"secret" credentials type without throwing', async () => {
      const result = await stripe.verify(
        { body: new Uint8Array(), headers: { 'stripe-signature': 't=1,v1=deadbeef' } },
        { type: 'publicKey', publicKey: 'irrelevant' },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_signature');
    });

    it('sign() throws when given a non-"secret" credentials type', async () => {
      await expect(
        stripe.sign?.(new Uint8Array(), { type: 'publicKey', publicKey: 'irrelevant' }),
      ).rejects.toThrow('type "secret"');
    });

    it('accepts a secret supplied as raw Uint8Array bytes, not a string', async () => {
      const rawSecret = new TextEncoder().encode('whsec_bytes_secret');
      const bytesCreds = { type: 'secret' as const, secret: rawSecret };
      const signer = createTestSigner(stripe, bytesCreds);
      const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));
      const result = await stripe.verify(toReq(signed), bytesCreds);
      expect(result.ok).toBe(true);
    });

    it('extractEventId returns null when the "id" field is present but not a string', async () => {
      const req: WebhookRequest = {
        body: new TextEncoder().encode(JSON.stringify({ id: 12345, type: 'x' })),
        headers: {},
      };
      expect(stripe.extractEventId(req)).toBeNull();
    });
  });

  describe('§10.5 fast-check invariant (single-case sanity; full sweep in test/security/fuzz.test.ts)', () => {
    it('a hand-flipped hex digest never verifies', async () => {
      const signer = createTestSigner(stripe, CREDS);
      const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));
      const header = signed.headers['stripe-signature'] as string;
      const flipped = header.replace(
        /v1=([0-9a-f])/,
        (_m, c: string) => `v1=${c === '0' ? '1' : '0'}`,
      );
      const result = await stripe.verify(
        { body: signed.body, headers: { 'stripe-signature': flipped } },
        CREDS,
      );
      expect(result.ok).toBe(false);
    });

    it('bytesToHex/round-trip sanity: the fixture header actually decodes to 32 bytes (sha256)', async () => {
      const signer = createTestSigner(stripe, CREDS);
      const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));
      const header = signed.headers['stripe-signature'] as string;
      const hex = header.match(/v1=([0-9a-f]+)/)?.[1] ?? '';
      expect(hex).toHaveLength(64);
      expect(bytesToHex(new Uint8Array(32))).toHaveLength(64);
    });
  });
});
