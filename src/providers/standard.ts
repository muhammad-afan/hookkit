import { hmacSign } from '../core/crypto.js';
import { base64ToBytes, bytesToBase64, concatBytes, utf8ToBytes } from '../core/encoding.js';
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
import { hmacVerifyWithRotation, nowSeconds, randomEventId } from './_shared.js';

const ID_HEADER = 'webhook-id';
const TIMESTAMP_HEADER = 'webhook-timestamp';
const SIGNATURE_HEADER = 'webhook-signature';
const SVIX_ID_HEADER = 'svix-id';
const SVIX_TIMESTAMP_HEADER = 'svix-timestamp';
const SVIX_SIGNATURE_HEADER = 'svix-signature';
const DEFAULT_TOLERANCE_SECONDS = 300;
const SECRET_PREFIX = 'whsec_';

function readHeader(req: WebhookRequest, primary: string, alias: string): string | undefined {
  return req.headers[primary] ?? req.headers[alias];
}

/** Strip the "whsec_" prefix, then base64-decode the remainder to get raw key bytes. */
function deriveKeyBytes(secret: string | Uint8Array): Uint8Array {
  if (typeof secret !== 'string') return secret;
  const stripped = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  return base64ToBytes(stripped);
}

async function verifyStandard(
  req: WebhookRequest,
  creds: WebhookCredentials,
  opts?: VerifyOptions,
): Promise<VerifyResult> {
  if (creds.type !== 'secret') {
    return { ok: false, error: new InvalidSignatureError('standard') };
  }

  const id = readHeader(req, ID_HEADER, SVIX_ID_HEADER);
  const timestamp = readHeader(req, TIMESTAMP_HEADER, SVIX_TIMESTAMP_HEADER);
  const signatureHeader = readHeader(req, SIGNATURE_HEADER, SVIX_SIGNATURE_HEADER);

  if (!id) return { ok: false, error: new MissingSignatureHeaderError('standard', ID_HEADER) };
  if (!timestamp)
    return { ok: false, error: new MissingSignatureHeaderError('standard', TIMESTAMP_HEADER) };
  if (!signatureHeader)
    return { ok: false, error: new MissingSignatureHeaderError('standard', SIGNATURE_HEADER) };

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, error: new MalformedSignatureHeaderError('standard', TIMESTAMP_HEADER) };
  }

  const toleranceSeconds = opts?.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (toleranceSeconds <= 0) {
    throw new RangeError('Standard Webhooks adapter: toleranceSeconds must be > 0.');
  }

  const now = (opts?.now ?? Date.now)();
  if (!isWithinTolerance(timestampSeconds, toleranceSeconds, now)) {
    return { ok: false, error: new TimestampOutOfToleranceError('standard', toleranceSeconds) };
  }

  const candidates = signatureHeader
    .split(' ')
    .map((s) => s.trim())
    .filter(Boolean);

  const v1Sigs: Uint8Array[] = [];
  for (const candidate of candidates) {
    const comma = candidate.indexOf(',');
    if (comma === -1) continue;
    const version = candidate.slice(0, comma);
    const value = candidate.slice(comma + 1);
    if (version !== 'v1') continue;
    try {
      v1Sigs.push(base64ToBytes(value));
    } catch {
      // skip malformed entries; a well-formed one may still match
    }
  }

  if (v1Sigs.length === 0) {
    return { ok: false, error: new MalformedSignatureHeaderError('standard', SIGNATURE_HEADER) };
  }

  const signedPayload = concatBytes(utf8ToBytes(`${id}.${timestamp}.`), req.body);

  let matched = false;
  for (const sigBytes of v1Sigs) {
    const ok = await hmacVerifyWithRotation({
      hash: 'SHA-256',
      primary: creds.secret,
      additional: opts?.additionalSecrets,
      signature: sigBytes,
      data: signedPayload,
      deriveKeyBytes,
    });
    if (ok) {
      matched = true;
      break;
    }
  }

  if (!matched) {
    return { ok: false, error: new InvalidSignatureError('standard') };
  }

  return { ok: true, eventId: id, timestamp: timestampSeconds };
}

async function signStandard(
  body: Uint8Array,
  creds: WebhookCredentials,
  opts?: TestSignOptions,
): Promise<{ headers: Record<string, string> }> {
  if (creds.type !== 'secret') {
    throw new Error('standard.sign: credentials must be of type "secret"');
  }
  const id = opts?.eventId ?? randomEventId('msg_');
  const timestamp = opts?.timestamp ?? nowSeconds();
  const signedPayload = concatBytes(utf8ToBytes(`${id}.${timestamp}.`), body);
  const sigBytes = await hmacSign('SHA-256', deriveKeyBytes(creds.secret), signedPayload);
  return {
    headers: {
      [ID_HEADER]: id,
      [TIMESTAMP_HEADER]: String(timestamp),
      [SIGNATURE_HEADER]: `v1,${bytesToBase64(sigBytes)}`,
    },
  };
}

export const standard: ProviderAdapter = {
  name: 'standard',
  requiredHeaders: [ID_HEADER, TIMESTAMP_HEADER, SIGNATURE_HEADER],
  defaultToleranceSeconds: DEFAULT_TOLERANCE_SECONDS,
  extractEventId(req: WebhookRequest): string | null {
    return readHeader(req, ID_HEADER, SVIX_ID_HEADER) ?? null;
  },
  verify: verifyStandard,
  sign: signStandard,
};
