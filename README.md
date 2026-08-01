# UKP CLI

UKP is a local-first Unified Knowledge Plane CLI. It turns configured folders
into named knowledge endpoints, then lets clients use stable atomic commands
instead of remembering paths and backend details.

The current minimum runnable Service uses QMD as the `search` provider. That is
the first supported provider path, not the definition of UKP: a UKP Service is
a folder that declares capabilities, and providers implement those
capabilities.

## Quick Start

Run these commands from the folder that should become a Knowledge Service:

```bash
ukp init service --name your-endpoint-name
qmd init
qmd collection add ./docs
qmd update
ukp diagnose
ukp register
ukp inspect --endpoint your-endpoint-name
ukp search "keyword" --endpoint your-endpoint-name --limit 3
```

For the in-CLI version of this path:

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

The generated Manifest is enough for the first `diagnose -> register -> search`
path.

Add these optional capabilities only when the Service should expose that
operation through UKP:

```toml
[capabilities.get]
provider = "file"

[capabilities.refresh]
provider = "qmd"
```

QMD still owns its own collection, index, ranking, update behavior, and
local/global configuration. UKP owns endpoint names, Registry bindings,
capability selection, provider invocation, and command output.

## Common Commands

```bash
ukp list
ukp inspect
ukp inspect --endpoint your-endpoint-name
ukp search "keyword"
ukp search "keyword" --endpoint your-endpoint-name --json
ukp get --endpoint your-endpoint-name docs/example.md
ukp refresh --endpoint your-endpoint-name
```

`--endpoint <name>` is the canonical endpoint selector. `-c <name>` remains a
compatibility alias. `-g` explicitly selects the full Host Registry for commands
that support global scope.

Future providers should enter UKP as provider adapters for declared
capabilities, instead of promoting QMD collection, index, or ranking semantics
into UKP-wide rules.
