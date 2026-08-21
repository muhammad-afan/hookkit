import type { ExecutionContext } from '@nestjs/common';
import { createParamDecorator } from '@nestjs/common';
import type { VerifiedEvent } from '../../core/types.js';
import type { HooksentinelHttpRequest } from './types.js';

/** Pulls the verified, parsed event off the request. Only valid on a route decorated with `@Webhook()`. */
export const WebhookEvent: (...dataOrPipes: unknown[]) => ParameterDecorator = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): VerifiedEvent => {
    const req = ctx.switchToHttp().getRequest<HooksentinelHttpRequest>();
    if (!req.hooksentinelPending) {
      throw new Error(
        'hooksentinel: @WebhookEvent() was used on a route without @Webhook(). Add @Webhook("providerName") to the handler.',
      );
    }
    return req.hooksentinelPending.event;
  },
);
