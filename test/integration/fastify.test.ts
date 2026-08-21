import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hooksentinelFastify, hooksentinelFastifyRawBody } from '../../src/adapters/fastify.js';
import { createReceiver } from '../../src/core/receiver.js';
import { stripe } from '../../src/providers/stripe.js';
import { createTestSigner } from '../../src/testing/index.js';

const CREDS = { type: 'secret' as const, secret: 'whsec_fastify_test' };

// light-my-request (Fastify's inject() backend) only recognizes string/Buffer/stream
// payloads as raw bytes; a bare Uint8Array gets treated as a plain object and
// JSON-stringified, silently corrupting the signed bytes. Always wrap in Buffer.from().
function buildApp(onEvent: (event: unknown) => void): FastifyInstance {
  const app = Fastify();
  const receiver = createReceiver({ adapter: stripe, credentials: CREDS, onEvent });
  hooksentinelFastifyRawBody(app);
  app.post('/webhooks/stripe', hooksentinelFastify(receiver));
  return app;
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('hooksentinelFastify', () => {
  it('processes a validly signed request end-to-end', async () => {
    const onEvent = vi.fn();
    app = buildApp(onEvent);

    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', ...signed.headers },
      payload: Buffer.from(signed.body),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'processed', eventId: 'evt_1' });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects a tampered body with 400', async () => {
    const onEvent = vi.fn();
    app = buildApp(onEvent);

    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', ...signed.headers },
      payload: Buffer.from(JSON.stringify({ id: 'evt_TAMPERED', type: 'x' })),
    });

    expect(res.statusCode).toBe(400);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('produces a MissingRawBodyError (500) when hooksentinelFastifyRawBody was never registered', async () => {
    const onEvent = vi.fn();
    const bareApp = Fastify();
    const receiver = createReceiver({ adapter: stripe, credentials: CREDS, onEvent });
    bareApp.post('/webhooks/stripe', hooksentinelFastify(receiver));

    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));

    const res = await bareApp.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', ...signed.headers },
      payload: Buffer.from(signed.body),
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().message).toContain('hooksentinelFastifyRawBody');
    await bareApp.close();
  });

  it('keeps JSON parsing usable for other routes registered on the same instance', async () => {
    const onEvent = vi.fn();
    app = buildApp(onEvent);
    app.post('/echo', async (req) => req.body);

    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ hello: 'world' }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hello: 'world' });
  });
});
