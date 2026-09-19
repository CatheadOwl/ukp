# UKP

Folder as a Service: turn folders into named knowledge endpoints — one
stable command surface, on this machine or your own server.

Register a folder and it becomes an endpoint for humans and agents alike —
nothing is started, the folder stays a folder. Navigate, read, and search
it; propose changes back to the owner as reviewable suggestions; update
provider-owned indexes (local today). No physical paths to memorize, no
provider-specific commands to relearn.

> [!NOTE]
> Early-stage CLI (MVP) — commands and behavior may still change.

```bash
$ ukp init service --name notes && ukp register
initialized Service: notes
registered: notes

$ ukp rg "Goals" --endpoint notes           # no search provider needed
== notes ==
1. 2026/q3-plan.md:3
   Goals for Q3: ship the knowledge plane.
   uri: ukp://notes/2026/q3-plan.md#L3

$ ukp read ukp://notes/2026/q3-plan.md      # read straight from the reference
# Q3 Plan
Goals for Q3: ship the knowledge plane.

$ ukp propose --endpoint notes --id typo-fix --file typo-fix.md   # the write face: declare propose first
proposal typo-fix created (revision 1)
```

## Why UKP

Knowledge work starts in folders, but repeated use needs stable names,
predictable scope, and a single command surface. Use UKP when:

- the right knowledge already lives in folders, and callers should address
  it by name instead of path;
- you keep re-explaining to people and agents where things live and how
  they are indexed;
- changes should come back as reviewable proposals for the owner to decide,
  not as unreviewed edits;
- provider setup should stay with the provider instead of leaking into
  every caller.

## What It Does

- Register local folders as named knowledge endpoints — a registered folder
  is a *Service*, addressed by its endpoint name.
- `ukp inspect` shows which endpoints the current scope selects — see what a
  command will touch before running it.
- Navigate the Markdown structure of an endpoint — folders, descriptions,
  depth — with zero provider dependency.
- Read endpoint-scoped references through `read/file` — if a file moves,
  reference recovery re-finds it (git history first, then search). The
  optional `read/qmd` goes through QMD (an external tool — see
  Requirements). `read` and `nav` are derived defaults of every local
  Service.
- Run base lexical search with `rg` across endpoint files — provider-free
  and on by default, shaped into `read`-ready references.
- Search one endpoint, a workspace default scope, the whole local Registry,
  or endpoints you have explicitly declared as its dependencies
  (authority/context links), with explicit recursion (QMD-backed).
- Propose changes as an idempotent, reviewable suggestion — the proposal
  lands in the endpoint's inbox and the verdict stays with its owner.
- Update provider-owned indexes through a stable UKP command (QMD-backed).
- Serve an endpoint over HTTP — a single endpoint, or the whole registry as
  a host door — when you want it reachable from other machines.
- Want a read-only endpoint? Declare zero capabilities — an empty
  `[capabilities]` table still registers one (derived `read`/`nav` only).
- Give agents JSON output (`--json`; `ukp read` uses `--format json`),
  reference sidecars, and
  `ukp://` handoff keys when they need machine-readable results.

UKP owns endpoint names, Registry bindings, Client scope, capability
selection, routing, and output shape; the provider owns collection setup,
indexes, ranking, and maintenance. UKP points to the delegated setup path —
it does not rewrite provider config for you.

## Install

Requirements:

- Bun `1.3.14` or newer — npm installs the `ukp` command, but the CLI runs
  on Bun.
- QMD on `PATH` only for the QMD-backed capabilities (`search/qmd`,
  `read/qmd`, `update/qmd`). QMD is an external tool maintained as a
  separate project; see its own release channel for installation. UKP
  installs and runs without it — those capabilities report as unavailable
  until `qmd` is available.

```bash
npm install -g @catheadowl/ukp
ukp --version
ukp guide service
```

One-off execution: `npx @catheadowl/ukp --version` (or `pnpm dlx` / `bunx`).

## First Run

For a human or agent starting from a folder:

1. `ukp init service` creates the minimum Service Manifest (`.ukp/service.toml`).
2. `ukp guide service` shows the provider-agnostic path. For the current QMD
   provider, `ukp guide service qmd` hands off the provider-owned setup.
3. `ukp diagnose` checks that the folder is wired correctly.
4. `ukp register` adds the folder to the Host Registry (`~/.ukp/registry.toml`).
5. `ukp inspect --endpoint <name>` shows the current binding, manifest, and
   provider availability.
6. `ukp nav`, `ukp rg`, and `ukp read` give the provider-free baseline.
7. `ukp search "<query>" --endpoint <name>` finds indexed matches after
   provider setup.

No QMD installed? Stop at step 6 — `nav`, `read`, `rg`, and `propose` work on
any endpoint without it.

An agent can carry out the same flow on your behalf.

For workspace defaults, use `ukp guide client` and `.ukp/client.toml`.

## Commands

Grouping below follows `ukp --help`; every command stays a flat
`ukp <verb>`. `--endpoint <name>` is the canonical endpoint selector
(`-c` is a compatibility alias); `-g` selects the full local Host Registry
where supported.

