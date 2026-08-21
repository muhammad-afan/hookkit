import { describe, expect, it } from 'vitest';
import type { ProviderAdapter, WebhookRequest } from '../../src/core/types.js';
import type { LoadedFixture } from '../fixtures/loader.js';

export interface ConformanceOptions {
  /**
   * Real, validly-signed fixtures from OTHER providers. Proves this adapter's verify()
   * doesn't accidentally accept another provider's header shape (hooksentinel-testing.md §3.4,
   * "rejects a signature from a different provider").
   */
  readonly otherFixtures?: readonly LoadedFixture[];
}

/**
 * The shared conformance baseline every adapter must pass (hooksentinel-testing.md §3.4).
 * Adding a provider means: write the adapter, drop in one fixture, call this. Keeps
 * contributor PRs cheap and keeps every adapter honest against the same bar.
 */
export function runAdapterConformance(
  adapter: ProviderAdapter,
  fixture: LoadedFixture,
  opts: ConformanceOptions = {},
): void {
  describe(`${adapter.name} conformance`, () => {
    const frozenNow =
      fixture.expected.timestamp !== null
        ? () => (fixture.expected.timestamp as number) * 1000
        : undefined;
    const verifyOpts = frozenNow ? { now: frozenNow } : undefined;

    function toReq(overrides: Partial<WebhookRequest> = {}): WebhookRequest {
      return {
        body: fixture.body,
        headers: fixture.headers,
        url: fixture.url,
        method: fixture.method,
        ...overrides,
      };
    }

    it(`accepts a known-good ${fixture.synthetic ? 'synthetic' : 'recorded'} delivery`, async () => {
      const result = await adapter.verify(toReq(), fixture.credentials, verifyOpts);
      expect(result.ok).toBe(true);
      if (result.ok && fixture.expected.timestamp !== null) {
        expect(result.timestamp).toBe(fixture.expected.timestamp);
      }
    });

    it('rejects a single flipped byte in the body', async () => {
      const tampered = new Uint8Array(fixture.body);
      tampered[0] = (tampered[0] ?? 0) ^ 0xff;
      const result = await adapter.verify(
        toReq({ body: tampered }),
        fixture.credentials,
        verifyOpts,
      );
      expect(result.ok).toBe(false);
    });

    it('rejects a wrong secret', async () => {
      if (fixture.credentials.type !== 'secret') return;
      const wrongCreds = { type: 'secret' as const, secret: 'definitely-the-wrong-secret-value' };
      const result = await adapter.verify(toReq(), wrongCreds, verifyOpts);
      expect(result.ok).toBe(false);
    });

    it('rejects a missing signature header', async () => {
      const headers = { ...fixture.headers };
      for (const header of adapter.requiredHeaders) delete headers[header];
      const result = await adapter.verify(toReq({ headers }), fixture.credentials, verifyOpts);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('missing_signature_header');
    });

    it('rejects an empty signature header', async () => {
      const headers = { ...fixture.headers };
      for (const header of adapter.requiredHeaders) headers[header] = '';
      const result = await adapter.verify(toReq({ headers }), fixture.credentials, verifyOpts);
      expect(result.ok).toBe(false);
    });

    it('rejects a truncated signature', async () => {
      const sigHeaderName = adapter.requiredHeaders[adapter.requiredHeaders.length - 1] as string;
      const headers = { ...fixture.headers };
      const original = headers[sigHeaderName] ?? '';
      headers[sigHeaderName] = original.slice(0, Math.floor(original.length / 2));
      const result = await adapter.verify(toReq({ headers }), fixture.credentials, verifyOpts);
      expect(result.ok).toBe(false);
    });

    if (opts.otherFixtures?.length) {
      it('rejects a signature from a different provider', async () => {
        for (const other of opts.otherFixtures ?? []) {
          const result = await adapter.verify(
            { body: other.body, headers: other.headers, url: other.url, method: other.method },
            fixture.credentials,
            verifyOpts,
          );
          expect(result.ok).toBe(false);
        }
      });
    }

    it('extracts a stable event id', () => {
      if (fixture.expected.eventId === null) return;
      expect(adapter.extractEventId(toReq())).toBe(fixture.expected.eventId);
    });

    it('never throws — always returns a VerifyResult', async () => {
      const garbageInputs: WebhookRequest[] = [
        { body: new Uint8Array(), headers: {} },
        { body: fixture.body, headers: {} },
        {
          body: new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
          headers: Object.fromEntries(
            adapter.requiredHeaders.map((h) => [h, 'not-a-real-signature']),
          ),
        },
      ];
      for (const req of garbageInputs) {
        const result = await adapter.verify(req, fixture.credentials, verifyOpts);
        expect(result.ok).toBe(false);
      }
    });
  });
}
