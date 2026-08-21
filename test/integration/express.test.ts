import express from 'express';
import type { Express } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expressWebhook } from '../../src/adapters/express.js';
import { createReceiver } from '../../src/core/receiver.js';
import { stripe } from '../../src/providers/stripe.js';
import { createTestSigner } from '../../src/testing/index.js';

const CREDS = { type: 'secret' as const, secret: 'whsec_express_test' };

function buildApp(onEvent: (event: unknown) => void): Express {
  const app = express();
  const receiver = createReceiver({ adapter: stripe, credentials: CREDS, onEvent });
  app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), expressWebhook(receiver));
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    },
  );
  return app;
}

let server: ReturnType<Express['listen']> | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function listen(app: Express): Promise<string> {
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const address = server?.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe('expressWebhook', () => {
  it('processes a validly signed request end-to-end over real HTTP', async () => {
    const onEvent = vi.fn();
    const app = buildApp(onEvent);
    const base = await listen(app);

    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));

    const res = await fetch(`${base}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signed.headers },
      body: signed.body as BodyInit,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: 'processed', eventId: 'evt_1' });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects a tampered body over real HTTP with 400', async () => {
    const onEvent = vi.fn();
    const app = buildApp(onEvent);
    const base = await listen(app);

    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));

    const res = await fetch(`${base}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signed.headers },
      body: JSON.stringify({ id: 'evt_TAMPERED', type: 'x' }),
    });

    expect(res.status).toBe(400);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('produces a MissingRawBodyError (500) when express.json() runs before express.raw()', async () => {
    const onEvent = vi.fn();
    const app = express();
    app.use(express.json()); // misconfiguration: global JSON parser registered first
    const receiver = createReceiver({ adapter: stripe, credentials: CREDS, onEvent });
    app.post('/webhooks/stripe', expressWebhook(receiver));
    app.use(
      (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ code: 'missing_raw_body', message: err.message });
      },
    );
    const base = await listen(app);

    const res = await fetch(`${base}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
      body: JSON.stringify({ id: 'evt_1', type: 'x' }),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.message).toContain('express.raw');
  });
});
