import { describe, expect, it } from 'vitest';
import { concatBytes, utf8ToBytes } from '../../../src/core/encoding.js';
import type { WebhookRequest } from '../../../src/core/types.js';
import { createGenericAdapter } from '../../../src/providers/generic.js';
import { createTestSigner } from '../../../src/testing/index.js';
import { loadFixture } from '../../fixtures/loader.js';
import { runAdapterConformance } from '../../shared/conformance.js';

const CREDS = { type: 'secret' as const, secret: 'acme_shared_secret' };

// Kept in sync by hand with scripts/generate-synthetic-fixtures.mjs's "acme" config —
// a fabricated scheme (not a real provider) proving the escape hatch actually works.
const acme = createGenericAdapter({
  name: 'acme',
  signatureHeader: 'x-acme-signature',
  algorithm: 'sha256',
  encoding: 'hex',
  prefix: 'sha256=',
  timestampHeader: 'x-acme-timestamp',
  toleranceSeconds: 300,
  eventIdHeader: 'x-acme-event-id',
  buildSignedPayload: ({ timestamp, body }) => concatBytes(utf8ToBytes(`${timestamp}.`), body),
});

function toReq(signed: { body: Uint8Array; headers: Record<string, string> }): WebhookRequest {
  return { body: signed.body, headers: signed.headers };
}

runAdapterConformance(acme, loadFixture('generic', 'acme-event'), {
  otherFixtures: [
    loadFixture('stripe', 'checkout-completed'),
    loadFixture('github', 'pull-request-opened'),
    loadFixture('shopify', 'orders-create'),
  ],
});

