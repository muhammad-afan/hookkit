import type { HookkitError } from '../../core/errors.js';
import type {
  IdempotencyStore,
  ProviderAdapter,
  VerifiedEvent,
  VerifyOptions,
  WebhookCredentials,
  WebhookRequest,
} from '../../core/types.js';

export interface HookkitProviderConfig<TPayload = unknown> {
  readonly adapter: ProviderAdapter;
  readonly credentials: WebhookCredentials;
  readonly verify?: VerifyOptions | undefined;
  readonly parse?: ((body: Uint8Array) => TPayload | Promise<TPayload>) | undefined;
}

export interface HookkitModuleOptions {
  /** Shared idempotency store used by every registered provider. Omit to disable dedupe. */
  readonly store?: IdempotencyStore | undefined;
  readonly ttlSeconds?: number | undefined;
  readonly onStoreError?: ('fail' | 'allow') | undefined;
  /** What to do with the idempotency claim when a guarded route handler throws. Default: 'release'. */
  readonly onHandlerError?: ('release' | 'keep') | undefined;
  readonly maxBodyBytes?: number | undefined;
  readonly providers: Record<string, HookkitProviderConfig>;
  readonly onError?:
    | ((error: HookkitError, req: WebhookRequest) => void | Promise<void>)
    | undefined;
}

/** Bookkeeping the guard attaches to the request; consumed by the interceptor and @WebhookEvent(). */
export interface PendingWebhook {
  readonly event: VerifiedEvent;
  readonly release: () => Promise<void>;
  readonly complete: () => Promise<void>;
}

/** Structural request shape — deliberately not `express.Request` or `FastifyRequest` so the guard works on both platforms. */
export interface HookkitHttpRequest {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  originalUrl?: string;
  method?: string;
  hookkitPending?: PendingWebhook;
}
