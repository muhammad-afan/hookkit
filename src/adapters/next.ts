import type { Receiver } from '../core/types.js';

/**
 * Next.js App Router helper. `Request` in the App Router already exposes the raw
 * stream, so this is a thin, explicit wrapper around `receiver.fetch`.
 *
 * @example
 * // app/api/webhooks/stripe/route.ts
 * const receiver = createReceiver({ ... });
 * export const POST = nextWebhook(receiver);
 * export const runtime = 'nodejs'; // or 'edge' — both work
 */
export function nextWebhook(receiver: Receiver): (request: Request) => Promise<Response> {
  return (request: Request): Promise<Response> => receiver.fetch(request);
}
