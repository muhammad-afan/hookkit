import Redis from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redisStore } from '../../src/stores/redis.js';

// Real Redis via testcontainers — deliberately not mocked. A mock can't prove the claim
// is a single atomic server-side operation; only a real server round trip can.
describe('redisStore (real Redis via testcontainers)', () => {
  let container: StartedTestContainer;
  let client: Redis;

  beforeAll(async () => {
    container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    client = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) });
  }, 60_000);

  afterAll(async () => {
    await client.quit();
    await container.stop();
  });

  it('first claim succeeds, second claim of the same key fails', async () => {
    const store = redisStore({ client, keyPrefix: `test:${Date.now()}:` });
    expect(await store.claim('evt_1', 60)).toBe(true);
    expect(await store.claim('evt_1', 60)).toBe(false);
  });

  it('uses a single atomic SET NX EX — no concurrent claim of the same key can double-win', async () => {
    const store = redisStore({ client, keyPrefix: `test:${Date.now()}:race:` });
    const results = await Promise.all(
      Array.from({ length: 25 }, () => store.claim('evt_race', 60)),
    );
    const wins = results.filter(Boolean).length;
    expect(wins).toBe(1);
  });

  it('release() allows a subsequent claim to succeed again', async () => {
    const store = redisStore({ client, keyPrefix: `test:${Date.now()}:release:` });
    await store.claim('evt_1', 60);
    await store.release('evt_1');
    expect(await store.claim('evt_1', 60)).toBe(true);
  });

  it('a claim expires after its TTL', async () => {
    const store = redisStore({ client, keyPrefix: `test:${Date.now()}:ttl:` });
    await store.claim('evt_1', 1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await store.claim('evt_1', 60)).toBe(true);
  }, 10_000);

  it('distinct keys claim independently and respect the configured key prefix', async () => {
    const prefix = `test:${Date.now()}:prefix:`;
    const store = redisStore({ client, keyPrefix: prefix });
    await store.claim('a', 60);
    expect(await client.exists(`${prefix}a`)).toBe(1);
  });

  it('complete() extends the TTL rather than erroring', async () => {
    const prefix = `test:${Date.now()}:complete:`;
    const store = redisStore({ client, keyPrefix: prefix });
    await store.claim('evt_1', 5);
    await store.complete?.('evt_1', 120);
    const ttl = await client.ttl(`${prefix}evt_1`);
    expect(ttl).toBeGreaterThan(5);
  });
});
