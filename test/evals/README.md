# Eval Scenarios

This is the black-box eval layer: closed command chains driven **only through
the published CLI surface**. Where `test/` asserts units and `test/e2e/`
asserts integration through command-layer entry points, this directory
asserts a different thing entirely — that everything the CLI *prints* as a
handoff actually works for a stranger who copies it verbatim.

## The rules

1. **Spawn only.** Scenarios never import from `src/`. They spawn the CLI
   entry and consume stdout, stderr, exit codes, and the filesystem
   after-state — the exact surface a stranger (or a dispatched agent) gets.
   `guard.test.ts` fails the suite if any file here imports the
   implementation.
2. **Printed handoffs must replay verbatim.** If the output prints a JSON
   sidecar reference, a `ukp://` uri, or a human-mode `read:` hint line,
   the scenario executes it exactly as printed (whitespace-split, no
   re-typing) and expects exit 0 with the same content.
3. **Content identity, not just exit codes.** Where the product promises a
   content-addressed key (the docid is a sha256 prefix), the scenario
   recomputes it from the fixture bytes and compares — a hint that reads
   *something* is not enough; it must read the *same resource*.
4. **Self-contained fixtures.** Each scenario ships its own environment
   (isolated home, registry, provider shim, git history) built by
   `harness/scenario.ts`. Nothing leaks between scenarios.

## Layout

```text
test/evals/
├── guard.test.ts            # enforces rule 1 mechanically
├── harness/scenario.ts      # spawn harness: isolated home + qmd PATH shim + git helpers
├── scenarios/               # deterministic leg — CI-runnable
│   ├── local-handoff.test.ts    # search → sidecar docid / ukp:// uri / read: hint → read back
│   ├── recovery-chain.test.ts   # stale ukp:// → recovery echo → --show-pin verification
│   ├── remote-handoff.test.ts   # register --url → remote search → hint replay over the wire
│   └── write-loop.test.ts       # propose three states → ukp:// remote read back
└── agent-scenarios/         # subagent leg — task artifacts, see below
```

## Subagent leg (task artifacts)

`agent-scenarios/` holds the other consumer: not a script, but a real agent.
Each file is a self-contained task artifact — agent shape, verbatim prompt,
pass criteria, fail signals, regression trigger, experiment log — that any
agent runtime can be dispatched against. The dispatch is done by whoever
runs it (one subagent per task, prompt verbatim); nothing here calls a model
or holds credentials, so the artifacts are runner-neutral.

Two verifier forms, chosen by the construct:

- an end state exists (the right content was reached, the right command ran)
  → deterministic checks over the transcript;
- the construct is salience or preference (did the agent notice and use the
  printed handoff?) → the prose criteria are the primary verifier, and the
  optional follow-up question is diagnostic only, never ground truth.

Verdicts are `pass` / `partial` / `fail`, recorded in the artifact's
experiment log with mandatory instrument identity (model, runtime, version).
They are evidence, never CI gates. Persistent `partial` verdicts mean the
criteria need sharpening.

## Running

```bash
bun test test/evals     # just this layer
bun test                # the whole suite (this layer included)
```

The search scenarios need a `qmd` on PATH — the harness installs a shim
pointing at the deterministic fixture provider (`test/fixtures/qmd-provider`),
so no real provider is required. The recovery scenarios need `git`.

## Adding a scenario

Add a family under `scenarios/` when the assertion is about **what the
output promises to a consumer** (handoff executability, recovery, identity),
not about internal behavior — that belongs in `test/` or `test/e2e/`. Build
the world with `harness/scenario.ts`, drive everything through `runUkp`, and
assert on the observable surface only.
