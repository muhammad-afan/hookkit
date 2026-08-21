import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { assertRawBody } from './raw-body.js';
import { HooksentinelRegistry } from './registry.service.js';
import { HOOKSENTINEL_PROVIDER_METADATA_KEY } from './tokens.js';
import type { HooksentinelHttpRequest } from './types.js';

// `.send()` — not `.json()` — is the method both Express's and Fastify's response
// objects actually share. Fastify's Reply has no `.json()` at all; `.send()` on both
// platforms auto-serializes a plain object payload to JSON with the right content-type.
interface MinimalResponse {
  status(code: number): { send(body: unknown): void };
}

/**
 * Verifies, dedupes, and parses a webhook request before the route handler runs.
 * Registered as a guard (not an interceptor) so it runs before validation pipes,
 * matching hooksentinel's fail-closed design: an unverified request never reaches
 * application logic at all.
 *
 * On success, attaches `{ event, release, complete }` to the request for
 * `@WebhookEvent()` and `WebhookLifecycleInterceptor` to consume. On rejection or
 * duplicate, it writes the response itself and returns `false`.
 */
export class WebhookGuard implements CanActivate {
  private readonly registry: HooksentinelRegistry;
  private readonly reflector: Reflector;

  constructor(registry: HooksentinelRegistry, reflector: Reflector) {
    this.registry = registry;
    this.reflector = reflector;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const providerName = this.reflector.get<string>(
      HOOKSENTINEL_PROVIDER_METADATA_KEY,
      context.getHandler(),
    );
    if (!providerName) {
      throw new Error(
        'hooksentinel: WebhookGuard is active on a route with no @Webhook() metadata. Use @Webhook("providerName") on the handler instead of applying WebhookGuard directly.',
      );
    }

    const httpContext = context.switchToHttp();
    const req = httpContext.getRequest<HooksentinelHttpRequest>();
    const res = httpContext.getResponse<MinimalResponse>();

    assertRawBody(req);

    const webhookRequest = this.registry.buildWebhookRequest(providerName, {
      body: req.rawBody,
      headers: req.headers,
      url: req.originalUrl ?? req.url,
      method: req.method,
    });

    const outcome = await this.registry.run(providerName, webhookRequest);

    if (outcome.kind === 'rejected') {
      await this.registry.reportError(outcome.error, webhookRequest);
      res
        .status(outcome.httpStatus)
        .send({ error: { code: outcome.error.code, message: outcome.error.message } });
      return false;
    }

    if (outcome.kind === 'duplicate') {
      res.status(200).send({ status: 'duplicate', eventId: outcome.eventId });
      return false;
    }

    req.hooksentinelPending = {
      event: outcome.event,
      release: outcome.release,
      complete: outcome.complete,
    };
    return true;
  }
}

Injectable()(WebhookGuard);
Inject(HooksentinelRegistry)(WebhookGuard, undefined, 0);
Inject(Reflector)(WebhookGuard, undefined, 1);
