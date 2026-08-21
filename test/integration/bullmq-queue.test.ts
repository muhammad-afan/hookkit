import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReceiver } from '../../src/core/receiver.js';
import { stripe } from '../../src/providers/stripe.js';
import { bullmqQueue, bullmqWorkerHandler, fromBullmqJobData } from '../../src/queues/bullmq.js';
import { memoryStore } from '../../src/stores/memory.js';
import { createTestSigner } from '../../src/testing/index.js';

const CREDS = { type: 'secret' as const, secret: 'whsec_bullmq_test' };

/**
 * Real Redis + real BullMQ, not mocks — matching this repo's established rule for
 * anything claim/queue-ordering sensitive (see redisStore's tests). A mock Queue could
 * hide a real serialization bug (raw bytes are Uint8Array, which does not survive
 * Redis's JSON encoding without the base64 round-trip bullmqQueue/fromBullmqJobData do).
 */
describe('bullmq queue handoff (CLAUDE.md §8)', () => {
  let container: StartedTestContainer;
  let connection: Redis;
  let queue: Queue;

  beforeAll(async () => {
    container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    connection = new Redis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
      maxRetriesPerRequest: null, // required by BullMQ
    });
    queue = new Queue('hooksentinel-test-webhooks', { connection });
  }, 60_000);

  afterAll(async () => {
    await queue.close();
    await connection.quit();
    await container.stop();
  });

  it('§8: claim → enqueue → ack — a successful enqueue acks 202 and the job data round-trips byte-for-byte', async () => {
    const store = memoryStore();
    const receiver = createReceiver({
      adapter: stripe,
      credentials: CREDS,
      idempotency: { store },
      enqueue: bullmqQueue({ queue }),
    });
    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_bullmq_1', type: 'x' }));

    const result = await receiver.handle({ body: signed.body, headers: signed.headers });

    expect(result.status).toBe('enqueued');
    if (result.status === 'enqueued') expect(result.httpStatus).toBe(202);

    // Drain the job directly and confirm the raw bytes survived the Redis round-trip
    // exactly — this is the whole reason bullmqQueue base64-encodes them.
    const jobs = await queue.getJobs(['waiting', 'active'], 0, 10);
    const job = jobs.find((j) => j.data.id === 'evt_bullmq_1');
    expect(job).toBeDefined();
    if (!job) throw new Error('unreachable');
    const event = fromBullmqJobData(job.data);
    expect(event.id).toBe('evt_bullmq_1');
    expect(event.provider).toBe('stripe');
    expect(Array.from(event.raw)).toEqual(Array.from(signed.body));
    expect(event.payload).toEqual({ id: 'evt_bullmq_1', type: 'x' });
  });

  it('§8: an enqueue failure releases the idempotency claim and returns 503 — proven by a subsequent successful retry, not just a call count', async () => {
    const store = memoryStore();
    const claimKeyEventId = 'evt_bullmq_fail_1';

    // A queue pointed at a connection that immediately fails — simulates a genuine
    // enqueue-time failure (e.g. Redis unreachable), not just a rejected promise.
    const brokenConnection = new Redis({
      host: '127.0.0.1',
      port: 1,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    const brokenQueue = new Queue('hooksentinel-test-broken', { connection: brokenConnection });

    const failingReceiver = createReceiver({
      adapter: stripe,
      credentials: CREDS,
      idempotency: { store },
      enqueue: bullmqQueue({ queue: brokenQueue }),
    });
    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: claimKeyEventId, type: 'x' }));
    const req = { body: signed.body, headers: signed.headers };

    const first = await failingReceiver.handle(req);
    expect(first.status).toBe('rejected');
    if (first.status === 'rejected') {
      expect(first.error.code).toBe('enqueue_error');
      expect(first.httpStatus).toBe(503);
    }
    await brokenQueue.close().catch(() => undefined);
    await brokenConnection.quit().catch(() => undefined);

    // Prove the claim was actually released: retry against the WORKING queue must
    // succeed as 'enqueued', not be suppressed as 'duplicate'.
    const retryReceiver = createReceiver({
      adapter: stripe,
      credentials: CREDS,
      idempotency: { store },
      enqueue: bullmqQueue({ queue }),
    });
    const retry = await retryReceiver.handle(req);
    expect(retry.status).toBe('enqueued');
  }, 20_000);

  it('bullmqWorkerHandler reconstructs a typed VerifiedEvent and hands it to the user handler', async () => {
    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_worker_1', type: 'worker_test' }));

    const workerQueue = new Queue('hooksentinel-test-worker', { connection });
    await workerQueue.add('webhook', {
      id: 'evt_worker_1',
      provider: 'stripe',
      payload: { id: 'evt_worker_1', type: 'worker_test' },
      rawBase64: Buffer.from(signed.body).toString('base64'),
      headers: signed.headers,
      timestamp: null,
      receivedAt: Date.now(),
    });

    const received: { id?: string; provider?: string } = {};
    const worker = new Worker(
      'hooksentinel-test-worker',
      bullmqWorkerHandler(async (event) => {
        received.id = event.id;
        received.provider = event.provider;
      }),
      { connection },
    );

    try {
      await new Promise<void>((resolve, reject) => {
        worker.on('completed', () => resolve());
        worker.on('failed', (_job, err) => reject(err));
        setTimeout(() => reject(new Error('worker did not process the job in time')), 8000);
      });
    } finally {
      await worker.close();
      await workerQueue.close();
    }

    expect(received).toEqual({ id: 'evt_worker_1', provider: 'stripe' });
  }, 15_000);
});
