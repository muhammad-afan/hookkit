import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, Controller, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookkitModule } from '../../../src/adapters/nestjs/hookkit.module.js';
import { WebhookEvent } from '../../../src/adapters/nestjs/webhook-event.decorator.js';
import { Webhook } from '../../../src/adapters/nestjs/webhook.decorator.js';
import type { VerifiedEvent } from '../../../src/core/types.js';
import { stripe } from '../../../src/providers/stripe.js';
import { memoryStore } from '../../../src/stores/memory.js';
import { createTestSigner } from '../../../src/testing/index.js';

/**
 * Same suite as webhook.test.ts, run against NestFastifyApplication instead of
 * NestExpressApplication. Fastify's raw-body capture and response API are different
 * under the hood (Nest's FastifyAdapter uses addContentTypeParser, not
 * express.raw()/json(); Fastify's Reply has no .json(), only .send()) — this exists to
 * prove the guard's platform-agnostic code path actually works on both, not just Express.
 */

const CREDS = { type: 'secret' as const, secret: 'whsec_nestjs_fastify_test' };

function applyClassDecorator<T extends new (...args: never[]) => unknown>(
  target: T,
  decorator: ClassDecorator,
): T {
  decorator(target as unknown as new (...args: never[]) => unknown);
  return target;
}

function applyMethodDecorator(
  prototype: object,
  propertyKey: string,
  decorator: MethodDecorator,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, propertyKey) as PropertyDescriptor;
  const result = decorator(prototype, propertyKey, descriptor);
  if (result) Object.defineProperty(prototype, propertyKey, result as PropertyDescriptor);
}

function applyParamDecorator(
  prototype: object,
  propertyKey: string,
  index: number,
  decorator: ParameterDecorator,
): void {
  decorator(prototype, propertyKey, index);
}

class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host
      .switchToHttp()
      .getResponse<{ status: (c: number) => { send: (b: unknown) => void } }>();
    const message = exception instanceof Error ? exception.message : String(exception);
    res.status(500).send({ message });
  }
}
applyClassDecorator(AllExceptionsFilter, Catch());

interface AppHandle {
  readonly app: NestFastifyApplication;
  readonly baseUrl: string;
}

async function createApp(options: {
  readonly onEvent: (event: VerifiedEvent) => void | Promise<void>;
  readonly onHandlerError?: 'release' | 'keep';
  readonly nestFactoryOptions?: Record<string, unknown>;
  readonly extraSetup?: (app: NestFastifyApplication) => void;
}): Promise<AppHandle> {
  class WebhooksController {
    async handleStripe(event: VerifiedEvent): Promise<{ ok: true }> {
      await options.onEvent(event);
      return { ok: true };
    }
  }
  applyParamDecorator(WebhooksController.prototype, 'handleStripe', 0, WebhookEvent());
  applyMethodDecorator(WebhooksController.prototype, 'handleStripe', Post('stripe'));
  applyMethodDecorator(WebhooksController.prototype, 'handleStripe', Webhook('stripe'));
  applyClassDecorator(WebhooksController, Controller('webhooks'));

  class AppModule {}
  Module({
    imports: [
      HookkitModule.forRootAsync({
        useFactory: () => ({
          store: memoryStore(),
          onHandlerError: options.onHandlerError,
          providers: { stripe: { adapter: stripe, credentials: CREDS } },
        }),
      }),
    ],
    controllers: [WebhooksController],
  })(AppModule);

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    rawBody: true,
    logger: false,
    ...options.nestFactoryOptions,
  });
  app.useGlobalFilters(new AllExceptionsFilter());
  // Nest registers its own rawBody-capturing content-type parser lazily, inside
  // init() — so extraSetup must run AFTER init() to actually override it. This mirrors
  // how the real bug happens: a plugin/parser registered anytime after bootstrap wins.
  await app.init();
  options.extraSetup?.(app);

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}

let current: AppHandle | undefined;

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

async function signedFetch(baseUrl: string, body: unknown): Promise<Response> {
  const signer = createTestSigner(stripe, CREDS);
  const signed = await signer.sign(JSON.stringify(body));
  return fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signed.headers },
    body: signed.body as BodyInit,
  });
}

