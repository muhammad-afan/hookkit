import type { HookkitError } from './errors.js';

/** Normalized, framework-agnostic view of the inbound request. */
export interface WebhookRequest {
  /** Exact bytes as received. Never a re-serialized object. */
  readonly body: Uint8Array;
  /** Lowercased header names → value. Multi-value headers joined by ", ". */
  readonly headers: Readonly<Record<string, string>>;
  /** Absolute URL of the request. Required by URL-bound providers (Twilio, Square). */
  readonly url?: string | undefined;
  /** HTTP method, uppercase. Defaults to "POST". */
  readonly method?: string | undefined;
}

/** Credentials — a union because providers differ fundamentally. */
export type WebhookCredentials =
  | { readonly type: 'secret'; readonly secret: string | Uint8Array }
  | { readonly type: 'publicKey'; readonly publicKey: string | Uint8Array }
  | { readonly type: 'apiCredentials'; readonly [k: string]: unknown };

export interface VerifyOptions {
  /** Replay window in seconds. Adapter default used when omitted. */
  readonly toleranceSeconds?: number;
  /** Injectable clock for testing. Returns ms since epoch. */
  readonly now?: () => number;
  /** Extra secrets accepted during rotation. Tried in order after the primary. */
  readonly additionalSecrets?: readonly (string | Uint8Array)[];
}

/** Result of verification. Discriminated union — no exceptions on the happy path. */
export type VerifyResult =
  | { readonly ok: true; readonly eventId: string | null; readonly timestamp: number | null }
  | { readonly ok: false; readonly error: HookkitError };

/** The adapter contract. Implement once per provider. */
export interface ProviderAdapter<TCreds extends WebhookCredentials = WebhookCredentials> {
  readonly name: string;
  /** Headers that must be present. Used for auto-detection and fast rejection. */
  readonly requiredHeaders: readonly string[];
  /** Default replay tolerance in seconds. null = provider sends no timestamp. */
  readonly defaultToleranceSeconds: number | null;
  /** True if this adapter performs network I/O (PayPal). Surfaced in docs/metrics. */
  readonly requiresNetwork?: boolean;
  /**
   * Extract a stable, provider-assigned unique event id for deduplication.
   * Return null when the provider sends none — caller must then supply a fallback.
   */
  extractEventId(req: WebhookRequest): string | null;
  /** Verify. MUST NOT throw for expected failures — return { ok: false }. */
  verify(req: WebhookRequest, creds: TCreds, opts?: VerifyOptions): Promise<VerifyResult>;
  /**
   * Build validly-signed headers for a given body. Optional — powers `createTestSigner`.
   * Adapters that implement this make themselves testable without a real provider account.
   */
  sign?(
    body: Uint8Array,
    creds: TCreds,
    opts?: TestSignOptions,
  ): Promise<{ headers: Record<string, string> }>;
}

/** Options for constructing a test-signed request via createTestSigner. */
export interface TestSignOptions {
  /** Seconds since epoch. Defaults to "now" for timestamped providers. */
  readonly timestamp?: number;
  /** Provider-assigned event id to embed, where the provider sends one out-of-band (e.g. a header). */
  readonly eventId?: string;
  readonly url?: string;
  readonly method?: string;
}

/** Contract for idempotency stores. Claims must be atomic — see IdempotencyStore docs. */
export interface IdempotencyStore {
  /**
   * Atomically claim an event id.
   * Returns true if this caller won the claim (first delivery).
   * Returns false if already claimed (duplicate).
   * MUST be atomic — this is the entire contract.
   */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  /** Release a claim so the provider's retry can be processed. Used on handler failure. */
  release(key: string): Promise<void>;
  /** Optional: mark permanently complete, for stores that distinguish in-flight vs done. */
  complete?(key: string, ttlSeconds: number): Promise<void>;
}

export interface VerifiedEvent<TPayload = unknown> {
  readonly id: string;
  readonly provider: string;
  readonly payload: TPayload;
  readonly raw: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  readonly timestamp: number | null;
  readonly receivedAt: number;
}

