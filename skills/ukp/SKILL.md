---
name: ukp
description: "ukp — a CLI tool for named knowledge endpoints(registered local or remote folders)"
---

# ukp

A CLI tool for knowledge endpoints: register any local or remote folder
as a named endpoint, then address knowledge by name through one stable
command surface.

## Entry

Run `ukp --help` — the command surface teaches itself: grouped help,
per-command `--help` for exact grammar, `ukp guide <topic>` for
role-based walkthroughs, `ukp list` for the registered endpoints.

## Handoff: ukp:// references

Knowledge you got from ukp is handed off as
`ukp://<endpoint>/<path>` — name-addressed, so folders can move while
references stay valid. 

`ukp read <uri>` opens one as-is, replayable in
any session. The cross-repo `{name}:path` shorthand resolves the same
way.

## Writes: propose

Endpoints are read-only by default. Changes go through `ukp propose` —
an idempotent suggestion box (created / unchanged / updated; a revision
bumps only on updated) that the endpoint owner adjudicates.
