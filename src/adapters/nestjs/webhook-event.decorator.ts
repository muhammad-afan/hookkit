import type { ExecutionContext } from '@nestjs/common';
import { createParamDecorator } from '@nestjs/common';
import type { VerifiedEvent } from '../../core/types.js';
import type { HookkitHttpRequest } from './types.js';

/** Pulls the verified, parsed event off the request. Only valid on a route decorated with `@Webhook()`. */
export const WebhookEvent: (...dataOrPipes: unknown[]) => ParameterDecorator = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): VerifiedEvent => {
    const req = ctx.switchToHttp().getRequest<HookkitHttpRequest>();
    if (!req.hookkitPending) {
      throw new Error(
        'hookforge: @WebhookEvent() was used on a route without @Webhook(). Add @Webhook("providerName") to the handler.',
      );
    }
    return req.hookkitPending.event;
  },
);
