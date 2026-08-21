import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, Controller, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterEach, describe, expect, it } from 'vitest';
import { WebhookEvent } from '../../../../src/adapters/nestjs/webhook-event.decorator.js';

/**
 * `@WebhookEvent()`'s own "used without @Webhook()" guard (webhook-event.decorator.ts)
 * can only actually run through Nest's real param-resolution pipeline — createParamDecorator
 * factories aren't directly callable outside a request. So this is a full (but minimal)
 * Nest app: a controller with @WebhookEvent() but deliberately NO @Webhook() on the
 * handler, meaning no guard ever sets req.hooksentinelPending.
 */

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

let app: NestExpressApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('@WebhookEvent() used without @Webhook()', () => {
  it('throws a clear error instead of silently returning undefined', async () => {
    class MisusedController {
      handle(event: unknown): unknown {
        return { received: event };
      }
    }
    applyParamDecorator(MisusedController.prototype, 'handle', 0, WebhookEvent());
    applyMethodDecorator(MisusedController.prototype, 'handle', Post('misused'));
    applyClassDecorator(MisusedController, Controller('webhooks'));

    class AppModule {}
    Module({ controllers: [MisusedController] })(AppModule);

    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0);
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/webhooks/misused`, { method: 'POST' });

    expect(res.status).toBe(500);
    const json = (await res.json()) as { message: string };
    expect(json.message).toContain('@WebhookEvent()');
    expect(json.message).toContain('@Webhook(');
  });
});
