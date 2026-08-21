import { hmacSign, sha256 } from '../core/crypto.js';
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  utf8ToBytes,
} from '../core/encoding.js';
import {
  InvalidSignatureError,
  MalformedSignatureHeaderError,
  MissingSignatureHeaderError,
} from '../core/errors.js';
import type {
  ProviderAdapter,
  TestSignOptions,
  VerifyOptions,
  VerifyResult,
  WebhookCredentials,
  WebhookRequest,
} from '../core/types.js';
import { hmacVerifyWithRotation, secretToRawBytes } from './_shared.js';

const SIGNATURE_HEADER = 'x-twilio-signature';

/**
 * Parse an application/x-www-form-urlencoded body into [key, value] pairs, sorted by
 * key using plain UTF-16 code-unit ordering (Twilio's own algorithm — never locale-
 * aware collation, which can silently reorder keys with identical prefixes).
 */
function parseSortedFormParams(body: Uint8Array): [string, string][] {
  const text = bytesToUtf8(body);
  const params = new URLSearchParams(text);
  const entries = [...params.entries()];
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries;
}

function isFormEncoded(contentType: string | undefined): boolean {
  return (contentType ?? '').toLowerCase().includes('application/x-www-form-urlencoded');
}

/**
 * Build the exact bytes Twilio signs.
 *
 * Form-encoded body: the full request URL, then every POST param appended as
 * `key + value` (no separators), sorted alphabetically by key.
 *
 * Non-form body (e.g. JSON): the full request URL with a hex-encoded SHA-256 hash of
 * the body appended.
 *
 * The URL MUST be the exact URL Twilio requested — behind a proxy/load balancer this is
 * frequently NOT what `req.url` reports by default (http vs https, internal hostname).
 * Pass the corrected URL explicitly via `WebhookRequest.url` — reconstruct it from
 * `x-forwarded-proto` / `x-forwarded-host` if you're behind a proxy. There is no
 * separate "override" API: `WebhookRequest.url` *is* the override.
 */
async function buildSignedPayload(
  url: string,
  body: Uint8Array,
  contentType: string | undefined,
): Promise<Uint8Array> {
  if (isFormEncoded(contentType)) {
    let combined = url;
    for (const [key, value] of parseSortedFormParams(body)) {
      combined += key + value;
    }
    return utf8ToBytes(combined);
  }
  const digest = await sha256(body);
  return utf8ToBytes(url + bytesToHex(digest));
}

/**
 * Best-effort event id: Twilio's own resource identifiers, when present in a form body.
 * No try/catch here — `URLSearchParams` parsing of a string is defined to never throw,
 * and `bytesToUtf8` decodes leniently (fatal: false), so there is no error path to catch.
 */
function extractTwilioEventId(req: WebhookRequest): string | null {
  if (!isFormEncoded(req.headers['content-type'])) return null;
  const params = new URLSearchParams(bytesToUtf8(req.body));
  return params.get('MessageSid') ?? params.get('CallSid') ?? params.get('SmsSid') ?? null;
}

async function verifyTwilio(
  req: WebhookRequest,
  creds: WebhookCredentials,
  opts?: VerifyOptions,
): Promise<VerifyResult> {
  if (creds.type !== 'secret') {
    return { ok: false, error: new InvalidSignatureError('twilio') };
  }

  const header = req.headers[SIGNATURE_HEADER];
  if (!header) {
    return { ok: false, error: new MissingSignatureHeaderError('twilio', SIGNATURE_HEADER) };
  }

  if (!req.url) {
    return { ok: false, error: new MalformedSignatureHeaderError('twilio', SIGNATURE_HEADER) };
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = base64ToBytes(header);
  } catch {
    return { ok: false, error: new MalformedSignatureHeaderError('twilio', SIGNATURE_HEADER) };
  }

  const signedPayload = await buildSignedPayload(req.url, req.body, req.headers['content-type']);

  const ok = await hmacVerifyWithRotation({
    hash: 'SHA-1',
    primary: creds.secret,
    additional: opts?.additionalSecrets,
    signature: sigBytes,
    data: signedPayload,
  });

  if (!ok) {
    return { ok: false, error: new InvalidSignatureError('twilio') };
  }

  return { ok: true, eventId: extractTwilioEventId(req), timestamp: null };
}

async function signTwilio(
  body: Uint8Array,
  creds: WebhookCredentials,
  opts?: TestSignOptions,
): Promise<{ headers: Record<string, string> }> {
  if (creds.type !== 'secret') {
    throw new Error('twilio.sign: credentials must be of type "secret"');
  }
  const url = opts?.url;
  if (!url) {
    throw new Error(
      'twilio.sign: opts.url is required — Twilio signatures are bound to the exact request URL',
    );
  }
  // sign() has no explicit content-type input; infer it the same way a caller's real
  // body would present itself — valid JSON is treated as a JSON body, anything else as
  // form-encoded (Twilio's actual webhook bodies are form-encoded almost universally).
  let contentType: string;
  try {
    JSON.parse(bytesToUtf8(body));
    contentType = 'application/json';
  } catch {
    contentType = 'application/x-www-form-urlencoded';
  }

  const signedPayload = await buildSignedPayload(url, body, contentType);
  const sigBytes = await hmacSign('SHA-1', secretToRawBytes(creds.secret), signedPayload);
  return { headers: { [SIGNATURE_HEADER]: bytesToBase64(sigBytes) } };
}

export const twilio: ProviderAdapter = {
  name: 'twilio',
  requiredHeaders: [SIGNATURE_HEADER],
  defaultToleranceSeconds: null,
  extractEventId: extractTwilioEventId,
  verify: verifyTwilio,
  sign: signTwilio,
};
