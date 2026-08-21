import { AmbiguousProviderError, UnknownProviderRouteError } from './errors.js';
import { fromFetchRequest } from './request.js';
import type { ReceiverResult, Router, RouterConfig, WebhookRequest } from './types.js';

function toRejected(error: UnknownProviderRouteError | AmbiguousProviderError): ReceiverResult {
  return {
    status: 'rejected',
    error,
    httpStatus: error.httpStatus as ReceiverResult['httpStatus'],
  };
}

/** Returns the keys of every registered receiver whose adapter's full requiredHeaders set is present. */
function detectProviderKeys(req: WebhookRequest, receivers: RouterConfig['receivers']): string[] {
  const matches: string[] = [];
  for (const [key, receiver] of Object.entries(receivers)) {
    const required = receiver.adapter.requiredHeaders;
    if (required.length > 0 && required.every((header) => req.headers[header] !== undefined)) {
      matches.push(key);
    }
  }
  return matches;
}

/**
 * Multi-provider routing over a single endpoint (e.g. `/api/webhooks/[provider]`).
 *
 * `autoDetect` is off by default and should stay off unless you've deliberately
 * checked that your registered providers' header shapes don't overlap — see
 * `RouterConfig.autoDetect`'s doc comment for why. Explicit routing (pass the
 * provider key yourself) is always safer and is the recommended default.
 */
export function createRouter(config: RouterConfig): Router {
  const autoDetect = config.autoDetect ?? false;

  async function handle(req: WebhookRequest, providerKey?: string): Promise<ReceiverResult> {
    let key = providerKey;

    if (key === undefined) {
      if (!autoDetect) {
        return toRejected(UnknownProviderRouteError.noKeyGiven());
      }
      const matches = detectProviderKeys(req, config.receivers);
      if (matches.length !== 1) {
        return toRejected(new AmbiguousProviderError(matches));
      }
      key = matches[0];
    }

    const receiver = config.receivers[key as string];
    if (!receiver) {
      return toRejected(
        UnknownProviderRouteError.forKey(key as string, Object.keys(config.receivers)),
      );
    }

    return receiver.handle(req);
  }

  async function fetchHandler(request: Request, providerKey?: string): Promise<Response> {
    const req = await fromFetchRequest(request);
    const result = await handle(req, providerKey);
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

  return { handle, fetch: fetchHandler };
}
