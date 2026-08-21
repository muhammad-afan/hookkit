/** Encode/decode helpers between Uint8Array and hex/base64 strings. No dependencies. */

const HEX_CHARS = '0123456789abcdef';

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    out += HEX_CHARS[byte >> 4];
    out += HEX_CHARS[byte & 0x0f];
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0) {
    throw new Error('hexToBytes: input has odd length');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byteStr = clean.slice(i * 2, i * 2 + 2);
    const byte = Number.parseInt(byteStr, 16);
    if (Number.isNaN(byte)) {
      throw new Error(`hexToBytes: invalid hex sequence "${byteStr}"`);
    }
    out[i] = byte;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

export function utf8ToBytes(str: string): Uint8Array {
  return encoder.encode(str);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/**
 * Normalize a body-like input to Uint8Array without any re-encoding round trip.
 * Accepts string | Uint8Array | ArrayBuffer | Buffer-like (has a .buffer or is array-like).
 */
export function toBytes(input: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof input === 'string') {
    return utf8ToBytes(input);
  }
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  throw new TypeError('toBytes: unsupported input type');
}

export function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
