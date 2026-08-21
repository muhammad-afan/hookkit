import { describe, expect, it } from 'vitest';
import type { WebhookRequest } from '../../../src/core/types.js';
import { github } from '../../../src/providers/github.js';
import { createTestSigner } from '../../../src/testing/index.js';
import { loadFixture } from '../../fixtures/loader.js';
import { runAdapterConformance } from '../../shared/conformance.js';

const CREDS = { type: 'secret' as const, secret: 'github_app_secret' };

function toReq(signed: { body: Uint8Array; headers: Record<string, string> }): WebhookRequest {
  return { body: signed.body, headers: signed.headers };
}

runAdapterConformance(github, loadFixture('github', 'pull-request-opened'), {
  otherFixtures: [
    loadFixture('stripe', 'checkout-completed'),
    loadFixture('shopify', 'orders-create'),
    loadFixture('standard', 'user-created'),
  ],
});

runAdapterConformance(github, loadFixture('github', 'push'));

describe('github adapter', () => {
  it('accepts a validly signed request', async () => {
    const signer = createTestSigner(github, CREDS);
    const signed = await signer.sign(JSON.stringify({ action: 'opened' }));
    const result = await github.verify(toReq(signed), CREDS);
    expect(result.ok).toBe(true);
  });

  it('has no timestamp / replay tolerance', () => {
    expect(github.defaultToleranceSeconds).toBeNull();
  });

  it('extracts the event id from x-github-delivery', async () => {
    const signer = createTestSigner(github, CREDS);
    const signed = await signer.sign(JSON.stringify({ action: 'opened' }), {
      eventId: 'delivery-uuid-1',
    });
    expect(github.extractEventId(toReq(signed))).toBe('delivery-uuid-1');
  });

  it('rejects a tampered body', async () => {
    const signer = createTestSigner(github, CREDS);
    const signed = await signer.sign(JSON.stringify({ action: 'opened' }));
    const tampered = {
      ...signed,
      body: new TextEncoder().encode(JSON.stringify({ action: 'closed' })),
    };
    const result = await github.verify(toReq(tampered), CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_signature');
  });

  it('rejects when x-hub-signature-256 is missing', async () => {
    const result = await github.verify({ body: new Uint8Array(), headers: {} }, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing_signature_header');
  });

  it('rejects a header without the sha256= prefix', async () => {
    const result = await github.verify(
      { body: new Uint8Array(), headers: { 'x-hub-signature-256': 'deadbeef' } },
      CREDS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
  });

  it('ignores the legacy x-hub-signature (SHA-1) header entirely', async () => {
    const signer = createTestSigner(github, CREDS);
    const signed = await signer.sign(JSON.stringify({ action: 'opened' }));
    const req = {
      body: signed.body,
      headers: { ...signed.headers, 'x-hub-signature': 'sha1=irrelevant' },
    };
    const result = await github.verify(req, CREDS);
    expect(result.ok).toBe(true);
  });

  describe('§3.7 algorithm confusion', () => {
    it('a sha1= value placed in the sha256 header is rejected, never falls back to SHA-1', async () => {
      // Compute what would be a *valid* SHA-1 signature for this body, then present it
      // under the x-hub-signature-256 header with a sha1= prefix. If the adapter ever
      // fell back to SHA-1 verification when it saw that prefix, this would incorrectly
      // pass.
      const result = await github.verify(
        {
          body: new TextEncoder().encode('{"action":"opened"}'),
          headers: { 'x-hub-signature-256': 'sha1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        },
        CREDS,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
    });
  });

  describe('§3.10-3.14 header format edge cases', () => {
    it('3.10: uppercase hex is accepted (must decode, not string-compare)', async () => {
      const signer = createTestSigner(github, CREDS);
      const signed = await signer.sign(JSON.stringify({ action: 'opened' }));
      const header = signed.headers['x-hub-signature-256'] as string;
      const hex = header.slice('sha256='.length);
      const uppercased = `sha256=${hex.toUpperCase()}`;
      const result = await github.verify(
        { body: signed.body, headers: { 'x-hub-signature-256': uppercased } },
        CREDS,
      );
      expect(result.ok).toBe(true);
    });

    it('3.13: valid hex but wrong length is rejected without throwing', async () => {
      const result = await github.verify(
        {
          body: new TextEncoder().encode('{}'),
          headers: { 'x-hub-signature-256': 'sha256=abcd1234' },
        },
        CREDS,
      );
      expect(result.ok).toBe(false);
    });

    it('3.14: non-hex characters are malformed, not a throw', async () => {
      const result = await github.verify(
        {
          body: new TextEncoder().encode('{}'),
          headers: { 'x-hub-signature-256': 'sha256=not-hex-zzzz' },
        },
        CREDS,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
    });
  });

  describe('coverage: branches not reachable through the normal happy/sad paths above', () => {
    it('verify() rejects a non-"secret" credentials type without throwing', async () => {
      const result = await github.verify(
        { body: new Uint8Array(), headers: { 'x-hub-signature-256': 'sha256=deadbeef' } },
        { type: 'publicKey', publicKey: 'irrelevant' },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_signature');
    });

    it('sign() throws when given a non-"secret" credentials type', async () => {
      await expect(
        github.sign?.(new Uint8Array(), { type: 'publicKey', publicKey: 'irrelevant' }),
      ).rejects.toThrow('type "secret"');
    });
  });

  describe('§4.6-4.7 secret rotation', () => {
    it('4.6: accepts a secret from additionalSecrets', async () => {
      const newSecret = 'github_new_secret';
      const signer = createTestSigner(github, { type: 'secret', secret: newSecret });
      const signed = await signer.sign(JSON.stringify({ action: 'opened' }));
      const result = await github.verify(toReq(signed), CREDS, { additionalSecrets: [newSecret] });
      expect(result.ok).toBe(true);
    });

    it('4.7: rejects when all additionalSecrets candidates are wrong', async () => {
      const signer = createTestSigner(github, { type: 'secret', secret: 'the_actual_secret' });
      const signed = await signer.sign(JSON.stringify({ action: 'opened' }));
      const result = await github.verify(toReq(signed), CREDS, {
        additionalSecrets: ['wrong_one', 'wrong_two'],
      });
      expect(result.ok).toBe(false);
    });
  });
});
