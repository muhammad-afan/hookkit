import { hmacSign } from '../core/crypto.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '../core/encoding.js';
import {
  InvalidSignatureError,
  MalformedSignatureHeaderError,
  MissingSignatureHeaderError,
  TimestampOutOfToleranceError,
} from '../core/errors.js';
import { isWithinTolerance } from '../core/time.js';
import type {
  ProviderAdapter,
  TestSignOptions,
  VerifyOptions,
  VerifyResult,
  WebhookCredentials,
  WebhookRequest,
} from '../core/types.js';
import {
  extractJsonStringField,
  hmacVerifyWithRotation,
  nowSeconds,
  secretToRawBytes,
} from './_shared.js';

const SIGNATURE_HEADER = 'x-slack-signature';
const TIMESTAMP_HEADER = 'x-slack-request-timestamp';
const PREFIX = 'v0=';
const DEFAULT_TOLERANCE_SECONDS = 300;

async function verifySlack(
  req: WebhookRequest,
  creds: WebhookCredentials,
  opts?: VerifyOptions,
): Promise<VerifyResult> {
  if (creds.type !== 'secret') {
    return { ok: false, error: new InvalidSignatureError('slack') };
  }

  const header = req.headers[SIGNATURE_HEADER];
  if (!header) {
    return { ok: false, error: new MissingSignatureHeaderError('slack', SIGNATURE_HEADER) };
  }

  const timestamp = req.headers[TIMESTAMP_HEADER];
  if (!timestamp) {
    return { ok: false, error: new MissingSignatureHeaderError('slack', TIMESTAMP_HEADER) };
  }

  if (!header.startsWith(PREFIX)) {
    return { ok: false, error: new MalformedSignatureHeaderError('slack', SIGNATURE_HEADER) };
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(header.slice(PREFIX.length));
  } catch {
    return { ok: false, error: new MalformedSignatureHeaderError('slack', SIGNATURE_HEADER) };
  }

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, error: new MalformedSignatureHeaderError('slack', TIMESTAMP_HEADER) };
  }

  const toleranceSeconds = opts?.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (toleranceSeconds <= 0) {
    throw new RangeError(
      'Slack adapter: toleranceSeconds must be > 0. tolerance:0 disables replay protection.',
    );
  }

  const now = (opts?.now ?? Date.now)();
  if (!isWithinTolerance(timestampSeconds, toleranceSeconds, now)) {
    return { ok: false, error: new TimestampOutOfToleranceError('slack', toleranceSeconds) };
  }

  // Signed over the raw bytes regardless of content-type — Slack sends both
  // application/x-www-form-urlencoded (slash commands) and application/json (Events
  // API). Never parse the body before verifying.
  const signedPayload = concatBytes(utf8ToBytes(`v0:${timestamp}:`), req.body);

  const ok = await hmacVerifyWithRotation({
    hash: 'SHA-256',
    primary: creds.secret,
    additional: opts?.additionalSecrets,
    signature: sigBytes,
    data: signedPayload,
  });

  if (!ok) {
    return { ok: false, error: new InvalidSignatureError('slack') };
  }

  return { ok: true, eventId: null, timestamp: timestampSeconds };
}

async function signSlack(
  body: Uint8Array,
  creds: WebhookCredentials,
  opts?: TestSignOptions,
): Promise<{ headers: Record<string, string> }> {
  if (creds.type !== 'secret') {
    throw new Error('slack.sign: credentials must be of type "secret"');
  }
  const timestamp = opts?.timestamp ?? nowSeconds();
  const signedPayload = concatBytes(utf8ToBytes(`v0:${timestamp}:`), body);
  const sigBytes = await hmacSign('SHA-256', secretToRawBytes(creds.secret), signedPayload);
  return {
    headers: {
      [SIGNATURE_HEADER]: `${PREFIX}${bytesToHex(sigBytes)}`,
      [TIMESTAMP_HEADER]: String(timestamp),
    },
  };
}

export const slack: ProviderAdapter = {
  name: 'slack',
  requiredHeaders: [SIGNATURE_HEADER, TIMESTAMP_HEADER],
  defaultToleranceSeconds: DEFAULT_TOLERANCE_SECONDS,
  extractEventId(req: WebhookRequest): string | null {
    return extractJsonStringField(req.body, 'event_id');
  },
  verify: verifySlack,
  sign: signSlack,
};
