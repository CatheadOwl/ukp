# Read a fact through the printed handoffs, without learning the layout

## Control Target

Salience and preference: when a stranger agent wants one fact out of a
registered knowledge endpoint, does the CLI's own output carry it the whole
way — from `search` results to a copyable read line to the right content —
so the agent never needs to know where files live or how addressing works?

## Agent Shape

Blank context (no prior conversation, no background on this repository). A
shell with `ukp` on PATH and one endpoint already registered and known by
name. Any coding-agent runtime.

## Prompt To Agent

There is a knowledge endpoint registered under the name `notes`. Somewhere
in it there is a document that mentions the phrase "lighthouse keeper".
Find it and tell me the full sentence that contains the phrase. Use the
endpoint's own commands; do not explore the filesystem directly.

## Follow-up

Which line of the command output told you what to run next?

## Pass Criteria

- The quoted sentence exists verbatim in the endpoint's corpus and contains
  the phrase.
- The transcript shows the agent reached the content through the CLI, and
  the read command it ran matches a handoff line the previous command
  printed (copied, not re-typed from intuition).

## Strong Pass Signals

- The agent ran the printed `read:` line exactly as printed.
- The agent never listed directories or searched the raw filesystem.

## Fail Signals

- The agent found the file with `grep`/`find` or by guessing paths.
- The agent quoted a sentence from memory or from the search excerpt
  without reading the resource back.
- The agent constructed a reference form the output never showed it.

## Regression Trigger

Re-run when search's human output shape changes (result units, handoff
lines), when read's reference forms change, or when endpoint listing output
changes.

## Experiment Log

(none yet)
