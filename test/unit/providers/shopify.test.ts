import { describe, expect, it } from 'vitest';
import type { WebhookRequest } from '../../../src/core/types.js';
import { shopify } from '../../../src/providers/shopify.js';
import { createTestSigner } from '../../../src/testing/index.js';
import { loadFixture } from '../../fixtures/loader.js';
import { runAdapterConformance } from '../../shared/conformance.js';

const CREDS = { type: 'secret' as const, secret: 'shopify_app_secret' };

function toReq(signed: { body: Uint8Array; headers: Record<string, string> }): WebhookRequest {
  return { body: signed.body, headers: signed.headers };
}

runAdapterConformance(shopify, loadFixture('shopify', 'orders-create'), {
  otherFixtures: [
    loadFixture('stripe', 'checkout-completed'),
    loadFixture('github', 'pull-request-opened'),
    loadFixture('standard', 'user-created'),
  ],
});

describe('shopify adapter', () => {
  it('accepts a validly signed request (base64 HMAC-SHA256)', async () => {
    const signer = createTestSigner(shopify, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 123 }));
    const result = await shopify.verify(toReq(signed), CREDS);
    expect(result.ok).toBe(true);
  });

  it('has no timestamp / replay tolerance', () => {
    expect(shopify.defaultToleranceSeconds).toBeNull();
  });

  it('extracts the event id from x-shopify-webhook-id', async () => {
    const signer = createTestSigner(shopify, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 123 }), { eventId: 'wh-uuid-1' });
    expect(shopify.extractEventId(toReq(signed))).toBe('wh-uuid-1');
  });

  it('rejects a tampered body', async () => {
    const signer = createTestSigner(shopify, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 123 }));
    const tampered = { ...signed, body: new TextEncoder().encode(JSON.stringify({ id: 456 })) };
    const result = await shopify.verify(toReq(tampered), CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_signature');
  });

  it('rejects when x-shopify-hmac-sha256 is missing', async () => {
    const result = await shopify.verify({ body: new Uint8Array(), headers: {} }, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing_signature_header');
  });

  it('rejects a header that is not valid base64', async () => {
    const result = await shopify.verify(
      { body: new Uint8Array(), headers: { 'x-shopify-hmac-sha256': '***not-base64***' } },
      CREDS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
  });

  it('never treats x-shopify-triggered-at as a security input (it is unsigned)', async () => {
    const signer = createTestSigner(shopify, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 123 }));
    const req = {
      body: signed.body,
      headers: { ...signed.headers, 'x-shopify-triggered-at': 'anything-attacker-controlled' },
    };
    const result = await shopify.verify(req, CREDS);
    expect(result.ok).toBe(true);
  });

  describe('§3.11-3.12 base64 format edge cases', () => {
    it('3.11: base64 without padding is accepted', async () => {
      const signer = createTestSigner(shopify, CREDS);
      const signed = await signer.sign(JSON.stringify({ id: 123 }));
      const header = signed.headers['x-shopify-hmac-sha256'] as string;
      const unpadded = header.replace(/=+$/, '');
      const result = await shopify.verify(
        { body: signed.body, headers: { 'x-shopify-hmac-sha256': unpadded } },
        CREDS,
      );
      expect(result.ok).toBe(true);
    });

    it('3.12: base64url characters (-/_) are rejected as malformed, not silently decoded', async () => {
      // '-' and '_' are outside the standard base64 alphabet — a base64url-encoded
      // signature must never be silently accepted as if it were standard base64.
      const result = await shopify.verify(
        {
          body: new Uint8Array(),
          headers: { 'x-shopify-hmac-sha256': 'AB-CD_EF12345678901234567890AB==' },
        },
        CREDS,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
    });
  });

  describe('coverage: branches not reachable through the normal happy/sad paths above', () => {
    it('verify() rejects a non-"secret" credentials type without throwing', async () => {
      const result = await shopify.verify(
        { body: new Uint8Array(), headers: { 'x-shopify-hmac-sha256': 'AAAA' } },
        { type: 'publicKey', publicKey: 'irrelevant' },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_signature');
    });

    it('sign() throws when given a non-"secret" credentials type', async () => {
      await expect(
        shopify.sign?.(new Uint8Array(), { type: 'publicKey', publicKey: 'irrelevant' }),
      ).rejects.toThrow('type "secret"');
    });
  });

  describe('§4.6-4.7 secret rotation', () => {
    it('4.6: accepts a secret from additionalSecrets', async () => {
      const newSecret = 'shopify_new_secret';
      const signer = createTestSigner(shopify, { type: 'secret', secret: newSecret });
      const signed = await signer.sign(JSON.stringify({ id: 123 }));
      const result = await shopify.verify(toReq(signed), CREDS, { additionalSecrets: [newSecret] });
      expect(result.ok).toBe(true);
    });

    it('4.7: rejects when all additionalSecrets candidates are wrong', async () => {
      const signer = createTestSigner(shopify, { type: 'secret', secret: 'the_actual_secret' });
      const signed = await signer.sign(JSON.stringify({ id: 123 }));
      const result = await shopify.verify(toReq(signed), CREDS, {
        additionalSecrets: ['wrong_one', 'wrong_two'],
      });
      expect(result.ok).toBe(false);
    });
  });
});
