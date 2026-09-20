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

The suite splits by scope: unit regression lives at `test/`, closed-chain
end-to-end scenarios (identity registration, transport, search, handoff,
read-back) live at [`test/e2e/`](./test/e2e/README.md), and black-box eval
scenarios (spawn-only; every printed handoff must replay verbatim; the
boundary is guard-enforced) live at [`test/evals/`](./test/evals/README.md).

Release maintainers run a release preflight before publishing: git hygiene,
the full test suite, typecheck, package metadata and tarball allowlist
review, private-material leak scans, and a publish dry-run. After publishing,
verify the npm page renders the package README (registry readme metadata has
been observed to go missing). The npm tarball
is intentionally allowlisted — runtime source, README, package metadata,
lock/config files, and the project license only.

## Boundaries

- Do not publish or depend on any private development material outside this
  repository.
- Keep QMD collection, index, ranking, and maintenance internals provider-owned.
- The ukp-remote wire v1 slices (serve, `register --url`, the host door, and
  remote `search`/`read`/`nav`/`rg`/`propose`) are accepted and shipped; do
  not add remote `update`, a formally specified network protocol, the
  semantic search tier, API Search, full Client Scope, or standalone binary
  distribution unless that scope has been explicitly accepted.
