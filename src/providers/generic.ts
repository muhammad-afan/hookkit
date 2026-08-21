import { hmacSign } from '../core/crypto.js';
import type { HmacHash } from '../core/crypto.js';
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes, toBytes } from '../core/encoding.js';
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
import { hmacVerifyWithRotation, secretToRawBytes } from './_shared.js';

export type GenericAlgorithm = 'sha1' | 'sha256' | 'sha512';
export type GenericEncoding = 'hex' | 'base64';

const ALGORITHM_TO_HASH: Record<GenericAlgorithm, HmacHash> = {
  sha1: 'SHA-1',
  sha256: 'SHA-256',
  sha512: 'SHA-512',
};

export interface GenericSignedPayloadContext {
  readonly body: Uint8Array;
  readonly headers: Record<string, string>;
  readonly url?: string | undefined;
  readonly timestamp?: string | undefined;
}

export interface GenericAdapterConfig {
  readonly name: string;
  readonly signatureHeader: string;
  readonly algorithm: GenericAlgorithm;
  readonly encoding: GenericEncoding;
  /** e.g. "sha256=" — stripped from the header value before decoding. */
  readonly prefix?: string;
  readonly timestampHeader?: string;
  /** Only enforced if provided — this escape hatch does not assume every scheme is timestamped. */
  readonly toleranceSeconds?: number;
  /** Build the exact bytes that were signed. */
  readonly buildSignedPayload: (ctx: GenericSignedPayloadContext) => Uint8Array | string;
  readonly eventIdHeader?: string;
}

function decodeSignature(value: string, encoding: GenericEncoding): Uint8Array {
  return encoding === 'hex' ? hexToBytes(value) : base64ToBytes(value);
}

function encodeSignature(bytes: Uint8Array, encoding: GenericEncoding): string {
  return encoding === 'hex' ? bytesToHex(bytes) : bytesToBase64(bytes);
}

/**
 * Build-your-own adapter for a provider hookforge doesn't ship yet. Config-driven: you
 * supply the header shape, algorithm, and exactly how the signed bytes are constructed
 * — hookforge still handles decoding, the HMAC comparison (`subtle.verify`, constant-
 * time), secret rotation, and (if configured) the replay-tolerance window.
 *
 * Only HMAC-based schemes are supported here — for asymmetric (Ed25519/ECDSA) or
 * network-verified (PayPal-style) providers, write a dedicated `ProviderAdapter`
 * instead; this escape hatch does not cover those shapes.
 */
export function createGenericAdapter(config: GenericAdapterConfig): ProviderAdapter {
  const hash = ALGORITHM_TO_HASH[config.algorithm];
  const requiredHeaders = config.timestampHeader
    ? [config.signatureHeader, config.timestampHeader]
    : [config.signatureHeader];

  async function verify(
    req: WebhookRequest,
    creds: WebhookCredentials,
    opts?: VerifyOptions,
  ): Promise<VerifyResult> {
    if (creds.type !== 'secret') {
      return { ok: false, error: new InvalidSignatureError(config.name) };
    }

    const header = req.headers[config.signatureHeader];
    if (!header) {
      return {
        ok: false,
        error: new MissingSignatureHeaderError(config.name, config.signatureHeader),
      };
    }

    let value = header;
    if (config.prefix) {
      if (!value.startsWith(config.prefix)) {
        return {
          ok: false,
          error: new MalformedSignatureHeaderError(config.name, config.signatureHeader),
        };
      }
      value = value.slice(config.prefix.length);
    }

    let sigBytes: Uint8Array;
    try {
      sigBytes = decodeSignature(value, config.encoding);
    } catch {
      return {
        ok: false,
        error: new MalformedSignatureHeaderError(config.name, config.signatureHeader),
      };
    }

    let timestamp: string | undefined;
    let timestampSeconds: number | null = null;
    if (config.timestampHeader) {
      timestamp = req.headers[config.timestampHeader];
      if (!timestamp) {
        return {
          ok: false,
          error: new MissingSignatureHeaderError(config.name, config.timestampHeader),
        };
      }

      if (config.toleranceSeconds !== undefined) {
        timestampSeconds = Number.parseInt(timestamp, 10);
        if (!Number.isFinite(timestampSeconds)) {
          return {
            ok: false,
            error: new MalformedSignatureHeaderError(config.name, config.timestampHeader),
          };
        }

        const toleranceSeconds = opts?.toleranceSeconds ?? config.toleranceSeconds;
        if (toleranceSeconds <= 0) {
          throw new RangeError(
            `${config.name} adapter: toleranceSeconds must be > 0. tolerance:0 disables replay protection.`,
          );
        }

        const now = (opts?.now ?? Date.now)();
        if (!isWithinTolerance(timestampSeconds, toleranceSeconds, now)) {
          return {
            ok: false,
            error: new TimestampOutOfToleranceError(config.name, toleranceSeconds),
          };
        }
      }
    }

    const rawSignedPayload = config.buildSignedPayload({
      body: req.body,
      headers: req.headers,
      url: req.url,
      timestamp,
    });
    const signedPayload = toBytes(rawSignedPayload);

    const ok = await hmacVerifyWithRotation({
      hash,
      primary: creds.secret,
      additional: opts?.additionalSecrets,
      signature: sigBytes,
      data: signedPayload,
    });

    if (!ok) {
      return { ok: false, error: new InvalidSignatureError(config.name) };
    }

    const eventId = config.eventIdHeader ? (req.headers[config.eventIdHeader] ?? null) : null;
    return { ok: true, eventId, timestamp: timestampSeconds };
  }

  async function sign(
    body: Uint8Array,
    creds: WebhookCredentials,
    opts?: TestSignOptions,
  ): Promise<{ headers: Record<string, string> }> {
    if (creds.type !== 'secret') {
      throw new Error(`${config.name}.sign: credentials must be of type "secret"`);
    }

    const timestamp = config.timestampHeader
      ? String(opts?.timestamp ?? Math.floor(Date.now() / 1000))
      : undefined;

    const rawSignedPayload = config.buildSignedPayload({
      body,
      headers: {},
      url: opts?.url,
      timestamp,
    });
    const signedPayload = toBytes(rawSignedPayload);
    const sigBytes = await hmacSign(hash, secretToRawBytes(creds.secret), signedPayload);
    const encoded = `${config.prefix ?? ''}${encodeSignature(sigBytes, config.encoding)}`;

    const headers: Record<string, string> = { [config.signatureHeader]: encoded };
    if (config.timestampHeader && timestamp !== undefined) {
      headers[config.timestampHeader] = timestamp;
    }
    if (config.eventIdHeader && opts?.eventId) {
      headers[config.eventIdHeader] = opts.eventId;
    }
    return { headers };
  }

  return {
    name: config.name,
    requiredHeaders,
    defaultToleranceSeconds: config.toleranceSeconds ?? null,
    extractEventId(req: WebhookRequest): string | null {
      return config.eventIdHeader ? (req.headers[config.eventIdHeader] ?? null) : null;
    },
    verify,
    sign,
  };
}
