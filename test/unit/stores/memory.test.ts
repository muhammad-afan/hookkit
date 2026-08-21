import { describe, expect, it } from 'vitest';
import { memoryStore } from '../../../src/stores/memory.js';

describe('memoryStore', () => {
  it('first claim succeeds, second claim of the same key fails', async () => {
    const store = memoryStore();
    expect(await store.claim('evt_1', 60)).toBe(true);
    expect(await store.claim('evt_1', 60)).toBe(false);
  });

  it('distinct keys claim independently', async () => {
    const store = memoryStore();
    expect(await store.claim('a', 60)).toBe(true);
    expect(await store.claim('b', 60)).toBe(true);
  });

  it('release() allows a subsequent claim to succeed again', async () => {
    const store = memoryStore();
    await store.claim('evt_1', 60);
    await store.release('evt_1');
    expect(await store.claim('evt_1', 60)).toBe(true);
  });

  it('a claim expires after its TTL', async () => {
    const store = memoryStore();
    await store.claim('evt_1', 0); // already-expired TTL of 0 seconds
    await new Promise((r) => setTimeout(r, 5));
    expect(await store.claim('evt_1', 60)).toBe(true);
  });

  it('does not let concurrent claims of the same key both win (the dedupe race)', async () => {
    const store = memoryStore();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.claim('evt_race', 60)),
    );
    const wins = results.filter(Boolean).length;
    expect(wins).toBe(1);
  });

  it('complete() is a no-op that does not throw when called after claim()', async () => {
    const store = memoryStore();
    await store.claim('evt_1', 60);
    await expect(store.complete?.('evt_1', 60)).resolves.toBeUndefined();
  });
});
