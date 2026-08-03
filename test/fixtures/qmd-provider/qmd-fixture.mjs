#!/usr/bin/env node

import { appendFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const commandName = args[0];
const searchIndex = args.indexOf("search");
const query = searchIndex >= 0 ? args[searchIndex + 1] : undefined;
const limitIndex = args.indexOf("-n");
const nativeLimit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : undefined;
const formatIndex = args.indexOf("--format");
const outputFormat = formatIndex >= 0 ? args[formatIndex + 1] : "text";
const isGet = commandName === "get";
const reference = isGet ? args[1] ?? "" : undefined;
const noLineNumbers = args.includes("--no-line-numbers");

const invocation = {
  cwd: process.cwd(),
  commandName,
  args,
  query,
  nativeLimit,
  outputFormat,
  ...(isGet ? { reference, noLineNumbers } : {}),
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

if (isGet) {
  if (serviceFolder.includes("no-lines")) {
    process.stderr.write("qmd: unknown option '--no-line-numbers'\n");
    process.exit(2);
  }
  if (serviceFolder.includes("provider-fail")) {
    process.stderr.write("fixture provider failure\n");
    process.exit(7);
  }
  if (reference.includes("missing")) {
    process.stderr.write(`fixture: resource not found: ${reference}\n`);
    process.exit(1);
  }
  if (reference.includes("emptybody")) {
    process.stdout.write("qmd://fixture-qmd/emptybody  #a1b2c3\nFolder Context: fixtures\n---\n\n");
    process.exit(0);
  }
  let body = "# Default fixture note\n\nBody for an accepted weak reference.";
  if (reference.includes("running")) {
    body = "# Running agents\n\nOperating the OpenAI Agents SDK service.";
  } else if (reference.includes("cad")) {
    body = "# CAD notes\n\nCAD fixture note content.";
  }
  process.stdout.write(`qmd://fixture-qmd/${reference}  #a1b2c3\nFolder Context: fixtures\n---\n\n${body}\n`);
  process.exit(0);
}

if (isRefresh) {
  process.stdout.write("fixture update complete\n");
} else if (outputFormat === "json") {
  let result = [];
  if (hasMatch) {
    if (serviceFolder.includes("path-shaped")) {
      result = [{ file: `qmd://${join(process.cwd(), "docs", "path-note.md")}`, line: 7, title: "Path-shaped fixture note", score: 1 }];
    } else if (serviceFolder.includes("collection-shaped")) {
      result = [{ uri: "qmd://collection-shaped/docs/collection-note.md:3", title: "Collection-shaped fixture note", score: 1 }];
    } else if (serviceFolder.includes("outside-result")) {
      result = [{ uri: `qmd://${join(dirname(process.cwd()), "outside.md")}:2`, title: "Outside fixture note", score: 1 }];
    } else {
      result = [{ uri: "qmd://fixture-qmd/documents/cad-notes.md:1", title: "CAD fixture note", score: 1 }];
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  if (hasMatch && serviceFolder.includes("embedded-uri")) {
    process.stdout.write("Embedded provider location (qmd://external-collection/docs/provider-note.md:5).\n");
  } else {
    process.stdout.write(hasMatch ? "CAD fixture note\nqmd://fixture-qmd/documents/cad-notes.md:1\n" : "");
  }
}

if (shouldFail) {
  process.stderr.write("fixture provider failure\n");
  process.exitCode = 7;
}
