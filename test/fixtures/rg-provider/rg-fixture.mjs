#!/usr/bin/env node

// rg fixture: emulates the ripgrep surface UKP uses —
// `--version`, match mode (`--json` event lines), count mode (`--count`),
// and files mode (`--files`, ADR-RG-005: true tree walk over every file
// type, no content read, hidden entries only with --hidden/-uu).
// Match/count scan the cwd's .md files for the `-e <pattern>` substring so
// tests get real endpoint-relative paths.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("rg-fixture 0.0.0 (mock)\n");
  process.exit(0);
}

const serviceFolder = basename(process.cwd());
if (serviceFolder.includes("rg-fail")) {
  process.stderr.write("fixture rg failure\n");
  process.exit(2);
}
if (serviceFolder.includes("rg-sigint")) {
  process.exit(130);
}

if (args.includes("--files")) {
  const hidden = args.includes("--hidden") || args.includes("-uu") || args.includes("-uuu");
  const globs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--glob" || args[index] === "-g" || args[index] === "--iglob") {
      globs.push({ value: args[index + 1], caseInsensitive: args[index] === "--iglob" });
      index += 1; // consume the value token
    }
  }
  // gitignore-ish glob semantics (rg -g): no slash → matched against the
  // basename; a slash anchors to the endpoint-relative path; "*" never
  // crosses "/". Override model: a "!negation" match excludes; with any
  // positive glob present, only matching files pass (include+exclude
  // combos, ADR-RG-005). Fidelity note: real ripgrep is
  // last-matching-glob-wins; this emulation treats any matching negation
  // as an immediate exclude — the two models agree on every ordering the
  // tests use (negations after positives).
  const globRegExp = (glob, caseInsensitive) => {
    let source = "";
    for (const ch of glob) {
      if (ch === "*") source += "[^/]*";
      else if (ch === "?") source += "[^/]";
      else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${source}$`, caseInsensitive ? "i" : "");
  };
  const globMatches = (relPath, body, caseInsensitive) => {
    // rg matches override globs against the "./"-stripped relative path,
    // while emission below keeps the "./" (real rg output form).
    const target = body.includes("/") ? relPath.replace(/^\.\//, "") : basename(relPath);
    return globRegExp(body, caseInsensitive).test(target);
  };
  const included = (relPath) => {
    let hasPositive = false;
    let positiveMatch = false;
    for (const { value, caseInsensitive } of globs) {
      const negated = value.startsWith("!");
      const body = negated ? value.slice(1) : value;
      if (negated) {
        if (globMatches(relPath, body, caseInsensitive)) return false;
      } else {
        hasPositive = true;
        if (globMatches(relPath, body, caseInsensitive)) positiveMatch = true;
      }
    }
    return hasPositive ? positiveMatch : true;
  };
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!hidden && entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(".");
  const relPaths = files
    .map((path) => `./${path.split("\\").join("/")}`)
    .filter(included);
  // Emission order is deliberately REVERSED: UKP's files intake must sort
  // the full list before the client-side cap (deterministic window,
  // ADR-RG-005) — a pre-sorted fixture could not tell.
  for (const path of relPaths.reverse()) process.stdout.write(`${path}\n`);
  process.exit(relPaths.length > 0 ? 0 : 1);
}

const patternIndex = args.indexOf("-e");
const pattern = patternIndex >= 0 ? args[patternIndex + 1] : undefined;
if (pattern === undefined) {
  process.stderr.write("fixture: missing -e <pattern>\n");
  process.exit(2);
}
const ignoreCase = args.includes("-i");

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".md")) files.push(path);
  }
};
walk(".");

const needle = ignoreCase ? pattern.toLowerCase() : pattern;
const matches = [];
const counts = [];
for (const file of files.sort()) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  let fileCount = 0;
  lines.forEach((line, index) => {
    const haystack = ignoreCase ? line.toLowerCase() : line;
    if (line.length === 0 || !haystack.includes(needle)) return;
    fileCount += 1;
    matches.push({ path: file.split("\\").join("/"), line: index + 1, text: line });
  });
  if (fileCount > 0) counts.push({ path: file.split("\\").join("/"), count: fileCount });
}

if (args.includes("--count")) {
  for (const entry of counts) process.stdout.write(`${entry.path}:${entry.count}\n`);
  process.exit(counts.length > 0 ? 0 : 1);
}

if (args.includes("--json")) {
  for (const match of matches) {
    process.stdout.write(`${JSON.stringify({
      type: "match",
      data: { path: { text: match.path }, line_number: match.line, lines: { text: `${match.text}\n` } },
    })}\n`);
  }
  process.exit(matches.length > 0 ? 0 : 1);
}

process.stderr.write("fixture: expected --json or --count\n");
process.exit(2);
