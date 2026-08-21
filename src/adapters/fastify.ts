import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MissingRawBodyError } from '../core/errors.js';
import { toWebhookRequest } from '../core/request.js';
import type { Receiver } from '../core/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/**
 * Registers a raw-body content-type parser on the given Fastify instance, scoped to
 * this plugin registration — it does not disable JSON parsing globally. Register the
 * plugin on a child scope (e.g. via `fastify.register(async (app) => {...})`) so it
 * only affects your webhook routes, not the rest of the app.
 *
 * @example
 * fastify.register(async (app) => {
 *   hookkitFastifyRawBody(app);
 *   app.post('/webhooks/stripe', hookkitFastify(receiver));
 * });
 */
export function hookkitFastifyRawBody(fastify: FastifyInstance): void {
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req: FastifyRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
      req.rawBody = body;
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch {
        // Not valid JSON at the transport layer — hookforge's own parse step will
        // produce a proper ParseError after signature verification; don't fail here.
        done(null, undefined);
      }
    },
  );
}

/**
 * Fastify route handler. Requires `hookkitFastifyRawBody()` to have been registered
 * first so `request.rawBody` is populated with the exact signed bytes.
 *
 * @example
 * app.post('/webhooks/stripe', hookkitFastify(receiver));
 */
export function hookkitFastify(
  receiver: Receiver,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!Buffer.isBuffer(request.rawBody)) {
      throw new MissingRawBodyError(
        "hookforge: request.rawBody was not available. Register hookkitFastifyRawBody(fastify) on this route's scope before hookkitFastify(receiver) — see https://hookkit.dev/errors/missing_raw_body",
      );
    }

    const webhookRequest = toWebhookRequest({
      body: request.rawBody,
      headers: request.headers,
      url: request.url,
      method: request.method,
    });

    const result = await receiver.handle(webhookRequest);

    if (result.status === 'rejected') {
      reply
        .status(result.httpStatus)
        .send({ error: { code: result.error.code, message: result.error.message } });
      return;
    }

    reply.status(result.httpStatus).send({ status: result.status, eventId: result.eventId });
  };
}
