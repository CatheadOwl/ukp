# Changelog

All notable public changes to UKP will be documented in this file.

## [Unreleased]

### Fixed

- Windows: every remote command and every `ukp rg` run paid a hidden 5-10s
  per-spawn tax — Windows Defender behaviorally inspects the direct
  bun-to-`ssh.exe`/`rg.exe`/`taskkill.exe` child edge while letting the same
  binaries start in a fraction of a second through any intermediary. Real-tool
  spawns on win32 now route through a one-level `powershell -EncodedCommand`
  relay that carries argv byte-identical (the pinned wake command's quoting is
  untouched), and tunnel teardown tree-kills through cmd so the reaper itself
  is not taxed. Measured on the liku/ali dogfood rig: `ukp rg --endpoint liku-notes`
  11.4s -> 2.4s, `ukp list` (two ssh doors) ~11s -> 3.1s, local `ukp rg` 9.9s
  -> 0.9s. Test-injected tool commands are never wrapped; non-Windows is
  byte-identical.

## [0.2.3] - 2026-09-21

### Added

- `ukp serve --print-task` (Windows): prints the resident-door process-manager
  artifacts — start script (`%USERPROFILE%\.ukp\start-door.cmd`, with the
  token as a paste-in placeholder and a door.log paper trail), the Task
  Scheduler command, and the firewall rule — from your current flags, for
  you to review and apply. Print-only by construction: nothing is
  installed, started, or supervised, the real token is never read or
  printed (the blind replay that motivated this showed raw operators
  guessing at exactly these mechanical steps even with the handbook in
  hand), and off-loopback doors without TLS or with `--allow-anonymous`
  are refused at print time because serve would refuse them at task
  start. `--max-idle` and `--systemd-socket` are rejected alongside it;
  non-Windows hosts are pointed at systemd socket activation instead.
- The deployment handbook now ships inside the npm package
  (`docs/remote-deployment.md`), and `ukp guide remote` resolves its own
  handbook references with the in-package path plus the public URL.
  Before, the guide pointed at "the deployment handbook" twice without
  saying where it was, and the tarball excluded it — an operator with only
  the installed package could not reach the Windows resident-door recipe
  (certificate, start script, Task Scheduler) or the systemd
  socket-activation units at all. (Windows host https-path feedback,
  2026-09-20: the recipe existed but was reachable only from the
  repository.)

### Changed

- The Windows resident door no longer shows a console window, in the
  handbook recipe and in `ukp serve --print-task` alike (owner ruling: a
  visibly popping cmd box is not an acceptable product form). The
  generator now prints a hidden launcher (start-door-hidden.vbs) and
  points the Task Scheduler task at it: the console is hidden at process
  creation (nothing ever flashes), all output lands in door.log, the
  door's exit code propagates to the task result, and a crashed door is
  retried up to 3 times 30s apart. The retry lives in the launcher
  because Task Scheduler's own restart-on-failure setting does not fire
  on exit codes (disproven by crash drills on the dogfood host; zero-flash
  confirmed at logon there). Machine restart without a logon still
  leaves the door down — prefer ssh:// or a Linux host for always-on.

### Fixed

- Internal workline labels no longer surface in user-facing text: `serve
  --help` carried a "TLS (W5')" decision label and the remote-skip messages
  of `diagnose`/`inspect` said "ukp_remote W2" — both meaningless to a
  user. Caught by the 0.2.3 first-impression blind replay; the help guard
  test now sweeps workline labels alongside ADR-/RQ- tokens so the class
  stays dead.
