import { describe, expect, it } from 'vitest';
import type { PrismaIdempotencyDelegate } from '../../../src/stores/prisma.js';
import { prismaStore } from '../../../src/stores/prisma.js';

/**
 * A fake Prisma delegate that reproduces exactly the two error shapes the store depends
 * on: P2002 (unique constraint violation) from create(), and P2025 (record not found)
 * from delete(). Spinning up a real Postgres via testcontainers for this would mostly
 * be testing Prisma's own generated client, not hookkit's logic — the store's entire
 * contract is "catch these two error codes correctly," which this fake exercises exactly.
 */
function fakePrismaDelegate(): PrismaIdempotencyDelegate {
  const rows = new Map<string, { key: string; expiresAt: Date }>();
  return {
    async create(args) {
      if (rows.has(args.data.key)) {
        const err = new Error('Unique constraint failed on the fields: (`key`)');
        (err as unknown as { code: string }).code = 'P2002';
        throw err;
      }
      rows.set(args.data.key, { key: args.data.key, expiresAt: args.data.expiresAt });
      return rows.get(args.data.key);
    },
    async delete(args) {
      if (!rows.has(args.where.key)) {
        const err = new Error(
          'An operation failed because it depends on one or more records that were required but not found.',
        );
        (err as unknown as { code: string }).code = 'P2025';
        throw err;
      }
      const row = rows.get(args.where.key);
      rows.delete(args.where.key);
      return row;
    },
  };
}

describe('prismaStore', () => {
  it('first claim succeeds via create(); second claim of the same key fails via P2002', async () => {
    const store = prismaStore({ delegate: fakePrismaDelegate() });
    expect(await store.claim('evt_1', 60)).toBe(true);
    expect(await store.claim('evt_1', 60)).toBe(false);
  });

  it('does not call findUnique-then-create — a single create() call decides the outcome', async () => {
    const delegate = fakePrismaDelegate();
    let createCalls = 0;
    const wrapped: PrismaIdempotencyDelegate = {
      create: async (args) => {
        createCalls += 1;
        return delegate.create(args);
      },
      delete: (args) => delegate.delete(args),
    };
    const store = prismaStore({ delegate: wrapped });
    await store.claim('evt_1', 60);
    await store.claim('evt_1', 60);
    expect(createCalls).toBe(2); // both attempts go straight to create(); the second's P2002 IS the dedupe check
  });

  it('release() deletes the claim so a subsequent claim succeeds again', async () => {
    const store = prismaStore({ delegate: fakePrismaDelegate() });
    await store.claim('evt_1', 60);
    await store.release('evt_1');
    expect(await store.claim('evt_1', 60)).toBe(true);
  });

  it('release() on a non-existent claim (P2025) does not throw', async () => {
    const store = prismaStore({ delegate: fakePrismaDelegate() });
    await expect(store.release('never_claimed')).resolves.toBeUndefined();
  });

  it('propagates unexpected errors from create() (not P2002)', async () => {
    const delegate = fakePrismaDelegate();
    const wrapped: PrismaIdempotencyDelegate = {
      create: async () => {
        throw new Error('connection refused');
      },
      delete: (args) => delegate.delete(args),
    };
    const store = prismaStore({ delegate: wrapped });
    await expect(store.claim('evt_1', 60)).rejects.toThrow('connection refused');
  });

  it('propagates unexpected errors from delete() (not P2025)', async () => {
    const delegate = fakePrismaDelegate();
    const wrapped: PrismaIdempotencyDelegate = {
      create: (args) => delegate.create(args),
      delete: async () => {
        throw new Error('connection refused');
      },
    };
    const store = prismaStore({ delegate: wrapped });
    await store.claim('evt_1', 60);
    await expect(store.release('evt_1')).rejects.toThrow('connection refused');
  });

  it('claim() writes an expiresAt in the future based on ttlSeconds', async () => {
    const delegate = fakePrismaDelegate();
    let capturedExpiresAt: Date | undefined;
    const wrapped: PrismaIdempotencyDelegate = {
      create: async (args) => {
        capturedExpiresAt = args.data.expiresAt;
        return delegate.create(args);
      },
      delete: (args) => delegate.delete(args),
    };
    const store = prismaStore({ delegate: wrapped });
    const before = Date.now();
    await store.claim('evt_1', 100);
    expect(capturedExpiresAt).toBeDefined();
    expect((capturedExpiresAt as Date).getTime()).toBeGreaterThan(before + 99_000);
  });
});
