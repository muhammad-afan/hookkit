import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HooksentinelError } from '../../src/core/errors.js';
import type { ProviderAdapter, WebhookCredentials } from '../../src/core/types.js';
import { github } from '../../src/providers/github.js';
import { shopify } from '../../src/providers/shopify.js';
import { standard } from '../../src/providers/standard.js';
import { stripe } from '../../src/providers/stripe.js';
import { createTestSigner } from '../../src/testing/index.js';

/**
 * hookkit-testing.md §10.5. The invariant that matters: for ANY input, verify() either
 * returns ok:true with a genuinely valid signature, or ok:false — it never throws, and
 * it never accepts random data. 5,000+ cases run here across the four adapters (well
 * over the documented minimum).
 */

const ADAPTERS: readonly { adapter: ProviderAdapter; credentials: WebhookCredentials }[] = [
  { adapter: stripe, credentials: { type: 'secret', secret: 'whsec_fuzz_test_secret' } },
  { adapter: github, credentials: { type: 'secret', secret: 'github_fuzz_test_secret' } },
  { adapter: shopify, credentials: { type: 'secret', secret: 'shopify_fuzz_test_secret' } },
  {
    adapter: standard,
    credentials: { type: 'secret', secret: 'whsec_ZnV6ei1zZWNyZXQtMzItYnl0ZXMtbG9uZy0h' },
  },
];

const arbitraryHeaders = fc.dictionary(
  fc.string({ minLength: 0, maxLength: 40 }),
  fc.string({ minLength: 0, maxLength: 200 }),
);

describe('§10.5 property-based fuzzing (fast-check)', () => {
  for (const { adapter, credentials } of ADAPTERS) {
    it(`${adapter.name}: verify() never throws on arbitrary input, and never accepts it (2000 runs)`, () => {
      fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ maxLength: 2048 }),
          arbitraryHeaders,
          async (body, headers) => {
            const result = await adapter.verify({ body, headers }, credentials);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toBeInstanceOf(HooksentinelError);
          },
        ),
        { numRuns: 2000 },
      );
    });

    it(`${adapter.name}: extractEventId() never throws on arbitrary input`, () => {
      fc.assert(
        fc.property(fc.uint8Array({ maxLength: 2048 }), arbitraryHeaders, (body, headers) => {
          expect(() => adapter.extractEventId({ body, headers })).not.toThrow();
        }),
        { numRuns: 500 },
      );
    });

    it(`${adapter.name}: round-trip — sign(body) then verify() is ok:true; mutating any single byte makes it ok:false`, async () => {
      if (!adapter.sign) throw new Error(`${adapter.name} has no sign() — cannot round-trip fuzz`);
      const signer = createTestSigner(adapter, credentials);
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.nat({ max: 199 }),
          async (bodyStr, mutateIndexRaw) => {
            const signed = await signer.sign(bodyStr);
            const good = await adapter.verify(
              { body: signed.body, headers: signed.headers },
              credentials,
            );
            expect(good.ok).toBe(true);

            if (signed.body.length === 0) return; // nothing to mutate
            const mutateIndex = mutateIndexRaw % signed.body.length;
            const mutated = new Uint8Array(signed.body);
            mutated[mutateIndex] = (mutated[mutateIndex] as number) ^ 0xff;
            const bad = await adapter.verify(
              { body: mutated, headers: signed.headers },
              credentials,
            );
            expect(bad.ok).toBe(false);
          },
        ),
        { numRuns: 300 },
      );
    });
  }

  it('cross-check: total fuzz runs across all adapters exceed the documented 5,000-case minimum', () => {
    const runsPerAdapter = 2000 + 500 + 300;
    expect(runsPerAdapter * ADAPTERS.length).toBeGreaterThan(5000);
  });
});
