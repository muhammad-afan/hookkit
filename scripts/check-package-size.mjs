// Enforces the "unpacked install size" row of CLAUDE.md's §10 table — the
// one size-limit itself can't check, since size-limit measures specific bundled entry
// points, not the whole published tarball. Budget recalibrated the same way and for the
// same reason as .size-limit.js — see that file's header comment.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUDGET_BYTES = 530_000; // ~+17.5% over the measured 451,195 B baseline

// `npm pack --json`'s top-level shape changed between major npm versions: npm 10/11
// output an array (`[{ unpackedSize, ... }]`); npm 12+ output an object keyed by
// package name (`{ '@hooksentinel/core': { unpackedSize, ... } }`). Handle both.
const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT }).toString();
const parsed = JSON.parse(output);
const { unpackedSize } = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];

const actualKb = (unpackedSize / 1000).toFixed(1);
const budgetKb = (BUDGET_BYTES / 1000).toFixed(0);
console.log(`unpacked install size: ${actualKb} kB (budget: ${budgetKb} kB)`);

if (unpackedSize > BUDGET_BYTES) {
  console.error(
    `FAIL: unpacked install size ${unpackedSize} B exceeds the ${BUDGET_BYTES} B budget.`,
  );
  process.exit(1);
}
