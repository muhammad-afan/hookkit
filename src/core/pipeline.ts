import { sha256 } from './crypto.js';
import { bytesToHex, bytesToUtf8, concatBytes, utf8ToBytes } from './encoding.js';
import type { HookkitError } from './errors.js';
import { IdempotencyStoreError, ParseError, PayloadTooLargeError } from './errors.js';
import { enforceMaxBodyBytes } from './request.js';
import type {
  IdempotencyStore,
  ProviderAdapter,
  VerifiedEvent,
  VerifyOptions,
  WebhookCredentials,
  WebhookRequest,
} from './types.js';
import { verify } from './verify.js';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** JSON.parse with a reviver that strips prototype-pollution-capable keys. */
export function defaultJsonParse(body: Uint8Array): unknown {
  const text = bytesToUtf8(body);
  return JSON.parse(text, (key, value) => (DANGEROUS_KEYS.has(key) ? undefined : value));
}

export async function defaultFallbackKey(
  req: WebhookRequest,
  timestamp: number | null,
): Promise<string> {
  const bodyDigest = await sha256(req.body);
  if (timestamp === null) {
    return bytesToHex(bodyDigest);
  }
  const combined = concatBytes(utf8ToBytes(`${timestamp}.`), bodyDigest);
  const digest = await sha256(combined);
  return bytesToHex(digest);
}

export interface PipelineIdempotencyConfig {
  readonly store: IdempotencyStore;
  readonly ttlSeconds?: number | undefined;
  readonly onStoreError?: ('fail' | 'allow') | undefined;
  readonly fallbackKey?: ((req: WebhookRequest) => string | Promise<string>) | undefined;
}

export interface RunPipelineParams<TPayload> {
  readonly adapter: ProviderAdapter;
  readonly credentials: WebhookCredentials;
  readonly verifyOptions?: VerifyOptions | undefined;
  readonly idempotency?: PipelineIdempotencyConfig | undefined;
  readonly maxBodyBytes: number;
  readonly parse: (body: Uint8Array) => TPayload | Promise<TPayload>;
  readonly req: WebhookRequest;
  readonly now?: (() => number) | undefined;
}

export type PipelineOutcome<TPayload> =
  | {
      readonly kind: 'ready';
      readonly event: VerifiedEvent<TPayload>;
      /** Releases the idempotency claim (if any) so a provider retry can be reprocessed. Safe to call when no idempotency store is configured — it's a no-op. */
      readonly release: () => Promise<void>;
      /** Marks the claim complete (if the store distinguishes in-flight vs done). No-op otherwise. */
      readonly complete: () => Promise<void>;
    }
  | { readonly kind: 'duplicate'; readonly eventId: string }
  | { readonly kind: 'rejected'; readonly error: HookkitError; readonly httpStatus: number };

const noopAsync = async (): Promise<void> => undefined;

/**
 * The shared verify → claim → parse pipeline. Stops short of calling any business
 * logic — callers (createReceiver, the NestJS guard) decide what happens next and
 * are responsible for calling `release()` on handler failure or `complete()` on success.
 */
export async function runPipeline<TPayload>(
  params: RunPipelineParams<TPayload>,
): Promise<PipelineOutcome<TPayload>> {
  const { req, adapter, credentials, verifyOptions, idempotency, maxBodyBytes, parse } = params;
  const now = params.now ?? Date.now;

  try {
    enforceMaxBodyBytes(req.body, maxBodyBytes);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return { kind: 'rejected', error: err, httpStatus: err.httpStatus };
    }
    throw err;
  }

  const result = await verify(adapter, req, credentials, verifyOptions);
  if (!result.ok) {
    return { kind: 'rejected', error: result.error, httpStatus: result.error.httpStatus };
  }

  const eventId = result.eventId ?? adapter.extractEventId(req);
  const id =
    eventId ??
    (await (idempotency?.fallbackKey?.(req) ?? defaultFallbackKey(req, result.timestamp)));
  const claimKey = `${adapter.name}:${id}`;
  const ttlSeconds = idempotency?.ttlSeconds ?? 86_400;

  let release = noopAsync;
  let complete = noopAsync;

  if (idempotency) {
    let isDuplicate = false;
    try {
      const claimed = await idempotency.store.claim(claimKey, ttlSeconds);
      isDuplicate = !claimed;
    } catch (cause) {
      const error = new IdempotencyStoreError(cause);
      if (idempotency.onStoreError !== 'allow') {
        return { kind: 'rejected', error, httpStatus: error.httpStatus };
      }
      // onStoreError: 'allow' — proceed as if the claim succeeded, risking a duplicate.
    }

    if (isDuplicate) {
      return { kind: 'duplicate', eventId: id };
    }

    release = async (): Promise<void> => {
      await idempotency.store.release(claimKey).catch(() => undefined);
    };
    complete = async (): Promise<void> => {
      await idempotency.store.complete?.(claimKey, ttlSeconds).catch(() => undefined);
    };
  }

  let payload: TPayload;
  try {
    payload = await parse(req.body);
  } catch (cause) {
    const error = new ParseError(adapter.name, cause);
    await release();
    return { kind: 'rejected', error, httpStatus: error.httpStatus };
  }

  const event: VerifiedEvent<TPayload> = {
    id,
    provider: adapter.name,
    payload,
    raw: req.body,
    headers: req.headers,
    timestamp: result.timestamp,
    receivedAt: now(),
  };

  return { kind: 'ready', event, release, complete };
}
