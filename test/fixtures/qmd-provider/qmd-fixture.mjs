#!/usr/bin/env node

import { appendFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const commandName = args[0];
const searchIndex = args.indexOf("search");
const query = searchIndex >= 0 ? args[searchIndex + 1] : undefined;
const limitIndex = args.indexOf("-n");
const nativeLimit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : undefined;
const formatIndex = args.indexOf("--format");
const outputFormat = formatIndex >= 0 ? args[formatIndex + 1] : "text";

const invocation = {
  cwd: process.cwd(),
  commandName,
  args,
  query,
  nativeLimit,
  outputFormat,
};

await writeFile("qmd-fixture-invocation.json", `${JSON.stringify(invocation, null, 2)}\n`, "utf8");
await appendFile("qmd-fixture-invocations.jsonl", `${JSON.stringify(invocation)}\n`, "utf8");

const serviceFolder = basename(process.cwd());
const isRefresh = commandName === "update";
const hasMatch = query === "fixture-cad-search-token" && !serviceFolder.includes("no-match");
const shouldFail = serviceFolder.includes("provider-fail");
const shouldCancel = serviceFolder.includes("provider-sigint");

if (shouldCancel) {
  process.stderr.write("fixture provider cancelled\n");
  process.exit(130);
}

if (isRefresh) {
  process.stdout.write("fixture update complete\n");
} else if (outputFormat === "json") {
  const result = hasMatch
    ? [{ uri: "qmd://fixture-cad/cad-notes.md", title: "CAD fixture note", score: 1 }]
    : [];
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  process.stdout.write(hasMatch ? "CAD fixture note\n" : "");
}

if (shouldFail) {
  process.stderr.write("fixture provider failure\n");
  process.exitCode = 7;
}
