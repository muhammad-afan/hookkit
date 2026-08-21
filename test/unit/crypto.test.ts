import { describe, expect, it } from 'vitest';
import { hmacSign, hmacVerify, sha256 } from '../../src/core/crypto.js';
import { utf8ToBytes } from '../../src/core/encoding.js';

describe('crypto', () => {
  it('hmacVerify accepts a signature produced by hmacSign', async () => {
    const key = utf8ToBytes('secret-key');
    const data = utf8ToBytes('payload-bytes');
    const sig = await hmacSign('SHA-256', key, data);
    expect(await hmacVerify('SHA-256', key, sig, data)).toBe(true);
  });

  it('hmacVerify rejects a tampered payload', async () => {
    const key = utf8ToBytes('secret-key');
    const sig = await hmacSign('SHA-256', key, utf8ToBytes('original'));
    expect(await hmacVerify('SHA-256', key, sig, utf8ToBytes('tampered'))).toBe(false);
  });

  it('hmacVerify rejects the wrong key', async () => {
    const data = utf8ToBytes('payload-bytes');
    const sig = await hmacSign('SHA-256', utf8ToBytes('key-a'), data);
    expect(await hmacVerify('SHA-256', utf8ToBytes('key-b'), sig, data)).toBe(false);
  });

  it('supports SHA-1 and SHA-512', async () => {
    const key = utf8ToBytes('k');
    const data = utf8ToBytes('d');
    for (const hash of ['SHA-1', 'SHA-512'] as const) {
      const sig = await hmacSign(hash, key, data);
      expect(await hmacVerify(hash, key, sig, data)).toBe(true);
    }
  });

  it('sha256 is deterministic', async () => {
    const data = utf8ToBytes('hello');
    const a = await sha256(data);
    const b = await sha256(data);
    expect(a).toEqual(b);
  });
});
