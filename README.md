# UKP CLI

UKP is a local-first Unified Knowledge Plane CLI.

It turns folders into named knowledge endpoints, then lets people and agents use
stable commands to inspect, search, read, and refresh them without remembering
physical paths or backend-specific command details.

```text
init service -> diagnose/register/list -> inspect -> search -> get -> refresh
```

> [!NOTE]
> The current minimum runnable Service uses QMD for lexical search. QMD is the
> first supported provider path, not the definition of UKP.

## Why UKP

Local knowledge work often starts as folders: project notes, design records,
specs, research files, and agent handbooks. Those folders can be useful, but
they are awkward to call from repeatable workflows because every caller needs
to know paths, setup details, and backend commands.

UKP adds a small control plane around those folders:

- give a knowledge folder a stable endpoint name;
- declare what capabilities it supports;
- inspect what a command will touch before running it;
- search through one CLI surface;
- read known endpoint-local files after a result;
- refresh provider-owned indexes through a stable UKP command.

## Quick Start

Run these commands from the folder that should become a Knowledge Service:

```bash
ukp init service --name your-endpoint-name
qmd init
qmd collection add ./docs
qmd update
ukp diagnose
ukp register
ukp list
ukp inspect --endpoint your-endpoint-name
ukp search "keyword" --endpoint your-endpoint-name --limit 3
```

The same path is available inside the CLI:

```bash
ukp guide service
```

## Service Manifest

`ukp init service` creates `.ukp/service.toml` with the current minimal search
capability:

```toml
[capabilities.search]
provider = "qmd"
```

That is enough for the first `diagnose -> register -> inspect -> search` path.

Add optional capabilities only when the Service should expose those operations
through UKP:

```toml
[capabilities.get]
provider = "file"

[capabilities.refresh]
provider = "qmd"
```

Then you can read endpoint-local files and refresh the provider:

```bash
ukp get --endpoint your-endpoint-name docs/example.md
ukp refresh --endpoint your-endpoint-name
```

## Commands

| Command | What it does |
|---|---|
| `ukp guide service` | Shows the first-use Service setup path. |
| `ukp init service` | Creates a minimal Service Manifest in the current folder. |
| `ukp diagnose` | Checks a local Service folder or registered endpoint scope. |
| `ukp register` / `ukp unregister` / `ukp list` | Manage Host Registry endpoint bindings. |
| `ukp inspect` | Explains current scope, Registry bindings, Manifest capabilities, and provider availability. |
| `ukp search` | Runs atomic lexical search against selected endpoints. |
| `ukp get` | Reads an endpoint-local resource when `get/file` is declared. |
| `ukp refresh` | Runs provider-owned maintenance when `refresh/qmd` is declared. |

`--endpoint <name>` is the canonical endpoint selector. `-c <name>` remains a
compatibility alias. `-g` explicitly selects the full Host Registry for commands
that support global scope.

## Agent Workflows

UKP is designed to be called by agents as well as humans:

```bash
ukp search "capability boundary" --endpoint your-endpoint-name --limit 5 --json
```

JSON output includes per-endpoint status and artifact references, while
provider-native artifacts preserve backend details without making them part of
the UKP-wide contract.

## Provider Boundary

UKP owns endpoint names, Registry bindings, Client scope, capability selection,
provider invocation, output shape, and recovery hints.

Providers own collection setup, indexes, ranking, local/global provider config,
maintenance strategy, and provider-native artifacts.

Future providers should enter UKP as adapters for declared capabilities instead
of turning QMD collection, index, or ranking semantics into UKP rules.

## Current Scope

This release surface is intentionally local-first and CLI-first. It supports the
QMD-backed `search` path plus the release surface around onboarding, inspection,
reading, and refresh.

Not included yet:

- Remote endpoints or a formal network protocol;
- `rg`, `vsearch`, API Search, query rewrite, reranking, or deduplication;
- full Client Scope with aliases, visibility, inheritance, or profiles;
- automatic artifact browsing, cleanup, or "select result N" references;
- standalone binary or external package distribution guarantees.
