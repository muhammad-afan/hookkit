## What does this change?

<!-- A sentence or two on what this PR does and why. -->

## Type of change

- [ ] Bug fix
- [ ] New provider adapter (see `CONTRIBUTING.md`'s checklist — did you complete all of it?)
- [ ] New store / queue / framework integration
- [ ] Documentation
- [ ] Other

## Checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass locally
- [ ] I did not add a runtime `dependency` without opening a discussion first (see
      `CONTRIBUTING.md` — devDependencies are fine)
- [ ] If this changes public API surface or behavior, I ran `pnpm changeset` and
      committed the generated file
- [ ] If this adds/changes a provider adapter: fixture added or the gap is documented in
      `test/fixtures/README.md`, the conformance suite passes, and the README's
      "Supported providers" table is updated

## Related issue

<!-- Closes #... if applicable -->
