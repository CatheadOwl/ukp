# UKP

Local-first Unified Knowledge Plane CLI for named knowledge endpoints.

UKP turns folders into addressable Knowledge Services, then gives humans and
agents one stable command surface to inspect, search, read, and refresh those
services without hard-coding physical paths or provider-specific commands.

> [!NOTE]
> UKP is currently an MVP/demo-but-usable CLI. It is not a stable 1.0 protocol,
> and it does not publish the private planning workspace used to build the
> project.

## What You Can Do

- Register local folders as named knowledge endpoints.
- Inspect what a command will touch before running it.
- Search one endpoint, a workspace default scope, the whole local Registry, or
  direct authority/context dependencies with explicit recursion.
- Read endpoint-scoped references through `get/file` or QMD-backed `get/qmd`.
- Refresh provider-owned indexes through a stable UKP command.
- Call the CLI from agents with JSON output and provider-native artifacts.

UKP currently ships the local-first CLI core only. The first runnable search
provider path is QMD.

## Install

After the first public package is published:

```bash
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

- Bun `1.3.14` or newer in the verified baseline family.
- QMD on `PATH` for `search/qmd`, `get/qmd`, and `refresh/qmd`.
- Node/npm for package dry-runs and publishing workflows.

UKP can be installed without QMD, but QMD-backed capabilities will report as
unavailable until the `qmd` executable is available.

## Quickstart

Create a Service Manifest in the folder you want to expose:

```bash
cd path/to/knowledge-folder
ukp init service --name my-notes --description "Project notes"
ukp guide service qmd
ukp diagnose
```

Register the Service, then inspect and search it:

```bash
ukp register
ukp list
ukp inspect --endpoint my-notes
ukp search "capability boundary" --endpoint my-notes --limit 5
```

Read a result with the `get:` command printed by `ukp search`:

```bash
ukp get --endpoint my-notes <reference>
```

For agent workflows, add JSON output:

```bash
ukp search "agent loop detection" --endpoint my-notes --json
```

## Core Model

UKP separates four related journeys:

| Journey | Meaning |
|---|---|
| Provider path | `ukp init service` and `ukp register` make a folder an addressable Service. |
| Content-searchable | Provider setup decides what content is indexed and searchable. |
| Declared dependencies | A Service can declare `[[dependencies]]` on other endpoints. |
| Client path | A workspace `.ukp/client.toml` can provide default endpoints. |

Registration makes a folder addressable. It does not guarantee the provider has
indexed the folder's content. Run `ukp guide service` and `ukp guide service qmd`
to see the operational path for both layers.

## Commands

| Command | What it does |
|---|---|
| `ukp version` / `ukp --version` / `ukp -V` | Shows the package version. |
| `ukp guide service` | Shows the provider-agnostic Service setup path. |
| `ukp guide service qmd` | Shows provider-owned setup for QMD. |
| `ukp init service` | Creates a minimal `.ukp/service.toml`. |
| `ukp diagnose` | Checks a local Service folder or registered endpoint scope. |
| `ukp register` / `ukp unregister --endpoint <name>` / `ukp list` | Manages Host Registry endpoint bindings. |
| `ukp inspect` | Explains current scope, Registry bindings, Manifest capabilities, and provider availability. |
| `ukp search` | Runs lexical search; `--recursive` expands direct authority/context dependencies. |
| `ukp get` | Reads an endpoint-scoped resource reference from one registered local Service. |
| `ukp refresh` | Runs provider-owned maintenance when `refresh/qmd` is declared. |

`--endpoint <name>` is the canonical endpoint selector. `-c <name>` remains a
compatibility alias. `-g` explicitly selects the full local Host Registry for
commands that support global scope.

## Provider Boundary

UKP owns endpoint names, Registry bindings, Client scope, capability selection,
provider invocation, output shape, and recovery hints.

Providers own collection setup, indexes, ranking, local/global provider config,
maintenance strategy, and provider-native artifacts.

QMD is the first supported provider path, not the definition of UKP. Future
providers should enter UKP as adapters for declared capabilities instead of
turning QMD collection, index, or ranking semantics into UKP-wide rules.

## Current Scope

Included in the current public core:

- local-first CLI;
- TOML Service Manifest, Host Registry, and Client Config handling;
- onboarding, diagnosis, registration, inspection, search, read, and refresh
  command surface;
- QMD-backed `search`, `get`, and `refresh`;
- agent-oriented JSON output and artifacts.

Not included yet:

- Remote endpoints or a formal network protocol;
- `rg`, `vsearch`, API Search, query rewrite, reranking, or deduplication;
- full Client Scope with aliases, visibility, inheritance, or profiles;
- automatic artifact browsing, cleanup, or "select result N" references;
- standalone binary distribution.

## Development

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
npm pack --dry-run --json
```

The npm package is intentionally allowlisted. The public tarball should contain
runtime source, README, package metadata, lock/config files, and the project
license only.
