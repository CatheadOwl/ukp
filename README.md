# UKP

Local-first Unified Knowledge Plane CLI for named knowledge endpoints.

UKP turns folders into services that can be addressed by name. That gives
humans and agents one stable command surface for inspecting, navigating,
reading, searching, and updating knowledge without memorizing physical
paths or provider-specific commands.

> [!NOTE]
> UKP is the current public MVP CLI. It is not a stable 1.0 protocol.

## Why UKP

Knowledge work usually starts in folders, but repeated use needs stable names,
predictable scope, and a single command surface. UKP exists to move that setup
out of every query and into a reusable registry/config boundary.

Use UKP when:

- the right knowledge already lives in folders;
- callers should address it by service name, not path;
- provider setup should stay with the provider instead of leaking into every
  caller.

## What It Does

- Register local folders as named knowledge endpoints.
- Inspect what a command will touch before running it.
- Navigate the Markdown structure of an endpoint—folders, descriptions,
  depth—with zero provider dependency.
- Read endpoint-scoped references through `read/file`; QMD-backed `read/qmd`
  is optional. `read` and `nav` are derived defaults of every registered
  local Service.
- Search one endpoint, a workspace default scope, the whole local Registry, or
  direct authority/context dependencies with explicit recursion (QMD-backed).
- Update provider-owned indexes through a stable UKP command (QMD-backed).
- Give agents JSON output and provider-native artifacts when they need
  machine-readable handoff.

## Install

```bash
npm install -g @catheadowl/ukp
ukp --version
ukp guide service
```

For one-off execution from the npm registry:

```bash
npx @catheadowl/ukp --version
pnpm dlx @catheadowl/ukp --version
bunx @catheadowl/ukp --version
bunx @catheadowl/ukp guide service
```

For local development from a checkout:

```bash
bun install
bun run src/cli.ts --version
bun run src/cli.ts guide service
```

Requirements:

- Bun `1.3.14` or newer in the verified baseline family. The package is
  published through npm, but the CLI currently runs on Bun.
- QMD on `PATH` for `search/qmd`, `read/qmd`, and `update/qmd`. QMD is an
  external tool maintained as a separate project; it is required for the
  QMD-backed search, read, and update capabilities, which reach it through
  UKP's provider path. See QMD's own release channel and documentation for
  installation.
- Node/npm for package dry-runs and publishing workflows.

UKP can be installed without QMD, but QMD-backed capabilities will report as
unavailable until the `qmd` executable is available.

## First Run

For a human or agent starting from a folder:

1. `ukp init service` creates the minimum Service Manifest (`.ukp/service.toml`).
2. `ukp guide service` shows the provider-agnostic path. For the current QMD
   provider, `ukp guide service qmd` hands off the provider-owned setup.
3. `ukp diagnose` checks that the folder is wired correctly.
4. `ukp register` adds the folder to the Host Registry (`~/.ukp/registry.toml`).
5. `ukp inspect --endpoint <name>` shows the current binding, manifest, and
   provider availability.
6. `ukp search "<query>" --endpoint <name>` finds matches.
7. `ukp read --endpoint <name> <reference>` reads a result.

An agent can carry out the same flow on your behalf. UKP handles naming,
routing, and the command surface; the provider handles collection setup,
indexing, ranking, and maintenance.

For workspace defaults, use `ukp guide client` and `.ukp/client.toml`.

## Who Owns What

| UKP owns | Provider owns |
|---|---|
| endpoint names, Registry bindings, Client scope, capability selection, routing, output shape, recovery hints | collection setup, indexes, ranking, provider config, maintenance, provider-native artifacts |

UKP points to the delegated setup path. It does not rewrite provider config for
you.

## Commands

Commands are grouped in `ukp --help` by purpose (ADR 0022). Grouping is a
display concern only: every command stays a flat `ukp <verb>`.

### Endpoint commands

| Command | What it does |
|---|---|
| `ukp search` | Runs indexed search through the endpoint's search provider (currently QMD; a semantic tier is a future provider tier); `--recursive` expands direct authority/context dependencies. Works on remote endpoints too: results hand off via `ukp://` references. |
| `ukp read` | Reads an endpoint-scoped resource reference from one registered Service — local or remote. On a slot miss, layered rename recovery runs (git history, then search re-anchor) with `ukp-pin` content-hash verification (`--pin`); `--format json` emits a structured failure envelope. |
| `ukp nav` | Navigates the Markdown structure of one endpoint (`--depth`, `[path]`, `[truncated: N]` folders, respects `.gitignore`); on by default, configurable via `[capabilities.nav] exclude_files/exclude_dirs`. |
| `ukp rg` | Runs base lexical search (ripgrep) across endpoints — available on every registered endpoint by default (a missing rg binary degrades to a skip, never a fault); results are shaped into `read`-ready `ukp://` references; `--count` lists per-file counts; `--` passes rg flags through on an allowlist. |
| `ukp propose` | Creates a proposal file in a target endpoint's proposal folder, dispatching via the file provider; resubmitting the same id updates the same proposal (created/unchanged/updated, revision bump). |

### Registry commands

| Command | What it does |
|---|---|
| `ukp init service` | Creates a minimal `.ukp/service.toml`. |
| `ukp register` / `ukp unregister --endpoint <name>` | Manages Host Registry endpoint bindings. `ukp register --url <url>` registers a remote `ukp serve` endpoint: the name and instance identity come from its discovery document and are pinned TOFU-style. |
| `ukp list` | Lists registered endpoint bindings (local paths and remote urls, with per-endpoint declared capabilities). |

