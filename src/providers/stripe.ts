import { hmacSign } from '../core/crypto.js';
import { bytesToHex, hexToBytes } from '../core/encoding.js';
import { concatBytes, utf8ToBytes } from '../core/encoding.js';
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

const SIGNATURE_HEADER = 'stripe-signature';
const DEFAULT_TOLERANCE_SECONDS = 300;

function parseSignatureHeader(value: string): { timestamp: string; v1Signatures: string[] } | null {
  let timestamp: string | null = null;
  const v1Signatures: string[] = [];
  for (const pair of value.split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (key === 't') timestamp = val;
    else if (key === 'v1') v1Signatures.push(val);
  }
  if (timestamp === null || v1Signatures.length === 0) return null;
  return { timestamp, v1Signatures };
}

async function verifyStripe(
  req: WebhookRequest,
  creds: WebhookCredentials,
  opts?: VerifyOptions,
): Promise<VerifyResult> {
  if (creds.type !== 'secret') {
    return { ok: false, error: new InvalidSignatureError('stripe') };
  }

  const header = req.headers[SIGNATURE_HEADER];
  if (!header) {
    return { ok: false, error: new MissingSignatureHeaderError('stripe', SIGNATURE_HEADER) };
  }

  const parsed = parseSignatureHeader(header);
  if (!parsed) {
    return { ok: false, error: new MalformedSignatureHeaderError('stripe', SIGNATURE_HEADER) };
  }

  const timestampSeconds = Number.parseInt(parsed.timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, error: new MalformedSignatureHeaderError('stripe', SIGNATURE_HEADER) };
  }

  const toleranceSeconds = opts?.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (toleranceSeconds <= 0) {
    throw new RangeError(
      'Stripe adapter: toleranceSeconds must be > 0. tolerance:0 disables replay protection.',
    );
  }

  const now = (opts?.now ?? Date.now)();
  if (!isWithinTolerance(timestampSeconds, toleranceSeconds, now)) {
    return { ok: false, error: new TimestampOutOfToleranceError('stripe', toleranceSeconds) };
  }

  const signedPayload = concatBytes(utf8ToBytes(`${parsed.timestamp}.`), req.body);

  let matched = false;
  for (const sigHex of parsed.v1Signatures) {
    let sigBytes: Uint8Array;
    try {
      sigBytes = hexToBytes(sigHex);
    } catch {
      continue;
    }
    const ok = await hmacVerifyWithRotation({
      hash: 'SHA-256',
      primary: creds.secret,
      additional: opts?.additionalSecrets,
      signature: sigBytes,
      data: signedPayload,
    });
    if (ok) {
      matched = true;
      break;
    }
  }

  if (!matched) {
    return { ok: false, error: new InvalidSignatureError('stripe') };
  }

  return { ok: true, eventId: null, timestamp: timestampSeconds };
}

async function signStripe(
  body: Uint8Array,
  creds: WebhookCredentials,
  opts?: TestSignOptions,
): Promise<{ headers: Record<string, string> }> {
  if (creds.type !== 'secret') {
    throw new Error('stripe.sign: credentials must be of type "secret"');
  }
  const timestamp = opts?.timestamp ?? nowSeconds();
  const signedPayload = concatBytes(utf8ToBytes(`${timestamp}.`), body);
  const sigBytes = await hmacSign('SHA-256', secretToRawBytes(creds.secret), signedPayload);
  return { headers: { [SIGNATURE_HEADER]: `t=${timestamp},v1=${bytesToHex(sigBytes)}` } };
}

export const stripe: ProviderAdapter = {
  name: 'stripe',
  requiredHeaders: [SIGNATURE_HEADER],
  defaultToleranceSeconds: DEFAULT_TOLERANCE_SECONDS,
  extractEventId(req: WebhookRequest): string | null {
    return extractJsonStringField(req.body, 'id');
  },
  verify: verifyStripe,
  sign: signStripe,
};
