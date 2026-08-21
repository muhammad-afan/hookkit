import { toBytes } from '../core/encoding.js';
import type { ProviderAdapter, TestSignOptions, WebhookCredentials } from '../core/types.js';

export interface SignedTestRequest {
  readonly body: Uint8Array;
  readonly headers: Record<string, string>;
}

export interface TestSigner {
  /** Sign a payload and return the exact { body, headers } pair a receiver expects. */
  sign(body: string | Uint8Array, opts?: TestSignOptions): Promise<SignedTestRequest>;
}

/**
 * Build a test signer for a given adapter and credentials. Produces real, validly-signed
 * requests without needing a live provider account — the backbone of every adapter test
 * and the recommended way to test your own webhook handlers locally.
 */
export function createTestSigner(
  adapter: ProviderAdapter,
  credentials: WebhookCredentials,
  defaults?: TestSignOptions,
): TestSigner {
  if (!adapter.sign) {
    throw new Error(
      `Adapter "${adapter.name}" does not implement sign() and cannot be used with createTestSigner.`,
    );
  }
  const sign = adapter.sign.bind(adapter);

  return {
    async sign(bodyInput: string | Uint8Array, opts?: TestSignOptions): Promise<SignedTestRequest> {
      const body = toBytes(bodyInput);
      const merged: TestSignOptions = { ...defaults, ...opts };
      const { headers } = await sign(body, credentials, merged);
      return { body, headers };
    },
  };
}
