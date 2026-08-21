import { afterEach, describe, expect, it } from 'vitest';
import { defaultJsonParse } from '../../src/core/pipeline.js';

/**
 * Internal test plan §10.2. The default JSON parser must never let a signed-but-
 * attacker-influenced payload pollute Object.prototype (or any other prototype) via
 * __proto__ / constructor / prototype keys — at any nesting depth, in any position.
 */
describe('§10.2 prototype pollution — defaultJsonParse', () => {
  // Belt-and-suspenders: if a guard above regressed and actually polluted
  // Object.prototype, every subsequent test in the process could silently see polluted
  // properties on plain object literals. Assert cleanliness after each test so a
  // regression fails loudly here, not as a mystery failure elsewhere in the suite.
  afterEach(() => {
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(({} as Record<string, unknown>).y).toBeUndefined();
  });

  it('19.1: a top-level __proto__ key does not pollute Object.prototype', () => {
    const raw = '{"__proto__":{"admin":true}}';
    const parsed = defaultJsonParse(new TextEncoder().encode(raw)) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(Object.hasOwn(parsed, '__proto__')).toBe(false);
  });

  it('19.2: {"constructor":{"prototype":{"x":1}}} is safe', () => {
    const raw = '{"constructor":{"prototype":{"x":1}}}';
    const parsed = defaultJsonParse(new TextEncoder().encode(raw)) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.hasOwn(parsed, 'constructor')).toBe(false);
  });

  it('19.3: nested __proto__ at depth 5 is safe', () => {
    const raw = JSON.stringify({
      a: { b: { c: { d: { __proto__: { polluted: true } } } } },
    });
    defaultJsonParse(new TextEncoder().encode(raw));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('19.3b: __proto__ pollution attempt inside an array element is safe', () => {
    const raw = '[{"__proto__":{"polluted":true}},{"a":1}]';
    const parsed = defaultJsonParse(new TextEncoder().encode(raw)) as unknown[];
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(parsed[0] as object, '__proto__')).toBe(false);
  });

  it('prototype key alone (not nested under constructor) is stripped', () => {
    const raw = '{"prototype":{"y":1}}';
    const parsed = defaultJsonParse(new TextEncoder().encode(raw)) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'prototype')).toBe(false);
  });

  it('a legitimate field literally named "admin" or "x" (not via __proto__) still parses normally', () => {
    const raw = '{"admin":true,"x":1}';
    const parsed = defaultJsonParse(new TextEncoder().encode(raw)) as Record<string, unknown>;
    expect(parsed.admin).toBe(true);
    expect(parsed.x).toBe(1);
  });

  it('does not throw on deeply nested legitimate JSON (no false-positive stripping)', () => {
    const raw = JSON.stringify({ a: { b: { c: { d: { e: 'safe' } } } } });
    const parsed = defaultJsonParse(new TextEncoder().encode(raw)) as {
      a: { b: { c: { d: { e: string } } } };
    };
    expect(parsed.a.b.c.d.e).toBe('safe');
  });
});