describe('createGenericAdapter (the build-your-own escape hatch)', () => {
  it('accepts a validly signed request', async () => {
    const signer = createTestSigner(acme, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1' }));
    const result = await acme.verify(toReq(signed), CREDS);
    expect(result.ok).toBe(true);
  });

  it('5.26: matches a hand-computed digest for a fabricated scheme — proves the escape hatch works', async () => {
    const timestamp = 1_700_000_000;
    const body = new TextEncoder().encode(JSON.stringify({ id: 'evt_hand' }));
    const signedPayload = concatBytes(utf8ToBytes(`${timestamp}.`), body);

    // Hand-compute the digest independently of the adapter, using only core primitives.
    const { hmacSign } = await import('../../../src/core/crypto.js');
    const { bytesToHex, utf8ToBytes: u8 } = await import('../../../src/core/encoding.js');
    const handComputedSig = await hmacSign('SHA-256', u8(CREDS.secret), signedPayload);

    const req: WebhookRequest = {
      body,
      headers: {
        'x-acme-signature': `sha256=${bytesToHex(handComputedSig)}`,
        'x-acme-timestamp': String(timestamp),
      },
    };

    const result = await acme.verify(req, CREDS, { now: () => timestamp * 1000 });
    expect(result.ok).toBe(true);
  });

  it('extracts the event id from the configured eventIdHeader', async () => {
    const signer = createTestSigner(acme, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1' }), { eventId: 'acme_evt_1' });
    expect(acme.extractEventId(toReq(signed))).toBe('acme_evt_1');
  });

  it('rejects a tampered body', async () => {
    const signer = createTestSigner(acme, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1' }));
    const tampered = { ...signed, body: new TextEncoder().encode(JSON.stringify({ id: 'evt_2' })) };
    const result = await acme.verify(toReq(tampered), CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_signature');
  });

  it('rejects the wrong secret', async () => {
    const signer = createTestSigner(acme, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1' }));
    const result = await acme.verify(toReq(signed), { type: 'secret', secret: 'wrong-secret' });
    expect(result.ok).toBe(false);
  });

  it('rejects when the signature header is missing', async () => {
    const result = await acme.verify({ body: new Uint8Array(), headers: {} }, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing_signature_header');
  });

  it('rejects when the timestamp header is missing (configured but absent)', async () => {
    const result = await acme.verify(
      { body: new Uint8Array(), headers: { 'x-acme-signature': 'sha256=deadbeef' } },
      CREDS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing_signature_header');
  });

  it('rejects a header missing the configured prefix', async () => {
    const result = await acme.verify(
      {
        body: new Uint8Array(),
        headers: { 'x-acme-signature': 'deadbeef', 'x-acme-timestamp': '1700000000' },
      },
      CREDS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
  });

  it('rejects a header with the configured prefix whose remainder is not valid hex', async () => {
    const result = await acme.verify(
      {
        body: new Uint8Array(),
        headers: { 'x-acme-signature': 'sha256=zz-not-hex', 'x-acme-timestamp': '1700000000' },
      },
      CREDS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
  });

  it('rejects a timestamp outside the configured tolerance window', async () => {
    const signer = createTestSigner(acme, CREDS);
    const stale = Math.floor(Date.now() / 1000) - 10_000;
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1' }), { timestamp: stale });
    const result = await acme.verify(toReq(signed), CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timestamp_out_of_tolerance');
  });

  it('throws synchronously if toleranceSeconds is overridden to 0 at call time', async () => {
    const signer = createTestSigner(acme, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1' }));
    await expect(acme.verify(toReq(signed), CREDS, { toleranceSeconds: 0 })).rejects.toThrow(
      RangeError,
    );
  });

  it('accepts a secret from additionalSecrets during rotation', async () => {
    const newSecret = 'acme_new_secret';
    const signer = createTestSigner(acme, { type: 'secret', secret: newSecret });
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1' }));
    const result = await acme.verify(toReq(signed), CREDS, { additionalSecrets: [newSecret] });
    expect(result.ok).toBe(true);
  });

  describe('§6.18 (critical replay test): the timestamp is part of the signed payload', () => {
    it('rewriting only the timestamp header breaks the signature', async () => {
      const now = 1_700_000_000;
      const signer = createTestSigner(acme, CREDS);
      const signed = await signer.sign(JSON.stringify({ id: 'evt_1' }), { timestamp: now - 100 });
      const rewritten = { ...signed.headers, 'x-acme-timestamp': String(now) };
      const result = await acme.verify({ body: signed.body, headers: rewritten }, CREDS, {
        now: () => now * 1000,
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('config variants', () => {
    it('a scheme with no timestampHeader configured never checks tolerance', async () => {
      const noTimestamp = createGenericAdapter({
        name: 'notime',
        signatureHeader: 'x-notime-signature',
        algorithm: 'sha256',
        encoding: 'hex',
        buildSignedPayload: ({ body }) => body,
      });
      expect(noTimestamp.defaultToleranceSeconds).toBeNull();
      const signer = createTestSigner(noTimestamp, CREDS);
      const signed = await signer.sign(JSON.stringify({ id: 'evt_1' }));
      const result = await noTimestamp.verify(
        { body: signed.body, headers: signed.headers },
        CREDS,
      );
      expect(result.ok).toBe(true);
    });

    it('a scheme with timestampHeader but no toleranceSeconds passes the timestamp through without enforcing a window', async () => {
      const noTolerance = createGenericAdapter({
        name: 'notol',
        signatureHeader: 'x-notol-signature',
        algorithm: 'sha256',
        encoding: 'hex',
        timestampHeader: 'x-notol-timestamp',
        buildSignedPayload: ({ body }) => body,
      });
      const signer = createTestSigner(noTolerance, CREDS);
      const veryOld = Math.floor(Date.now() / 1000) - 10_000_000;
      const signed = await signer.sign(JSON.stringify({ id: 'evt_1' }), { timestamp: veryOld });
      const result = await noTolerance.verify(
        { body: signed.body, headers: signed.headers },
        CREDS,
      );
      expect(result.ok).toBe(true);
    });

    it('base64 encoding works as an alternative to hex', async () => {
      const base64Scheme = createGenericAdapter({
        name: 'b64scheme',
        signatureHeader: 'x-b64-signature',
        algorithm: 'sha256',
        encoding: 'base64',
        buildSignedPayload: ({ body }) => body,
      });
      const signer = createTestSigner(base64Scheme, CREDS);
      const signed = await signer.sign(JSON.stringify({ id: 'evt_1' }));
      const result = await base64Scheme.verify(
        { body: signed.body, headers: signed.headers },
        CREDS,
      );
      expect(result.ok).toBe(true);
    });

    it('sha1 and sha512 algorithms both work', async () => {
      for (const algorithm of ['sha1', 'sha512'] as const) {
        const scheme = createGenericAdapter({
          name: `scheme-${algorithm}`,
          signatureHeader: 'x-signature',
          algorithm,
          encoding: 'hex',
          buildSignedPayload: ({ body }) => body,
        });
        const signer = createTestSigner(scheme, CREDS);
        const signed = await signer.sign(JSON.stringify({ id: 'evt_1' }));
        const result = await scheme.verify({ body: signed.body, headers: signed.headers }, CREDS);
        expect(result.ok).toBe(true);
      }
    });

    it('buildSignedPayload may return a plain string instead of Uint8Array', async () => {
      const stringScheme = createGenericAdapter({
        name: 'stringscheme',
        signatureHeader: 'x-signature',
        algorithm: 'sha256',
        encoding: 'hex',
        buildSignedPayload: ({ body }) => `prefix:${new TextDecoder().decode(body)}`,
      });
      const signer = createTestSigner(stringScheme, CREDS);
      const signed = await signer.sign(JSON.stringify({ id: 'evt_1' }));
      const result = await stringScheme.verify(
        { body: signed.body, headers: signed.headers },
        CREDS,
      );
      expect(result.ok).toBe(true);
    });
  });

  describe('coverage: branches not reachable through the normal happy/sad paths above', () => {
    it('verify() rejects a non-"secret" credentials type without throwing', async () => {
      const result = await acme.verify(
        {
          body: new Uint8Array(),
          headers: { 'x-acme-signature': 'sha256=aa', 'x-acme-timestamp': '1700000000' },
        },
        { type: 'publicKey', publicKey: 'irrelevant' },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_signature');
    });

    it('sign() throws when given a non-"secret" credentials type', async () => {
      await expect(
        acme.sign?.(new Uint8Array(), { type: 'publicKey', publicKey: 'irrelevant' }),
      ).rejects.toThrow('type "secret"');
    });

    it('rejects a non-numeric timestamp when toleranceSeconds is configured', async () => {
      const result = await acme.verify(
        {
          body: new Uint8Array(),
          headers: { 'x-acme-signature': 'sha256=aa', 'x-acme-timestamp': 'not-a-number' },
        },
        CREDS,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
    });

    it('extractEventId returns null when no eventIdHeader is configured', () => {
      const noEventId = createGenericAdapter({
        name: 'noevt',
        signatureHeader: 'x-signature',
        algorithm: 'sha256',
        encoding: 'hex',
        buildSignedPayload: ({ body }) => body,
      });
      expect(noEventId.extractEventId({ body: new Uint8Array(), headers: {} })).toBeNull();
    });

    it('extractEventId returns null when eventIdHeader is configured but absent from this request', () => {
      expect(acme.extractEventId({ body: new Uint8Array(), headers: {} })).toBeNull();
    });
  });
});
