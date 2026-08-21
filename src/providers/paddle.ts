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

const SIGNATURE_HEADER = 'paddle-signature';
const DEFAULT_TOLERANCE_SECONDS = 300;

function parseSignatureHeader(value: string): { ts: string; h1: string } | null {
  let ts: string | null = null;
  let h1: string | null = null;
  for (const pair of value.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (key === 'ts') ts = val;
    else if (key === 'h1') h1 = val;
  }
  if (ts === null || h1 === null) return null;
  return { ts, h1 };
}

async function verifyPaddle(
  req: WebhookRequest,
  creds: WebhookCredentials,
  opts?: VerifyOptions,
): Promise<VerifyResult> {
  if (creds.type !== 'secret') {
    return { ok: false, error: new InvalidSignatureError('paddle') };
  }

  const header = req.headers[SIGNATURE_HEADER];
  if (!header) {
    return { ok: false, error: new MissingSignatureHeaderError('paddle', SIGNATURE_HEADER) };
  }

  const parsed = parseSignatureHeader(header);
  if (!parsed) {
    return { ok: false, error: new MalformedSignatureHeaderError('paddle', SIGNATURE_HEADER) };
  }

  const timestampSeconds = Number.parseInt(parsed.ts, 10);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, error: new MalformedSignatureHeaderError('paddle', SIGNATURE_HEADER) };
  }

  const toleranceSeconds = opts?.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (toleranceSeconds <= 0) {
    throw new RangeError(
      'Paddle adapter: toleranceSeconds must be > 0. tolerance:0 disables replay protection.',
    );
  }

  const now = (opts?.now ?? Date.now)();
  if (!isWithinTolerance(timestampSeconds, toleranceSeconds, now)) {
    return { ok: false, error: new TimestampOutOfToleranceError('paddle', toleranceSeconds) };
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(parsed.h1);
  } catch {
    return { ok: false, error: new MalformedSignatureHeaderError('paddle', SIGNATURE_HEADER) };
  }

  const signedPayload = concatBytes(utf8ToBytes(`${parsed.ts}:`), req.body);

  const ok = await hmacVerifyWithRotation({
    hash: 'SHA-256',
    primary: creds.secret,
    additional: opts?.additionalSecrets,
    signature: sigBytes,
    data: signedPayload,
  });

  if (!ok) {
    return { ok: false, error: new InvalidSignatureError('paddle') };
  }

  return {
    ok: true,
    eventId: extractJsonStringField(req.body, 'event_id'),
    timestamp: timestampSeconds,
  };
}

async function signPaddle(
  body: Uint8Array,
  creds: WebhookCredentials,
  opts?: TestSignOptions,
): Promise<{ headers: Record<string, string> }> {
  if (creds.type !== 'secret') {
    throw new Error('paddle.sign: credentials must be of type "secret"');
  }
  const timestamp = opts?.timestamp ?? nowSeconds();
  const signedPayload = concatBytes(utf8ToBytes(`${timestamp}:`), body);
  const sigBytes = await hmacSign('SHA-256', secretToRawBytes(creds.secret), signedPayload);
  return { headers: { [SIGNATURE_HEADER]: `ts=${timestamp};h1=${bytesToHex(sigBytes)}` } };
}

export const paddle: ProviderAdapter = {
  name: 'paddle',
  requiredHeaders: [SIGNATURE_HEADER],
  defaultToleranceSeconds: DEFAULT_TOLERANCE_SECONDS,
  extractEventId(req: WebhookRequest): string | null {
    return extractJsonStringField(req.body, 'event_id');
  },
  verify: verifyPaddle,
  sign: signPaddle,
};
