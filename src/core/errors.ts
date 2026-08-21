/** Base class for all hooksentinel errors. Every error carries a stable machine-readable code. */
export abstract class HooksentinelError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  /** True if the provider retrying could plausibly succeed. */
  abstract readonly retryable: boolean;
  readonly provider?: string;

  constructor(message: string, provider?: string) {
    super(message);
    this.name = new.target.name;
    if (provider !== undefined) this.provider = provider;
  }
}

function docsUrl(code: string): string {
  return `https://hooksentinel.dev/errors/${code}`;
}

export class InvalidSignatureError extends HooksentinelError {
  readonly code = 'invalid_signature';
  readonly httpStatus = 400;
  readonly retryable = false;

  constructor(provider: string) {
    super(
      `Signature verification failed for provider "${provider}". The most common cause is that the request body was parsed or re-serialized before hooksentinel received it — verify() needs the exact raw bytes. See ${docsUrl('invalid_signature')}`,
      provider,
    );
  }
}

export class MissingSignatureHeaderError extends HooksentinelError {
  readonly code = 'missing_signature_header';
  readonly httpStatus = 400;
  readonly retryable = false;

  constructor(provider: string, header: string) {
    super(
      `Missing required header "${header}" for provider "${provider}". This request does not look like a genuine webhook from this provider. See ${docsUrl('missing_signature_header')}`,
      provider,
    );
  }
}

export class MalformedSignatureHeaderError extends HooksentinelError {
  readonly code = 'malformed_signature_header';
  readonly httpStatus = 400;
  readonly retryable = false;

  constructor(provider: string, header: string) {
    super(
      `Header "${header}" was present but could not be parsed for provider "${provider}". See ${docsUrl('malformed_signature_header')}`,
      provider,
    );
  }
}

export class TimestampOutOfToleranceError extends HooksentinelError {
  readonly code = 'timestamp_out_of_tolerance';
  readonly httpStatus = 400;
  readonly retryable = false;

  constructor(provider: string, toleranceSeconds: number) {
    super(
      `Timestamp is outside the ${toleranceSeconds}s replay tolerance window for provider "${provider}". This could be clock skew or a replay attack. See ${docsUrl('timestamp_out_of_tolerance')}`,
      provider,
    );
  }
}

export class MissingRawBodyError extends HooksentinelError {
  readonly code = 'missing_raw_body';
  readonly httpStatus = 500;
  readonly retryable = false;

  constructor(message?: string) {
    super(
      message ??
        `The raw request body was not available — it was likely parsed by another middleware (e.g. express.json()) before hooksentinel could see the exact bytes. In Express, register express.raw({type:'application/json'}) on this route BEFORE any express.json() middleware. See ${docsUrl('missing_raw_body')}`,
    );
  }
}

export class PayloadTooLargeError extends HooksentinelError {
  readonly code = 'payload_too_large';
  readonly httpStatus = 413;
  readonly retryable = false;

  constructor(maxBytes: number) {
    super(
      `Request body exceeds the configured maxBodyBytes limit of ${maxBytes} bytes. See ${docsUrl('payload_too_large')}`,
    );
  }
}

export class ParseError extends HooksentinelError {
  readonly code = 'parse_error';
  readonly httpStatus = 400;
  readonly retryable = false;

  constructor(provider: string, cause?: unknown) {
    super(
      `Signature verified for provider "${provider}", but the body could not be parsed as valid JSON. See ${docsUrl('parse_error')}`,
      provider,
    );
    if (cause !== undefined) this.cause = cause;
  }
}

export class DuplicateEventError extends HooksentinelError {
  readonly code = 'duplicate_event';
  readonly httpStatus = 200;
  readonly retryable = false;

  constructor(eventId: string) {
    super(`Event "${eventId}" was already processed and has been deduplicated.`);
  }
}

export class IdempotencyStoreError extends HooksentinelError {
  readonly code = 'idempotency_store_error';
  readonly httpStatus = 503;
  readonly retryable = true;

  constructor(cause?: unknown) {
    super(
      `The idempotency store was unreachable. Returning 503 so the provider retries rather than risk processing a duplicate. See ${docsUrl('idempotency_store_error')}`,
    );
    if (cause !== undefined) this.cause = cause;
  }
}

export class HandlerError extends HooksentinelError {
  readonly code = 'handler_error';
  readonly httpStatus = 500;
  readonly retryable = true;

  constructor(provider: string, cause?: unknown) {
    super(
      `The event handler for provider "${provider}" threw an error. See ${docsUrl('handler_error')}`,
      provider,
    );
    if (cause !== undefined) this.cause = cause;
  }
}

export class EnqueueError extends HooksentinelError {
  readonly code = 'enqueue_error';
  readonly httpStatus = 503;
  readonly retryable = true;

  constructor(provider: string, cause?: unknown) {
    super(
      `Handing the event off to the queue failed for provider "${provider}". Returning 503 so the provider retries — the ordering guarantee is claim → enqueue → ack, and enqueue did not complete. See ${docsUrl('enqueue_error')}`,
      provider,
    );
    if (cause !== undefined) this.cause = cause;
  }
}

export class ProviderVerificationError extends HooksentinelError {
  readonly code = 'provider_verification_error';
  readonly httpStatus = 503;
  readonly retryable = true;

  constructor(provider: string, cause?: unknown) {
    super(
      `An async verification call to provider "${provider}" failed or timed out. See ${docsUrl('provider_verification_error')}`,
      provider,
    );
    if (cause !== undefined) this.cause = cause;
  }
}

export class UnknownProviderRouteError extends HooksentinelError {
  readonly code = 'unknown_provider_route';
  readonly httpStatus = 404;
  readonly retryable = false;

  constructor(message?: string) {
    super(
      message ??
        `hooksentinel router: no receiver registered for the requested provider. See ${docsUrl('unknown_provider_route')}`,
    );
  }

  static forKey(providerKey: string, registeredKeys: readonly string[]): UnknownProviderRouteError {
    return new UnknownProviderRouteError(
      `hooksentinel router: no receiver registered for "${providerKey}". Registered: [${registeredKeys.join(', ')}]. See ${docsUrl('unknown_provider_route')}`,
    );
  }

  static noKeyGiven(): UnknownProviderRouteError {
    return new UnknownProviderRouteError(
      `hooksentinel router: no provider key was given and autoDetect is disabled. Pass the provider key explicitly (e.g. from a /api/webhooks/[provider] path segment) or set autoDetect: true. See ${docsUrl('unknown_provider_route')}`,
    );
  }
}

export class AmbiguousProviderError extends HooksentinelError {
  readonly code = 'ambiguous_provider';
  readonly httpStatus = 400;
  readonly retryable = false;

  constructor(matchedKeys: readonly string[]) {
    super(
      matchedKeys.length === 0
        ? `hooksentinel router: autoDetect could not identify a provider for this request — no registered receiver's required headers were all present. Route explicitly instead (e.g. /api/webhooks/[provider]). See ${docsUrl('ambiguous_provider')}`
        : `hooksentinel router: autoDetect found multiple receivers whose required headers all matched this request ([${matchedKeys.join(', ')}]) — refusing to guess. Route explicitly instead, or ensure their header shapes don't overlap. See ${docsUrl('ambiguous_provider')}`,
    );
  }
}
