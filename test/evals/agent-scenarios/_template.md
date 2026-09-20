# {Scenario Title}

## Control Target

The behavior under test, stated as the habit you want to observe. Name the
construct — task capability, salience, preference — because the verifier form
follows from it.

## Agent Shape

The configuration class this dispatch assumes: starting context (blank — no
prior conversation, no design background), reachable tools (a shell with the
`ukp` CLI on PATH), runtime family (any coding-agent runtime). Never name a
specific agent: naming one converts this artifact into that agent's private
regression test.

## Prompt To Agent

The natural task, verbatim — this is the only thing the agent sees. Intent,
permitted action surface, and a plain success statement only. No tool names
or workflow hints the user would not realistically give. No verifier
assertions: a leaked assertion turns the attempt into instruction-following
and voids it as evidence.

## Follow-up

Optional. One self-report question asked after the answer, to locate failure
source (salience, budget, misunderstanding). Diagnostic only — never ground
truth; post-hoc rationalization is a standing failure mode of introspection.

## Pass Criteria

Prose conditions on the observable behavior. Binary enough that "partial
pass" does not become the normal verdict — persistent partials mean the
criteria are underspecified, not that the agent is mediocre.

## Strong Pass Signals

Optional. Concrete behaviors that indicate the target habit, beyond the
minimum.

## Fail Signals

Concrete behaviors that falsify the target habit.

## Regression Trigger

Which surface changes (help text, output shapes, command naming, error
wording) warrant a re-run of this scenario. Re-runs are triggered by change,
not by schedule.

## Experiment Log

One block per attempt, newest last:

- {date} | verdict: pass / partial / fail | instrument: {model, runtime,
  version} | evidence: {what actually happened, with the signals observed} |
  implication: {what to change or re-run, if anything}

Instrument identity is mandatory — the agent is the measuring instrument,
and unversioned instruments make runs incomparable. Verdicts are evidence,
never CI gates: a non-deterministic subject cannot honestly gate CI.
