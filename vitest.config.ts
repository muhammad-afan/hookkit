import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Bun/Deno-only runtime smoke tests — run by `bun test` / `deno run` in CI's `runtimes`
    // job (test/runtime/smoke.test.ts, test/runtime/smoke.deno.ts), not by vitest/Node.
    exclude: ['test/runtime/smoke.test.ts', 'test/runtime/smoke.deno.ts', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        // hooksentinel-testing.md §12: every uncovered branch in crypto or an adapter is a
        // code path an attacker might reach that's never been observed.
        'src/core/crypto.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/providers/*.ts': { branches: 100 },
      },
    },
  },
});