export interface ReceiverConfig<TPayload = unknown> {
  readonly adapter: ProviderAdapter;
  readonly credentials: WebhookCredentials;
  readonly verify?: VerifyOptions;

  /** Idempotency. Omit to disable (logs a warning once in dev). */
  readonly idempotency?: {
    readonly store: IdempotencyStore;
    /** TTL for dedupe records. Default 86400 (24h). */
    readonly ttlSeconds?: number;
    /**
     * What to do if the store is unreachable.
     * 'fail'  → reject with 503 (safe: provider retries).  ← default
     * 'allow' → process anyway, risking a duplicate.
     */
    readonly onStoreError?: 'fail' | 'allow';
    /** Fallback id when the provider sends none. Default: SHA-256 of the body. */
    readonly fallbackKey?: (req: WebhookRequest) => string | Promise<string>;
  };

  /** Maximum accepted body size in bytes, enforced before hashing. Default 1 MB. */
  readonly maxBodyBytes?: number;

  /** Parse the verified bytes. Default: JSON.parse with prototype-pollution guard. */
  readonly parse?: (body: Uint8Array) => TPayload | Promise<TPayload>;

  /** Your business logic. Keep it fast, or use `enqueue` instead. */
  readonly onEvent?: (event: VerifiedEvent<TPayload>) => void | Promise<void>;

  /**
   * Fast-ack mode. When provided, hookforge acks immediately after enqueue
   * and `onEvent` is NOT called inline.
   */
  readonly enqueue?: (event: VerifiedEvent<TPayload>) => Promise<void>;

  /** What to do with an idempotency claim when the handler throws. Default: 'release'. */
  readonly onHandlerError?: 'release' | 'keep';

  /** Called on verification/parse failure. For logging and alerting. */
  readonly onError?: (error: HookkitError, req: WebhookRequest) => void | Promise<void>;

  /** Called when a duplicate is suppressed. Default behaviour is still 200. */
  readonly onDuplicate?: (eventId: string) => void | Promise<void>;
}

export type ReceiverResult =
  | { readonly status: 'processed'; readonly eventId: string; readonly httpStatus: 200 }
  | { readonly status: 'duplicate'; readonly eventId: string; readonly httpStatus: 200 }
  | { readonly status: 'enqueued'; readonly eventId: string; readonly httpStatus: 202 }
  | { readonly status: 'rejected'; readonly error: HookkitError; readonly httpStatus: number };

export interface Receiver<TPayload = unknown> {
  /** Framework-agnostic entry point. Every adapter funnels through this. */
  handle(req: WebhookRequest): Promise<ReceiverResult>;
  /** Convenience for fetch-API environments (Next.js, Hono, Workers). */
  fetch(request: Request): Promise<Response>;
  /**
   * The adapter this receiver was configured with. Additive, read-only metadata — not
   * used by `handle`/`fetch` themselves, but required by `createRouter`'s `autoDetect`
   * to inspect each registered provider's `requiredHeaders` without needing a second,
   * parallel adapter registry alongside `receivers`.
   */
  readonly adapter: ProviderAdapter;
}

export interface RouterConfig {
  readonly receivers: Record<string, Receiver<unknown>>;
  /**
   * Auto-detect the provider from headers when no explicit key is given.
   *
   * Off by default. Auto-detection is a footgun: if two registered providers' required
   * headers overlap, the router could verify a request against the wrong provider's
   * secret. When enabled, a request is only routed automatically if EXACTLY ONE
   * registered provider's full `requiredHeaders` set is present — zero or multiple
   * matches are rejected rather than guessed at. Prefer explicit routing (e.g. a
   * `/api/webhooks/[provider]` dynamic path segment) whenever possible.
   */
  readonly autoDetect?: boolean | undefined;
}

export interface Router {
  /** Explicit routing: pass the provider key yourself (e.g. from a URL path segment). */
  handle(req: WebhookRequest, providerKey?: string): Promise<ReceiverResult>;
  /** Fetch-API convenience. `providerKey` is required unless `autoDetect: true`. */
  fetch(request: Request, providerKey?: string): Promise<Response>;
}