describe('NestJS + Fastify integration — @Webhook() / @WebhookEvent() / WebhookGuard', () => {
  it('processes a validly signed request end-to-end', async () => {
    const onEvent = vi.fn();
    current = await createApp({ onEvent });

    const res = await signedFetch(current.baseUrl, { id: 'evt_1', type: 'x' });

    expect(res.status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(1);
    const event = onEvent.mock.calls[0]?.[0] as VerifiedEvent;
    expect(event.id).toBe('evt_1');
    expect(event.provider).toBe('stripe');
  });

  it('rejects a tampered body with 400 before the controller runs', async () => {
    const onEvent = vi.fn();
    current = await createApp({ onEvent });

    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));
    const res = await fetch(`${current.baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signed.headers },
      body: JSON.stringify({ id: 'evt_TAMPERED', type: 'x' }),
    });

    expect(res.status).toBe(400);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('deduplicates a second delivery of the same event id', async () => {
    const onEvent = vi.fn();
    current = await createApp({ onEvent });

    const body = { id: 'evt_dup', type: 'x' };
    const first = await signedFetch(current.baseUrl, body);
    const second = await signedFetch(current.baseUrl, body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: 'duplicate' });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('onHandlerError "release" (default): a thrown handler releases the claim so a retry is processed', async () => {
    let attempts = 0;
    const onEvent = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient failure');
    });
    current = await createApp({ onEvent });

    const body = { id: 'evt_retry', type: 'x' };
    const first = await signedFetch(current.baseUrl, body);
    expect(first.status).toBe(500);

    const retry = await signedFetch(current.baseUrl, body);
    expect(retry.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it('onHandlerError "keep": a thrown handler permanently suppresses the retry as a duplicate', async () => {
    const onEvent = vi.fn(async () => {
      throw new Error('permanent failure');
    });
    current = await createApp({ onEvent, onHandlerError: 'keep' });

    const body = { id: 'evt_keep', type: 'x' };
    const first = await signedFetch(current.baseUrl, body);
    expect(first.status).toBe(500);

    const retry = await signedFetch(current.baseUrl, body);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ status: 'duplicate' });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('raw-body diagnostic: bodyParser:false combined with rawBody:true names both documented causes', async () => {
    const onEvent = vi.fn();
    current = await createApp({ onEvent, nestFactoryOptions: { bodyParser: false } });

    const res = await signedFetch(current.baseUrl, { id: 'evt_1', type: 'x' });

    expect(res.status).toBe(500);
    const json = (await res.json()) as { message: string };
    expect(json.message).toContain('bodyParser: false');
    expect(json.message).toContain('nestjs/nest/issues/10471');
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('raw-body diagnostic: a content-type parser registered after rawBody:true overrides it (Fastify-native equivalent of nestjs/nest#10471)', async () => {
    const onEvent = vi.fn();
    current = await createApp({
      onEvent,
      extraSetup: (app) => {
        // The Fastify-native way to reproduce #10471: whichever addContentTypeParser
        // call for a content-type registers LAST wins. Nest's rawBody:true already
        // registered one for 'application/json'; this one silently replaces it,
        // exactly like a custom app.use(json()) does under Express.
        const instance = app.getHttpAdapter().getInstance();
        instance.removeContentTypeParser('application/json');
        instance.addContentTypeParser(
          'application/json',
          { parseAs: 'string' },
          (_req: unknown, body: string, done: (err: Error | null, body?: unknown) => void) => {
            try {
              done(null, JSON.parse(body));
            } catch (err) {
              done(err as Error, undefined);
            }
          },
        );
      },
    });

    const res = await signedFetch(current.baseUrl, { id: 'evt_1', type: 'x' });

    expect(res.status).toBe(500);
    const json2 = (await res.json()) as { message: string };
    expect(json2.message).toContain('nestjs/nest/issues/10471');
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('correct configuration (rawBody:true, no interfering parser) works — the diagnostic never fires on the happy path', async () => {
    const onEvent = vi.fn();
    current = await createApp({ onEvent });

    const res = await signedFetch(current.baseUrl, { id: 'evt_1', type: 'x' });

    expect(res.status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
