---
name: ukp-manifest-reference
description: "Normative reference for the hand-authored Service manifest (.ukp/service.toml) — every legal key, grammar, and example; kept in lockstep with the loader by an anchor test"
---

# Service manifest reference

`.ukp/service.toml` is the one UKP file you author by hand (usually seeded by
`ukp init service`; UKP never rewrites it). This page is the normative
reference for what it may contain. The loader enforces the same grammar in
code with a strict schema — unknown keys and tables are refused, so a typo
fails loudly instead of silently changing behavior. An anchor test parses
this page against the real schema: when they drift, the suite goes red.

## Keys at a glance

| Key | Shape | Required | Meaning |
|---|---|---|---|
| `name` | string | no | the endpoint's declared name (Endpoint name profile below) |
| `description` | non-empty string | no | human/agent-facing summary of what the endpoint holds |
| `dependencies` | array of tables | no | declared `depends_on` relations to other endpoints |
| `[capabilities]` | table | **yes** | the capability registry; an empty table is valid |

```text
manifest-keys: capabilities dependencies description name
capability-keys: config provider
dependency-keys: endpoint kind reason
dependency-kinds: authority context evidence implementation
```

## `name` — declared endpoint name

Optional. When present it must match the Endpoint name profile: 1–63
characters total, lowercase alphanumeric segments joined by single hyphens
(`[a-z0-9]+(-[a-z0-9]+)*`). When omitted, registration derives the effective
name from the folder basename — the basename goes through the same profile
check and is never auto-rewritten.

## `description` — endpoint summary

Optional; when present it must be a non-empty string. It is metadata for
humans and agents reading about the endpoint; it takes no part in endpoint
identity, scope resolution, capability resolution, or ordering, and the
registry does not store it.

## `[[dependencies]]` — declared knowledge relations

Optional; when present it must be a non-empty array of tables. Every entry
declares that this Service `depends_on` another endpoint:

- `endpoint` (required) — the depended-on endpoint's name. Whether that name
  is actually registered is not the manifest's business; `ukp diagnose` /
  `ukp inspect` surface dangling targets as warnings.
- `kind` (required) — one of `authority`, `context`, `implementation`,
  `evidence`.
- `reason` (optional) — a non-empty string saying why the relation exists.

The same `endpoint` may not appear twice, and a Service cannot declare a
dependency on its own effective endpoint name. The pre-table shorthand
(`dependencies = ["x"]`) and an empty array are both invalid. The graph is
declarative only — it changes no command's default behavior; it widens
`ukp search --recursive` and feeds read-only reporting. Only `depends_on`
exists in the schema; `derived_from`, `overlaps_with`, `related_to`, and
similar vocabulary are not accepted.

## `[capabilities]` — the capability registry

Required as a table; an **empty table is valid and means a read-only
endpoint**: it exposes only the derived file-native capabilities (`read`,
`nav`) and `rg` stays available as the external-tool base tier. Omitting the
`[capabilities]` key entirely is a structural error.

Each entry is a table `[capabilities.<name>]`:

- `provider` (optional for some, required for others) — a non-empty string.
  File-native capabilities (`propose`, `nav`) and the external-tool tier
  (`rg`) accept a **bare declaration** (`[capabilities.propose]` alone): the
  loader normalizes the provider for you (`file` / `external`). Every other
  capability — `search` today — must declare a non-empty `provider` or fail
  at load. Provider names are not enum-checked here: an unknown provider is
  a capability-resolution warning, not a schema error.
- `config` (optional) — a table whose keys belong to the provider, not to
  UKP (for example `[capabilities.propose] config.folder = "inbox"`).

Notes on derived capabilities: `read` and `nav` exist on every registered
local Service without any declaration; `[capabilities.nav]` exists only to
override defaults, and its visibility keys (`exclude_files`,
`exclude_dirs`) may sit flat under the table (the loader normalizes them
into `config`; having the same key in both places is a conflict). The legacy
table `[capabilities.get]` is recognized and wholly ignored for
compatibility — no other unknown key gets that treatment.

## Examples

Every example below is complete and loadable.

Provider-free baseline (the read-only endpoint `ukp init service` seeds):

```toml
name = "cad-notes"
description = "CAD knowledge service for standards, notes, and retrieval smoke tests."

[capabilities]
```

Indexed search through the default provider (the provider owns its
collections, indexes, and ranking — none of that is declared here):

```toml
name = "cad-qmd"
description = "CAD QMD-backed knowledge service."

[capabilities.search]
provider = "qmd"
```

The opt-in write path plus a dependency (propose is never derived — it must
be declared; the bare form means the `file` provider):

```toml
name = "mem0"
description = "Personal memory and project continuity notes."

[[dependencies]]
endpoint = "ukp-product"
kind = "context"
reason = "product decisions frame what is worth remembering"

[capabilities.propose]
```

## Version control

`ukp init service` writes a precise `.ukp/.gitignore` beside the manifest:
declarations (`service.toml`, `client.toml`) travel with clones, while
machine-local state (instance identity) stays ignored. Operator-owned files
are never touched.
