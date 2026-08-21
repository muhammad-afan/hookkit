import { hmacVerify } from '../core/crypto.js';
import type { HmacHash } from '../core/crypto.js';
import { utf8ToBytes } from '../core/encoding.js';

/** Normalize a secret credential (string or bytes) to raw UTF-8 bytes, as-is — no decoding. */
export function secretToRawBytes(secret: string | Uint8Array): Uint8Array {
  return typeof secret === 'string' ? utf8ToBytes(secret) : secret;
}

/**
 * Try the primary secret, then each of additionalSecrets in order, until one verifies.
 * Supports zero-downtime secret rotation. Each candidate is passed through `deriveKeyBytes`
 * so callers (e.g. Standard Webhooks, which base64-decodes the secret) control key derivation.
 */
export async function hmacVerifyWithRotation(params: {
  readonly hash: HmacHash;
  readonly primary: string | Uint8Array;
  readonly additional?: readonly (string | Uint8Array)[] | undefined;
  readonly signature: Uint8Array;
  readonly data: Uint8Array;
  readonly deriveKeyBytes?: ((secret: string | Uint8Array) => Uint8Array) | undefined;
}): Promise<boolean> {
  const derive = params.deriveKeyBytes ?? secretToRawBytes;
  const candidates = [params.primary, ...(params.additional ?? [])];
  for (const candidate of candidates) {
    let keyBytes: Uint8Array;
    try {
      keyBytes = derive(candidate);
    } catch {
      // A malformed secret (e.g. invalid base64) simply never matches — it must not crash verify().
      continue;
    }
    const ok = await hmacVerify(params.hash, keyBytes, params.signature, params.data);
    if (ok) return true;
  }
  return false;
}

export function randomEventId(prefix: string): string {
  return `${prefix}${globalThis.crypto.randomUUID()}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Extract a string field from a minimal, best-effort JSON parse. Returns null on any failure. */
export function extractJsonStringField(body: Uint8Array, field: string): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(body);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}
