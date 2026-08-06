# UKP CLI

UKP is a local-first Unified Knowledge Plane CLI.

It turns folders into named knowledge endpoints, then lets people and agents use
stable commands to inspect, search, read, and refresh them without remembering
physical paths or backend-specific command details.

> [!NOTE]
> The current minimum runnable Service uses QMD for lexical search. QMD is the
> first supported provider path, not the definition of UKP.

## Four Journeys

UKP separates four journeys. They do not replace each other:

- **Provider path**: `ukp init service` + `ukp register` make a folder an
  addressable Service — a named endpoint that can be inspected, called, and
  maintained.
- **Content-searchable**: provider setup decides what content is indexed. This
  is provider-owned. Registered as a Service does not mean its
  content is searchable; both steps are needed.
- **Declared dependencies**: a Service Manifest can name other knowledge
  endpoints it depends on. This is declarative only and does not change
  search/get behavior by itself.
- **Client path**: a workspace `.ukp/client.toml` default scope lets you use
  Services by default instead of naming one each call.

Run `ukp guide service` for the UKP Service setup path, `ukp guide service qmd`
for the default provider's setup, and `ukp <command> --help` for any command's
exact syntax.

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
- read endpoint-scoped references through `get/file` or provider delegation;
- refresh provider-owned indexes through a stable UKP command.

## Commands

| Command | What it does |
|---|---|
| `ukp version` / `ukp --version` / `ukp -V` | Shows the current UKP CLI package version. `ukp version -v` adds debug identity details. |
| `ukp guide service` | Shows the provider-agnostic Service setup path. |
| `ukp guide service qmd` | Shows provider-owned setup for the default QMD provider. |
| `ukp init service` | Creates a minimal Service Manifest in the current folder. |
| `ukp diagnose` | Checks a local Service folder or registered endpoint scope. |
| `ukp register` / `ukp unregister --endpoint <name>` / `ukp list` | Manage Host Registry endpoint bindings. |
| `ukp inspect` | Explains current scope, Registry bindings, Manifest capabilities, and provider availability. |
| `ukp search` | Runs atomic lexical search against selected endpoints. |
| `ukp get` | Reads an endpoint-scoped resource reference from one registered local Service. |
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
