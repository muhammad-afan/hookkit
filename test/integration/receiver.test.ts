import { describe, expect, it, vi } from 'vitest';
import { createReceiver } from '../../src/core/receiver.js';
import type { IdempotencyStore, WebhookRequest } from '../../src/core/types.js';
import { github } from '../../src/providers/github.js';
import { stripe } from '../../src/providers/stripe.js';
import { memoryStore } from '../../src/stores/memory.js';
import { createTestSigner } from '../../src/testing/index.js';

const CREDS = { type: 'secret' as const, secret: 'whsec_receiver_test' };

async function signedRequest(body: unknown): Promise<WebhookRequest> {
  const signer = createTestSigner(stripe, CREDS);
  const signed = await signer.sign(JSON.stringify(body));
  return { body: signed.body, headers: signed.headers };
}

describe('createReceiver — end-to-end pipeline', () => {
  it('verifies, parses, and calls onEvent for a valid Stripe webhook', async () => {
    const onEvent = vi.fn();
    const receiver = createReceiver({ adapter: stripe, credentials: CREDS, onEvent });
    const req = await signedRequest({ id: 'evt_1', type: 'checkout.session.completed' });

    const result = await receiver.handle(req);

    expect(result.status).toBe('processed');
    expect(onEvent).toHaveBeenCalledTimes(1);
    const event = onEvent.mock.calls[0]?.[0];
    expect(event.id).toBe('evt_1');
    expect(event.provider).toBe('stripe');
    expect(event.payload).toEqual({ id: 'evt_1', type: 'checkout.session.completed' });
  });

  it('rejects a tampered body with 400 and does not call onEvent', async () => {
    const onEvent = vi.fn();
    const receiver = createReceiver({ adapter: stripe, credentials: CREDS, onEvent });
    const req = await signedRequest({ id: 'evt_1', type: 'x' });
    const tampered = {
      ...req,
      body: new TextEncoder().encode(JSON.stringify({ id: 'evt_2', type: 'x' })),
    };

    const result = await receiver.handle(tampered);

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.httpStatus).toBe(400);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('deduplicates a second delivery of the same event id', async () => {
    const onEvent = vi.fn();
    const store = memoryStore();
    const receiver = createReceiver({
      adapter: stripe,
      credentials: CREDS,
      idempotency: { store },
      onEvent,
    });
    const req = await signedRequest({ id: 'evt_dup', type: 'x' });

    const first = await receiver.handle(req);
    const second = await receiver.handle(req);

    expect(first.status).toBe('processed');
    expect(second.status).toBe('duplicate');
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('handles concurrent duplicate deliveries — only one caller processes the event', async () => {
    const onEvent = vi.fn();
    const store = memoryStore();
    const receiver = createReceiver({
      adapter: stripe,
      credentials: CREDS,
      idempotency: { store },
      onEvent,
    });
    const req = await signedRequest({ id: 'evt_concurrent', type: 'x' });

    const results = await Promise.all(Array.from({ length: 10 }, () => receiver.handle(req)));

    const processed = results.filter((r) => r.status === 'processed');
    const duplicates = results.filter((r) => r.status === 'duplicate');
    expect(processed).toHaveLength(1);
    expect(duplicates).toHaveLength(9);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('onHandlerError "release" (default): releases the claim so a retry can be processed', async () => {
    const store = memoryStore();
    let attempts = 0;
    const onEvent = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient failure');
    });
    const receiver = createReceiver({
      adapter: stripe,
      credentials: CREDS,
      idempotency: { store },
      onEvent,
    });
    const req = await signedRequest({ id: 'evt_retry', type: 'x' });

    const first = await receiver.handle(req);
    expect(first.status).toBe('rejected');
    if (first.status === 'rejected') {
      expect(first.error.code).toBe('handler_error');
      expect(first.httpStatus).toBe(500);
    }

    const retry = await receiver.handle(req);
    expect(retry.status).toBe('processed');
    expect(attempts).toBe(2);
  });

  it('onHandlerError "keep": suppresses the retry as a duplicate, permanently', async () => {
    const store = memoryStore();
    const onEvent = vi.fn(async () => {
      throw new Error('permanent failure');
    });
    const receiver = createReceiver({
      adapter: stripe,
      credentials: CREDS,
      idempotency: { store },
      onEvent,
      onHandlerError: 'keep',
    });
    const req = await signedRequest({ id: 'evt_keep', type: 'x' });

    const first = await receiver.handle(req);
    expect(first.status).toBe('rejected');

    const retry = await receiver.handle(req);
    expect(retry.status).toBe('duplicate');
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects with 413 when the body exceeds maxBodyBytes, before any hashing/HMAC work', async () => {
    const receiver = createReceiver({ adapter: stripe, credentials: CREDS, maxBodyBytes: 10 });
    const req = await signedRequest({ id: 'evt_1', type: 'a-much-longer-payload-than-ten-bytes' });

    const result = await receiver.handle(req);

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.httpStatus).toBe(413);
      expect(result.error.code).toBe('payload_too_large');
    }
  });

  it('returns a ParseError and releases the claim when the verified body is not valid JSON', async () => {
    const store = memoryStore();
    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign('not-json{{{');
    const receiver = createReceiver({
      adapter: stripe,
      credentials: CREDS,
      idempotency: { store },
    });

    const result = await receiver.handle({ body: signed.body, headers: signed.headers });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.error.code).toBe('parse_error');
  });

  it('default parse strips __proto__ / constructor / prototype keys (pollution guard)', async () => {
    const onEvent = vi.fn();
    const receiver = createReceiver({ adapter: stripe, credentials: CREDS, onEvent });
    // Written as a raw JSON string — an object *literal* with a "__proto__" key sets the
    // prototype instead of an own property, which would never exercise JSON.parse's reviver.
    const rawJson = '{"id":"evt_1","__proto__":{"polluted":true},"constructor":{"evil":true}}';
    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(rawJson);

    await receiver.handle({ body: signed.body, headers: signed.headers });

    const payload = onEvent.mock.calls[0]?.[0].payload as Record<string, unknown>;
    expect(Object.hasOwn(payload, '__proto__')).toBe(false);
    expect(Object.hasOwn(payload, 'constructor')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('falls back to a body-hash id when the provider sends no event id', async () => {
    const onEvent = vi.fn();
    const receiver = createReceiver({
      adapter: github,
      credentials: { type: 'secret', secret: 's' },
      onEvent,
    });
    const signer = createTestSigner(github, { type: 'secret', secret: 's' });
    const signed = await signer.sign(JSON.stringify({ action: 'opened' }));
    const { 'x-github-delivery': _drop, ...headersWithoutId } = signed.headers;

    const result = await receiver.handle({ body: signed.body, headers: headersWithoutId });

    expect(result.status).toBe('processed');
    if (result.status === 'processed') expect(result.eventId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('idempotency store failure with onStoreError "fail" (default) rejects with 503', async () => {
    const failingStore: IdempotencyStore = {
      claim: vi.fn(async () => {
        throw new Error('redis down');
      }),
      release: vi.fn(async () => undefined),
    };
    const receiver = createReceiver({
      adapter: stripe,
      credentials: CREDS,
      idempotency: { store: failingStore },
    });
    const req = await signedRequest({ id: 'evt_1', type: 'x' });

    const result = await receiver.handle(req);

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.httpStatus).toBe(503);
      expect(result.error.code).toBe('idempotency_store_error');
    }
  });

  it('idempotency store failure with onStoreError "allow" processes anyway', async () => {
    const onEvent = vi.fn();
    const failingStore: IdempotencyStore = {
      claim: vi.fn(async () => {
        throw new Error('redis down');
      }),
      release: vi.fn(async () => undefined),
    };
    const receiver = createReceiver({
      adapter: stripe,
      credentials: CREDS,
      idempotency: { store: failingStore, onStoreError: 'allow' },
      onEvent,
    });
    const req = await signedRequest({ id: 'evt_1', type: 'x' });

    const result = await receiver.handle(req);

    expect(result.status).toBe('processed');
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('enqueue mode acks with 202 and does not call onEvent', async () => {
    const enqueue = vi.fn();
    const onEvent = vi.fn();
    const receiver = createReceiver({ adapter: stripe, credentials: CREDS, enqueue, onEvent });
    const req = await signedRequest({ id: 'evt_1', type: 'x' });

    const result = await receiver.handle(req);

    expect(result.status).toBe('enqueued');
    if (result.status === 'enqueued') expect(result.httpStatus).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('fetch() adapts a Fetch API Request into the same pipeline', async () => {
    const onEvent = vi.fn();
    const receiver = createReceiver({ adapter: stripe, credentials: CREDS, onEvent });
    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));

    const request = new Request('https://example.com/webhooks/stripe', {
      method: 'POST',
      headers: signed.headers,
      body: signed.body as BodyInit,
    });

    const response = await receiver.fetch(request);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ status: 'processed', eventId: 'evt_1' });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('calls onError for every rejection, with the original request', async () => {
    const onError = vi.fn();
    const receiver = createReceiver({ adapter: stripe, credentials: CREDS, onError });

    await receiver.handle({ body: new Uint8Array(), headers: {} });

    expect(onError).toHaveBeenCalledTimes(1);
    const [error, req] = onError.mock.calls[0] as [Error, WebhookRequest];
    expect(error.message).toBeTruthy();
    expect(req.headers).toEqual({});
  });

  it('8.6: calls onDuplicate with the event id when a delivery is suppressed', async () => {
    const store = memoryStore();
    const onDuplicate = vi.fn();
    const receiver = createReceiver({
      adapter: stripe,
      credentials: CREDS,
      idempotency: { store },
      onDuplicate,
    });
    const req = await signedRequest({ id: 'evt_dup_cb', type: 'x' });

    await receiver.handle(req);
    await receiver.handle(req);

    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledWith('evt_dup_cb');
  });

  it('calls onError (in addition to returning the rejected result) when the handler throws', async () => {
    const onError = vi.fn();
    const onEvent = vi.fn(async () => {
      throw new Error('handler blew up');
    });
    const receiver = createReceiver({ adapter: stripe, credentials: CREDS, onEvent, onError });
    const req = await signedRequest({ id: 'evt_1', type: 'x' });

    await receiver.handle(req);

    expect(onError).toHaveBeenCalledTimes(1);
    const [error] = onError.mock.calls[0] as [Error];
    expect(error.message).toContain('threw');
  });

  it('§8 ordering guarantee: enqueue() throwing releases the claim and rejects with 503 (EnqueueError), so the provider retries', async () => {
    const store = memoryStore();
    const enqueue = vi.fn(async () => {
      throw new Error('queue unavailable');
    });
    const receiver = createReceiver({
      adapter: stripe,
      credentials: CREDS,
      idempotency: { store },
      enqueue,
    });
    const req = await signedRequest({ id: 'evt_enqueue_fail', type: 'x' });

    const first = await receiver.handle(req);
    expect(first.status).toBe('rejected');
    if (first.status === 'rejected') {
      expect(first.error.code).toBe('enqueue_error');
      expect(first.httpStatus).toBe(503);
      expect(first.error.retryable).toBe(true);
    }

    // The claim is ALWAYS released on enqueue failure (unlike onEvent's
    // onHandlerError:'keep' option) — a queue outage isn't a business-logic bug, so a
    // retry is processed rather than suppressed as a duplicate.
    const enqueueOk = vi.fn(async () => undefined);
    const retryReceiver = createReceiver({
      adapter: stripe,
      credentials: CREDS,
      idempotency: { store },
      enqueue: enqueueOk,
    });
    const retry = await retryReceiver.handle(req);
    expect(retry.status).toBe('enqueued');
  });

  it('§8: the claim is released on enqueue failure even when onHandlerError is "keep" — enqueue failures are never treated as a kept business-logic failure', async () => {
    const store = memoryStore();
    const enqueue = vi.fn(async () => {
      throw new Error('queue unavailable');
    });
    const receiver = createReceiver({
      adapter: stripe,
      credentials: CREDS,
      idempotency: { store },
      enqueue,
      onHandlerError: 'keep',
    });
    const req = await signedRequest({ id: 'evt_enqueue_fail_keep', type: 'x' });

    const first = await receiver.handle(req);
    expect(first.status).toBe('rejected');

    const enqueueOk = vi.fn(async () => undefined);
    const retryReceiver = createReceiver({
      adapter: stripe,
      credentials: CREDS,
      idempotency: { store },
      enqueue: enqueueOk,
      onHandlerError: 'keep',
    });
    const retry = await retryReceiver.handle(req);
    expect(retry.status).toBe('enqueued');
  });

  it('calls onError when enqueue() throws (the enqueue path has its own onError call site, distinct from onEvent)', async () => {
    const onError = vi.fn();
    const enqueue = vi.fn(async () => {
      throw new Error('queue unavailable');
    });
    const receiver = createReceiver({ adapter: stripe, credentials: CREDS, enqueue, onError });
    const req = await signedRequest({ id: 'evt_1', type: 'x' });

    await receiver.handle(req);

    expect(onError).toHaveBeenCalledTimes(1);
    const [error] = onError.mock.calls[0] as [Error];
    expect(error.message).toContain('queue');
  });

  it('honours a custom clock passed via verify.now, not just the default Date.now', async () => {
    const now = 1_700_000_000;
    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }), {
      timestamp: now - 100,
    });
    const onEvent = vi.fn();
    const receiver = createReceiver({
      adapter: stripe,
      credentials: CREDS,
      onEvent,
      verify: { now: () => now * 1000 },
    });

    const result = await receiver.handle({ body: signed.body, headers: signed.headers });

    expect(result.status).toBe('processed');
    const event = onEvent.mock.calls[0]?.[0] as { receivedAt: number };
    expect(event.receivedAt).toBe(now * 1000);
  });

  it('fetch() formats a rejected verification as a JSON error response with the correct status', async () => {
    const receiver = createReceiver({ adapter: stripe, credentials: CREDS });

    const request = new Request('https://example.com/webhooks/stripe', {
      method: 'POST',
      headers: {},
      body: '{}',
    });

    const response = await receiver.fetch(request);
    const json = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('missing_signature_header');
    expect(json.error.message).toBeTruthy();
  });
});
