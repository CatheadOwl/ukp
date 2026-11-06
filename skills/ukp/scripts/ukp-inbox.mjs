#!/usr/bin/env node
// Owner-private SessionStart hook script (wired in ~/.zcode/cli/config.json →
// hooks.events.SessionStart; NOT part of the published skill whitelist).
// Advisory surface for pending ukp proposals: when the session's project is a
// ukp endpoint that declares the propose capability and its proposal folder is
// non-empty, inject one context line so adjudication is on the session agenda.
// Silent (exit 0, no output) when: not an endpoint, no propose capability,
// folder absent, or folder empty (adjudicated entries are deleted per the
// endpoint's triage convention, so non-empty === pending — no lifecycle-status
// parsing by design; terminal statuses do not exist yet).
// Only coupling to ukp: the `.ukp/service.toml` propose section and its
// optional `folder` key (ukp default "inbox"); case-insensitive dir match for
// Windows/POSIX parity.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root =
  process.env.ZCODE_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const tomlPath = join(root, ".ukp", "service.toml");
if (!existsSync(tomlPath)) process.exit(0);
const toml = readFileSync(tomlPath, "utf8");
if (!/^\s*\[capabilities\.propose\]/m.test(toml)) process.exit(0);

// Minimal config read: a top-level `folder = "…"` key (ukp only defines it
// under [capabilities.propose.config]).
const folderKey = toml.match(/^folder\s*=\s*"([^"]+)"/m);
const wanted = (folderKey?.[1] ?? "inbox").toLowerCase();
const folder = readdirSync(root, { withFileTypes: true })
  .find((e) => e.isDirectory() && e.name.toLowerCase() === wanted);
if (!folder) process.exit(0);

// README (the folder's rules doc) and dotfiles are not proposals.
const entries = readdirSync(join(root, folder.name), { withFileTypes: true })
  .filter((e) => e.isFile() && !/^readme\./i.test(e.name) && !e.name.startsWith("."))
  .map((e) => e.name);
if (entries.length === 0) process.exit(0);

// Display line per entry: service-maintained id + submitter subject when
// cheaply parseable from the front-matter head; file stem otherwise.
const items = entries.map((name) => {
  const stem = name.replace(/\.md$/i, "");
  try {
    const head = readFileSync(join(root, folder.name, name), "utf8").slice(0, 1200);
    const id = head.match(/^id:\s*(.+)$/m)?.[1]?.trim();
    const subject = head.match(/^subject:\s*(.+)$/m)?.[1]?.trim();
    if (id || subject) return `${id ?? stem}${subject ? ` — ${subject}` : ""}`;
  } catch {
    // unreadable entry: fall back to the stem
  }
  return stem;
});

const line =
  `[ukp inbox] ${folder.name}/ holds ${entries.length} pending proposal(s) awaiting ` +
  `owner adjudication: ${items.join(" | ")}. Triage rules live in ${folder.name}/README.md; ` +
  `proposals are a remote submitter's only write face — adjudication asks nothing of them.`;
process.stdout.write(JSON.stringify({ additionalContext: line.slice(0, 600) }));
