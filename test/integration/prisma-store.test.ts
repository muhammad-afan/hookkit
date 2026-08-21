import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaStore } from '../../src/stores/prisma.js';
import type { PrismaIdempotencyDelegate } from '../../src/stores/prisma.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/prisma');
const PRISMA_CLI = path.resolve(__dirname, '../../node_modules/.bin/prisma');

/**
 * Real Postgres + a real generated Prisma Client, exercising exactly the schema
 * documented in src/stores/prisma.ts's doc comment — not the fake delegate used by
 * the unit tests in test/unit/stores/prisma.test.ts (both are kept: the fake delegate
 * suite is fast for iteration, this suite exists specifically to catch cases where the
 * real Postgres/Prisma error shape for a unique-constraint violation doesn't match what
 * the fake was simulating).
 *
 * `prisma db push --accept-data-loss` runs here against a testcontainers-managed,
 * throwaway Postgres container created fresh for this test run and destroyed
 * afterwards — never a real, shared, or production database. Prisma's CLI refuses to
 * run this command when it detects it's being driven by an AI coding agent without
 * explicit human sign-off; that sign-off was obtained from the user for exactly this
 * scenario (testcontainers-backed schema push in this checked-in test) during the
 * session that authored this file. PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION is set
 * only for this one invocation, scoped to the ephemeral container's connection string —
 * it is not a blanket bypass.
 */
describe('prismaStore (real Postgres via testcontainers)', () => {
  let container: StartedTestContainer;
  let connectionString: string;
  let prisma: {
    processedWebhookEvent: PrismaIdempotencyDelegate;
    $disconnect: () => Promise<void>;
  };

  beforeAll(async () => {
    container = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'hookkit_test' })
      .withExposedPorts(5432)
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(5432);
    connectionString = `postgresql://postgres:test@${host}:${port}/hookkit_test`;

    execFileSync(PRISMA_CLI, ['generate', '--schema=schema.prisma'], {
      cwd: FIXTURE_DIR,
      stdio: 'pipe',
    });

    execFileSync(
      PRISMA_CLI,
      ['db', 'push', `--url=${connectionString}`, '--accept-data-loss', '--schema=schema.prisma'],
      {
        cwd: FIXTURE_DIR,
        stdio: 'pipe',
        env: {
          ...process.env,
          PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'Yes, proceed',
        },
      },
    );

    const generatedModule = await import(
      /* @vite-ignore */ path.join(FIXTURE_DIR, 'generated', 'client.ts')
    );
    const PrismaClient = generatedModule.PrismaClient as new (opts: {
      adapter: PrismaPg;
    }) => typeof prisma;

    const adapter = new PrismaPg({ connectionString });
    prisma = new PrismaClient({ adapter });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  it('first claim succeeds via a real INSERT; second claim of the same key fails via a real unique-constraint violation', async () => {
    const store = prismaStore({ delegate: prisma.processedWebhookEvent });
    const key = `evt_${crypto.randomUUID()}`;

    expect(await store.claim(key, 60)).toBe(true);
    expect(await store.claim(key, 60)).toBe(false);
  });

  it('does not let concurrent claims of the same key both win against a real database', async () => {
    const store = prismaStore({ delegate: prisma.processedWebhookEvent });
    const key = `evt_race_${crypto.randomUUID()}`;

    const results = await Promise.all(Array.from({ length: 20 }, () => store.claim(key, 60)));
    const wins = results.filter(Boolean).length;

    expect(wins).toBe(1);
  });

  it('release() deletes the real row so a subsequent claim succeeds again', async () => {
    const store = prismaStore({ delegate: prisma.processedWebhookEvent });
    const key = `evt_${crypto.randomUUID()}`;

    await store.claim(key, 60);
    await store.release(key);

    expect(await store.claim(key, 60)).toBe(true);
  });

  it('release() on a claim that was never made does not throw (real "record not found")', async () => {
    const store = prismaStore({ delegate: prisma.processedWebhookEvent });
    const key = `evt_never_claimed_${crypto.randomUUID()}`;

    await expect(store.release(key)).resolves.toBeUndefined();
  });

  it('distinct keys claim independently against the real table', async () => {
    const store = prismaStore({ delegate: prisma.processedWebhookEvent });
    const a = `evt_a_${crypto.randomUUID()}`;
    const b = `evt_b_${crypto.randomUUID()}`;

    expect(await store.claim(a, 60)).toBe(true);
    expect(await store.claim(b, 60)).toBe(true);
  });
});
