// Deno runtime smoke test — run against the BUILT package (dist/), not source. Run via:
//   deno run --allow-read test/runtime/smoke.deno.ts
// (after `pnpm build`; see .github/workflows/ci.yml's `runtimes` job).
//
// No `--allow-net` on purpose: everything here is local dist imports + crypto.subtle, so
// this deliberately avoids fetching a std-lib assertion module over the network. Plain
// assertions below instead.
//
// This is also where Discord's Ed25519 path gets verified outside Node, and it exercises
// the current 60s tolerance default (src/providers/discord.ts) rather than assuming the
// old 300s value.
import { toWebhookRequest } from '../../dist/index.js';
import { discord, generateDiscordTestKeyPair } from '../../dist/providers/discord.js';
import { stripe } from '../../dist/providers/stripe.js';
import { createTestSigner } from '../../dist/testing/index.js';

let failures = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`ok: ${message}`);
  }
}

async function run(): Promise<void> {
  {
    const signer = createTestSigner(stripe, { type: 'secret', secret: 'whsec_test_deno' });
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));
    const result = await stripe.verify(toWebhookRequest(signed), {
      type: 'secret',
      secret: 'whsec_test_deno',
    });
    assert(result.ok === true, 'stripe: a validly-signed HMAC-SHA256 payload verifies on Deno');
  }

  {
    const signer = createTestSigner(stripe, { type: 'secret', secret: 'whsec_test_deno' });
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));
    const tampered = {
      ...signed,
      body: new TextEncoder().encode('{"id":"evt_1","type":"tampered"}'),
    };
    const result = await stripe.verify(toWebhookRequest(tampered), {
      type: 'secret',
      secret: 'whsec_test_deno',
    });
    assert(result.ok === false, 'stripe: a tampered body is rejected on Deno');
  }

  {
    const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
    const signer = createTestSigner(discord, {
      type: 'publicKey',
      publicKey: privateKeyForSigning,
    });
    const signed = await signer.sign(JSON.stringify({ id: 'interaction_1', type: 2 }));
    const result = await discord.verify(toWebhookRequest(signed), { type: 'publicKey', publicKey });
    assert(result.ok === true, 'discord: Ed25519 verification works on Deno');
  }

  {
    const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
    const signer = createTestSigner(discord, {
      type: 'publicKey',
      publicKey: privateKeyForSigning,
    });
    const signed = await signer.sign(JSON.stringify({ id: 'ping_1', type: 1 }));
    const result = await discord.verify(toWebhookRequest(signed), { type: 'publicKey', publicKey });
    assert(
      result.ok === true,
      'discord: a PING (type 1) payload verifies with a fresh timestamp under the 60s default',
    );
  }

  {
    assert(discord.defaultToleranceSeconds === 60, 'discord: defaultToleranceSeconds is 60');
    const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
    const now = 1_700_000_000;
    const signer = createTestSigner(discord, {
      type: 'publicKey',
      publicKey: privateKeyForSigning,
    });
    const signed = await signer.sign(JSON.stringify({ id: 'interaction_2', type: 2 }), {
      timestamp: now - 60,
    });
    const result = await discord.verify(
      toWebhookRequest(signed),
      { type: 'publicKey', publicKey },
      { now: () => now * 1000 },
    );
    assert(result.ok === true, 'discord: a timestamp exactly at the 60s boundary verifies');
  }

  {
    const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
    const now = 1_700_000_000;
    const signer = createTestSigner(discord, {
      type: 'publicKey',
      publicKey: privateKeyForSigning,
    });
    const signed = await signer.sign(JSON.stringify({ id: 'interaction_3', type: 2 }), {
      timestamp: now - 61,
    });
    const result = await discord.verify(
      toWebhookRequest(signed),
      { type: 'publicKey', publicKey },
      { now: () => now * 1000 },
    );
    assert(result.ok === false, 'discord: a timestamp just past the 60s boundary is rejected');
  }

  if (failures > 0) {
    console.error(`\n${failures} smoke test(s) failed.`);
    Deno.exit(1);
  }
  console.log('\nAll Deno smoke tests passed.');
}

await run();
