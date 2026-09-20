# Changelog

All notable public changes to UKP will be documented in this file.

## [0.2.1] - 2026-09-20

### Fixed

- `ukp register --help` drops the internal tracking ID from the "Host
  doors" section header (the 0.2.0 acceptance re-verdict caught the same
  leak class the serve-help fix had cleaned). A guard test now sweeps
  every command help for ADR-/RQ- tokens so the class stays dead.

## [Unreleased]

### Fixed

- The discovery document (and the host-door roster) under-declared `rg`:
  `/v1/rg` serves every endpoint and a missing ripgrep binary degrades to
  per-endpoint availability data, but the projected capabilities listed only
  read/nav plus declared entries — remote consumers judging by discovery
  could not see lexical search. The external-tool base tier (ADR-RG-003) now
  projects unconditionally (`rg: { provider: "external", derived: true }`);
  a declared `rg` still overrides it. (Windows host upgrade feedback on
  0.2.0.)

### Added

- Windows hosts on the ssh:// path: the wake now speaks the host's shell.
  The pinned POSIX wake command is unchanged; when the host's default
  shell is cmd.exe (the Windows OpenSSH default — it cannot parse
  `sh -c` at all), the wake ladder detects the `'sh' is not recognized`
  signature and resends the pinned cmd.exe form (Windows-shaped PATH
  prefix: bun official, scoop, npm user prefix). Operators allowlist
  whichever form matches their host shell; a powershell DefaultShell is
  not supported. Both forms rejected reports a shell mismatch, not a
  missing-ukp error.
- The package bin is now a self-locating launcher (`bin/ukp.js`): npm
  shims exec it with node and bun's own links run it with bun; it finds
  the bun executable itself (UKP_BUN override, the standard install
  locations, then PATH), so `ukp` works in non-interactive shells — ssh
  wake sessions, Task Scheduler doors — without a PATH export, and fails
  with an install remedy instead of a stack trace when bun is absent.

### Changed

- The remote surfaces now state the platform burden guidance explicitly
  (owner discussion): ssh:// is the zero-resident path on every OS (on
  Windows, enabling the built-in OpenSSH Server feature once); the https
  path needs a resident listener — Linux can go resident-free via systemd
  socket activation, Windows has no systemd equivalent so a resident door
  wants a real service wrapper (WinSW-class). The deployment guide gains
  a "choosing a path by burden" paragraph; `ukp guide remote`'s
  operational note carries the same recommendation.

## [0.2.0] - 2026-09-20

### Added

- `ukp read --show-pin`: the ukp-pin is emitted by the product, never
  hand-computed. A successful read appends a ready-to-paste
  `<!-- ukp-pin: sha256-… -->` line to stderr (stdout stays body-only);
  the pin is the whole-file LF-normalized sha256, so it composes with a
  `--lines` window and verifies on any platform. `--format json` success
  envelopes gain an optional `pin` field; mismatched recovery candidates
  point at the flag; `ukp guide client` no longer teaches a
  sed/sha256sum recipe. Provider references (docid, `qmd://`) are
  rejected — the pin is file-slot-only; remote reads require the whole
  file (a line window is refused before any transport is opened).
- `ukp register --url ... --name <handle>`: the registry is your namespace —
  register a remote endpoint under a local handle when the declared name is
  already taken. The declared name is kept as provenance (a `declares:` line
  at registration, `name (declares X)` in `ukp list`), `--endpoint` stays an
  expected-name assertion on the declared name, and re-registering without
  `--name` refreshes the instance under its existing handle. Door-import name
  conflicts now point at the `--name` remedy, and server-declared `ukp://`
  references re-anchor to the handle so hand-off keys resolve locally.
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

- `ukp register --url ssh://host:port` is now rejected at intake (exit 1
  with the portless remedy): since the on-demand wake the ssh url port
  selects nothing — the woken door picks its own loopback port — so the
  dead grammar slot is an error instead of a silent no-op (non-standard
  sshd ports belong in an ssh config Host alias). Explicit default ports
  (`:8570`, `:22`) are rejected alike; https and loopback http ports are
  unaffected. Existing bindings from the resident-door era (e.g.
  `ssh://host:8571`) keep loading and calling — migrating one is an
  explicit unregister + register without the port.
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
- Guide de-duplication (the D-087 audit's B/C tails): `ukp guide remote`
  drops host-operator material the public deployment guide already owns
  (SSH lockdown / forced `command=` caveat, nvm symlink note) and keeps a
  pointer; `ukp guide service` states each dependency and
  provider-optionality fact once (Advanced and Remember lost five
  duplicated lines, kinds folded into the Details step).
- README accuracy pass (release-review replay findings): the remote
  quickstart intro no longer claims both paths run "from the consumer
  machine" (the TLS serve line runs on the host — block comments now say
  where each command runs); the Not Yet list drops "an HTTP search API"
  (remote search works over the ukp-remote wire — the formally specified
  protocol item already owns that boundary); the register row connects
  `--endpoint`'s assertion to door-import narrowing and documents
  `--token`.
- Added `ukp guide remote`, covering host-door setup, SSH and LAN HTTPS
  consumption, expected-name assertions during registration, and the current
  operational boundary that UKP does not yet install or autostart the remote
  door process. The LAN HTTPS quickstart carries its own NAT/EIP remedy
  (`--tls-san <public-ip>`, the certificate-name-mismatch failure it
  prevents, and the same-key re-sign note) — the first guide cognition
  replay (agent-eval case `remote-guide.consumption-model`, three blind
  agents) showed the remedy was reachable only from the README, not the
  guide.

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
