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
fixture executable records that directory and the received arguments, then
returns a small QMD-like JSON result. It does not emulate QMD ranking or
collection behavior.

## Provider contract covered

- `query` is passed as one positional argument, without trimming or rewriting.
- UKP's semantic `limit` is translated by the adapter to QMD's native `-n`.
- The provider receives output-mode selection; UKP does not reinterpret the
  provider's result ordering or score fields.
- The invocation cwd is the canonical Service folder containing
  `.ukp/service.toml`.

The fixture is not evidence that a real QMD index is healthy. QMD owns its
local/global configuration, collections, index freshness, and fallback rules.
