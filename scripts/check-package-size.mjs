// Enforces the "unpacked install size" row of hookkit-build-spec.md §10's table — the
// one size-limit itself can't check, since size-limit measures specific bundled entry
// points, not the whole published tarball. Budget recalibrated the same way and for the
// same reason as .size-limit.js — see that file's header comment.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUDGET_BYTES = 530_000; // ~+17.5% over the measured 451,195 B baseline

const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT }).toString();
const [{ unpackedSize }] = JSON.parse(output);

const actualKb = (unpackedSize / 1000).toFixed(1);
const budgetKb = (BUDGET_BYTES / 1000).toFixed(0);
console.log(`unpacked install size: ${actualKb} kB (budget: ${budgetKb} kB)`);

if (unpackedSize > BUDGET_BYTES) {
  console.error(
    `FAIL: unpacked install size ${unpackedSize} B exceeds the ${BUDGET_BYTES} B budget.`,
  );
  process.exit(1);
}
