# Changelog

All notable public changes to UKP will be documented in this file.

## [Unreleased]

### Fixed

- `ukp search` no longer renders a bare `(no matches)` that is
  indistinguishable from an unconfigured provider: zero-hit results surface
  a setup hint (`ukp guide service qmd`) in the human warnings and in the
  `--json` envelope, and the human surface classifies parsed zero hits as
  `no_matches` the same way the JSON envelope already did (exit code stays
  0 — no matches is a result, not a failure).
- README names the agent JSON flag correctly: `--json` (`ukp read` keeps
  its `--format json`).
- `ukp guide client` now teaches the `ukp-pin` convention — how to compute
  and embed the same-line content-hash comment next to a `ukp://` reference
  — and states the non-git rename-recovery boundary; `ukp read`'s `--pin`
  help and pin usage error point there.
- `ukp guide client` notes where runtime artifacts live
  (`%LOCALAPPDATA%\ukp\artifacts` on Windows, `~/.cache/ukp/artifacts`
  elsewhere).

### Changed

- `ukp nav` renders unexpanded folders as `path/ (+N .md)` (self-explanatory
  count) instead of `[truncated: N] path`.
- `ukp serve` help drops internal review numbering from its Wire/Auth lines.
- The npm tarball no longer ships `bun.lock` / `tsconfig.json`
  (development-repo files with no consumer-runtime role).

## [0.1.1] - 2026-09-17

### Changed

- `ukp search` emits the durable `uri:` line / `ukp_uri` sidecar field only
  after verifying the mapped candidate file's content hash against the hit's
  docid: subfolder-rooted collections emit verified uris again (real on-disk
  paths, tolerant of provider path normalization differences across
  versions), same-named different-content files never receive a wrong
  reference again, and stale index entries are honestly refused. Unemitted
  results carry `ukp_uri_omission_reason` in the `--json` reference sidecar.
- `ukp init service` prints a provider-agnostic note when the folder already
  carries a provider index (`.qmd/`), routing to `ukp guide service qmd`.
- `ukp register` (local) prints a cross-workspace consumption pointer to
  `ukp guide client`.
- `ukp guide service qmd` documents checking existing collections before
  adding (`qmd collection list`) and the default full-path collection naming
  that only a rename turns into a short name.

## [0.1.0] - 2026-09-17

The first public release.

### Added

- Local-first CLI for named Knowledge Service endpoints, with TOML Service
  Manifest, Host Registry, and Client Config.
- Zero-declaration readonly Services: a Service Manifest with an empty
  `[capabilities]` table is valid and registers an endpoint exposing only the
  derived file-native `read`/`nav` capabilities.
- Endpoint commands: `ukp search` (indexed search through the endpoint's search
  provider, with `--recursive` over direct authority/context dependencies),
  `ukp read` (endpoint-scoped resource references, layered rename recovery, and
  `ukp-pin` content-hash verification), `ukp nav`, `ukp rg` (base lexical search
  over endpoint files), and `ukp propose` (idempotent change proposals through
  the file provider, over the wire on remote endpoints too: PUT
  `/v1/propose/<id>` with the same three-state semantics).
- Registry commands: `ukp init service`, `ukp register`, `ukp unregister`, and
  `ukp list`.
- Operations commands: `ukp diagnose`, `ukp inspect`, `ukp update`, and
  `ukp serve`.
- Help commands: `ukp version`, `ukp guide service`, `ukp guide service qmd`,
  `ukp guide client`, and `ukp guide propose`.
- `ukp://<endpoint>/<relative-path>` addressing as a durable reference form,
  with provider-backed reading through the QMD adapter.
- Agent-oriented `--format json` output, reference sidecars, and
  provider-native artifacts.
- Public GitHub Actions templates for CI and npm trusted publishing.

### Notes

- This is an MVP/demo-but-usable release, not a stable 1.0 protocol.
- QMD collection, index, ranking, and maintenance stay provider-owned.
- Remote endpoints work over the ukp-remote wire v1 (`serve`,
  `register --url`, `search`/`read`/`nav`/`rg`/`list`/`propose`); not included:
  remote `update` and a formal network protocol; the semantic
  search tier, API Search, query rewrite, reranking, or deduplication; full
  Client Scope with aliases, visibility, inheritance, or profiles; automatic
  artifact browsing, cleanup, or result-selection references; standalone binary
  distribution.
