# Changelog

All notable public changes to UKP will be documented in this file.

## [0.1.0] - unreleased

The first public release; the date is set when the package is published.

### Added

- Local-first CLI for named Knowledge Service endpoints, with TOML Service
  Manifest, Host Registry, and Client Config.
- Endpoint commands: `ukp search` (indexed search through the endpoint's search
  provider, with `--recursive` over direct authority/context dependencies),
  `ukp read` (endpoint-scoped resource references, layered rename recovery, and
  `ukp-pin` content-hash verification), `ukp nav`, `ukp rg` (base lexical search
  over endpoint files), and `ukp propose` (idempotent change proposals through
  the file provider).
- Registry commands: `ukp init service`, `ukp register`, `ukp unregister`, and
  `ukp list`.
- Operations commands: `ukp diagnose`, `ukp inspect`, and `ukp update`.
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
- Remote endpoints work over the ukp-remote wire v1 (read-side: `serve`,
  `register --url`, `search`/`read`/`nav`/`rg`/`list`); not included: remote
  `update`/`propose` and a formal network protocol; the semantic
  search tier, API Search, query rewrite, reranking, or deduplication; full
  Client Scope with aliases, visibility, inheritance, or profiles; automatic
  artifact browsing, cleanup, or result-selection references; standalone binary
  distribution.