### Operations commands

| Command | What it does |
|---|---|
| `ukp diagnose` | Checks a local Service folder or registered endpoint scope. |
| `ukp inspect` | Explains current scope, Registry bindings, Manifest capabilities, and provider availability. |
| `ukp update` | Runs provider-owned maintenance when `update/qmd` is declared. |
| `ukp serve` | Exposes one registered endpoint over HTTP using the ukp-remote wire: a discovery document (`/.well-known/ukp.json`), `POST /v1/search`, and `GET /v1/read`. Loopback by default; `UKP_SERVE_TOKEN` enables bearer auth, and a non-loopback `--host` without a token is refused. |

### Help commands

| Command | What it does |
|---|---|
| `ukp version` / `ukp --version` / `ukp -V` | Shows the package version. |
| `ukp guide service` | Shows the provider-agnostic Service setup path. |
| `ukp guide service qmd` | Shows provider-owned setup for the QMD provider. |
| `ukp guide client` | Shows how a workspace uses registered Services by default. |
| `ukp guide propose` | Shows the propose quickstart: submitting idempotent change proposals to a Service. |

`--endpoint <name>` is the canonical endpoint selector. `-c <name>` remains a
compatibility alias. `-g` explicitly selects the full local Host Registry for
commands that support global scope.

## Supported Today

- local-first CLI;
- TOML Service Manifest, Host Registry, and Client Config;
- onboarding, diagnosis, registration, inspection, search, read, update, and
  HTTP serving (`ukp serve`) command surface;
- remote endpoint consumption (ukp-remote wire v1): serve one endpoint over
  HTTP, register it from another machine with `ukp register --url`, then
  `search`/`read`/`list` against it (`ukp://` handoffs, TOFU identity pin,
  bearer tokens via `UKP_ENDPOINT_<NAME>_TOKEN`);
- QMD-backed `search`, `read`, and `update`;
- agent-oriented JSON output and artifacts;
- explicit recursive search over direct authority/context dependencies.

## Not Yet

- remote operation of `nav` / `rg` / `update` / `propose` (explicit
  not-yet-remote-enabled errors today) and a formal network protocol;

## Remote Deployment

`ukp serve` speaks plain HTTP; TLS and public exposure belong to a reverse
proxy or an SSH tunnel in front of it (the data plane stays thin). The trust
model is public PKI — a real domain, or an overlay tailnet that provisions
real certificates. **Authentication is deny-by-default**: serving requires
`UKP_SERVE_TOKEN`; tokenless serving needs an explicit `--allow-anonymous`
and is refused off loopback. A reverse proxy on the same host forwards from
the public side to the loopback bind, so proxied deployments treat the token
as mandatory (serve cannot see past its own bind address). The full
real-machine walkthrough (worked example on the author's VPS) lives in the
repository handbook: `handbooks/ukp-remote-deployment/`.

### Via an SSH tunnel (two personal machines — zero extra components)

SSH provides encryption and authentication; the tunnel maps the remote
loopback to a local port, so the loopback admission holds naturally.

```bash
ssh -N -L 18575:127.0.0.1:8570 <host> &
UKP_ENDPOINT_<NAME>_TOKEN=<token> ukp register --url http://127.0.0.1:18575
```

### Behind Caddy (public domain)

```
# Caddyfile — automatic Let's Encrypt
kb.example.com {
    reverse_proxy 127.0.0.1:8570
}
```

```bash
UKP_SERVE_TOKEN=<token> ukp serve --endpoint <name> --host 127.0.0.1 --port 8570
# on the consumer machine:
UKP_ENDPOINT_<NAME>_TOKEN=<token> ukp register --url https://kb.example.com
```

### Via Tailscale (two machines on any network — including the same LAN)

Enable HTTPS certificates on your tailnet once (admin console: DNS →
MagicDNS → HTTPS Certificates); Tailscale then provisions Let's Encrypt
certificates for your `*.ts.net` hostnames.

```bash
# both machines: tailscale up (same tailnet)
# server machine:
UKP_SERVE_TOKEN=<token> ukp serve --endpoint <name> --host 127.0.0.1 --port 8570
tailscale serve --bg --https=443 http://127.0.0.1:8570
# consumer machine:
UKP_ENDPOINT_<NAME>_TOKEN=<token> ukp register --url https://<machine>.<tailnet>.ts.net
```

The overlay covers LAN and roaming machines alike; a fully offline LAN (no
coordination reachability) is the one gap — a dedicated private-CA recipe is
deferred until that is a real constraint.

### Hardening posture

- rate limiting, IP allowlists, and audit logging live at the proxy layer —
  the `ukp` core stays thin;
- multiple client tokens: comma-separate them — `UKP_SERVE_TOKEN=alice,bob`
  (any listed token authorizes);
- identity pinning is TOFU on `instance_uid`: a changed endpoint warns by
  default; set `UKP_TOFU=block` on hostile networks to refuse it outright.
- semantic search tier (5b), API Search, query rewrite, reranking, or deduplication;
- full Client Scope with aliases, visibility, inheritance, or profiles;
- automatic artifact browsing, cleanup, or "select result N" references;
- standalone binary distribution.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup.

- Repository: https://github.com/CatheadOwl/ukp
- Issues: https://github.com/CatheadOwl/ukp/issues

The npm package is intentionally allowlisted. The public tarball should contain
runtime source, README, package metadata, lock/config files, and the project
license only.
