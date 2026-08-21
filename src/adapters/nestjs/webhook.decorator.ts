import { HttpCode, SetMetadata, UseGuards, UseInterceptors, applyDecorators } from '@nestjs/common';
import { HOOKSENTINEL_PROVIDER_METADATA_KEY } from './tokens.js';
import { WebhookGuard } from './webhook.guard.js';
import { WebhookLifecycleInterceptor } from './webhook.interceptor.js';

/**
 * Marks a route handler as a webhook receiver for the named provider (as registered in
 * `HooksentinelModule.forRootAsync({ providers: { [name]: ... } })`). Wires up verification,
 * dedupe, and idempotency-claim lifecycle automatically — the handler body only needs
 * `@WebhookEvent()` to read the verified payload.
 *
 * @example
 * @Controller('webhooks')
 * class WebhooksController {
 *   @Post('stripe')
 *   @Webhook('stripe')
 *   async handleStripe(@WebhookEvent() event: VerifiedEvent<Stripe.Event>) {
 *     // Guaranteed: signature valid, not a duplicate, payload parsed.
 *   }
 * }
 */
export function Webhook(providerName: string): MethodDecorator {
  return applyDecorators(
    SetMetadata(HOOKSENTINEL_PROVIDER_METADATA_KEY, providerName),
    UseGuards(WebhookGuard),
    UseInterceptors(WebhookLifecycleInterceptor),
    // Nest's default success status for @Post() is 201. hooksentinel's ReceiverResult always
    // uses 200 for 'processed' across every other adapter — keep NestJS consistent with it.
    HttpCode(200),
  );
}
