import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { HookkitRegistry } from '../../../../src/adapters/nestjs/registry.service.js';
import { HOOKKIT_PROVIDER_METADATA_KEY } from '../../../../src/adapters/nestjs/tokens.js';
import type { HookkitHttpRequest } from '../../../../src/adapters/nestjs/types.js';
import { WebhookGuard } from '../../../../src/adapters/nestjs/webhook.guard.js';
import { stripe } from '../../../../src/providers/stripe.js';
import { createTestSigner } from '../../../../src/testing/index.js';

const CREDS = { type: 'secret' as const, secret: 'whsec_guard_unit_test' };

function buildContext(
  req: HookkitHttpRequest,
  res: { status: ReturnType<typeof vi.fn> },
  handler: () => void,
): ExecutionContext {
  return {
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
}

function fakeResponse(): { status: ReturnType<typeof vi.fn>; sent: unknown[] } {
  const sent: unknown[] = [];
  const send = vi.fn((body: unknown) => {
    sent.push(body);
  });
  const status = vi.fn(() => ({ send }));
  return { status, sent };
}

describe('WebhookGuard — branches not reachable through the full-app integration suites', () => {
  it('throws a clear error when applied to a route with no @Webhook() metadata (guard used directly, not via @Webhook())', async () => {
    const registry = new HookkitRegistry({
      providers: { stripe: { adapter: stripe, credentials: CREDS } },
    });
    const reflector = new Reflector();
    const guard = new WebhookGuard(registry, reflector);

    // A handler function with NO metadata attached — the exact shape a controller
    // method would have if someone applied @UseGuards(WebhookGuard) directly instead
    // of using @Webhook('providerName').
    const bareHandler = () => undefined;
    const res = fakeResponse();
    const context = buildContext({ headers: {} }, res, bareHandler);

    await expect(guard.canActivate(context)).rejects.toThrow('@Webhook("providerName")');
  });

  it('falls back to req.url when req.originalUrl is absent (Fastify-shaped request)', async () => {
    const registry = new HookkitRegistry({
      providers: { stripe: { adapter: stripe, credentials: CREDS } },
    });
    const reflector = new Reflector();
    const guard = new WebhookGuard(registry, reflector);

    const handler = () => undefined;
    Reflect.defineMetadata(HOOKKIT_PROVIDER_METADATA_KEY, 'stripe', handler);

    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));

    // Deliberately no `originalUrl` key at all — only `url`, matching what Fastify's
    // request object looks like (originalUrl is an Express-ism).
    const req: HookkitHttpRequest = {
      rawBody: Buffer.from(signed.body),
      headers: signed.headers,
      url: '/webhooks/stripe',
    };
    const res = fakeResponse();
    const context = buildContext(req, res, handler);

    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
    expect(req.hookkitPending?.event.id).toBe('evt_1');
  });
});
