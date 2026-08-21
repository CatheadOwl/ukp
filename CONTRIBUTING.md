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

Release maintainers also run private release preflight checks from the meta
workspace before publishing.

## Boundaries

- Do not publish or depend on the private meta workspace.
- Keep QMD collection, index, ranking, and maintenance internals provider-owned.
- Do not add Remote, `rg`, `vsearch`, API Search, full Client Scope, or
  standalone binary distribution unless that scope has been explicitly accepted.
