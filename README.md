# UKP

Local-first Unified Knowledge Plane CLI for named knowledge endpoints.

UKP turns folders into services that can be addressed by name. That gives
humans and agents one stable command surface for inspecting, navigating,
reading, searching, and refreshing knowledge without memorizing physical
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
- Refresh provider-owned indexes through a stable UKP command (QMD-backed).
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
- QMD on `PATH` for `search/qmd`, `read/qmd`, and `refresh/qmd`. QMD is an
  external tool maintained as a separate project; it is required for the
  QMD-backed search, read, and refresh capabilities, which reach it through
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

| Command | What it does |
|---|---|
| `ukp version` / `ukp --version` / `ukp -V` | Shows the package version. |
| `ukp guide service` | Shows the provider-agnostic Service setup path. |
| `ukp guide service qmd` | Shows provider-owned setup for the QMD provider. |
| `ukp guide client` | Shows how a workspace uses registered Services by default. |
| `ukp guide propose` | Shows the propose quickstart: submitting idempotent change proposals to a Service. |
| `ukp init service` | Creates a minimal `.ukp/service.toml`. |
| `ukp diagnose` | Checks a local Service folder or registered endpoint scope. |
| `ukp register` / `ukp unregister --endpoint <name>` / `ukp list` | Manages Host Registry endpoint bindings. |
| `ukp inspect` | Explains current scope, Registry bindings, Manifest capabilities, and provider availability. |
| `ukp search` | Runs lexical search; `--recursive` expands direct authority/context dependencies. |
| `ukp read` | Reads an endpoint-scoped resource reference from one registered local Service. On a slot miss, layered rename recovery runs (git history, then search re-anchor) with `ukp-pin` content-hash verification (`--pin`); `--format json` emits a structured failure envelope. |
| `ukp nav` | Navigates the Markdown structure of one endpoint (`--depth`, `[path]`, `[truncated: N]` folders, respects `.gitignore`); on by default, configurable via `[capabilities.nav] exclude_files/exclude_dirs`. |
| `ukp refresh` | Runs provider-owned maintenance when `refresh/qmd` is declared. |
| `ukp propose` | Creates a proposal file in a target endpoint's proposal folder, dispatching via the file provider; resubmitting the same id updates the same proposal (created/unchanged/updated, revision bump). |

`--endpoint <name>` is the canonical endpoint selector. `-c <name>` remains a
compatibility alias. `-g` explicitly selects the full local Host Registry for
commands that support global scope.

## Supported Today

- local-first CLI;
- TOML Service Manifest, Host Registry, and Client Config;
- onboarding, diagnosis, registration, inspection, search, read, and refresh
  command surface;
- QMD-backed `search`, `read`, and `refresh`;
- agent-oriented JSON output and artifacts;
- explicit recursive search over direct authority/context dependencies.

## Not Yet

- Remote endpoints or a formal network protocol;
- `rg`, `vsearch`, API Search, query rewrite, reranking, or deduplication;
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
