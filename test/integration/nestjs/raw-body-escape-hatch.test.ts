import express from 'express';
import type { Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { applyRawBodyOnlyTo } from '../../../src/adapters/nestjs/raw-body.js';

/**
 * applyRawBodyOnlyTo() is the manual-middleware fallback for users who need a custom
 * body-size limit — the exact scenario that breaks NestJS's global `rawBody: true`
 * (nestjs/nest#10471, per raw-body.ts's own diagnostic message). Its whole reason to
 * exist is: capture raw bytes on the webhook route ONLY, while a normal (differently-
 * configured, size-limited) body parser keeps working everywhere else on the same app.
 * These tests exercise exactly that combination, not just "does it capture bytes".
 */

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

describe('applyRawBodyOnlyTo — the escape hatch for a custom body-size limit', () => {
  it('captures the exact raw body only on the registered path', async () => {
    const app = express();
    const captured: { rawBody: Buffer | undefined }[] = [];
    applyRawBodyOnlyTo(app, '/webhooks/stripe');
    app.post('/webhooks/stripe', (req, res) => {
      captured.push({ rawBody: (req as express.Request & { rawBody?: Buffer }).rawBody });
      res.status(200).json({ ok: true });
    });
    const base = await listen(app);

    const payload = JSON.stringify({ id: 'evt_1', type: 'x' });
    const res = await fetch(`${base}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(Buffer.isBuffer(captured[0]?.rawBody)).toBe(true);
    expect(captured[0]?.rawBody?.toString('utf8')).toBe(payload);
  });

  it('does NOT apply to other routes — normal JSON body-parsing keeps working there', async () => {
    const app = express();
    applyRawBodyOnlyTo(app, '/webhooks/stripe');
    app.use(express.json());
    app.post('/webhooks/stripe', (req, res) => {
      res.status(200).json({
        hasRawBody: Buffer.isBuffer((req as express.Request & { rawBody?: Buffer }).rawBody),
      });
    });
    app.post('/other-route', (req, res) => {
      res.status(200).json({ body: req.body, hasRawBody: 'rawBody' in req });
    });
    const base = await listen(app);

    const other = await fetch(`${base}/other-route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });

    expect(other.status).toBe(200);
    const otherJson = await other.json();
    expect(otherJson).toEqual({ body: { hello: 'world' }, hasRawBody: false });
  });

  it('coexists with a custom, smaller body-size limit on a DIFFERENT route — the entire reason this escape hatch exists', async () => {
    const app = express();
    // The webhook route: raw bytes, no size limit imposed by the escape hatch itself.
    applyRawBodyOnlyTo(app, '/webhooks/stripe');
    app.post('/webhooks/stripe', (req, res) => {
      const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
      res.status(200).json({ bytesReceived: rawBody?.length ?? 0 });
    });

    // A different route: a real, custom, DELIBERATELY SMALL body-size limit — the exact
    // requirement that breaks NestJS's global rawBody:true (#10471) if you try to raise
    // or otherwise customize the limit after enabling it.
    app.post('/other-route', express.json({ limit: '1kb' }), (req, res) => {
      res.status(200).json({ body: req.body });
    });
    app.use(
      (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(413).json({ error: err.message });
      },
    );

    const base = await listen(app);

    // A payload well over 1kb — must be REJECTED on /other-route by its custom limit...
    const bigPayload = JSON.stringify({ data: 'x'.repeat(2000) });
    const bigRes = await fetch(`${base}/other-route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bigPayload,
    });
    expect(bigRes.status).toBe(413);

    // ...while the SAME size of payload sent to the webhook route is captured in full,
    // completely unaffected by /other-route's 1kb limit — proving the two are genuinely
    // independent, which is the whole point of scoping raw-body capture per-route.
    const webhookRes = await fetch(`${base}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bigPayload,
    });
    expect(webhookRes.status).toBe(200);
    const webhookJson = await webhookRes.json();
    expect(webhookJson.bytesReceived).toBe(Buffer.byteLength(bigPayload));
  });

  it('accepts an array of paths, capturing raw body on each independently', async () => {
    const app = express();
    applyRawBodyOnlyTo(app, ['/webhooks/stripe', '/webhooks/shopify']);
    for (const path of ['/webhooks/stripe', '/webhooks/shopify']) {
      app.post(path, (req, res) => {
        res.status(200).json({
          hasRawBody: Buffer.isBuffer((req as express.Request & { rawBody?: Buffer }).rawBody),
        });
      });
    }
    const base = await listen(app);

    for (const path of ['/webhooks/stripe', '/webhooks/shopify']) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const json = await res.json();
      expect(json).toEqual({ hasRawBody: true });
    }
  });

  it('an empty body still produces a zero-length Buffer, not undefined', async () => {
    const app = express();
    const captured: { rawBody: Buffer | undefined }[] = [];
    applyRawBodyOnlyTo(app, '/webhooks/stripe');
    app.post('/webhooks/stripe', (req, res) => {
      captured.push({ rawBody: (req as express.Request & { rawBody?: Buffer }).rawBody });
      res.status(200).end();
    });
    const base = await listen(app);

    await fetch(`${base}/webhooks/stripe`, { method: 'POST' });

    expect(Buffer.isBuffer(captured[0]?.rawBody)).toBe(true);
    expect(captured[0]?.rawBody?.length).toBe(0);
  });
});
