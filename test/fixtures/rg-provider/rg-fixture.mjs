#!/usr/bin/env node

// rg fixture: emulates the ripgrep surface UKP uses —
// `--version`, match mode (`--json` event lines) and count mode (`--count`).
// Scans the cwd's .md files for the `-e <pattern>` substring so tests get
// real endpoint-relative paths.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("rg-fixture 0.0.0 (mock)\n");
  process.exit(0);
}

const patternIndex = args.indexOf("-e");
const pattern = patternIndex >= 0 ? args[patternIndex + 1] : undefined;
if (pattern === undefined) {
  process.stderr.write("fixture: missing -e <pattern>\n");
  process.exit(2);
}
const serviceFolder = basename(process.cwd());
if (serviceFolder.includes("rg-fail")) {
  process.stderr.write("fixture rg failure\n");
  process.exit(2);
}
if (serviceFolder.includes("rg-sigint")) {
  process.exit(130);
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

