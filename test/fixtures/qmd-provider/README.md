---
description: Deterministic QMD-provider test fixture — a canonical UKP Service folder whose fake `qmd` executable records invocations and returns QMD-like search/get/update results for adapter contract tests.
---

# QMD provider fixture

This fixture represents one canonical UKP Service folder. It is intentionally
small and deterministic so the provider adapter can be tested without relying
on the user's QMD index or global configuration.

## Layout

```text
qmd-provider/
├── .ukp/service.toml     # Service capability declaration
├── documents/             # Known fixture input
├── qmd-fixture.mjs        # QMD-compatible test executable
└── expected-invocation.json
```

The Service folder is the working directory for the provider invocation. The
fixture executable records that directory and the received arguments into
`qmd-fixture-invocation.json` (latest call) and `qmd-fixture-invocations.jsonl`
(appended stream), then returns a small QMD-like result: JSON for `search`, a
provider header + `---` + body text stream for `get`, and a short
acknowledgement for `update`. It does not emulate QMD ranking or collection
behavior.

## Provider contract covered

- `query` is passed as one positional argument, without trimming or rewriting.
- UKP's semantic `limit` is translated by the adapter to QMD's native `-n`.
- The provider receives output-mode selection; UKP does not reinterpret the
  provider's result ordering or score fields.
- `get` receives the reference with `:start[:count]` range appended and
  `--no-line-numbers`; it returns a provider location header, a `Folder
  Context:` metadata line, a `---` separator, then the body — which the adapter
  strips down to body-only stdout.
- The invocation cwd is the canonical Service folder containing
  `.ukp/service.toml`.

The fixture is not evidence that a real QMD index is healthy. QMD owns its
local/global configuration, collections, index freshness, and fallback rules.

## Parallel-test isolation rule

The invocation state files above are mutable and live in the Service folder
(the provider's cwd). bun runs test files in parallel, so **a test file that
asserts on invocation state must not register this shared directory as its
endpoint** — a parallel file's invocation would overwrite or delete the same
files mid-assert. Such test files take a private copy at module load via
`test/helpers/qmd-fixture.ts` (`createQmdFixtureCopy`). Test files that only
spawn the executable against their own per-test service folders (read,
update, manifest) can keep referencing the shared directory read-only.
