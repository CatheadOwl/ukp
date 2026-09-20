# End-to-End Tests

This directory holds the end-to-end suite: tests that drive **closed command
chains** across the CLI surface, rather than single-function units. A typical
chain registers or connects to endpoints, executes commands, and reads results
back through another command.

Unit regression (argument parsing, renderers, path safety, per-command
behavior) stays in the parent `test/` directory. If a scenario needs a full
chain — identity registration, transport, search, handoff, read-back — it
belongs here.

## What lives here

| File | Chain it covers |
|---|---|
| `serve.test.ts` | `ukp serve` HTTP surface: discovery document, search/read routes, auth, TLS identity lifecycle |
| `remote-client.test.ts` | Remote consumption end to end: a real local `serve` instance acts as the remote — `register --url`, TOFU pinning, search/read/nav/rg/list/propose over loopback, ssh transport wake |
| `host-door.test.ts` | Host-door import (`/e/<name>/`): registration, drift notes, name collision handling |
| `bin-launcher.test.ts` | Package entry smoke: the published launcher resolves a runtime and starts the CLI |
| `reference-integrity.test.ts` | Reference emission integrity: adversarial corpus layouts, `ukp://` reference emission, read-back round-trip |

Remote chains run against real loopback HTTP with a fixture search provider
(`../helpers/qmd-fixture.mjs`) — there are no transport stubs in this suite.
The ssh wake path uses the scripted ssh binary in `../helpers/fake-ssh.mjs`.

## Running

```bash
bun test              # full suite (what CI runs)
bun test test/e2e     # only the end-to-end chains
```

The TLS cases need `openssl` on `PATH` (self-signed certificate generation).

## Adding a scenario

Keep the unit/e2e split: add here only when the assertion depends on the whole
chain (identity, transport, handoff between commands) rather than one module.
Drive the chain through command-layer entry points or the launcher binary,
following the existing files; reuse `../helpers/` instead of adding new
fixture providers.
