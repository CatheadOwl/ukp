# Changelog

All notable public changes to UKP will be documented in this file.

## [Unreleased]

### Added

- `ukp serve --tls-san <ip|dns>` (repeatable, next to `--tls`): merge an
  extra SAN entry into the self-signed identity — the cloud NAT/EIP case,
  where the public IP is on no NIC and the automatic SAN coverage can never
  see it. A persisted certificate missing a requested entry is re-signed
  over the same key: the pin is unchanged and pinned clients re-anchor
  transparently. Coverage only grows — the re-sign unions the
  certificate's existing SAN with automatic coverage and the new entries,
  so changing the flag list keeps earlier entries and dropping never
  re-signs.
  Next to `--tls-cert/--tls-key` it is a usage error (an operator
  certificate carries its own SAN).
- `ukp serve --systemd-socket` (Linux): serve on a systemd
  socket-activation listener instead of binding a port — the socket unit
  holds the port, spawns the door on first connection, and the door
  self-reaps after --max-idle; nothing resident between uses on the https
  path either. Token required (the bind belongs to the unit).
- `ukp serve --max-idle <seconds>`: self-exit after that long without
  requests (requests re-arm the timer; idle connections don't). The orphan
  backstop the on-demand-woken doors rely on, and the companion flag for
  process-manager or socket-activated deployments.

### Changed

- The `ssh://` transport wakes the host door on demand: nothing to
  pre-start on the host (prerequisites: ssh reachable + ukp on its
  PATH). One ssh process per invocation opens the forward and runs a
  pinned loopback `ukp serve` that serves the host Registry and reaps
  itself when idle; consecutive invocations reuse the connection for two
  minutes (native Windows ssh pays the handshake per call). The url port
  in `ssh://` no longer selects anything; a missing remote `ukp` is
  reported with the remedy.

### Fixed

- `ukp register --url` now accepts `--endpoint <name>` as an expected-name
  assertion. The remote name still comes from discovery, but registration can
  now fail loudly when the command and the served endpoint disagree; on a host
  door, `--endpoint` imports exactly that one endpoint.
- `ukp search` empty results now surface a setup hint (`ukp guide service
  qmd`) in both human and `--json` output — a bare `(no matches)` was
  indistinguishable from a provider that was never set up, the most common
  first-run stumble.
- README names the agent JSON flag correctly: `--json` (`ukp read` keeps
  its `--format json`).

### Changed

- `ukp init service` now creates the provider-free baseline Manifest
  (`[capabilities]`) instead of predeclaring QMD search. The first Service
  smoke is `diagnose -> register -> nav/read/rg`; `ukp guide service qmd`
  is the optional indexed search/update setup path.
- `ukp guide client` teaches the `ukp-pin` convention — how to compute and
  embed the same-line content-hash comment next to a `ukp://` reference —
  plus the non-git rename-recovery boundary and where runtime artifacts
  live; `ukp read`'s `--pin` messages point there.
- `ukp nav` renders unexpanded folders as `path/ (+N .md)` instead of
  `[truncated: N] path`.
- Added `ukp guide remote`, covering host-door setup, SSH and LAN HTTPS
  consumption, expected-name assertions during registration, and the current
  operational boundary that UKP does not yet install or autostart the remote
  door process.

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
