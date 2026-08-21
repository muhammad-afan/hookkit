import { hmacSign } from '../core/crypto.js';
import { bytesToHex, hexToBytes } from '../core/encoding.js';
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
import { hmacVerifyWithRotation, randomEventId, secretToRawBytes } from './_shared.js';

const SIGNATURE_HEADER = 'x-hub-signature-256';
const DELIVERY_HEADER = 'x-github-delivery';
const PREFIX = 'sha256=';

async function verifyGithub(
  req: WebhookRequest,
  creds: WebhookCredentials,
  opts?: VerifyOptions,
): Promise<VerifyResult> {
  if (creds.type !== 'secret') {
    return { ok: false, error: new InvalidSignatureError('github') };
  }

  const header = req.headers[SIGNATURE_HEADER];
  if (!header) {
    return { ok: false, error: new MissingSignatureHeaderError('github', SIGNATURE_HEADER) };
  }

  if (!header.startsWith(PREFIX)) {
    return { ok: false, error: new MalformedSignatureHeaderError('github', SIGNATURE_HEADER) };
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(header.slice(PREFIX.length));
  } catch {
    return { ok: false, error: new MalformedSignatureHeaderError('github', SIGNATURE_HEADER) };
  }

  const ok = await hmacVerifyWithRotation({
    hash: 'SHA-256',
    primary: creds.secret,
    additional: opts?.additionalSecrets,
    signature: sigBytes,
    data: req.body,
  });

  if (!ok) {
    return { ok: false, error: new InvalidSignatureError('github') };
  }

  return { ok: true, eventId: null, timestamp: null };
}

async function signGithub(
  body: Uint8Array,
  creds: WebhookCredentials,
  opts?: TestSignOptions,
): Promise<{ headers: Record<string, string> }> {
  if (creds.type !== 'secret') {
    throw new Error('github.sign: credentials must be of type "secret"');
  }
  const sigBytes = await hmacSign('SHA-256', secretToRawBytes(creds.secret), body);
  return {
    headers: {
      [SIGNATURE_HEADER]: `${PREFIX}${bytesToHex(sigBytes)}`,
      [DELIVERY_HEADER]: opts?.eventId ?? randomEventId(''),
    },
  };
}

export const github: ProviderAdapter = {
  name: 'github',
  requiredHeaders: [SIGNATURE_HEADER],
  defaultToleranceSeconds: null,
  extractEventId(req: WebhookRequest): string | null {
    return req.headers[DELIVERY_HEADER] ?? null;
  },
  verify: verifyGithub,
  sign: signGithub,
};
