import { ed25519SignWithPkcs8, ed25519Verify } from '../core/crypto.js';
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
import { extractJsonStringField, nowSeconds } from './_shared.js';

const SIGNATURE_HEADER = 'x-signature-ed25519';
const TIMESTAMP_HEADER = 'x-signature-timestamp';
// 60s, not Stripe's conventional 300s — see the doc comment on `discord` below for why
// this default is deliberately tight rather than borrowed from another adapter.
const DEFAULT_TOLERANCE_SECONDS = 60;

function decodeEd25519Key(key: string | Uint8Array, label: string): Uint8Array {
  if (typeof key !== 'string') return key;
  try {
    return hexToBytes(key);
  } catch {
    throw new RangeError(`discord adapter: ${label} must be valid hex-encoded bytes`);
  }
}

async function verifyDiscord(
  req: WebhookRequest,
  creds: WebhookCredentials,
  opts?: VerifyOptions,
): Promise<VerifyResult> {
  if (creds.type !== 'publicKey') {
    return { ok: false, error: new InvalidSignatureError('discord') };
  }

  const sigHeader = req.headers[SIGNATURE_HEADER];
  if (!sigHeader) {
    return { ok: false, error: new MissingSignatureHeaderError('discord', SIGNATURE_HEADER) };
  }
  const timestamp = req.headers[TIMESTAMP_HEADER];
  if (!timestamp) {
    return { ok: false, error: new MissingSignatureHeaderError('discord', TIMESTAMP_HEADER) };
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(sigHeader);
  } catch {
    return { ok: false, error: new MalformedSignatureHeaderError('discord', SIGNATURE_HEADER) };
  }

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, error: new MalformedSignatureHeaderError('discord', TIMESTAMP_HEADER) };
  }

  const toleranceSeconds = opts?.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (toleranceSeconds <= 0) {
    throw new RangeError(
      'Discord adapter: toleranceSeconds must be > 0. tolerance:0 disables replay protection.',
    );
  }

  const now = (opts?.now ?? Date.now)();
  if (!isWithinTolerance(timestampSeconds, toleranceSeconds, now)) {
    return { ok: false, error: new TimestampOutOfToleranceError('discord', toleranceSeconds) };
  }

  // Config error — a bad publicKey is the developer's mistake, not a forged request.
  // Fail loud and synchronously, matching toleranceSeconds:0's precedent, rather than
  // silently rejecting every request as "invalid signature" until someone notices.
  const publicKeyBytes = decodeEd25519Key(creds.publicKey, 'credentials.publicKey');

  // No separator: `${timestamp}${rawBody}`.
  const signedPayload = concatBytes(utf8ToBytes(timestamp), req.body);

  const ok = await ed25519Verify(publicKeyBytes, sigBytes, signedPayload);
  if (!ok) {
    return { ok: false, error: new InvalidSignatureError('discord') };
  }

  // Discord does not send a dedicated event-id header; interaction payloads carry a
  // top-level "id" field. Return null (triggering the body-hash fallback) if absent —
  // e.g. for a PING payload, which callers must handle themselves; this adapter
  // verifies it like any other request and does not special-case it.
  return { ok: true, eventId: extractJsonStringField(req.body, 'id'), timestamp: timestampSeconds };
}

async function signDiscord(
  body: Uint8Array,
  creds: WebhookCredentials,
  opts?: TestSignOptions,
): Promise<{ headers: Record<string, string> }> {
  if (creds.type !== 'publicKey') {
    throw new Error(
      'discord.sign: credentials must be of type "publicKey", holding the PRIVATE key (PKCS8, hex-encoded) in the `publicKey` field — see generateDiscordTestKeyPair().',
    );
  }
  const timestamp = String(opts?.timestamp ?? nowSeconds());
  const signedPayload = concatBytes(utf8ToBytes(timestamp), body);
  const privateKeyBytes = decodeEd25519Key(
    creds.publicKey,
    'credentials.publicKey (private key for signing)',
  );
  const sigBytes = await ed25519SignWithPkcs8(privateKeyBytes, signedPayload);
  return {
    headers: {
      [SIGNATURE_HEADER]: bytesToHex(sigBytes),
      [TIMESTAMP_HEADER]: timestamp,
    },
  };
}

/**
 * Discord (Ed25519 interactions).
 *
 * **The replay-tolerance check is a hookkit addition, not a Discord requirement.**
 * Discord's own verification docs only check signature validity — they don't check
 * timestamp freshness at all, because Discord enforces a 3-second interaction-response
 * window on their end: a captured-and-replayed interaction would almost always be
 * rejected as "already acknowledged" or simply be too late to matter, making a
 * timestamp check redundant from Discord's point of view.
 *
 * hookkit checks it anyway, because the timestamp is already part of the signed bytes
 * (`${timestamp}${rawBody}`) — enforcing a window costs nothing extra and closes an
 * otherwise-open door: without it, a captured request could be replayed indefinitely
 * against *your* endpoint, independent of whatever Discord itself does. This is
 * defense-in-depth, not a documented Discord behavior — if you diff hookkit's behavior
 * against Discord's own docs, this is the difference you're seeing.
 *
 * The default tolerance is 60s, not the 300s convention used by Stripe/Slack/Standard/
 * Paddle here. Those providers can genuinely retry deliveries over several minutes, so
 * a wide window absorbs real-world latency. Discord cannot — every legitimate
 * interaction is acknowledged within 3 seconds by construction, so a timestamp arriving
 * minutes late is never a legitimate late delivery, only a replay. 60s already leaves
 * generous headroom over normal network/processing lag while keeping the replay window
 * meaningfully tight instead of copying a convention sized for a different provider's
 * retry model. Override via `VerifyOptions.toleranceSeconds` like any other adapter.
 */
export const discord: ProviderAdapter = {
  name: 'discord',
  requiredHeaders: [SIGNATURE_HEADER, TIMESTAMP_HEADER],
  defaultToleranceSeconds: DEFAULT_TOLERANCE_SECONDS,
  extractEventId(req: WebhookRequest): string | null {
    return extractJsonStringField(req.body, 'id');
  },
  verify: verifyDiscord,
  sign: signDiscord,
};

/**
 * Generates a real Ed25519 keypair for testing Discord webhook handlers, without
 * needing a live Discord application. Web Crypto (at least in current Node) cannot
 * export a raw Ed25519 private key, only PKCS8 — so this returns the private half
 * PKCS8-encoded, hex-encoded for convenience.
 *
 * `publicKey` is what you'd configure on a real Discord app and pass to `verify()`'s
 * credentials. `privateKeyForSigning` is passed to `createTestSigner(discord, {
 * type: 'publicKey', publicKey: privateKeyForSigning })` — sign() and verify()
 * intentionally take the same credentials shape, using whichever half of the keypair
 * is appropriate for that operation.
 *
 * @example
 * const { publicKey, privateKeyForSigning } = await generateDiscordTestKeyPair();
 * const signer = createTestSigner(discord, { type: 'publicKey', publicKey: privateKeyForSigning });
 * const signed = await signer.sign(JSON.stringify({ type: 1 }));
 * const result = await discord.verify(signed, { type: 'publicKey', publicKey });
 */
export async function generateDiscordTestKeyPair(): Promise<{
  publicKey: string;
  privateKeyForSigning: string;
}> {
  const keyPair = (await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKeyRaw = await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey);
  const privateKeyPkcs8 = await globalThis.crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  return {
    publicKey: bytesToHex(new Uint8Array(publicKeyRaw)),
    privateKeyForSigning: bytesToHex(new Uint8Array(privateKeyPkcs8)),
  };
}
