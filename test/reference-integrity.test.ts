import { describe, expect, test, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { executeHumanSearch, parseSearchArgs } from "../src/commands/search.ts";
import { executeReadCommand as executeReadCommandMaybeAsync, type ReadCommandResult } from "../src/commands/read.ts";
import { registerAt } from "../src/registry.ts";
import { createQmdFixtureCopy } from "./helpers/qmd-fixture.ts";

// Reference-integrity invariant harness (ADR 0025 acceptance; REF-1..4 in
// docs/concepts/reference-integrity.md; the engineering lesson's six-layout
// adversarial corpus). Every layout asserts CONTENT IDENTITY — the consumed
// uri reads back the content of the hit that emitted it — or a classified
// omission. "Readable" is never the assertion.
//
// The emitter is the real search pipeline over a fixture provider whose
// results the test declares via `qmd-fixture-results.json` with docids it
// computes itself (sha256 of raw file bytes, first 6 hex — the ADR 0025 pin).

function executeReadCommand(args: readonly string[], context: Parameters<typeof executeReadCommandMaybeAsync>[1]): ReadCommandResult {
  const result = executeReadCommandMaybeAsync(args, context);
  if (result instanceof Promise) throw new Error("local read unexpectedly took the async path");
  return result;
}

const fixture = createQmdFixtureCopy("reference-integrity-fixture");
const fixtureExecutable = join(fixture, "qmd-fixture.mjs");
const nodeExecutable = Bun.which("node") ?? process.execPath;

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

const shaPrefix = (content: string): string =>
  createHash("sha256").update(content).digest("hex").slice(0, 6);

interface CaseRun {
  human: { exitCode: number; stdout: string };
  sidecar: { results: Array<Record<string, unknown>> };
  root: string;
  registryPath: string;
}

/** One (emitter × layout) cell: a Service folder with declared files, a
 * declared provider-result corpus (docids computed by the caller), the real
 * human + json search pipeline over it. `results` may be a function of the
 * created paths (for out-of-folder absolute locations). */
function runCase(options: {
  endpointName: string;
  files: Array<[relPath: string, content: string]>;
  results:
    | Array<Record<string, unknown>>
    | ((paths: { root: string; folder: string }) => Array<Record<string, unknown>>);
}): CaseRun {
  const root = mkdtempSync(join(tmpdir(), `ukp-refint-${options.endpointName}-`));
  const folder = join(root, options.endpointName);
  mkdirSync(join(folder, ".ukp"), { recursive: true });
  writeFileSync(
    join(folder, ".ukp", "service.toml"),
    `name = "${options.endpointName}"\n\n[capabilities.search]\nprovider = "qmd"\n`,
    "utf8",
  );
  for (const [rel, content] of options.files) {
    const target = join(folder, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  const results = typeof options.results === "function" ? options.results({ root, folder }) : options.results;
  writeFileSync(join(folder, "qmd-fixture-results.json"), JSON.stringify(results), "utf8");
  const registryPath = join(root, "registry.toml");
  registerAt(registryPath, options.endpointName, folder);
  const context = { currentDirectory: root, registryPath, qmdCommand: [nodeExecutable, fixtureExecutable] as const };
  const human = executeHumanSearch(parseSearchArgs(["fixture-cad-search-token", "--endpoint", options.endpointName]), context);
  const jsonRun = executeHumanSearch(
    parseSearchArgs(["fixture-cad-search-token", "--json", "--endpoint", options.endpointName]),
    { ...context, artifactRoot: join(root, "artifacts"), artifactRunId: "refint-run" },
  );
  expect(human.exitCode).toBe(0);
  expect(jsonRun.exitCode).toBe(0);
  const envelope = JSON.parse(jsonRun.stdout);
  const sidecar = JSON.parse(readFileSync(envelope.endpoints[0].references_artifact, "utf8"));
  return { human, sidecar, root, registryPath };
}

function readUri(uri: string, run: CaseRun): ReadCommandResult {
  return executeReadCommand([uri], {
    currentDirectory: run.root,
    registryPath: run.registryPath,
    qmdCommand: [nodeExecutable, fixtureExecutable],
  });
}

describe("reference-integrity invariants (ADR 0025 / REF-1..4)", () => {
  // Layout 1 — Service-root collection (the only layout the old fixtures
  // covered): emitted uri reads back the hit's own content (REF-1).
  test("service-root layout emits a uri whose read is content-identical to the hit", () => {
    const content = "# Root note\n\nHIT-MARKER-service-root\n";
    const run = runCase({
      endpointName: "svc-root",
      files: [["notes.md", content]],
      results: [{ docid: `#${shaPrefix(content)}`, file: "qmd://svc-root/notes.md", line: 1, title: "Root note", score: 1 }],
    });
    try {
      const uri = "ukp://svc-root/notes.md";
      expect(run.human.stdout).toContain(`uri: ${uri}`);
      expect(run.sidecar.results[0].ukp_uri).toBe(uri);
      const read = readUri(uri, run);
      expect(read.exitCode).toBe(0);
      expect(read.stdout).toContain("HIT-MARKER-service-root");
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  }, 15_000);

  // Layout 2 — subfolder-rooted collection + provider path normalization
  // (session_format on disk vs session-format in the location): the
  // ISSUE-014 false-negative class. The emitted uri must carry the REAL
  // disk path.
  test("subfolder-root + normalization layout emits the real disk path, content-identical", () => {
    const content = "# Questions\n\nHIT-MARKER-subfolder-root\n";
    const run = runCase({
      endpointName: "subfolder-root",
      files: [["explorer/session_format/questions.md", content]],
      results: [{
        docid: `#${shaPrefix(content)}`,
        file: "qmd://subfolder-root/session-format/questions.md",
        line: 2,
        title: "Questions",
        score: 1,
      }],
    });
    try {
      const uri = "ukp://subfolder-root/explorer/session_format/questions.md";
      expect(run.human.stdout).toContain(`uri: ${uri}`);
      expect(run.sidecar.results[0].ukp_uri).toBe(uri);
      const read = readUri(uri, run);
      expect(read.exitCode).toBe(0);
      expect(read.stdout).toContain("HIT-MARKER-subfolder-root");
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  }, 15_000);

  // Layout 3 — same-named file at the Service root vs the hit inside a
  // subfolder collection (the AGENTS.md false positive). Existence alone
  // used to emit the WRONG root file; the hash must adjudicate to the hit.
  test("same-name collision emits the hit's file, never the root decoy", () => {
    const hitContent = "# Rust conventions\n\nHIT-MARKER-vendored\n";
    const decoyContent = "# KB conventions\n\nDECOY-MARKER-root\n";
    const run = runCase({
      endpointName: "name-collision",
      files: [["AGENTS.md", decoyContent], ["codex/AGENTS.md", hitContent]],
      results: [{
        docid: `#${shaPrefix(hitContent)}`,
        file: "qmd://name-collision/AGENTS.md",
        line: 1,
        title: "Rust conventions",
        score: 1,
      }],
    });
    try {
      const uri = "ukp://name-collision/codex/AGENTS.md";
      expect(run.human.stdout).toContain(`uri: ${uri}`);
      expect(run.human.stdout).not.toContain("uri: ukp://name-collision/AGENTS.md\n");
      expect(run.sidecar.results[0].ukp_uri).toBe(uri);
      const read = readUri(uri, run);
      expect(read.exitCode).toBe(0);
      expect(read.stdout).toContain("HIT-MARKER-vendored");
      expect(read.stdout).not.toContain("DECOY-MARKER-root");
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  }, 15_000);

  // Layout 4 — external / out-of-folder (collection-shaped miss and a
  // path-shaped escape): REF-2 declines, REF-4 records the reason.
  test("out-of-folder layouts emit nothing and record the omission reason", () => {
    const content = "# Ghost\n\nnever indexed\n";
    const run = runCase({
      endpointName: "outside-folder",
      files: [["docs/real.md", content]],
      results: ({ folder }) => [
        { docid: `#${shaPrefix(content)}`, file: "qmd://external-collection/shared/ghost.md", line: 1, title: "Ghost", score: 1 },
        // Path-shaped absolute location outside the Service folder (its own
        // parent): the old cross-drive / `..` guard, now with a reason.
        { docid: "#abcdef", file: `qmd://${join(dirname(folder), "outside.md")}`, line: 1, title: "Outside", score: 1 },
      ],
    });
    try {
      expect(run.human.stdout).not.toContain("uri: ukp://outside-folder/");
      expect(run.sidecar.results[0]).not.toHaveProperty("ukp_uri");
      expect(run.sidecar.results[0].ukp_uri_omission_reason).toBe("no-candidate");
      expect(run.sidecar.results[1]).not.toHaveProperty("ukp_uri");
      expect(run.sidecar.results[1].ukp_uri_omission_reason).toBe("out-of-folder");
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  }, 15_000);

  // Layout 5 — stale index: the docid matches the OLD content, the disk has
  // NEW content. The slot promise covers current content, so no uri.
  test("stale-index layout refuses the uri (hash-mismatch) instead of promising drifted content", () => {
    const oldContent = "# Stale note\n\nOLD-CONTENT\n";
    const newContent = "# Stale note\n\nNEW-CONTENT\n";
    const run = runCase({
      endpointName: "stale-index",
      files: [["stale-note.md", newContent]],
      results: [{ docid: `#${shaPrefix(oldContent)}`, file: "qmd://stale-index/stale-note.md", line: 1, title: "Stale note", score: 1 }],
    });
    try {
      expect(run.human.stdout).not.toContain("uri: ukp://stale-index/");
      expect(run.sidecar.results[0]).not.toHaveProperty("ukp_uri");
      expect(run.sidecar.results[0].ukp_uri_omission_reason).toBe("hash-mismatch");
      // The session key still hands off (degradation, not breakage).
      expect(run.human.stdout).toContain("read: ukp read --endpoint stale-index ");
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  }, 15_000);

  // Layout 6 — ambiguity: two files with identical content both verify; a
  // slot must name exactly one file, so ambiguity declines (REF-2).
  test("ambiguous duplicate-content layout declines instead of guessing a slot", () => {
    const content = "# Duplicate\n\nHIT-MARKER-duplicate\n";
    const run = runCase({
      endpointName: "ambiguous-dup",
      files: [["x/a.md", content], ["y/a.md", content]],
      results: [{ docid: `#${shaPrefix(content)}`, file: "qmd://ambiguous-dup/a.md", line: 1, title: "Duplicate", score: 1 }],
    });
    try {
      expect(run.human.stdout).not.toContain("uri: ukp://ambiguous-dup/");
      expect(run.sidecar.results[0].ukp_uri_omission_reason).toBe("ambiguous");
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  }, 15_000);

  // Extra — no-docid result with an in-folder location: nothing can be
  // verified, so no uri even though the file exists (REF-2: existence ≠
  // identity; REF-4 records why).
  test("no-docid result never emits an unverified uri", () => {
    const content = "# No docid\n\nHIT-MARKER-no-docid\n";
    const run = runCase({
      endpointName: "no-docid-hit",
      files: [["docs/orphan.md", content]],
      results: [{ file: "qmd://no-docid-hit/docs/orphan.md", line: 1, title: "Orphan", score: 1 }],
    });
    try {
      expect(run.human.stdout).not.toContain("uri: ukp://no-docid-hit/");
      expect(run.sidecar.results[0].status).toBe("provider_only");
      expect(run.sidecar.results[0].ukp_uri_omission_reason).toBe("no-docid");
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  }, 15_000);
});
