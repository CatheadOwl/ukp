# Changelog

All notable public changes to UKP will be documented in this file.

## [Unreleased]

### Added

- `ukp nav --json` (`ukp.nav.v1`) folder entries carry `markdown` — the
  representative README child's endpoint-relative path, restored additively
  (W2 问 4 waiting slot closed, 2026-10-31): mapped verbatim from the
  upstream `NavNode.markdown` model field (`@any-nav/scan` 0.2.0, the
  DEC-0020 locator) with zero derivation at the projection layer. Present
  iff that README is in the scan tree (a budget cut past it or an exclusion
  leaves the field absent); folder entries only — file entries are their
  own read target. The human face is unchanged.
- `ukp search --timeout <seconds>` — the provider spawn timeout made an
  explicit flag (owner ruling 2026-10-28 on the parity-audit finding, seat
  20261028-1113 option 3): default stays 60s with the hang guard ON
  (search's primary consumers are unattended agent sessions — the
  orchestration-family posture: GitHub Actions / GitLab CI / Kubernetes all
  default-guard), a positive value raises it and wins over
  `UKP_PROVIDER_TIMEOUT_MS`, and `--timeout 0` disables the guard entirely
  (the 2026-08-16 interactive semantics — interrupt is then the only cancel
  mechanism — revived on demand, using the classic-CLI family's universal
  "zero disables" grammar: curl / wget / ssh_config). Applies to both qmd
  spawns of a search (human and JSON modes). A timeout kill keeps the
  `failed` classification but the message now names the flag ("provider
  timed out after 60s - raise or disable via --timeout") — diagnosable,
  never disguised as a provider crash; with the guard disabled a SIGTERM is
  reported as external. No connect/total split (a local subprocess spawn
  has no connect phase; one gate suffices). The 2026-08-16 spec clause ("no
  implicit timeout") is superseded in place with the ruling chain and the
  survey evidence archived verbatim in the seat record; the parity-audit
  ledger row closes with it (state 3 -> 4).
- `ukp use <endpoint> [endpoint...]` — the one-step consumer gesture (inbox
  proposal client-portability-and-skill-coverage, owner-endorsed): writes
  or updates the workspace `.ukp/client.toml` `default_endpoints` (explicit
  replace, idempotent — same names re-run as unchanged, new names rewrite
  the list and report the old one) and brings the declarations'
  version-control visibility along in the same step. Every name must
  already be registered (admission at write time; registering stays a
  separate gesture). The target is the nearest existing client.toml
  walking up from the current directory — the same nearest-wins rule
  scope resolution applies — or a fresh file in the current folder. An
  existing structurally invalid config is refused, never clobbered.
  Dual-role folders are safe: service.toml is never touched. Spec:
  docs/spec/use-command.md; `ukp guide client` teaches it as step 1.
- `ukp list --json` — the offline machine-readable endpoint snapshot
  (schema `ukp.list.v1`, TODO 20261028-0053): one pretty-printed document
  per the repo machine-face convention, one object per binding with
  `name` / `kind` (local-remote discriminator) / `location` (the local
  binding root's canonical absolute path, or the registered remote url)
  / `declared_name` / `capabilities` / `base_tier` (`nav`, `read`, `rg`
  — declaration-free baseline membership) / `available` / `warning`.
  Three contract promises (docs/spec/list-command.md): field names are
  stable across versions (additive fields or a new schema id, never
  renames); the rows share the text listing's single production core
  (local rows byte-identical truth, same locals-first order); and the
  snapshot is offline — remote bindings are projected from registry
  facts only, no transport, no discovery fetch (their capability fields
  are `null`; the text face's remote capability cell stays a
  per-invocation network refresh). stderr stays empty in this mode —
  degradation truth rides in the rows' `warning` fields, the exact
  strings the text face prints on stderr.
- Labeled, scoped, revocable keys for `ukp serve` (RQ-16c / W13):
  `ukp serve token add <label> <scopes>` issues a
  `ukp_<label>_<id>_<secret>` key into `~/.ukp/tokens` (0600, SHA-256
  hash-only storage — the raw key is shown exactly once), `token list`
  tabulates labels/key-ids/scopes, and `token revoke <label>` deletes
  every key of a label. Scopes are required per key in Docker-registry
  grammar (`notes:ro,cad:rw`; full power is the explicit `*:rw`): a
  scoped key reads only its endpoints, `rw` adds the propose route, and
  out-of-scope names answer byte-identically to unknown ones (the
  ADR-REM-010 roster-404 mechanism, no 403 class). The serve gate
  re-reads the file on every request, so deleting a line revokes without
  a restart; a malformed or (POSIX) world-permission file refuses
  startup loudly, and mid-flight corruption fails closed. While
  `UKP_SERVE_TOKEN` is set it keeps its exact previous full-power
  semantics and the file is not consulted (env > file chain order, the
  AWS/gh/kubectl convention); deny-by-default admission now spans both
  sources. The mechanism lives in a new purity-enforced
  `src/plumbing/token-file.ts` (zero UKP imports, machine-checked by
  test).

### Changed

- The nav engine supply closed its transition window (ADR 0029 closing,
  2026-10-31): `@any-nav/scan` moves from the local `link:@any-nav/scan`
  transition (which made every publish intentionally red under pack-audit
  and required a per-machine `bun link` registration) to the registry pin
  `^0.2.0`, riding the any-nav 0.2.0 facade train (`@catheadowl/pathscope
  ^0.1.1` transitively). The pack-audit `link:` dependency guard retires
  with the window — the publish face is green again; fresh clones install
  from the registry alone. One nav test re-encodes the folder description
  chain to the standardized carriers any-nav DEC-0025 shipped (package.json
  wins over README; the Docusaurus-shaped `_category_` sidecar no longer
  reads) — a re-adjudicated upstream assertion retired, not a behavior
  change on the UKP face.

- **Breaking-ish** `ukp list` eats the workspace scope by default and gains
  `-g` (ADR 0031, owner ruling 2026-10-28, restoring the 13ae382 clause the
  first implementation silently dropped): the default listing now shows the
  nearest `.ukp/client.toml` default_endpoints resolution — the same
  `resolveScope` law every consumer command follows — with the full Host
  Registry as fallback when no client config exists, so bare machines see
  byte-identical output. `-g` lists every registered endpoint and never
  reads the client config (the escape hatch for invalid or dangling
  configs, which otherwise fail the listing with exit 1 and the `-g`
  remedy). `--json` rides the same scope — no machine-face exemption,
  which is exactly how the 2026-09-21 spec came to ratify the original
  drift; the ukp.list.v1 envelope and fields are unchanged, only the row
  set is selected (`ukp list -g --json` = the full snapshot). Dangling
  default entries drop out of the rows and warn on stderr in both faces.
  Guidance follows: the root-help name-source line and `ukp use`'s
  unknown-endpoint remedy now point at `ukp list -g`. Machine consumers
  that need the full registry should pin `-g`.
- `ukp init service` now writes a precise `.ukp/.gitignore` instead of the
  blanket `*`: only the machine-local state that actually lives in `.ukp/`
  is ignored by name (`/instance-uid`, `/tls/`), so the pure declarations —
  `service.toml`, and `client.toml` for dual-role folders — are committable
  by default (a fresh clone re-registers the Service with one
  `ukp register`). Real-usage evidence behind the change: endpoint
  declarations did not travel with clones, and carving client.toml back
  into tracking cost three error-prone steps. Existing files are still
  never touched by init; repositories carrying the retired `*` template
  migrate in one step with `ukp use` (verbatim-template recognition;
  operator-owned files stay untouched) or by hand. Identity and TLS key
  material remain ignored on every path.
- `ukp nav` rides the any-nav scan facade's pathscope engine chain (ADR 0029,
  2026-10-24): the `@any-nav/scan` dependency moves from the registry `0.1.0`
  pin to a local `link:@any-nav/scan` transition supply (two-level chain —
  scan delegates its walk to `@catheadowl/pathscope`; bun's path-form `link:`
  and `file:` protocols were probed and rejected with evidence). Accepted
  engine-semantic increments, each adjudicated against a three-endpoint
  regression gate: nested `.git` subtrees (vendored repos) no longer appear
  in the route view, and pointing `nav` into one fails with `route root
  segment … vanished from the scan tree` (exact-path `ukp read` still
  retrieves that content); `vendor/` and `coverage/` join the default
  exclusion floor (opt out via a repo `.gitignore` negation such as
  `!vendor/`); `**` glob patterns follow git truth (zero or more directory
  levels, so `**/x.md` now matches a root-level `x.md`); gitignore and floor
  matching is case-insensitive (on Windows this aligns nav with the platform
  git default); gitignore inheritance now reaches above the Service folder
  up to the repository root; the `unreadable-directory` maintainer diagnostic
  is retired. The runtime install closure widens to scan + pathscope
  (ignore/fdir/find-up, all with zero install scripts); until the closing
  window swaps the dependency back to a registry pin, `npm publish` is
  intentionally blocked by the pack-audit `link:` guard.
- `ukp list` no longer word-wraps its stderr footnotes on interactive
  terminals: they stay raw single lines in every mode and the terminal
  wraps what it must (owner ruling 2026-10-24 — neither human nor agent
  reading benefits from CLI-side pre-wrapping, which splits sentences at
  a fixed width; the 2026-09-21 interactive word-boundary wrap and its
  width snapshot are removed together with their tests). Piped/CI stderr
  bytes were already raw and are unchanged; the TTY-gated progress line
  is unaffected.

### Fixed

- Trailing separators in endpoint-relative references are now
  address-encoding noise instead of a syntax error (ADR 0023 amendment,
  D-099): `ukp read --endpoint X "docs/"` addresses the same slot as
  `docs` and stat decides — a directory tail reports the friendly
  "is a directory, not a readable resource" failure instead of
  "reference must not contain empty path segments", and a file tail
  reads normally. Applies uniformly to `ukp read` (both the plain and
  `ukp://` tiers) and `ukp nav` routes; interior empty segments
  (`a//b`) are still rejected as a grammar error.
- Windows: tool stderr routed through the win32 spawn relay no longer
  leaks a `#< CLIXML` serialization header ahead of the real error.
  The relay's first cmdlet (the not-found `Get-Command` guard) made
  PowerShell emit its one-time "Preparing modules for first use"
  progress record, which a redirected stderr serializes as CLIXML —
  so `ukp rg "{{template:"` (a pattern rg itself rejects as a regex)
  surfaced `status: failed: #< CLIXML` instead of rg's readable parse
  error. The relay now suppresses the progress stream; native tool
  stderr passes through byte-clean with the exit code preserved
  (rg and the ssh wake transport both benefit). Literal `{{...}}`
  searches keep working via the passthrough form
  (`ukp rg "{{seedcast:" -- -F`).
- Windows: the spawn relay's not-found guard actually fires again. The
  guard's `Get-Command -LiteralName` used a parameter that Windows
  PowerShell 5.1 does not have — the unknown parameter is silently
  swallowed and the check returns every command, so the guard was
  vacuous: on a machine without ripgrep, `ukp rg` silently reported an
  empty result instead of the intended "rg unavailable" skip with a
  warning (a missing tool even exited 0 through the relay). The guard
  now resolves via `-Name` and a live test pins the 127 sentinel.
- `ukp rg --help` and the rg guide topic no longer advertise `-uu`: the
  passthrough allowlist (ADR-RG-002 frozen set) rejects that compound
  form with exit 2, so agents following the visibility note hit a dead
  end. The wording now teaches the equivalent allowlisted form
  (`-- --no-ignore` to lift .gitignore rules; `--hidden` + `--no-ignore`
  together cover the full `-uu` semantics).

### Added

- Security policy and posture declaration: the package now ships a
  `SECURITY.md` (scope, private vulnerability reporting via GitHub
  security advisories, coordinated disclosure) and the README gained a
  Security section — local by default, deny-by-default serving,
  registration-time TLS pinning or SSH transport, byte-identical 404s for
  unselected endpoints on a subset door — with the accepted tradeoffs
  disclosed (client-side plaintext 0600 token storage, the token-bearing
  Windows door artifact, the trust-on-first-use window).

### Security

- The serve bearer gate now compares tokens in constant time: the
  presented `Authorization` header and each expected `Bearer <token>`
  string are SHA-256-digested before a `crypto.timingSafeEqual`
  comparison (hash-then-compare). Operator-chosen tokens are arbitrary
  lengths, so digesting first makes the comparison length-uniform —
  unequal lengths neither throw nor leak through early exits, and every
  auth-failure class (missing / malformed / wrong token) runs the same
  path. The auth outcome surface (status codes, messages, headers) is
  unchanged, and the byte-identical 401 across failure classes is now
  pinned by a wire test.

## [0.2.6] - 2026-09-23

### Added

- `ukp serve --print-task --write`: the door artifact generator can now
  write its two file artifacts directly to `%USERPROFILE%\.ukp\`
  (CRLF by construction) with the token interpolated from your
  `UKP_SERVE_TOKEN` — the token is never displayed, never passed in argv,
  and refused outright if it contains characters that would corrupt a cmd
  file (quotes, percent signs, control characters); minted hex tokens
  always pass. Existing files are never overwritten — manual edits (a
  PATH patch) are safe, and regeneration goes through the removal recipe.
  stdout reports what was written plus the remaining steps (task
  registration, firewall rule, `ukp diagnose --door` verification); the
  print-only form is unchanged and stays the default (full notes and the
  removal section). Nothing is registered, started, or opened by UKP in
  either mode.
- `ukp diagnose --door`: a read-only health check for this host's resident
  doors (Windows scheduled tasks running the print-task hidden launcher),
  merged into diagnose per the doctor convention rather than a new verb.
  Every door is reported with its task state, the wscript->cmd->bun
  process tree, its port (who holds it - inside the tree, an outside
  leftover, or free), and a door.log tail triage where only the latest
  evidence counts (failure signatures warn only when they follow the
  newest serving banner, so stale scar lines from earlier failed runs
  stay silent under a healthy restart). Discovery matches the launcher shape, not a fixed
  task name, so renamed second doors are found. Strictly read-only: the
  port verdict comes from the listener table (never a real bind, which
  could pop a firewall prompt), the start script's token line is never
  echoed, and every repair hint points at `ukp serve --print-task`
  section 5 or the restart posture. A door that is down is a finding
  (exit 1); a host with no doors is healthy.
- print-task Notes carry three door-family copy riders: single-endpoint
  prints name the alternative ("omit --endpoint to serve the whole
  registry as one host door" - one door instead of one port per
  endpoint); self-signed prints note that the scheduled task's PATH may
  lack the openssl source the interactive shell has (Git for Windows'
  mingw64\bin named as the common remedy, no hardcoded path); every
  print says to stop the door before editing start-door.cmd (a running
  cmd re-reads the script at a stale byte offset).
- `ukp guide remote` no longer prefers host door mode unconditionally:
  the preference now applies when the whole Registry is safe to declare,
  and a Registry mixing in endpoints you do not want to expose is pointed
  at --endpoint doors (with their per-door port/task/token cost named).
- `ukp init service` now installs a self-ignoring `.gitignore` (`*`)
  inside `.ukp/` on fresh inits: the folder holds machine-local Service
  state (manifest, instance identity, TLS private keys) that must never
  enter version control or folder sync. An existing `.ukp/.gitignore` is
  never touched (operator policy wins) and the repo-root `.gitignore` is
  never modified.
- print-task now prints its own inverse as section 5 ("To remove the
  door"), in three levels - stop now is not disabling, and disabling is
  not erasing: stop now (the same launcher-root taskkill; the scheduler's
  Stop/End-Task route is deliberately absent - it does not kill the
  tree), stop for good (`Unregister-ScheduledTask -Confirm:$false`, which
  neither confirms silently nor stops the running instance), and erase
  everything as the reverse of the setup steps (firewall rule delete,
  the by-name files with the token-bearing cmd called out - a file that
  ever left the machine burns the token; certificate material by TLS
  shape - a single-endpoint door's self-signed identity sits inside the
  served folder, so sync carries the private key out - and the
  host/consumer `ukp unregister` calls). The deployment handbook
  carries the mirrored teardown section plus the Linux
  socket-activation inverse (disable --now, unit files, ~/.ukp/tls).

### Fixed

- `ukp serve --print-task` on Windows: the generated start-door.cmd no
  longer redirects to door.log itself - the hidden launcher (vbs) is the
  sole log owner. Both layers redirecting to the same file deadlocked
  every first run (a nested append-open sharing violation: the door
  never started, and door.log showed only "process cannot access the
  file" lines). Affected 0.2.3-0.2.5.

### Changed

- print-task section 3 now defaults to an unelevated per-user PowerShell
  Register-ScheduledTask recipe (AtLogOn trigger for the current user;
  the elevated schtasks route is demoted to a note for machine-level
  triggers). The recipe deliberately sets no execution time limit: the
  Task Scheduler default stops a task 72 hours after it starts, silently
  killing a resident door.
- Manual restart now kills the launcher root (the wscript.exe running
  start-door-hidden.vbs) before Start-ScheduledTask - a serve-leaf-only
  kill leaves the launcher's retry to re-grab the port within 30
  seconds, racing the restart (no schtasks commands remain in the
  printed artifacts); a Git Bash note covers MSYS_NO_PATHCONV=1 for
  slash-style arguments.

## [0.2.5] - 2026-09-22

### Added

- `ukp guide remote` now tells consumers how to peek at a door before
  importing: `ssh <host> ukp list` for the ssh path, and the public
  `/.well-known/ukp.json` document is previewable with curl before
  registering (`-k` on the self-signed doors `ukp serve --tls` generates) —
  the roster of endpoint names and capabilities is no longer a post-import
  drift surprise.
- `ukp rg --files`: file enumeration as a second mode of `rg` (same family as
  `--count`) — a true tree walk, so empty and binary files are listed too,
  with no pattern to give. Output is one sorted `ukp://` reference per file
  (`--json` gains a `files` array and `files_mode`), `--glob`/`--type` narrow
  it, and the result cap defaults to 500 (`--limit` to change). Visibility is
  the same root as rg search: hidden files — including the `.ukp/` wiring —
  stay behind `-- --hidden`. Remote endpoints behave the same over the door
  (`/v1/rg?files=1`).
- `ukp rg --glob` is now repeatable (a later glob may negate with `!`, so
  include+exclude combinations work), `--iglob` joined the passthrough
  allowlist (case-insensitive glob), and `ukp guide rg` covers the three
  modes, glob semantics, and visibility tiers — rg was the only command
  without guide coverage.

### Fixed

- Windows: every remote command and every `ukp rg` run paid a hidden 5-10s
  per-spawn tax — Windows Defender behaviorally inspects the direct
  bun-to-`ssh.exe`/`rg.exe`/`taskkill.exe` child edge while letting the same
  binaries start in a fraction of a second through any intermediary. Real-tool
  spawns on win32 now route through a one-level `powershell -EncodedCommand`
  relay that carries argv byte-identical (the wake command's quoting is
  untouched), and tunnel teardown tree-kills through cmd so the reaper itself
  is not taxed. Measured on a Windows client with remote ssh doors: a
  remote-endpoint `ukp rg` 11.4s -> 2.4s, `ukp list` (two ssh doors) ~11s
  -> 3.1s, local `ukp rg` 9.9s -> 0.9s. Test-injected tool commands are never wrapped; non-Windows is
  byte-identical.

- An ssh endpoint whose host is powered off now fails with a classified
  verdict in seconds instead of stalling `ukp list` (and every remote
  command) for ~40s before a vague "check the host alias and key auth"
  message. Deterministic failures — host unreachable (off / firewalled /
  name gone), connection refused (host online, no ssh server), key rejected,
  host key changed — are read from ssh's own diagnostics and reject on the
  first attempt instead of burning the three-attempt wake ladder; instant
  verdicts (refused / auth / host key / name-resolution failures) are
  caught even earlier by the shell-family probe. Each class says what it
  means and what to do ("the machine appears off, firewalled, or its
  address no longer resolves; verify it is powered on", "start the ssh
  server on the host", ...). The retry ladder keeps doing its actual job
  (remote port collisions, doors that are slow to start), and
  `UKP_SSH_CONNECT_TIMEOUT_MS` keeps its meaning. Measured against a
  powered-off host: warm shell cache 39.8s -> 11.2s (one ConnectTimeout),
  cold cache -> ~17s, refused 13.4s -> 5.3s; healthy paths unchanged.

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
- `ukp serve --select <names>`: a subset host door - the host door's
  one-port `/e/<name>/` routing serving ONLY the named endpoints, for
  registries that mix shareable knowledge with internal project folders
  (one port and one scheduled task instead of one per endpoint; K8s
  Ingress "only add backends you intend to expose" shape). Discovery,
  routing, the public per-endpoint documents, and the 404 available-list
  all carry the same effective roster (select ∩ current registry), and an
  excluded endpoint's 404 is byte-identical to an unknown name's - the
  door never betrays that a hidden endpoint exists (CWE-204 / GitHub's
  404-not-404-avoiding-existence-confirmation posture; hiding a name from
  discovery while still routing it is rejected as rsync-style obscurity).
  Flag semantics mirror `register --select` (comma-separated, empty or
  unknown names are usage errors with the roster, mutually exclusive with
  --endpoint); membership still reconciles per request, so a selected
  endpoint unregistered later just disappears from every face. The serve
  banner gains a `select:` line, `--print-task` mirrors the flag into the
  start script, and `ukp diagnose --door` reports subset doors as
  `serve: subset a,b` (ADR-REM-010).
- Remote guide: "Prefer host door mode" keeps its condition (the whole
  Registry safe to declare) but a Registry mixing in endpoints the operator
  will not declare now takes `ukp serve --select a,b,c` - one port, one
  door, only the named subset, with unselected endpoints not served,
  routed, or declared - replacing the retired per-endpoint `--endpoint`
  door advice (O-020 ruling D companion wording change).
