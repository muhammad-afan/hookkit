import type { NextFunction, Request, Response } from 'express';
import { MissingRawBodyError } from '../core/errors.js';
import { toWebhookRequest } from '../core/request.js';
import type { Receiver } from '../core/types.js';

/**
 * Express middleware. Requires the raw request body as a Buffer on `req.body` —
 * register `express.raw({ type: 'application/json' })` on this route BEFORE any
 * `express.json()` middleware, or hookforge cannot see the exact signed bytes.
 *
 * @example
 * app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), expressWebhook(receiver));
 */
export function expressWebhook(
  receiver: Receiver,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async (): Promise<void> => {
      try {
        if (!Buffer.isBuffer(req.body)) {
          throw new MissingRawBodyError();
        }

        const webhookRequest = toWebhookRequest({
          body: req.body,
          headers: req.headers as Record<string, string | string[] | undefined>,
          url: req.originalUrl ?? req.url,
          method: req.method,
        });

        const result = await receiver.handle(webhookRequest);

        if (result.status === 'rejected') {
          res
            .status(result.httpStatus)
            .json({ error: { code: result.error.code, message: result.error.message } });
          return;
        }

        res.status(result.httpStatus).json({ status: result.status, eventId: result.eventId });
      } catch (err) {
        next(err);
      }
    })();
  };
}
