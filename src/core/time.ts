/** Default clock. Overridable via VerifyOptions.now for deterministic tests. */
export function defaultNow(): number {
  return Date.now();
}

/**
 * Check whether a provider timestamp (in seconds since epoch) falls within
 * toleranceSeconds of "now". A tolerance of 0 disables replay protection and
 * must never be silently allowed by an adapter.
 */
export function isWithinTolerance(
  timestampSeconds: number,
  toleranceSeconds: number,
  nowMs: number,
): boolean {
  const nowSeconds = nowMs / 1000;
  const diff = Math.abs(nowSeconds - timestampSeconds);
  return diff <= toleranceSeconds;
}
