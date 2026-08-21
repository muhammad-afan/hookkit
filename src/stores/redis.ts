import type Redis from 'ioredis';
import type { IdempotencyStore } from '../core/types.js';

export interface RedisStoreConfig {
  /** An ioredis client (or Cluster) instance. ioredis is an optional peer dependency. */
  readonly client: Redis;
  /** Prefix applied to every key this store writes. Default: "hooksentinel:". */
  readonly keyPrefix?: string;
}

/**
 * Redis-backed idempotency store. Safe across multiple processes/instances.
 *
 * The claim is a single `SET key value NX EX ttl` call — one round trip, atomic on the
 * Redis server. This is deliberately NOT a GET-then-SET: that sequence is a classic
 * TOCTOU race that lets two concurrent duplicate deliveries both win the claim.
 */
export function redisStore(config: RedisStoreConfig): IdempotencyStore {
  const prefix = config.keyPrefix ?? 'hooksentinel:';
  const fullKey = (key: string): string => `${prefix}${key}`;

  return {
    async claim(key: string, ttlSeconds: number): Promise<boolean> {
      const result = await config.client.set(fullKey(key), '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    },
    async release(key: string): Promise<void> {
      await config.client.del(fullKey(key));
    },
    async complete(key: string, ttlSeconds: number): Promise<void> {
      await config.client.expire(fullKey(key), ttlSeconds);
    },
  };
}
