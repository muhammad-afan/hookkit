import { describe, expect, it } from 'vitest';
import type { WebhookRequest } from '../../../src/core/types.js';
import { paddle } from '../../../src/providers/paddle.js';
import { createTestSigner } from '../../../src/testing/index.js';
import { loadFixture } from '../../fixtures/loader.js';
import { runAdapterConformance } from '../../shared/conformance.js';

const CREDS = { type: 'secret' as const, secret: 'paddle_notification_secret' };

function toReq(signed: { body: Uint8Array; headers: Record<string, string> }): WebhookRequest {
  return { body: signed.body, headers: signed.headers };
}

runAdapterConformance(paddle, loadFixture('paddle', 'subscription-created'), {
  otherFixtures: [
    loadFixture('stripe', 'checkout-completed'),
    loadFixture('github', 'pull-request-opened'),
    loadFixture('shopify', 'orders-create'),
    loadFixture('standard', 'user-created'),
    loadFixture('slack', 'app-mention-event'),
  ],
});

describe('paddle adapter', () => {
  it('accepts a validly signed request', async () => {
    const signer = createTestSigner(paddle, CREDS);
    const signed = await signer.sign(JSON.stringify({ event_id: 'evt_1', event_type: 'x' }));
    const result = await paddle.verify(toReq(signed), CREDS);
    expect(result.ok).toBe(true);
  });

  it('extracts the event id from event_id in the JSON body', async () => {
    const signer = createTestSigner(paddle, CREDS);
    const signed = await signer.sign(JSON.stringify({ event_id: 'evt_1', event_type: 'x' }));
    expect(paddle.extractEventId(toReq(signed))).toBe('evt_1');
  });

  it('the header format is ts=...;h1=<hex>', async () => {
    const signer = createTestSigner(paddle, CREDS);
    const signed = await signer.sign(JSON.stringify({ event_id: 'evt_1' }));
    expect(signed.headers['paddle-signature']).toMatch(/^ts=\d+;h1=[0-9a-f]{64}$/);
  });

  it('rejects a tampered body', async () => {
    const signer = createTestSigner(paddle, CREDS);
    const signed = await signer.sign(JSON.stringify({ event_id: 'evt_1', event_type: 'x' }));
    const tampered = {
      ...signed,
      body: new TextEncoder().encode(JSON.stringify({ event_id: 'evt_2', event_type: 'x' })),
    };
    const result = await paddle.verify(toReq(tampered), CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_signature');
  });

  it('rejects the wrong secret', async () => {
    const signer = createTestSigner(paddle, CREDS);
    const signed = await signer.sign(JSON.stringify({ event_id: 'evt_1', event_type: 'x' }));
    const result = await paddle.verify(toReq(signed), { type: 'secret', secret: 'wrong-secret' });
    expect(result.ok).toBe(false);
  });

  it('rejects when paddle-signature is missing', async () => {
    const result = await paddle.verify({ body: new Uint8Array(), headers: {} }, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing_signature_header');
  });

  it('rejects a malformed signature header (missing h1)', async () => {
    const result = await paddle.verify(
      { body: new Uint8Array(), headers: { 'paddle-signature': 'ts=1700000000' } },
      CREDS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
  });

  it('throws synchronously if toleranceSeconds is 0', async () => {
    const signer = createTestSigner(paddle, CREDS);
    const signed = await signer.sign(JSON.stringify({ event_id: 'evt_1' }));
    await expect(paddle.verify(toReq(signed), CREDS, { toleranceSeconds: 0 })).rejects.toThrow(
      RangeError,
    );
  });

  it('rejects a timestamp outside the tolerance window (replay)', async () => {
    const signer = createTestSigner(paddle, CREDS);
    const stale = Math.floor(Date.now() / 1000) - 10_000;
    const signed = await signer.sign(JSON.stringify({ event_id: 'evt_1' }), { timestamp: stale });
    const result = await paddle.verify(toReq(signed), CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timestamp_out_of_tolerance');
  });

  it('accepts a secret from additionalSecrets during rotation', async () => {
    const newSecret = 'paddle_new_secret';
    const signer = createTestSigner(paddle, { type: 'secret', secret: newSecret });
    const signed = await signer.sign(JSON.stringify({ event_id: 'evt_1' }));
    const result = await paddle.verify(toReq(signed), CREDS, { additionalSecrets: [newSecret] });
    expect(result.ok).toBe(true);
  });

  describe('§6.18 (critical replay test): the timestamp is part of the signed payload', () => {
    it('rewriting only the ts= value breaks the signature', async () => {
      const now = 1_700_000_000;
      const signer = createTestSigner(paddle, CREDS);
      const signed = await signer.sign(JSON.stringify({ event_id: 'evt_1' }), {
        timestamp: now - 100,
      });
      const header = signed.headers['paddle-signature'] as string;
      const rewritten = header.replace(/ts=\d+/, `ts=${now}`);
      const result = await paddle.verify(
        { body: signed.body, headers: { 'paddle-signature': rewritten } },
        CREDS,
        { now: () => now * 1000 },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_signature');
    });
  });

  describe('coverage: branches not reachable through the normal happy/sad paths above', () => {
    it('verify() rejects a non-"secret" credentials type without throwing', async () => {
      const result = await paddle.verify(
        { body: new Uint8Array(), headers: { 'paddle-signature': 'ts=1700000000;h1=deadbeef' } },
        { type: 'publicKey', publicKey: 'irrelevant' },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_signature');
    });

    it('sign() throws when given a non-"secret" credentials type', async () => {
      await expect(
        paddle.sign?.(new Uint8Array(), { type: 'publicKey', publicKey: 'irrelevant' }),
      ).rejects.toThrow('type "secret"');
    });

    it('rejects a non-numeric ts value', async () => {
      const result = await paddle.verify(
        { body: new Uint8Array(), headers: { 'paddle-signature': 'ts=abc;h1=deadbeef' } },
        CREDS,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
    });

    it('rejects a non-hex h1 value without throwing', async () => {
      const result = await paddle.verify(
        {
          body: new Uint8Array(),
          headers: { 'paddle-signature': 'ts=1700000000;h1=not-hex-zzzz' },
        },
        CREDS,
      );
      expect(result.ok).toBe(false);
    });
  });
});
