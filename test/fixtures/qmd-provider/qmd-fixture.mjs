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
const isUpdate = commandName === "update";
const hasMatch = query === "fixture-cad-search-token" && !serviceFolder.includes("no-match");
const shouldFail = serviceFolder.includes("provider-fail");
const shouldCancel = serviceFolder.includes("provider-sigint");

// docid → body map so a search→get round-trip resolves the same content by
// fingerprint (ADR 0011). The docid is QMD's content-hash prefix; the fixture
// hardcodes stable values for its known documents.
const docidBodies = {
  a1b2c3: "# CAD notes\n\nCAD fixture note content.",
  b2c3d4: "# Collection note\n\nalpha\nbeta\ngamma\n",
  c3d4e5: "# Path note\n\none\ntwo\n",
  d4e5f6: "# Outside note\n\nBody from a path-shaped collection.\n",
  e5f6a7: "# External note\n\nExternal fixture note content.",
  f6a7b8: "# Provider note\n\nProvider note content.",
};

if (shouldCancel) {
  process.stderr.write("fixture provider cancelled\n");
  process.exit(130);
}

// Zero-output hang guard fixture branch: a provider that never responds. The
// caller's spawnSync timeout (UKP_PROVIDER_TIMEOUT_MS) kills this with SIGTERM.
if (serviceFolder.includes("provider-hang")) {
  await new Promise((resolve) => setTimeout(resolve, 30_000));
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
  // Resolve a bare or hash-prefixed docid (`a1b2c3`, `#a1b2c3`, `#a1b2c3:2`, ...)
  // by content fingerprint; otherwise fall back to weak-reference token matching.
  const docidMatch = /^#?([a-f0-9]{6})(?::\d+(?::\d+)?)?$/.exec(reference);
  const docid = docidMatch ? docidMatch[1] : undefined;
  let body = docid ? docidBodies[docid] : undefined;
  if (!body) {
    body = "# Default fixture note\n\nBody for an accepted weak reference.";
    if (reference.includes("running")) {
      body = "# Running agents\n\nOperating the OpenAI Agents SDK service.";
    } else if (reference.includes("config")) {
      body = "# Configuration\n\nSDK-wide defaults configured at startup.";
    } else if (reference.includes("cad")) {
      body = "# CAD notes\n\nCAD fixture note content.";
    }
  }
  const headerDocid = docid ? `#${docid}` : "#a1b2c3";
  process.stdout.write(`qmd://fixture-qmd/${reference}  ${headerDocid}\nFolder Context: fixtures\n---\n\n${body}\n`);
  process.exit(0);
}

if (isUpdate) {
  process.stdout.write("fixture update complete\n");
} else if (outputFormat === "json" && !serviceFolder.includes("no-json")) {
  let result = [];
  if (hasMatch) {
    if (serviceFolder.includes("path-shaped")) {
      result = [{ docid: "#c3d4e5", file: `qmd://${join(process.cwd(), "docs", "path-note.md")}`, line: 7, title: "Path-shaped fixture note", score: 1, snippet: "one\ntwo\n" }];
    } else if (serviceFolder.includes("same-authority-external")) {
      result = [{ docid: "#e5f6a7", file: "qmd://same-authority-external/docs/external-note.md", line: 4, title: "Same-authority external fixture note", score: 1, snippet: "External fixture note content." }];
    } else if (serviceFolder.includes("collection-shaped")) {
      result = [{ docid: "#b2c3d4", file: "qmd://collection-shaped/docs/collection-note.md", line: 3, title: "Collection-shaped fixture note", score: 1, snippet: "alpha\nbeta\ngamma\n" }];
    } else if (serviceFolder.includes("outside-result")) {
      result = [{ docid: "#d4e5f6", file: `qmd://${join(dirname(process.cwd()), "outside.md")}`, line: 2, title: "Outside fixture note", score: 1, snippet: "Body from a path-shaped collection." }];
    } else if (serviceFolder.includes("embedded-uri")) {
      result = [{ docid: "#f6a7b8", file: "qmd://external-collection/docs/provider-note.md", line: 5, title: "Embedded provider location note", score: 1, snippet: "Embedded provider location note. Accent color #ff0000." }];
    } else if (serviceFolder.includes("no-line")) {
      result = [{ docid: "#c1d2e3", file: "qmd://fixture-qmd/documents/no-line.md", title: "No-line fixture note", score: 1, snippet: "No-line fixture content without a line hint." }];
    } else if (serviceFolder.includes("no-docid")) {
      result = [{ file: "qmd://fixture-qmd/documents/no-docid.md", line: 3, title: "No-docid fixture note", score: 1, snippet: "No-docid fixture content cannot form a get route." }];
    } else if (serviceFolder.includes("no-title")) {
      result = [{ docid: "#e6f7a8", file: "qmd://fixture-qmd/documents/no-title.md", line: 2, score: 1, snippet: "No-title fixture content." }];
    } else if (serviceFolder.includes("banner")) {
      result = [{ docid: "#d2e3f4", file: "qmd://fixture-qmd/documents/banner.md", line: 1, title: "Banner fixture note", score: 1, snippet: "---\ntitle: Banner fixture\n---\nBanner body text." }];
    } else if (serviceFolder.includes("multi-result")) {
      result = [
        { docid: "#a1b2c3", file: "qmd://fixture-qmd/documents/cad-notes.md", line: 1, title: "CAD fixture note", score: 1, snippet: "CAD fixture note content." },
        { docid: "#b2c3d4", file: "qmd://collection-shaped/docs/collection-note.md", line: 3, title: "Collection-shaped fixture note", score: 1, snippet: "alpha beta gamma" },
      ];
    } else {
      result = [{ docid: "#a1b2c3", file: "qmd://fixture-qmd/documents/cad-notes.md", line: 1, title: "CAD fixture note", score: 1, snippet: "CAD fixture note content." }];
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  // Native text shape. A provider that ignores `--format json` (folder name
  // contains `no-json`) lands here and exercises the Human renderer's fallback.
  process.stdout.write(hasMatch ? "qmd://fixture-qmd/documents/cad-notes.md:1  #a1b2c3\nCAD fixture note\n" : "");
}

if (shouldFail) {
  process.stderr.write("fixture provider failure\n");
  process.exitCode = 7;
}