- Release-face wording pass (0.2.3 homepage and first-impression blind
  replays): the opening demo shows the declare-propose step before
  `ukp propose`; the search-scope bullet names the manifest `dependencies`
  kinds instead of the floating "authority/context links" phrase; the Bun
  requirement says you install Bun yourself and what a missing `bun`
  produces; `read/file` is glossed as the built-in file capability; the
  README's `-c` claim (a flag that never existed) is replaced by the real
  legacy surface — `ukp unregister <name>`'s positional form; root help
  glosses QMD as an external tool and gives `-g` its own clause; `serve`'s
  summary glosses "host door"; `read`'s summary says where a docid comes
  from; `ukp init service` now calls rg what `ukp diagnose` calls it (the
  external-tool base tier). The shipped deployment handbook drops a
  dangling internal cross-reference and private host-name provenance
  (blocker and should-fix findings of the 0.2.3 homepage gate). The
  grounding gate's findings landed in the same pass: the First Run
  propose claim is scoped to endpoints that declare it (propose is never
  derived), the agent-handoff bullet uses the dual-reference vocabulary
  (docid handoff keys, durable `ukp://` references), and serve wording
  says "every local binding" — a host door does not serve remote
  bindings.
- The Windows certificate command in the deployment handbook carried two
  literal tab characters where the `.ukp\tls\` paths were meant (the `\t`
  of `tls` had collapsed into a tab) — copy-pasting the documented openssl
  command as printed would write the key and certificate to a wrong path.
  Caught independently by all three agents of a blind raw-operator replay
  (the dogfood operator had silently repaired it by hand); fixed before the
  handbook's first tarball shipment. The same replay family caught two
  more stale handbook lines: `ukp register <folder>` (the CLI rejects
  positional arguments — the canonical form is running `ukp register`
  from inside the folder) and the resident recipe's "set PATH" step
  (obsolete since the self-locating launcher; `--print-task`'s generated
  script carries the correct minimal form).
- Door drift notes no longer send taken names down a dead end: `ukp list`
  now separates door endpoints that merely need importing (bulk-import
  hint, unchanged) from endpoints whose name is already held by another
  binding — those get the single-endpoint remedy
  (`ukp register --url <door>/<name> --name <handle>`), because the bulk
  import would skip them again.

## [0.2.2] - 2026-09-20

### Added

- The `ukp serve` startup banner carries a ripgrep availability line
  (`rg: ok` / `rg: missing (rg calls skip with a warning — install ripgrep
  on this door's PATH)`), probed once at startup in the door's own process.
  /v1/rg serves every endpoint and a missing binary degrades per-endpoint
  on the wire by design — but that truth reached only the consumer; an
  operator whose door environment (schtasks session, ssh wake shell) lacks
  rg had no startup signal, because `ukp diagnose` measures the invoking
  shell instead. The banner probe's environment is, by construction, the
  one that matters.

### Fixed

- The ssh:// wake now probes the host's shell family before its first
  attempt (`echo %OS%`: cmd.exe expands it to `Windows_NT`, a POSIX shell
  echoes the literal token — language-independent) and sends the matching
  wake form directly: Windows hosts no longer pay a dead 20-second
  POSIX attempt on every invocation. The probe also picks the tty stance:
  `-tt` (which exists for POSIX SIGHUP reaping) now rides the POSIX form
  only — Windows has no SIGHUP (max-idle bounds the door), and a
  Win32-OpenSSH 9.5 build was caught losing quoted remote commands under
  a pty (an interactive cmd swallowed the wake and waited on stdin
  forever; the no-pty path executes it correctly). Failure classification
  is language-independent: cmd locales vary the message body but always
  quote the missing ASCII token ('sh' / 'ukp'), and exit codes are
  unusable (pty sessions report 0 even for failed commands). Verified
  end to end on the Windows dogfood host: register through the woken
  door in ~9s, nav/read/rg and ukp:// URI round-trips, a name-collision
  skip with the --name remedy, sshd-session doors reaping within the 60s
  max-idle while the resident https door stayed untouched, and the
  discovery document declaring rg on every endpoint.

## [0.2.1] - 2026-09-20

### Fixed

- `ukp register --help` drops the internal tracking ID from the "Host
  doors" section header (the 0.2.0 acceptance re-verdict caught the same
  leak class the serve-help fix had cleaned). A guard test now sweeps
  every command help for ADR-/RQ- tokens so the class stays dead.

## [0.2.4] - 2026-09-22

### Changed

