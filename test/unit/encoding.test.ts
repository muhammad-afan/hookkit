import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  hexToBytes,
  toBytes,
  utf8ToBytes,
} from '../../src/core/encoding.js';

describe('encoding', () => {
  it('round-trips hex', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255]);
    expect(bytesToHex(bytes)).toBe('00010f10ff');
    expect(hexToBytes('00010f10ff')).toEqual(bytes);
  });

  it('rejects odd-length hex', () => {
    expect(() => hexToBytes('abc')).toThrow();
  });

  it('rejects invalid hex characters', () => {
    expect(() => hexToBytes('zz')).toThrow();
  });

  it('round-trips base64', () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]);
    const b64 = bytesToBase64(bytes);
    expect(b64).toBe('SGVsbG8=');
    expect(base64ToBytes(b64)).toEqual(bytes);
  });

  it('round-trips utf8', () => {
    const str = 'hello 世界';
    expect(bytesToUtf8(utf8ToBytes(str))).toBe(str);
  });

  it('toBytes normalizes string/Uint8Array/ArrayBuffer without re-encoding', () => {
    const str = 'raw-bytes-test';
    const fromString = toBytes(str);
    const fromBytes = toBytes(fromString);
    const fromBuffer = toBytes(fromString.buffer as ArrayBuffer);
    expect(fromString).toEqual(fromBytes);
    expect(fromString).toEqual(fromBuffer);
  });

  it('concatBytes joins chunks in order', () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4]);
    expect(concatBytes(a, b)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
