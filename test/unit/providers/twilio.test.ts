import { describe, expect, it } from 'vitest';
import type { WebhookRequest } from '../../../src/core/types.js';
import { twilio } from '../../../src/providers/twilio.js';
import { createTestSigner } from '../../../src/testing/index.js';
import { loadFixture } from '../../fixtures/loader.js';
import { runAdapterConformance } from '../../shared/conformance.js';

const CREDS = { type: 'secret' as const, secret: 'twilio_auth_token' };
const URL = 'https://example.com/webhooks/twilio';

function toReq(
  signed: { body: Uint8Array; headers: Record<string, string> },
  url = URL,
): WebhookRequest {
  return {
    body: signed.body,
    headers: { ...signed.headers, 'content-type': 'application/x-www-form-urlencoded' },
    url,
  };
}

runAdapterConformance(twilio, loadFixture('twilio', 'incoming-sms'), {
  otherFixtures: [
    loadFixture('stripe', 'checkout-completed'),
    loadFixture('github', 'pull-request-opened'),
    loadFixture('shopify', 'orders-create'),
    loadFixture('standard', 'user-created'),
    loadFixture('slack', 'app-mention-event'),
  ],
});

describe('twilio adapter (URL-bound, HMAC-SHA1)', () => {
  it('5.14: accepts a validly signed request when the URL matches exactly', async () => {
    const signer = createTestSigner(twilio, CREDS);
    const body = 'MessageSid=SM1&From=%2B15551234567&Body=hi';
    const signed = await signer.sign(body, { url: URL });

    const result = await twilio.verify(toReq(signed), CREDS);

    expect(result.ok).toBe(true);
  });

  it('extracts MessageSid as the event id', async () => {
    const signer = createTestSigner(twilio, CREDS);
    const body = 'MessageSid=SM1&From=%2B15551234567&Body=hi';
    const signed = await signer.sign(body, { url: URL });

    expect(twilio.extractEventId(toReq(signed))).toBe('SM1');
  });

  it('rejects a tampered body', async () => {
    const signer = createTestSigner(twilio, CREDS);
    const signed = await signer.sign('MessageSid=SM1&Body=hi', { url: URL });
    const tampered = { ...signed, body: new TextEncoder().encode('MessageSid=SM1&Body=tampered') };

    const result = await twilio.verify(toReq(tampered), CREDS);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_signature');
  });

  it('rejects the wrong secret', async () => {
    const signer = createTestSigner(twilio, CREDS);
    const signed = await signer.sign('MessageSid=SM1&Body=hi', { url: URL });

    const result = await twilio.verify(toReq(signed), { type: 'secret', secret: 'wrong-token' });

    expect(result.ok).toBe(false);
  });

  it('rejects when x-twilio-signature is missing', async () => {
    const result = await twilio.verify({ body: new Uint8Array(), headers: {}, url: URL }, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing_signature_header');
  });

  it('rejects a signature header that is not valid base64', async () => {
    const result = await twilio.verify(
      { body: new Uint8Array(), headers: { 'x-twilio-signature': '***not-base64***' }, url: URL },
      CREDS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
  });

  it('rejects when the WebhookRequest has no url at all', async () => {
    const signer = createTestSigner(twilio, CREDS);
    const signed = await signer.sign('MessageSid=SM1&Body=hi', { url: URL });

    const result = await twilio.verify({ body: signed.body, headers: signed.headers }, CREDS);

    expect(result.ok).toBe(false);
  });

  describe('§5.14-5.19 the URL-binding proxy pitfall', () => {
    it('5.15: a protocol mismatch (https signed, http verified) is rejected', async () => {
      const signer = createTestSigner(twilio, CREDS);
      const signed = await signer.sign('MessageSid=SM1&Body=hi', {
        url: 'https://example.com/webhooks/twilio',
      });

      const result = await twilio.verify(
        toReq(signed, 'http://example.com/webhooks/twilio'),
        CREDS,
      );

      expect(result.ok).toBe(false);
    });

    it('5.15b: ...and passing the correct (explicit) URL override fixes it — proving WebhookRequest.url IS the override', async () => {
      const signer = createTestSigner(twilio, CREDS);
      const realUrl = 'https://example.com/webhooks/twilio';
      const signed = await signer.sign('MessageSid=SM1&Body=hi', { url: realUrl });

      // Simulates a proxy that reports the wrong scheme internally (http); the
      // integration adapter is responsible for reconstructing `realUrl` from
      // x-forwarded-proto/-host and passing it as WebhookRequest.url.
      const result = await twilio.verify(toReq(signed, realUrl), CREDS);

      expect(result.ok).toBe(true);
    });

    it('5.16: a trailing-slash mismatch is rejected', async () => {
      const signer = createTestSigner(twilio, CREDS);
      const signed = await signer.sign('MessageSid=SM1&Body=hi', {
        url: 'https://example.com/webhooks/twilio',
      });

      const result = await twilio.verify(
        toReq(signed, 'https://example.com/webhooks/twilio/'),
        CREDS,
      );

      expect(result.ok).toBe(false);
    });

    it('5.17: an explicit-port mismatch is rejected', async () => {
      const signer = createTestSigner(twilio, CREDS);
      const signed = await signer.sign('MessageSid=SM1&Body=hi', {
        url: 'https://example.com/webhooks/twilio',
      });

      const result = await twilio.verify(
        toReq(signed, 'https://example.com:443/webhooks/twilio'),
        CREDS,
      );

      expect(result.ok).toBe(false);
    });

    it('5.18: form params are sorted alphabetically before signing — matches a hand-built expected string', async () => {
      const signer = createTestSigner(twilio, CREDS);
      // Deliberately out of order in the body: Zulu, Alpha, Mike.
      const body = 'Zulu=z&Alpha=a&Mike=m';
      const signed = await signer.sign(body, { url: URL });

      const result = await twilio.verify(toReq(signed), CREDS);
      expect(result.ok).toBe(true);

      // Hand-compute the expected signed string (URL + sorted key+value, no separators)
      // and confirm the adapter's own signature matches it independently.
      const { hmacSign } = await import('../../../src/core/crypto.js');
      const { bytesToBase64, utf8ToBytes } = await import('../../../src/core/encoding.js');
      const expectedString = `${URL}AlphaaMikemZuluz`;
      const expectedSig = await hmacSign(
        'SHA-1',
        utf8ToBytes(CREDS.secret),
        utf8ToBytes(expectedString),
      );
      expect(signed.headers['x-twilio-signature']).toBe(bytesToBase64(expectedSig));
    });

    it('5.19: params with identical prefixes ("a" vs "ab") sort correctly — the classic off-by-one', async () => {
      const signer = createTestSigner(twilio, CREDS);
      // "ab" must sort AFTER "a" (shorter/prefix key first) — a naive or unstable sort
      // can get this backwards.
      const body = 'ab=second&a=first';
      const signed = await signer.sign(body, { url: URL });

      const result = await twilio.verify(toReq(signed), CREDS);
      expect(result.ok).toBe(true);

      const { hmacSign } = await import('../../../src/core/crypto.js');
      const { bytesToBase64, utf8ToBytes } = await import('../../../src/core/encoding.js');
      // Correct order: "a" (value "first") before "ab" (value "second").
      const expectedString = `${URL}afirstabsecond`;
      const expectedSig = await hmacSign(
        'SHA-1',
        utf8ToBytes(CREDS.secret),
        utf8ToBytes(expectedString),
      );
      expect(signed.headers['x-twilio-signature']).toBe(bytesToBase64(expectedSig));
    });
  });

  describe('non-form (JSON) bodies use the URL + body-hash scheme', () => {
    it('verifies a JSON body signed with the hash-based scheme', async () => {
      const signer = createTestSigner(twilio, CREDS);
      const body = JSON.stringify({ event: 'call.completed' });
      const signed = await signer.sign(body, { url: URL });

      const req: WebhookRequest = {
        body: signed.body,
        headers: { ...signed.headers, 'content-type': 'application/json' },
        url: URL,
      };
      const result = await twilio.verify(req, CREDS);

      expect(result.ok).toBe(true);
    });

    it('a JSON body verified as if it were form-encoded (wrong content-type) fails', async () => {
      const signer = createTestSigner(twilio, CREDS);
      const body = JSON.stringify({ event: 'call.completed' });
      const signed = await signer.sign(body, { url: URL });

      // Wrong content-type: claims form-encoded, but the signature was computed via the hash scheme.
      const req: WebhookRequest = {
        body: signed.body,
        headers: { ...signed.headers, 'content-type': 'application/x-www-form-urlencoded' },
        url: URL,
      };
      const result = await twilio.verify(req, CREDS);

      expect(result.ok).toBe(false);
    });
  });

  describe('coverage: branches not reachable through the normal happy/sad paths above', () => {
    it('verify() rejects a non-"secret" credentials type without throwing', async () => {
      const result = await twilio.verify(
        { body: new Uint8Array(), headers: { 'x-twilio-signature': 'AAAA' }, url: URL },
        { type: 'publicKey', publicKey: 'irrelevant' },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_signature');
    });

    it('sign() throws when given a non-"secret" credentials type', async () => {
      await expect(
        twilio.sign?.(
          new Uint8Array(),
          { type: 'publicKey', publicKey: 'irrelevant' },
          { url: URL },
        ),
      ).rejects.toThrow('type "secret"');
    });

    it('sign() throws when opts.url is missing', async () => {
      await expect(twilio.sign?.(new Uint8Array(), CREDS)).rejects.toThrow('opts.url is required');
    });

    it('extractEventId returns null for a non-form-encoded request', () => {
      const req: WebhookRequest = {
        body: new TextEncoder().encode('{}'),
        headers: { 'content-type': 'application/json' },
      };
      expect(twilio.extractEventId(req)).toBeNull();
    });

    it('a missing content-type header falls back to the hash-based (non-form) scheme, not a crash', async () => {
      const signer = createTestSigner(twilio, CREDS);
      const signed = await signer.sign(JSON.stringify({ id: 'evt_1' }), { url: URL });
      const result = await twilio.verify(
        { body: signed.body, headers: signed.headers, url: URL },
        CREDS,
      );
      expect(result.ok).toBe(true);
    });

    it('two form params with the same key sort as equal, not thrown or misordered', async () => {
      const signer = createTestSigner(twilio, CREDS);
      const signed = await signer.sign('a=1&a=2', { url: URL });
      const result = await twilio.verify(toReq(signed), CREDS);
      expect(result.ok).toBe(true);
    });

    it('accepts a secret from additionalSecrets during rotation', async () => {
      const newSecret = 'twilio_new_auth_token';
      const signer = createTestSigner(twilio, { type: 'secret', secret: newSecret });
      const signed = await signer.sign('MessageSid=SM123', { url: URL });
      const result = await twilio.verify(toReq(signed), CREDS, { additionalSecrets: [newSecret] });
      expect(result.ok).toBe(true);
    });
  });
});
