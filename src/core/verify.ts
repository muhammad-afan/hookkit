import type {
  ProviderAdapter,
  VerifyOptions,
  VerifyResult,
  WebhookCredentials,
  WebhookRequest,
} from './types.js';

/** Low-level verification escape hatch — bypasses the receiver pipeline entirely. */
export async function verify(
  adapter: ProviderAdapter,
  req: WebhookRequest,
  credentials: WebhookCredentials,
  opts?: VerifyOptions,
): Promise<VerifyResult> {
  return adapter.verify(req, credentials, opts);
}
