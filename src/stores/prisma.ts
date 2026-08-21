import type { IdempotencyStore } from '../core/types.js';

/**
 * Add this model to your own schema.prisma. The store below only ever calls
 * `create` and `delete` on it — hookforge never generates or migrates your schema.
 *
 * ```prisma
 * model ProcessedWebhookEvent {
 *   key       String   @id
 *   createdAt DateTime @default(now())
 *   expiresAt DateTime
 * }
 * ```
 *
 * Prisma/SQL rows don't expire on their own the way a Redis TTL does. `expiresAt` is
 * written for your own bookkeeping — if you want old rows actually removed, run a
 * periodic job: `prisma.processedWebhookEvent.deleteMany({ where: { expiresAt: { lt: new Date() } } })`.
 * Until you do, claims are effectively permanent, which is a safe (if storage-hungry)
 * default for exactly-once dedupe.
 */
export interface PrismaIdempotencyDelegate {
  create(args: { data: { key: string; expiresAt: Date } }): Promise<unknown>;
  delete(args: { where: { key: string } }): Promise<unknown>;
}

export interface PrismaStoreConfig {
  /**
   * The Prisma model delegate for the table above, e.g. `prisma.processedWebhookEvent`.
   * hookforge does not import `@prisma/client` — pass your own generated client's delegate,
   * whatever you named the model.
   */
  readonly delegate: PrismaIdempotencyDelegate;
}

interface PrismaErrorLike {
  readonly code?: unknown;
}

function hasPrismaCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as PrismaErrorLike).code === code;
}

/** Prisma unique-constraint violation — the claim already exists. This is the expected duplicate path, not a failure. */
function isUniqueConstraintViolation(err: unknown): boolean {
  return hasPrismaCode(err, 'P2002');
}

/** Prisma "record to delete does not exist" — release() on an already-expired/missing claim. Not an error. */
function isRecordNotFoundError(err: unknown): boolean {
  return hasPrismaCode(err, 'P2025');
}

/**
 * Prisma-backed idempotency store. Safe across multiple processes/instances.
 *
 * The claim is a single `INSERT` relying on the `@id` unique constraint on `key` —
 * never a `findUnique` followed by a `create`, which is a TOCTOU race. A duplicate
 * insert throws Prisma's `P2002` error, which this store catches and turns into a
 * normal "already claimed" result instead of propagating.
 *
 * For true exactly-once processing (not just at-least-once with dedupe), write your
 * claim and your business-logic side effect in the SAME Prisma transaction instead of
 * using this store at all:
 *
 * ```ts
 * async function handleStripeEvent(event: VerifiedEvent<Stripe.Event>) {
 *   try {
 *     await prisma.$transaction(async (tx) => {
 *       await tx.processedWebhookEvent.create({
 *         data: { key: `stripe:${event.id}`, expiresAt: new Date(Date.now() + 86_400_000) },
 *       });
 *       await tx.order.update({
 *         where: { id: event.payload.data.object.metadata.orderId },
 *         data: { status: 'paid' },
 *       });
 *     });
 *   } catch (err) {
 *     if (isUniqueConstraintViolation(err)) return; // already processed, nothing to do
 *     throw err;
 *   }
 * }
 * ```
 *
 * If the claim insert succeeds but the order update fails, the whole transaction rolls
 * back — including the claim — so a provider retry will see no claim and try again.
 * This is the one pattern that gets you real exactly-once semantics; the generic
 * `idempotency.store` config on `createReceiver` only gets you at-least-once-with-dedupe,
 * because the claim and your handler are two separate operations there.
 */
export function prismaStore(config: PrismaStoreConfig): IdempotencyStore {
  return {
    async claim(key: string, ttlSeconds: number): Promise<boolean> {
      try {
        await config.delegate.create({
          data: { key, expiresAt: new Date(Date.now() + ttlSeconds * 1000) },
        });
        return true;
      } catch (err) {
        if (isUniqueConstraintViolation(err)) return false;
        throw err;
      }
    },
    async release(key: string): Promise<void> {
      try {
        await config.delegate.delete({ where: { key } });
      } catch (err) {
        if (isRecordNotFoundError(err)) return;
        throw err;
      }
    },
  };
}
