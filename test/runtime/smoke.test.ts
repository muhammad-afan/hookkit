// Bun runtime smoke test — run against the BUILT package (dist/), not source, since this
// is checking what a real Bun consumer would get after `npm install hookkit`. Run via:
//   bun test test/runtime/smoke.test.ts
// (after `pnpm build`; see .github/workflows/ci.yml's `runtimes` job).
//
// This is also where Discord's Ed25519 path gets verified outside Node — Bun has
// historically lagged on Ed25519 WebCrypto support (see CLAUDE.md §3.6), so this is a real
// compatibility check, not a formality. It also exercises the current 60s tolerance default
// (CLAUDE.md §3.6 / src/providers/discord.ts) rather than assuming the old 300s value.
import { expect, test } from 'bun:test';
import { toWebhookRequest } from '../../dist/index.js';
import { discord, generateDiscordTestKeyPair } from '../../dist/providers/discord.js';
import { stripe } from '../../dist/providers/stripe.js';
import { createTestSigner } from '../../dist/testing/index.js';

test('stripe: a validly-signed HMAC-SHA256 payload verifies on Bun', async () => {
  const signer = createTestSigner(stripe, { type: 'secret', secret: 'whsec_test_bun' });
  const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));
  const result = await stripe.verify(toWebhookRequest(signed), {
    type: 'secret',
    secret: 'whsec_test_bun',
  });
  expect(result.ok).toBe(true);
});

test('stripe: a tampered body is rejected on Bun', async () => {
  const signer = createTestSigner(stripe, { type: 'secret', secret: 'whsec_test_bun' });
  const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));
  const tampered = {
    ...signed,
    body: new TextEncoder().encode('{"id":"evt_1","type":"tampered"}'),
  };
  const result = await stripe.verify(toWebhookRequest(tampered), {
    type: 'secret',
    secret: 'whsec_test_bun',
  });
  expect(result.ok).toBe(false);
});

test('discord: Ed25519 verification works on Bun', async () => {
  const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
  const signer = createTestSigner(discord, { type: 'publicKey', publicKey: privateKeyForSigning });
  const signed = await signer.sign(JSON.stringify({ id: 'interaction_1', type: 2 }));
  const result = await discord.verify(toWebhookRequest(signed), { type: 'publicKey', publicKey });
  expect(result.ok).toBe(true);
});

test('discord: a PING (type 1) payload verifies like any other, with a fresh timestamp, under the 60s default', async () => {
  const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
  const signer = createTestSigner(discord, { type: 'publicKey', publicKey: privateKeyForSigning });
  const signed = await signer.sign(JSON.stringify({ id: 'ping_1', type: 1 }));
  const result = await discord.verify(toWebhookRequest(signed), { type: 'publicKey', publicKey });
  expect(result.ok).toBe(true);
});

test('discord: defaultToleranceSeconds is 60, and a timestamp inside it verifies', async () => {
  expect(discord.defaultToleranceSeconds).toBe(60);
  const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
  const now = 1_700_000_000;
  const signer = createTestSigner(discord, { type: 'publicKey', publicKey: privateKeyForSigning });
  const signed = await signer.sign(JSON.stringify({ id: 'interaction_2', type: 2 }), {
    timestamp: now - 60,
  });
  const result = await discord.verify(
    toWebhookRequest(signed),
    { type: 'publicKey', publicKey },
    { now: () => now * 1000 },
  );
  expect(result.ok).toBe(true);
});

test('discord: a timestamp just past the 60s boundary is rejected', async () => {
  const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
  const now = 1_700_000_000;
  const signer = createTestSigner(discord, { type: 'publicKey', publicKey: privateKeyForSigning });
  const signed = await signer.sign(JSON.stringify({ id: 'interaction_3', type: 2 }), {
    timestamp: now - 61,
  });
  const result = await discord.verify(
    toWebhookRequest(signed),
    { type: 'publicKey', publicKey },
    { now: () => now * 1000 },
  );
  expect(result.ok).toBe(false);
});
