import type { Job, Queue } from 'bullmq';
import { base64ToBytes, bytesToBase64 } from '../core/encoding.js';
import type { VerifiedEvent } from '../core/types.js';

/**
 * The JSON-serializable shape a `VerifiedEvent` is stored as in a BullMQ job — Redis
 * job data must be JSON-serializable, and `raw` is `Uint8Array`, which doesn't survive
 * `JSON.stringify` losslessly, so it's base64-encoded for the trip through the queue.
 */
export interface BullmqJobData<TPayload = unknown> {
  readonly id: string;
  readonly provider: string;
  readonly payload: TPayload;
  readonly rawBase64: string;
  readonly headers: Record<string, string>;
  readonly timestamp: number | null;
  readonly receivedAt: number;
}

export interface BullmqQueueConfig {
  readonly queue: Queue;
  /** BullMQ job name. Default: "webhook". */
  readonly jobName?: string;
}

function toJobData<TPayload>(event: VerifiedEvent<TPayload>): BullmqJobData<TPayload> {
  return {
    id: event.id,
    provider: event.provider,
    payload: event.payload,
    rawBase64: bytesToBase64(event.raw),
    headers: event.headers,
    timestamp: event.timestamp,
    receivedAt: event.receivedAt,
  };
}

/**
 * Wire into `createReceiver`'s `enqueue` option for the fast-ack + async-processing
 * pattern (internal build spec §8): `claim idempotency → enqueue → ack`. If the
 * queue.add() call throws, `createReceiver` releases the idempotency claim and returns
 * 503 itself — this function doesn't need to handle that; just let the rejection
 * propagate.
 *
 * @example
 * const receiver = createReceiver({
 *   adapter: stripe,
 *   credentials: { type: 'secret', secret },
 *   idempotency: { store: redisStore({ client: redis }) },
 *   enqueue: bullmqQueue({ queue: new Queue('webhooks', { connection: redis }) }),
 *   // onEvent is NOT called — createReceiver acks (202) immediately after enqueue.
 * });
 */
export function bullmqQueue<TPayload = unknown>(
  config: BullmqQueueConfig,
): (event: VerifiedEvent<TPayload>) => Promise<void> {
  const jobName = config.jobName ?? 'webhook';
  return async (event: VerifiedEvent<TPayload>): Promise<void> => {
    await config.queue.add(jobName, toJobData(event));
  };
}

/** Reconstructs a typed `VerifiedEvent` from BullMQ job data — the inverse of `bullmqQueue`'s encoding. */
export function fromBullmqJobData<TPayload = unknown>(
  data: BullmqJobData<TPayload>,
): VerifiedEvent<TPayload> {
  return {
    id: data.id,
    provider: data.provider,
    payload: data.payload,
    raw: base64ToBytes(data.rawBase64),
    headers: data.headers,
    timestamp: data.timestamp,
    receivedAt: data.receivedAt,
  };
}

/**
 * Wraps your handler as a BullMQ job processor, reconstructing the typed `VerifiedEvent`
 * from job data automatically.
 *
 * @example
 * new Worker('webhooks', bullmqWorkerHandler<Stripe.Event>(async (event) => {
 *   await handleStripeEvent(event.payload);
 * }), { connection: redis });
 */
export function bullmqWorkerHandler<TPayload = unknown>(
  handler: (event: VerifiedEvent<TPayload>) => void | Promise<void>,
): (job: Job<BullmqJobData<TPayload>>) => Promise<void> {
  return async (job: Job<BullmqJobData<TPayload>>): Promise<void> => {
    const event = fromBullmqJobData<TPayload>(job.data);
    await handler(event);
  };
}
