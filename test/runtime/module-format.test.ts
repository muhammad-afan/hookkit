import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * hookkit-testing.md §9, test 17.15. Catches the "forgot a file in the `files` array"
 * class of bug that no unit test can — packs the real tarball via `npm pack`, installs
 * it into a fresh scratch project exactly the way a consumer would, and confirms every
 * subpath in package.json's `exports` map actually resolves in both ESM and CJS.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * `npm pack --json`'s top-level shape changed between major npm versions: npm 10/11
 * output an array (`[{ filename, ... }]`); npm 12+ outputs an object keyed by package
 * name (`{ hookkit: { filename, ... } }`). Handle both rather than assuming one.
 */
function firstPackResult(jsonOutput: string): { filename: string } {
  const parsed: unknown = JSON.parse(jsonOutput);
  const result = Array.isArray(parsed) ? parsed[0] : Object.values(parsed as object)[0];
  return result as { filename: string };
}

// Subpaths that are pure WebCrypto or only *type-only* import their peer package
// (express/fastify/ioredis — all compiled away by verbatimModuleSyntax, verified by
// grepping dist/ for a lingering runtime import). These must resolve with ZERO peer
// packages installed — that's the whole point of the zero-dependency claim.
const PEERLESS_SUBPATHS = [
  'hookkit',
  'hookkit/stripe',
  'hookkit/shopify',
  'hookkit/github',
  'hookkit/standard',
  'hookkit/slack',
  'hookkit/discord',
  'hookkit/twilio',
  'hookkit/paddle',
  'hookkit/generic',
  'hookkit/express',
  'hookkit/next',
  'hookkit/fastify',
  'hookkit/stores/memory',
  'hookkit/stores/redis',
  'hookkit/stores/prisma',
  'hookkit/queues/bullmq',
  'hookkit/testing',
];

// hookkit/nestjs is the one subpath that genuinely value-imports its peers
// (@nestjs/common, @nestjs/core, rxjs — Injectable, Inject, Reflector, RxJS operators
// are all real runtime code, not type-only), so it's tested separately, WITH those
// peers installed — the realistic shape of a consumer who actually uses it.
const NESTJS_SUBPATH = 'hookkit/nestjs';

let peerlessDir: string;
let nestjsDir: string;
let tarballPath: string;

beforeAll(() => {
  const packOutput = execFileSync('npm', ['pack', '--json'], { cwd: ROOT }).toString();
  const { filename } = firstPackResult(packOutput);
  tarballPath = path.join(ROOT, filename);

  peerlessDir = mkdtempSync(path.join(tmpdir(), 'hookkit-pack-peerless-'));
  execFileSync('npm', ['init', '-y'], { cwd: peerlessDir, stdio: 'pipe' });
  execFileSync('npm', ['install', tarballPath, '--no-save'], { cwd: peerlessDir, stdio: 'pipe' });

  nestjsDir = mkdtempSync(path.join(tmpdir(), 'hookkit-pack-nestjs-'));
  execFileSync('npm', ['init', '-y'], { cwd: nestjsDir, stdio: 'pipe' });
  execFileSync(
    'npm',
    [
      'install',
      tarballPath,
      '@nestjs/common@^11',
      '@nestjs/core@^11',
      'rxjs@^7',
      'reflect-metadata@^0.2',
      '--no-save',
    ],
    { cwd: nestjsDir, stdio: 'pipe' },
  );
}, 180_000);

afterAll(() => {
  rmSync(peerlessDir, { recursive: true, force: true });
  rmSync(nestjsDir, { recursive: true, force: true });
  rmSync(tarballPath, { force: true });
});

describe('§9/17.15 fresh npm pack install — module format compatibility', () => {
  it('every peerless subpath resolves via ESM import(), with NO peer packages installed', () => {
    const script = PEERLESS_SUBPATHS.map(
      (specifier, i) =>
        `import('${specifier}').then(m => console.log('${i}', Object.keys(m).length > 0));`,
    ).join('\n');
    writeFileSync(path.join(peerlessDir, 't.mjs'), script);
    const out = execFileSync('node', ['t.mjs'], { cwd: peerlessDir }).toString();
    for (let i = 0; i < PEERLESS_SUBPATHS.length; i++) {
      expect(out).toContain(`${i} true`);
    }
  });

  it('every peerless subpath resolves via CJS require(), with NO peer packages installed', () => {
    const lines = PEERLESS_SUBPATHS.map(
      (specifier, i) => `console.log(${i}, Object.keys(require('${specifier}')).length > 0);`,
    ).join('\n');
    writeFileSync(path.join(peerlessDir, 't.cjs'), lines);
    const out = execFileSync('node', ['t.cjs'], { cwd: peerlessDir }).toString();
    for (let i = 0; i < PEERLESS_SUBPATHS.length; i++) {
      expect(out).toContain(`${i} true`);
    }
  });

  it('the core entry actually exports a working createReceiver function via ESM', () => {
    writeFileSync(
      path.join(peerlessDir, 't2.mjs'),
      "import { createReceiver } from 'hookkit'; console.log(typeof createReceiver);",
    );
    const out = execFileSync('node', ['t2.mjs'], { cwd: peerlessDir }).toString().trim();
    expect(out).toBe('function');
  });

  it('the core entry actually exports a working createReceiver function via CJS', () => {
    writeFileSync(
      path.join(peerlessDir, 't2.cjs'),
      "console.log(typeof require('hookkit').createReceiver);",
    );
    const out = execFileSync('node', ['t2.cjs'], { cwd: peerlessDir }).toString().trim();
    expect(out).toBe('function');
  });

  it(`${NESTJS_SUBPATH} resolves via ESM once its real runtime peers (@nestjs/common, @nestjs/core, rxjs) are installed`, () => {
    writeFileSync(
      path.join(nestjsDir, 'tn.mjs'),
      `import('${NESTJS_SUBPATH}').then(m => console.log('HookkitModule' in m, typeof m.Webhook));`,
    );
    const out = execFileSync('node', ['tn.mjs'], { cwd: nestjsDir }).toString().trim();
    expect(out).toBe('true function');
  });

  it(`${NESTJS_SUBPATH} resolves via CJS once its real runtime peers are installed`, () => {
    writeFileSync(
      path.join(nestjsDir, 'tn.cjs'),
      `const m = require('${NESTJS_SUBPATH}'); console.log('HookkitModule' in m, typeof m.Webhook);`,
    );
    const out = execFileSync('node', ['tn.cjs'], { cwd: nestjsDir }).toString().trim();
    expect(out).toBe('true function');
  });

  it('the tarball contains no src/ or test/ files — only the published surface', () => {
    const listing = execFileSync('tar', ['-tzf', tarballPath]).toString();
    expect(listing).not.toMatch(/package\/src\//);
    expect(listing).not.toMatch(/package\/test\//);
    expect(listing).toMatch(/package\/dist\//);
  });
});
