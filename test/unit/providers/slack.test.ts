import { describe, expect, it } from 'vitest';
import type { WebhookRequest } from '../../../src/core/types.js';
import { slack } from '../../../src/providers/slack.js';
import { createTestSigner } from '../../../src/testing/index.js';
import { loadFixture } from '../../fixtures/loader.js';
import { runAdapterConformance } from '../../shared/conformance.js';

const CREDS = { type: 'secret' as const, secret: 'slack_signing_secret' };

function toReq(signed: { body: Uint8Array; headers: Record<string, string> }): WebhookRequest {
  return { body: signed.body, headers: signed.headers };
}

runAdapterConformance(slack, loadFixture('slack', 'app-mention-event'), {
  otherFixtures: [
    loadFixture('stripe', 'checkout-completed'),
    loadFixture('github', 'pull-request-opened'),
    loadFixture('shopify', 'orders-create'),
    loadFixture('standard', 'user-created'),
  ],
});

describe('slack adapter', () => {
  it('accepts a validly signed JSON request', async () => {
    const signer = createTestSigner(slack, CREDS);
    const signed = await signer.sign(JSON.stringify({ event_id: 'Ev1', type: 'event_callback' }));
    const result = await slack.verify(toReq(signed), CREDS);
    expect(result.ok).toBe(true);
  });

  it('extracts the event id from event_id in the JSON body', async () => {
    const signer = createTestSigner(slack, CREDS);
    const signed = await signer.sign(JSON.stringify({ event_id: 'Ev1', type: 'event_callback' }));
    expect(slack.extractEventId(toReq(signed))).toBe('Ev1');
  });

  it('rejects a tampered body', async () => {
    const signer = createTestSigner(slack, CREDS);
    const signed = await signer.sign(JSON.stringify({ event_id: 'Ev1', type: 'x' }));
    const tampered = {
      ...signed,
      body: new TextEncoder().encode(JSON.stringify({ event_id: 'Ev2', type: 'x' })),
    };
    const result = await slack.verify(toReq(tampered), CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_signature');
  });

  it('rejects the wrong secret', async () => {
    const signer = createTestSigner(slack, CREDS);
    const signed = await signer.sign(JSON.stringify({ event_id: 'Ev1', type: 'x' }));
    const result = await slack.verify(toReq(signed), { type: 'secret', secret: 'wrong-secret' });
    expect(result.ok).toBe(false);
  });

  it('rejects when x-slack-signature is missing', async () => {
    const result = await slack.verify(
      { body: new Uint8Array(), headers: { 'x-slack-request-timestamp': '1700000000' } },
      CREDS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing_signature_header');
  });

  it('rejects when x-slack-request-timestamp is missing', async () => {
    const result = await slack.verify(
      { body: new Uint8Array(), headers: { 'x-slack-signature': 'v0=deadbeef' } },
      CREDS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing_signature_header');
  });

  it('rejects a header without the v0= prefix', async () => {
    const result = await slack.verify(
      {
        body: new Uint8Array(),
        headers: { 'x-slack-signature': 'deadbeef', 'x-slack-request-timestamp': '1700000000' },
      },
      CREDS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
  });

  it('rejects a v0= header whose remainder is not valid hex', async () => {
    const result = await slack.verify(
      {
        body: new Uint8Array(),
        headers: {
          'x-slack-signature': 'v0=zz-not-hex',
          'x-slack-request-timestamp': '1700000000',
        },
      },
      CREDS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
  });

  it('rejects a non-numeric timestamp header as malformed, not silently NaN-compared', async () => {
    const result = await slack.verify(
      {
        body: new Uint8Array(),
        headers: {
          'x-slack-signature': `v0=${'aa'.repeat(32)}`,
          'x-slack-request-timestamp': 'not-a-number',
        },
      },
      CREDS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
  });

  it('throws synchronously if toleranceSeconds is 0', async () => {
    const signer = createTestSigner(slack, CREDS);
    const signed = await signer.sign(JSON.stringify({ event_id: 'Ev1', type: 'x' }));
    await expect(slack.verify(toReq(signed), CREDS, { toleranceSeconds: 0 })).rejects.toThrow(
      RangeError,
    );
  });

  it('rejects a timestamp outside the tolerance window (replay)', async () => {
    const signer = createTestSigner(slack, CREDS);
    const stale = Math.floor(Date.now() / 1000) - 10_000;
    const signed = await signer.sign(JSON.stringify({ event_id: 'Ev1', type: 'x' }), {
      timestamp: stale,
    });
    const result = await slack.verify(toReq(signed), CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timestamp_out_of_tolerance');
  });

  it('accepts a secret from additionalSecrets during rotation', async () => {
    const newSecret = 'slack_new_secret';
    const signer = createTestSigner(slack, { type: 'secret', secret: newSecret });
    const signed = await signer.sign(JSON.stringify({ event_id: 'Ev1', type: 'x' }));
    const result = await slack.verify(toReq(signed), CREDS, { additionalSecrets: [newSecret] });
    expect(result.ok).toBe(true);
  });

  describe('§5.8-5.9 Slack-specific quirks', () => {
    it('5.8: verifies a form-urlencoded slash-command body over its raw bytes, never parsing first', async () => {
      const formBody = 'token=abc123&team_id=T1&command=%2Fweather&text=94070';
      const signer = createTestSigner(slack, CREDS);
      const signed = await signer.sign(formBody);
      const req: WebhookRequest = {
        body: signed.body,
        headers: { ...signed.headers, 'content-type': 'application/x-www-form-urlencoded' },
      };
      const result = await slack.verify(req, CREDS);
      expect(result.ok).toBe(true);
    });

    it('5.8b: a form-urlencoded body is byte-for-byte signed — tampering it is caught exactly like JSON', async () => {
      const formBody = 'token=abc123&team_id=T1&command=%2Fweather&text=94070';
      const signer = createTestSigner(slack, CREDS);
      const signed = await signer.sign(formBody);
      const tamperedBody = new TextEncoder().encode(
        'token=abc123&team_id=T1&command=%2Fweather&text=00000',
      );
      const result = await slack.verify({ body: tamperedBody, headers: signed.headers }, CREDS);
      expect(result.ok).toBe(false);
    });

    it('5.9: the signature basestring uses colon separators (v0:ts:body), not dots — a dot-joined basestring never verifies', async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const body = new TextEncoder().encode('{"event_id":"Ev1"}');
      // Deliberately compute a digest over a dot-separated basestring (Stripe-style) to
      // prove the adapter does NOT accept that shape — it must be colon-separated.
      const wrongBasestring = new TextEncoder().encode(`v0.${timestamp}.`);
      const combined = new Uint8Array(wrongBasestring.length + body.length);
      combined.set(wrongBasestring, 0);
      combined.set(body, wrongBasestring.length);

      const { hmacSign } = await import('../../../src/core/crypto.js');
      const { bytesToHex, utf8ToBytes } = await import('../../../src/core/encoding.js');
      const sigBytes = await hmacSign('SHA-256', utf8ToBytes(CREDS.secret), combined);

      const result = await slack.verify(
        {
          body,
          headers: {
            'x-slack-signature': `v0=${bytesToHex(sigBytes)}`,
            'x-slack-request-timestamp': String(timestamp),
          },
        },
        CREDS,
      );
      expect(result.ok).toBe(false);
    });
  });

  describe('§6.18 (critical replay test): the timestamp is part of the signed payload', () => {
    it('rewriting only the timestamp header breaks the signature', async () => {
      const now = 1_700_000_000;
      const signer = createTestSigner(slack, CREDS);
      const signed = await signer.sign(JSON.stringify({ event_id: 'Ev1', type: 'x' }), {
        timestamp: now - 100,
      });
      const rewritten = { ...signed.headers, 'x-slack-request-timestamp': String(now) };
      const result = await slack.verify({ body: signed.body, headers: rewritten }, CREDS, {
        now: () => now * 1000,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_signature');
    });
  });

  describe('coverage: branches not reachable through the normal happy/sad paths above', () => {
    it('verify() rejects a non-"secret" credentials type without throwing', async () => {
      const result = await slack.verify(
        {
          body: new Uint8Array(),
          headers: {
            'x-slack-signature': 'v0=deadbeef',
            'x-slack-request-timestamp': '1700000000',
          },
        },
        { type: 'publicKey', publicKey: 'irrelevant' },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_signature');
    });

    it('sign() throws when given a non-"secret" credentials type', async () => {
      await expect(
        slack.sign?.(new Uint8Array(), { type: 'publicKey', publicKey: 'irrelevant' }),
      ).rejects.toThrow('type "secret"');
    });
  });
});
