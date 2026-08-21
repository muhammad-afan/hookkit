import { describe, expect, it } from 'vitest';
import { isWithinTolerance } from '../../src/core/time.js';

describe('isWithinTolerance', () => {
  it('accepts a timestamp within the window', () => {
    const nowMs = 1_700_000_000_000;
    const timestampSeconds = nowMs / 1000 - 100;
    expect(isWithinTolerance(timestampSeconds, 300, nowMs)).toBe(true);
  });

  it('rejects a timestamp outside the window', () => {
    const nowMs = 1_700_000_000_000;
    const timestampSeconds = nowMs / 1000 - 301;
    expect(isWithinTolerance(timestampSeconds, 300, nowMs)).toBe(false);
  });

  it('accepts a future timestamp within tolerance (clock skew)', () => {
    const nowMs = 1_700_000_000_000;
    const timestampSeconds = nowMs / 1000 + 100;
    expect(isWithinTolerance(timestampSeconds, 300, nowMs)).toBe(true);
  });

  it('is inclusive at the exact boundary', () => {
    const nowMs = 1_700_000_000_000;
    const timestampSeconds = nowMs / 1000 - 300;
    expect(isWithinTolerance(timestampSeconds, 300, nowMs)).toBe(true);
  });
});
