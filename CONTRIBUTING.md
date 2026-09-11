# Contributing

UKP is early and still intentionally small. Please keep changes focused on the
local-first CLI core unless a release note, issue, or design discussion has
accepted a broader scope.

## Development

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
npm pack --dry-run --json
```

Release maintainers run additional release preflight checks before
publishing; see the release process.

## Boundaries

- Do not publish or depend on any private development material outside this
  repository.
- Keep QMD collection, index, ranking, and maintenance internals provider-owned.
- Do not add Remote, semantic search tier, API Search, full Client Scope, or
  standalone binary distribution unless that scope has been explicitly accepted.
