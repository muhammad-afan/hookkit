import { hmacSign } from '../core/crypto.js';
import { base64ToBytes, bytesToBase64 } from '../core/encoding.js';
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

const SIGNATURE_HEADER = 'x-shopify-hmac-sha256';
const WEBHOOK_ID_HEADER = 'x-shopify-webhook-id';

async function verifyShopify(
  req: WebhookRequest,
  creds: WebhookCredentials,
  opts?: VerifyOptions,
): Promise<VerifyResult> {
  if (creds.type !== 'secret') {
    return { ok: false, error: new InvalidSignatureError('shopify') };
  }

  const header = req.headers[SIGNATURE_HEADER];
  if (!header) {
    return { ok: false, error: new MissingSignatureHeaderError('shopify', SIGNATURE_HEADER) };
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = base64ToBytes(header);
  } catch {
    return { ok: false, error: new MalformedSignatureHeaderError('shopify', SIGNATURE_HEADER) };
  }

  const ok = await hmacVerifyWithRotation({
    hash: 'SHA-256',
    primary: creds.secret,
    additional: opts?.additionalSecrets,
    signature: sigBytes,
    data: req.body,
  });

  if (!ok) {
    return { ok: false, error: new InvalidSignatureError('shopify') };
  }

  return { ok: true, eventId: null, timestamp: null };
}

async function signShopify(
  body: Uint8Array,
  creds: WebhookCredentials,
  opts?: TestSignOptions,
): Promise<{ headers: Record<string, string> }> {
  if (creds.type !== 'secret') {
    throw new Error('shopify.sign: credentials must be of type "secret"');
  }
  const sigBytes = await hmacSign('SHA-256', secretToRawBytes(creds.secret), body);
  return {
    headers: {
      [SIGNATURE_HEADER]: bytesToBase64(sigBytes),
      [WEBHOOK_ID_HEADER]: opts?.eventId ?? randomEventId(''),
    },
  };
}

export const shopify: ProviderAdapter = {
  name: 'shopify',
  requiredHeaders: [SIGNATURE_HEADER],
  defaultToleranceSeconds: null,
  extractEventId(req: WebhookRequest): string | null {
    return req.headers[WEBHOOK_ID_HEADER] ?? null;
  },
  verify: verifyShopify,
  sign: signShopify,
};
