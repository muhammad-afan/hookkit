import type { IdempotencyStore } from '../core/types.js';

/**
 * In-process idempotency store backed by a Map.
 *
 * The claim is atomic because JavaScript is single-threaded and `claim()` performs its
 * has-then-set check with no `await` in between — no other call can interleave mid-check.
 *
 * This is dev / single-instance only. State lives in process memory: it is lost on
 * restart and is NOT shared across multiple instances (e.g. multiple ECS tasks or
 * serverless invocations). Use `hookforge/stores/redis` or `hookforge/stores/prisma` for
 * anything running more than one instance.
 */
export function memoryStore(): IdempotencyStore {
  const expiresAt = new Map<string, number>();

  function isExpired(key: string): boolean {
    const exp = expiresAt.get(key);
    if (exp === undefined) return true;
    if (exp <= Date.now()) {
      expiresAt.delete(key);
      return true;
    }
    return false;
  }

  return {
    async claim(key: string, ttlSeconds: number): Promise<boolean> {
      if (!isExpired(key)) return false;
      expiresAt.set(key, Date.now() + ttlSeconds * 1000);
      return true;
    },
    async release(key: string): Promise<void> {
      expiresAt.delete(key);
    },
    async complete(key: string, ttlSeconds: number): Promise<void> {
      expiresAt.set(key, Date.now() + ttlSeconds * 1000);
    },
  };
}
