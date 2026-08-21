import { EnqueueError, HandlerError } from './errors.js';
import { defaultJsonParse, runPipeline } from './pipeline.js';
import { DEFAULT_MAX_BODY_BYTES, fromFetchRequest } from './request.js';
import type { Receiver, ReceiverConfig, ReceiverResult } from './types.js';
import type { WebhookRequest } from './types.js';

export function createReceiver<TPayload = unknown>(
  config: ReceiverConfig<TPayload>,
): Receiver<TPayload> {
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const parse =
    config.parse ?? (defaultJsonParse as (body: Uint8Array) => TPayload | Promise<TPayload>);
  const onHandlerError = config.onHandlerError ?? 'release';
  const idem = config.idempotency;

  async function handle(req: WebhookRequest): Promise<ReceiverResult> {
    const outcome = await runPipeline<TPayload>({
      adapter: config.adapter,
      credentials: config.credentials,
      verifyOptions: config.verify,
      idempotency: idem,
      maxBodyBytes,
      parse,
      req,
      now: config.verify?.now,
    });

    if (outcome.kind === 'rejected') {
      await config.onError?.(outcome.error, req);
      return {
        status: 'rejected',
        error: outcome.error,
        httpStatus: outcome.httpStatus as ReceiverResult['httpStatus'],
      };
    }

    if (outcome.kind === 'duplicate') {
      await config.onDuplicate?.(outcome.eventId);
      return { status: 'duplicate', eventId: outcome.eventId, httpStatus: 200 };
    }

    const { event, release, complete } = outcome;

    if (config.enqueue) {
      // Ordering guarantee: claim → enqueue → ack. If enqueue fails, the claim is
      // ALWAYS released (unlike onEvent's onHandlerError:'keep' option) — a queue
      // outage is an infrastructure failure, not a business-logic bug, and keeping the
      // claim would silently lose the event forever once the queue recovers.
      try {
        await config.enqueue(event);
      } catch (cause) {
        const error = new EnqueueError(config.adapter.name, cause);
        await release();
        await config.onError?.(error, req);
        return { status: 'rejected', error, httpStatus: 503 };
      }
      await complete();
      return { status: 'enqueued', eventId: event.id, httpStatus: 202 };
    }

    if (config.onEvent) {
      try {
        await config.onEvent(event);
      } catch (cause) {
        const error = new HandlerError(config.adapter.name, cause);
        if (onHandlerError === 'release') await release();
        await config.onError?.(error, req);
        return { status: 'rejected', error, httpStatus: 500 };
      }
    }

    await complete();
    return { status: 'processed', eventId: event.id, httpStatus: 200 };
  }

  async function fetchHandler(request: Request): Promise<Response> {
    const req = await fromFetchRequest(request, maxBodyBytes);
    const result = await handle(req);
    if (result.status === 'rejected') {
      return Response.json(
        { error: { code: result.error.code, message: result.error.message } },
        { status: result.httpStatus },
      );
    }
    return Response.json(
      { status: result.status, eventId: result.eventId },
      { status: result.httpStatus },
    );
  }

  return { handle, fetch: fetchHandler, adapter: config.adapter };
}
