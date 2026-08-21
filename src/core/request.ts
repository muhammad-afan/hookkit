import { toBytes } from './encoding.js';
import { PayloadTooLargeError } from './errors.js';
import type { WebhookRequest } from './types.js';

export const DEFAULT_MAX_BODY_BYTES = 1_000_000;

/** Lowercase all header names; join multi-value headers with ", ". */
export function normalizeHeaders(
  headers: Record<string, string | string[] | undefined> | Headers,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/**
 * Enforce the max body size guard. Must run BEFORE any hashing/HMAC work —
 * HMAC over an unbounded body is a CPU amplification vector.
 */
export function enforceMaxBodyBytes(bytes: Uint8Array, maxBodyBytes: number): void {
  if (bytes.length > maxBodyBytes) {
    throw new PayloadTooLargeError(maxBodyBytes);
  }
}

/** Build a WebhookRequest from raw parts (used by the Express/node adapters). */
export function toWebhookRequest(input: {
  readonly body: string | Uint8Array | ArrayBuffer;
  readonly headers: Record<string, string | string[] | undefined> | Headers;
  readonly url?: string | undefined;
  readonly method?: string | undefined;
  readonly maxBodyBytes?: number | undefined;
}): WebhookRequest {
  const body = toBytes(input.body);
  enforceMaxBodyBytes(body, input.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  return {
    body,
    headers: normalizeHeaders(input.headers),
    url: input.url,
    method: (input.method ?? 'POST').toUpperCase(),
  };
}

/** Build a WebhookRequest from a Fetch API Request (Next.js, Hono, Workers, Deno). */
export async function fromFetchRequest(
  request: Request,
  maxBodyBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<WebhookRequest> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      throw new PayloadTooLargeError(maxBodyBytes);
    }
  }
  const buf = await request.arrayBuffer();
  const body = new Uint8Array(buf);
  enforceMaxBodyBytes(body, maxBodyBytes);
  return {
    body,
    headers: normalizeHeaders(request.headers),
    url: request.url,
    method: request.method.toUpperCase(),
  };
}
