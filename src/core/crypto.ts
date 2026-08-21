/**
 * WebCrypto-only primitives. Never import node:crypto — this file must run unmodified
 * on Node 22+, Bun, Deno, Cloudflare Workers, and Vercel Edge.
 */

export type HmacHash = 'SHA-1' | 'SHA-256' | 'SHA-512';

function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function importHmacKey(
  keyBytes: Uint8Array,
  hash: HmacHash,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    toBufferSource(keyBytes),
    { name: 'HMAC', hash },
    false,
    usages,
  );
}

/** Compute an HMAC digest. Used only where a signature must be produced (test signer), never for verification. */
export async function hmacSign(
  hash: HmacHash,
  keyBytes: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const key = await importHmacKey(keyBytes, hash, ['sign']);
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, toBufferSource(data));
  return new Uint8Array(sig);
}

/**
 * Verify an HMAC signature using subtle.verify, which compares in constant time internally.
 * This is the correct primitive — never subtle.sign() followed by a manual byte comparison.
 */
export async function hmacVerify(
  hash: HmacHash,
  keyBytes: Uint8Array,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const key = await importHmacKey(keyBytes, hash, ['verify']);
  return globalThis.crypto.subtle.verify(
    'HMAC',
    key,
    toBufferSource(signature),
    toBufferSource(data),
  );
}

/** SHA-256 digest, used for fallback idempotency keys (hash of the raw body). */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', toBufferSource(data));
  return new Uint8Array(digest);
}

/**
 * Verify an Ed25519 signature (Discord). `publicKeyBytes` must be the raw 32-byte
 * public key. Throws if the key bytes are not a valid Ed25519 public key — callers
 * should treat that as a configuration error, not a per-request verification failure.
 */
export async function ed25519Verify(
  publicKeyBytes: Uint8Array,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    toBufferSource(publicKeyBytes),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  return globalThis.crypto.subtle.verify(
    'Ed25519',
    key,
    toBufferSource(signature),
    toBufferSource(data),
  );
}

/**
 * Sign with an Ed25519 private key encoded as PKCS8. Test-signing only — WebCrypto
 * (at least in current Node) does not support importing a raw Ed25519 private key for
 * signing, only PKCS8. See `generateDiscordTestKeyPair()` in `hookforge/discord` for how
 * to produce a compatible keypair.
 */
export async function ed25519SignWithPkcs8(
  pkcs8Bytes: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    toBufferSource(pkcs8Bytes),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign('Ed25519', key, toBufferSource(data));
  return new Uint8Array(sig);
}