- `ukp list` with a mixed registry (local + remote bindings) now prints
  local rows first and streams: the header and every local row appear
  before any network work starts, remote rows append in registry order as
  their fetches resolve, and an interactive terminal shows a single-line
  progress indicator on stderr (piped output stays byte-identical to the
  returned text and gains no control characters; the progress line never
  appears when stderr is not a TTY). Row order is the one agent-visible
  change: all locals first, then all remotes, each group in name-sorted
  registry order — degradation warnings on stderr follow the same
  grouping, after the table. Every streamed row clears the progress line
  before printing and the next frame redraws below it, so the table and
  the indicator never corrupt each other on a shared terminal. On an
  interactive terminal the stderr footnotes wrap at word boundaries to
  the terminal width (over-long tokens such as pins and paths hard-split;
  piped stderr keeps raw single lines). All-local listings are untouched:
  still fully synchronous with byte-identical output.
- `ukp list` wording: the header parenthetical is now plain language —
  "capabilities on every endpoint: nav, read (built-in, from the folder
  itself)" (was "(derived file-native)", which cold readers flagged as
  undefined jargon) — and a degraded row's stderr warning now says
  "declared capabilities unavailable", scoping the failure to the
  per-endpoint declared extras instead of reading as if every capability
  (nav/read included) were down. Blank-reader probes confirmed the new
  wording: readers scoped the failure correctly 6/6 (2/2 could not with
  the old wording).
- Remote error and remedy text now quotes the URL you registered, never
  the wire address the client actually fetches. Door-endpoint bindings
  (`ssh://host/name`) fetch through a `/e/<name>` route prefix (and, over
  ssh, a loopback tunnel port); before, transport failures and hints
  embedded that wire address, and the "is a host door" hint embedded it in
  a suggested `ukp register --url` command that would fail if copied
  verbatim. That hint now names the door origin (`ukp register --url
  ssh://host`), and the fix spans every remote face
  (list/search/read/nav/rg/propose), not just list.

### Fixed

- Warning and note lines no longer misalign on Windows consoles using a
  legacy DBCS codepage (cp936/GBK, the zh-CN Windows default). The CLI
  writes UTF-8 bytes and such a console decodes them with the wrong table —
  every multibyte character (the em dash in warning lines) shifted the
  cursor by an extra cell and stderr lines landed mid-column with phantom
  indents. The runtime output vocabulary is now printable ASCII across all
  command faces (`—` → `-`, `…` → `...`), which every codepage decodes
  identically: the sweep started with the list surface (2026-09-21) and has
  since closed the class over serve and register help text, usage and
  refusal messages, remote and capability error/remedy text, the serve
  banner, the `--print-task` artifacts, and the guide topics. (Non-ASCII
  user content such as Chinese folder names may still drift on DBCS
  consoles — run `chcp 65001` there.)
- `ukp list` fetches remote endpoints concurrently instead of serially:
  every remote row and the door drift check start together and results are
  awaited in registry order, so the wall clock is the slowest origin
  instead of the sum of all origins, and the printed table is unchanged
  byte for byte. Every ssh process ukp spawns (mux candidate, shell probe,
  wake client) now carries `-o ConnectTimeout` (default 10s, override with
  `UKP_SSH_CONNECT_TIMEOUT_MS`), so an unreachable host fails in seconds
  instead of waiting out the OS TCP timeout through every wake attempt.
  The host's shell family is cached beside the registry
  (`wake-shell.toml`), skipping the per-invocation `echo %OS%` roundtrip;
  a stale entry costs one wake retry and self-heals, never a hard failure.
  One wording change rides along: wake-failure warnings name the ssh
  target only — the redundant `(endpoint 'X')` parenthetical is gone, and
  under the concurrent fetch each degraded row's warning no longer risks
  quoting a sibling endpoint's name.
- `ukp list` rows become column-aligned: cells pad to the widest cell in
  their column (two-space gutter, last column unpadded). The rows were
  tab-separated before, so alignment was left to the terminal's tab stops —
  with the registry mixing short names, long local paths and remote urls,
  every row landed its columns on different stops and the table read
  ragged. Row semantics (flat shape, `(unavailable)` degradation,
  `(declares X)` annotations, stderr notes) are unchanged; a regression
  test pins the shared column offsets.

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