The same five commands work on local and remote endpoints — consuming a
remote endpoint is a one-command gesture (see below).

Endpoint commands:

| Command | What it does |
|---|---|
| `ukp search` | Indexed search through the endpoint's provider (QMD today); `--recursive` expands endpoints explicitly declared as dependencies (authority/context). Results hand off via `ukp://` references. |
| `ukp read` | Reads an endpoint-scoped resource — exact path, `ukp://` URI, or `docid` handoff key. |
| `ukp nav` | Markdown outline of an endpoint (`--depth`, respects `.gitignore`); on by default, configurable via `[capabilities.nav]`. |
| `ukp rg` | Lexical grep (ripgrep) across endpoint files — provider-free, on by default; results become `read`-ready `ukp://` references. A missing rg binary skips the endpoint with a warning (a single-endpoint run exits non-zero). |
| `ukp propose` | Submits an idempotent change proposal (suggestion box — the owner decides what happens next). Created/unchanged/updated; the revision bumps only on `updated`. |

Registry commands:

| Command | What it does |
|---|---|
| `ukp init service` | Creates a minimal `.ukp/service.toml`. |
| `ukp register` / `ukp unregister --endpoint <name>` | Manages Host Registry bindings. `ukp register --url <url>` registers a remote endpoint — the name comes from its discovery document (asserted, not chosen); `--endpoint <name>` is an expected-name assertion, not an alias. Identity is pinned TOFU-style (trust on first use), and self-signed certificates are pinned automatically. A **host door** url imports every endpoint behind it (`--endpoint` imports one; `--select` narrows; re-running refreshes idempotently). |
| `ukp list` | Lists registered endpoints with their declared capabilities. Door drift shows as a stderr note (`door <origin>: N unimported endpoint(s) …`) — importing stays an explicit gesture. |

Operations commands:

| Command | What it does |
|---|---|
| `ukp diagnose` | Checks a Service folder or endpoint scope for wiring problems. |
| `ukp inspect` | Explains current scope, bindings, manifest capabilities, and provider availability. |
| `ukp update` | Runs provider-owned maintenance when `update/qmd` is declared (local endpoints today). |
| `ukp serve` | Serves one endpoint — or, without `--endpoint`, the whole registry as a **host door** — over HTTP: a discovery document plus the five command routes (the write face requires the endpoint to declare propose). Loopback by default; `UKP_SERVE_TOKEN` enables bearer auth; `--tls` for HTTPS. |

Help commands:

| Command | What it does |
|---|---|
| `ukp version` / `ukp --version` / `ukp -V` | Shows the package version. |
| `ukp guide service` | Provider-agnostic Service setup path. |
| `ukp guide service qmd` | Provider-owned setup for the QMD provider. |
| `ukp guide client` | How a workspace uses registered Services by default. |
| `ukp guide remote` | How to serve and consume endpoints across machines. |
| `ukp guide propose` | The propose quickstart. |

## Remote in 60 seconds

`ukp serve` exposes an endpoint over HTTP. Authentication is deny-by-default:
serving with a `--host` beyond loopback requires `UKP_SERVE_TOKEN` (tokenless
serving needs an explicit `--allow-anonymous` and is refused off loopback).
The two fastest paths, from the consumer machine:

```bash
# SSH between two personal machines — the door is woken on demand, nothing
# to start on the host (prerequisites: ssh reachable + ukp on its PATH):
ukp register --url ssh://<host>                        # once; TOFU stored
ukp read --endpoint <name> notes/x.md                  # just works, like local

# Native TLS on a bare IP — self-signed, pinned automatically at registration:
UKP_SERVE_TOKEN=<token> ukp serve --endpoint <name> --host 0.0.0.0 --port 8570 --tls
ukp register --url https://<ip>:8570 --endpoint <name> --token <token>
```

Remote endpoints take the same commands as local ones — search, read, nav,
rg, propose. The full guide — the host door (one port for the whole
registry), Caddy and Tailscale fronting, the certificate pinning lifecycle,
and the hardening posture — lives in the
[deployment guide](https://github.com/CatheadOwl/ukp/blob/main/docs/remote-deployment.md).

## Not Yet

- remote operation of `update`, and a formally specified network protocol
  beyond the current ukp-remote wire v1;
- semantic search tier, an HTTP search API, query rewrite, reranking, or
  deduplication;
- full Client Scope with aliases, visibility, inheritance, or profiles;
- automatic artifact browsing, cleanup, or "select result N" references;
- standalone binary distribution.

## Documentation

- [Remote deployment](https://github.com/CatheadOwl/ukp/blob/main/docs/remote-deployment.md) — serving endpoints over
  SSH/HTTPS, the host door, Caddy and Tailscale fronting, the certificate
  pinning lifecycle, and the hardening posture.
- [Contributing](https://github.com/CatheadOwl/ukp/blob/main/CONTRIBUTING.md) — development setup and release packaging.
- [Changelog](https://github.com/CatheadOwl/ukp/blob/main/CHANGELOG.md) — what changed per release.
- Repository: https://github.com/CatheadOwl/ukp ·
  Issues: https://github.com/CatheadOwl/ukp/issues
