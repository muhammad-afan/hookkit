import { describe, expect, it } from 'vitest';
import type { WebhookRequest } from '../../../src/core/types.js';
import { discord, generateDiscordTestKeyPair } from '../../../src/providers/discord.js';
import { createTestSigner } from '../../../src/testing/index.js';
import { loadFixture } from '../../fixtures/loader.js';
import { runAdapterConformance } from '../../shared/conformance.js';

function toReq(signed: { body: Uint8Array; headers: Record<string, string> }): WebhookRequest {
  return { body: signed.body, headers: signed.headers };
}

runAdapterConformance(discord, loadFixture('discord', 'interaction-ping'), {
  otherFixtures: [
    loadFixture('stripe', 'checkout-completed'),
    loadFixture('github', 'pull-request-opened'),
    loadFixture('shopify', 'orders-create'),
    loadFixture('standard', 'user-created'),
    loadFixture('slack', 'app-mention-event'),
  ],
});

describe('discord adapter (Ed25519)', () => {
  it('5.10: accepts a validly signed Ed25519 request', async () => {
    const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
    const signer = createTestSigner(discord, {
      type: 'publicKey',
      publicKey: privateKeyForSigning,
    });
    const signed = await signer.sign(JSON.stringify({ id: 'interaction_1', type: 2 }));

    const result = await discord.verify(toReq(signed), { type: 'publicKey', publicKey });

    expect(result.ok).toBe(true);
  });

  it('extracts the interaction id from the JSON body', async () => {
    const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
    const signer = createTestSigner(discord, {
      type: 'publicKey',
      publicKey: privateKeyForSigning,
    });
    const signed = await signer.sign(JSON.stringify({ id: 'interaction_1', type: 2 }));

    expect(discord.extractEventId(toReq(signed))).toBe('interaction_1');
  });

  it('rejects a tampered body', async () => {
    const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
    const signer = createTestSigner(discord, {
      type: 'publicKey',
      publicKey: privateKeyForSigning,
    });
    const signed = await signer.sign(JSON.stringify({ id: 'interaction_1', type: 2 }));
    const tampered = {
      ...signed,
      body: new TextEncoder().encode(JSON.stringify({ id: 'interaction_2', type: 2 })),
    };

    const result = await discord.verify(toReq(tampered), { type: 'publicKey', publicKey });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_signature');
  });

  it('5.11: a valid signature under the WRONG public key is rejected', async () => {
    const keyPairA = await generateDiscordTestKeyPair();
    const keyPairB = await generateDiscordTestKeyPair();
    const signer = createTestSigner(discord, {
      type: 'publicKey',
      publicKey: keyPairA.privateKeyForSigning,
    });
    const signed = await signer.sign(JSON.stringify({ id: 'interaction_1', type: 2 }));

    const result = await discord.verify(toReq(signed), {
      type: 'publicKey',
      publicKey: keyPairB.publicKey,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_signature');
  });

  it('5.12: a publicKey that is not valid hex is a config error, thrown synchronously (not returned as ok:false)', async () => {
    const { privateKeyForSigning } = await generateDiscordTestKeyPair();
    const signer = createTestSigner(discord, {
      type: 'publicKey',
      publicKey: privateKeyForSigning,
    });
    const signed = await signer.sign(JSON.stringify({ id: 'interaction_1', type: 2 }));

    await expect(
      discord.verify(toReq(signed), { type: 'publicKey', publicKey: 'not-valid-hex-zzzz' }),
    ).rejects.toThrow(RangeError);
  });

  it('5.13: a PING (type 1) payload verifies exactly like any other — the adapter does not special-case it', async () => {
    const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
    const signer = createTestSigner(discord, {
      type: 'publicKey',
      publicKey: privateKeyForSigning,
    });
    // No explicit timestamp override — signed with "now", exactly like a real Discord
    // PING would be. Confirmed explicitly (not just assumed) against the tightened 60s
    // default: this must still pass, since a genuine PING always carries a fresh
    // timestamp.
    const signed = await signer.sign(JSON.stringify({ id: 'ping_1', type: 1 }));

    const result = await discord.verify(toReq(signed), { type: 'publicKey', publicKey });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.eventId).toBe('ping_1');
  });

  it('rejects when x-signature-ed25519 is missing', async () => {
    const result = await discord.verify(
      { body: new Uint8Array(), headers: { 'x-signature-timestamp': '1700000000' } },
      { type: 'publicKey', publicKey: 'aa'.repeat(32) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing_signature_header');
  });

  it('rejects when x-signature-timestamp is missing', async () => {
    const result = await discord.verify(
      { body: new Uint8Array(), headers: { 'x-signature-ed25519': 'aa'.repeat(64) } },
      { type: 'publicKey', publicKey: 'aa'.repeat(32) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing_signature_header');
  });

  it('rejects a non-hex signature header without throwing', async () => {
    const result = await discord.verify(
      {
        body: new Uint8Array(),
        headers: { 'x-signature-ed25519': 'zz-not-hex', 'x-signature-timestamp': '1700000000' },
      },
      { type: 'publicKey', publicKey: 'aa'.repeat(32) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
  });

  it('rejects a non-numeric timestamp header as malformed, not silently NaN-compared', async () => {
    const result = await discord.verify(
      {
        body: new Uint8Array(),
        headers: {
          'x-signature-ed25519': 'aa'.repeat(64),
          'x-signature-timestamp': 'not-a-number',
        },
      },
      { type: 'publicKey', publicKey: 'aa'.repeat(32) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed_signature_header');
  });

  it('throws synchronously if toleranceSeconds is 0', async () => {
    const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
    const signer = createTestSigner(discord, {
      type: 'publicKey',
      publicKey: privateKeyForSigning,
    });
    const signed = await signer.sign(JSON.stringify({ id: 'interaction_1', type: 2 }));

    await expect(
      discord.verify(toReq(signed), { type: 'publicKey', publicKey }, { toleranceSeconds: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects a timestamp outside the tolerance window (replay)', async () => {
    const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
    const signer = createTestSigner(discord, {
      type: 'publicKey',
      publicKey: privateKeyForSigning,
    });
    const stale = Math.floor(Date.now() / 1000) - 10_000;
    const signed = await signer.sign(JSON.stringify({ id: 'interaction_1', type: 2 }), {
      timestamp: stale,
    });

    const result = await discord.verify(toReq(signed), { type: 'publicKey', publicKey });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timestamp_out_of_tolerance');
  });

  describe('the 60s default tolerance (tighter than the 300s used elsewhere in this codebase)', () => {
    it('defaultToleranceSeconds is 60, not the 300s convention', () => {
      expect(discord.defaultToleranceSeconds).toBe(60);
    });

    it('accepts a timestamp exactly at the 60s boundary (inclusive)', async () => {
      const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
      const now = 1_700_000_000;
      const signer = createTestSigner(discord, {
        type: 'publicKey',
        publicKey: privateKeyForSigning,
      });
      const signed = await signer.sign(JSON.stringify({ id: 'interaction_1', type: 2 }), {
        timestamp: now - 60,
      });

      const result = await discord.verify(
        toReq(signed),
        { type: 'publicKey', publicKey },
        { now: () => now * 1000 },
      );

      expect(result.ok).toBe(true);
    });

    it('rejects a timestamp one second past the 60s boundary', async () => {
      const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
      const now = 1_700_000_000;
      const signer = createTestSigner(discord, {
        type: 'publicKey',
        publicKey: privateKeyForSigning,
      });
      const signed = await signer.sign(JSON.stringify({ id: 'interaction_1', type: 2 }), {
        timestamp: now - 61,
      });

      const result = await discord.verify(
        toReq(signed),
        { type: 'publicKey', publicKey },
        { now: () => now * 1000 },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('timestamp_out_of_tolerance');
    });

    it('a timestamp that would have passed under the old 300s default now correctly fails at 200s old', async () => {
      const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
      const now = 1_700_000_000;
      const signer = createTestSigner(discord, {
        type: 'publicKey',
        publicKey: privateKeyForSigning,
      });
      const signed = await signer.sign(JSON.stringify({ id: 'interaction_1', type: 2 }), {
        timestamp: now - 200,
      });

      const result = await discord.verify(
        toReq(signed),
        { type: 'publicKey', publicKey },
        { now: () => now * 1000 },
      );

      expect(result.ok).toBe(false);
    });

    it('remains overridable via VerifyOptions.toleranceSeconds like any other adapter', async () => {
      const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
      const now = 1_700_000_000;
      const signer = createTestSigner(discord, {
        type: 'publicKey',
        publicKey: privateKeyForSigning,
      });
      const signed = await signer.sign(JSON.stringify({ id: 'interaction_1', type: 2 }), {
        timestamp: now - 200,
      });

      const result = await discord.verify(
        toReq(signed),
        { type: 'publicKey', publicKey },
        {
          now: () => now * 1000,
          toleranceSeconds: 300,
        },
      );

      expect(result.ok).toBe(true);
    });
  });

  describe('§6.18 (critical replay test): the timestamp is part of the signed payload', () => {
    it('rewriting only the timestamp header breaks the signature', async () => {
      const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
      const now = 1_700_000_000;
      const signer = createTestSigner(discord, {
        type: 'publicKey',
        publicKey: privateKeyForSigning,
      });
      const signed = await signer.sign(JSON.stringify({ id: 'interaction_1', type: 2 }), {
        timestamp: now - 100,
      });

      const rewritten = { ...signed.headers, 'x-signature-timestamp': String(now) };
      const result = await discord.verify(
        { body: signed.body, headers: rewritten },
        { type: 'publicKey', publicKey },
        {
          now: () => now * 1000,
        },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_signature');
    });
  });

  describe('coverage: branches not reachable through the normal happy/sad paths above', () => {
    it('verify() rejects a non-"publicKey" credentials type without throwing', async () => {
      const result = await discord.verify(
        {
          body: new Uint8Array(),
          headers: {
            'x-signature-ed25519': 'aa'.repeat(64),
            'x-signature-timestamp': '1700000000',
          },
        },
        { type: 'secret', secret: 'irrelevant' },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_signature');
    });

    it('sign() throws when given a non-"publicKey" credentials type', async () => {
      await expect(
        discord.sign?.(new Uint8Array(), { type: 'secret', secret: 'irrelevant' }),
      ).rejects.toThrow('type "publicKey"');
    });

    it('sign() accepts a raw Uint8Array private key (not just a hex string)', async () => {
      const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
      const { hexToBytes } = await import('../../../src/core/encoding.js');
      const signer = createTestSigner(discord, {
        type: 'publicKey',
        publicKey: hexToBytes(privateKeyForSigning),
      });
      const signed = await signer.sign(JSON.stringify({ id: 'interaction_1', type: 2 }));

      const result = await discord.verify(toReq(signed), { type: 'publicKey', publicKey });
      expect(result.ok).toBe(true);
    });
  });
});
