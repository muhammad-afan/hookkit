# Contributing to hookkit

Thanks for considering a contribution. hookkit is a security-adjacent library — verifying
webhook signatures — so contributions get held to a slightly higher bar than a typical
utility package, especially around dependencies and cryptography. This doc explains why,
and what the path looks like for the two most common kinds of contribution.

## Development setup

```bash
git clone https://github.com/muhammad-afan/hookkit.git
cd hookkit
pnpm install
pnpm build
pnpm test
```

Before opening a PR, run the same gate CI runs:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Some integration tests (Redis, Prisma/Postgres, BullMQ) use
[testcontainers](https://node.testcontainers.org/) and need a working Docker daemon
locally. If Docker isn't available, those specific tests will fail — that's expected in a
Docker-less environment, not a sign something else is broken.

## Dependency minimalism is a policy, not a preference

Core (`hookkit`) and every provider adapter ship with **zero runtime dependencies** — see
`CLAUDE.md` §0/§10 for why this is a deliberate competitive and security position, not an
accident. Concretely:

- **Adding a runtime `dependency` requires a maintainer discussion first.** Open an issue
  before writing the code, not after. This applies even to small, well-regarded packages —
  the point is dependency *count*, not any particular package's trustworthiness.
- New integrations with external systems (a new store, a new queue) belong behind an
  **optional peer dependency**, gated with `peerDependenciesMeta: { optional: true }`, so
  installing hookkit never pulls in Redis/Prisma/BullMQ/NestJS clients for someone who
  isn't using that integration.
- `devDependencies` are much less sensitive — normal open-source judgment applies there.

## Adding a provider adapter

This is the highest-leverage contribution path — the generic adapter
(`createGenericAdapter`, see `CLAUDE.md` §3.9) lets anyone self-serve an unsupported
provider immediately, but a first-class adapter is what makes it show up in the supported
providers table and get the full test/fixture treatment. Checklist:

1. **Read `CLAUDE.md` §3 and `hookkit-testing.md` first.** Identify which of the six
   signature shapes (§3, D4) your provider uses — body-only HMAC, timestamped HMAC,
   URL-bound HMAC, asymmetric, async network verify, or non-body signing. This determines
   the adapter's shape before you write any code.
2. **Adapter file**: `src/providers/<name>.ts`, implementing the `ProviderAdapter`
   interface (`verify`, `extractEventId`, `requiredHeaders`, `defaultToleranceSeconds`,
   and `sign` for `createTestSigner` support — see any existing adapter for the pattern).
   Zero imports outside `../core/*`.
3. **A real, recorded fixture.** hookkit's policy (see `test/fixtures/README.md`) is to
   never fabricate a fake "real" fixture — a payload recorded from that provider's actual
   test/sandbox mode, with any live secrets redacted, is what's needed. If you can't
   produce one (no account with that provider), say so in the PR; a synthetic-fixture-only
   adapter is still useful but will be flagged as such.
4. **The full conformance suite.** Run your adapter through `runAdapterConformance()` (see
   `test/shared/conformance.ts` and any existing adapter test file for how it's wired up)
   — this is the shared baseline test suite every adapter must pass. Then add
   provider-specific tests for whatever `hookkit-testing.md` calls out as unique to this
   provider (key derivation quirks, multiple signature values, unusual tolerance handling,
   etc.).
5. **A docs table row.** Add the provider to the "Supported providers" table in
   `README.md` — header(s), algorithm, tolerance, event ID field — matching the format
   already there.
6. **A changeset.** Run `pnpm changeset`, describe the addition, and commit the generated
   file alongside your change. See "Releasing" below.

## Reporting a bug

Use the bug report issue template. A minimal reproduction (ideally a failing test) gets
looked at fastest.

## Requesting a provider

Use the provider request issue template rather than opening a blank issue — it captures
the signature shape and docs link up front, which is most of what's needed to scope the
work.

## Releasing (maintainers)

hookkit uses [Changesets](https://github.com/changesets/changesets). After a
merge-worthy change:

```bash
pnpm changeset
```

Follow the prompts (bump type + a short description of the change from a consumer's
point of view). Commit the generated `.changeset/*.md` file with your PR. The release
workflow (`.github/workflows/release.yml`) handles versioning and publishing from `main`
via Changesets' GitHub Action — you should not need to publish manually except for the
one-time first release (see the workflow file's header comment).

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
