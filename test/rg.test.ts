import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseRgArgs,
  executeRgCommand as executeRgCommandMaybeAsync,
  splitRgPassthrough,
  type RgCommandResult,
} from "../src/commands/rg.ts";
import { RgUsageError, validateRgPassthrough } from "../src/capabilities/rg.ts";
import { KitUsageError } from "../src/commands/kit.ts";
import type { RgContext } from "../src/capabilities/rg.ts";
import { registerAt } from "../src/registry.ts";

// ukp_remote W6 conditional-async seam (read.test.ts precedent): every test
// here is a local rg run, which stays fully synchronous. This wrapper keeps
// the call sites untouched and fails loudly if a local case ever goes async.
function executeRgCommand(args: readonly string[], context: Parameters<typeof executeRgCommandMaybeAsync>[1]): RgCommandResult {
  const result = executeRgCommandMaybeAsync(args, context);
  if (result instanceof Promise) throw new Error("local rg unexpectedly took the async path");
  return result;
}

const fixtureExecutable = join(import.meta.dir, "fixtures", "rg-provider", "rg-fixture.mjs");
const nodeExecutable = Bun.which("node") ?? process.execPath;
const rgCommand = [nodeExecutable, fixtureExecutable];

function createService(root: string, name: string, extraManifest = ""): string {
  const folder = join(root, `${name}-service`);
  mkdirSync(join(folder, ".ukp"), { recursive: true });
  writeFileSync(
    join(folder, ".ukp", "service.toml"),
    `name = "${name}"\n[capabilities.nav]\nprovider = "file"\n${extraManifest}`,
  );
  return folder;
}

interface FileSpec {
  path: string;
  content?: string;
}

function writeFiles(folder: string, files: readonly FileSpec[]): void {
  for (const file of files) {
    const target = join(folder, ...file.path.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, file.content ?? `# ${file.path}\n`);
  }
}

function setup(root: string, name: string, files: readonly FileSpec[], extraManifest = ""): RgContext {
  const service = createService(root, name, extraManifest);
  writeFiles(service, files);
  const registryPath = join(root, "registry.toml");
  registerAt(registryPath, name, service);
  return { currentDirectory: root, registryPath, rgCommand };
}

describe("ukp rg command surface", () => {
  test("parses the stable pattern and limit contract", () => {
    const parsed = parseRgArgs(["--endpoint", "kb", "needle", "--limit", "10", "-i", "--count"]);
    expect(parsed.request).toEqual({ query: "needle", limit: 10 });
    expect(parsed.options.ignoreCase).toBe(true);
    expect(parsed.options.count).toBe(true);
    expect(parsed.options.explicitEndpoints).toEqual(["kb"]);
    // Parse-layer usage errors surface as kit usage errors since the ADR
    // 0024 migration (same messages, exit 2 path).
    expect(() => parseRgArgs(["--endpoint", "kb", "x", "--limit", "0"])).toThrow(KitUsageError);
    expect(() => parseRgArgs(["--endpoint", "kb", "x", "--limit", "1001"])).toThrow(KitUsageError);
    expect(() => parseRgArgs([])).toThrow(KitUsageError);
    expect(() => parseRgArgs(["--endpoint", "kb", "a", "b"])).toThrow(KitUsageError);
    expect(() => parseRgArgs(["-g", "--endpoint", "kb", "x"])).toThrow(KitUsageError);
  });

  test("default limit is 50 (ADR-RG-004)", () => {
    const parsed = parseRgArgs(["--endpoint", "kb", "needle"]);
    expect(parsed.request.limit).toBe(50);
  });

  test("passthrough allowlist accepts context flags and rejects scope/output breakers", () => {
    expect(() => validateRgPassthrough(["-C", "3", "-A2", "-w", "--no-ignore"])).not.toThrow();
    // Claude Grep surface parity: multiline (-U) routes through the hatch.
    expect(() => validateRgPassthrough(["-U", "--multiline"])).not.toThrow();
    expect(() => validateRgPassthrough(["--json"])).toThrow(/allowlist/);
    expect(() => validateRgPassthrough(["-r", "x"])).toThrow(/allowlist/);
    expect(() => validateRgPassthrough(["--config", "x"])).toThrow(/allowlist/);
    expect(() => validateRgPassthrough(["docs/guide.md"])).toThrow(/path operands/);
    expect(() => validateRgPassthrough(["-C"])).toThrow(/requires a value/);
  });

  test("splits argv at the first --", () => {
    expect(splitRgPassthrough(["--endpoint", "kb", "x"])).toEqual({ commandArgs: ["--endpoint", "kb", "x"], passthrough: [] });
    expect(splitRgPassthrough(["--endpoint", "kb", "x", "--", "-C", "2"])).toEqual({
      commandArgs: ["--endpoint", "kb", "x"],
      passthrough: ["-C", "2"],
    });
  });

  test("rejected passthrough surfaces as usage error exit 2 before any endpoint work", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-reject-"));
    try {
      const context = setup(root, "kb", [{ path: "docs/a.md", content: "# a\nneedle here\n" }]);
      const result = executeRgCommand(["--endpoint", "kb", "needle", "--", "--json"], context);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("ukp rg:");
      expect(result.stderr).toContain("allowlist");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("human mode renders result units with ukp:// uri lines", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-human-"));
    try {
      const context = setup(root, "kb", [
        { path: "docs/guide.md", content: "# guide\nneedle one\nplain\nneedle two\n" },
      ]);
      const result = executeRgCommand(["--endpoint", "kb", "needle"], context);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("== kb ==");
      expect(result.stdout).toContain("1. docs/guide.md:2");
      expect(result.stdout).toContain("needle one");
      expect(result.stdout).toContain("uri: ukp://kb/docs/guide.md#L2");
      expect(result.stdout).toContain("2. docs/guide.md:4");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("json mode emits the ukp.rg.v1 envelope with read-ready matches", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-json-"));
    try {
      const context = setup(root, "kb", [
        { path: "README.md", content: "needle in readme\n" },
      ]);
      const result = executeRgCommand(["--endpoint", "kb", "needle", "--json"], context);
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.schema).toBe("ukp.rg.v1");
      expect(envelope.capability).toBe("rg");
      expect(envelope.limit).toBe(50);
      expect(envelope.endpoints[0].status).toBe("succeeded");
      expect(envelope.endpoints[0].matches[0].ukp_uri).toBe("ukp://kb/README.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rg output round-trips through ukp read by ukp:// uri", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-roundtrip-"));
    try {
      const context = setup(root, "kb", [
        { path: "docs/note.md", content: "# note\nthe needle line\n" },
      ]);
      const rgResult = executeRgCommand(["--endpoint", "kb", "needle", "--json"], context);
      const envelope = JSON.parse(rgResult.stdout);
      const uri = envelope.endpoints[0].matches[0].ukp_uri;
      const { executeReadCommand } = await import("../src/commands/read.ts");
      const readMaybeAsync = executeReadCommand([uri], { currentDirectory: root, registryPath: context.registryPath });
      if (readMaybeAsync instanceof Promise) throw new Error("local read unexpectedly took the async path");
      const read = readMaybeAsync;
      expect(read.exitCode).toBe(0);
      expect(read.stdout).toContain("the needle line");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no matches is a successful no_matches result, not a failure", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-nomatch-"));
    try {
      const context = setup(root, "kb", [{ path: "a.md", content: "nothing here\n" }]);
      const result = executeRgCommand(["--endpoint", "kb", "needle"], context);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("(no matches)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("count mode lists per-file counts", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-count-"));
    try {
      const context = setup(root, "kb", [
        { path: "a.md", content: "needle\nneedle\n" },
        { path: "b.md", content: "needle\n" },
      ]);
      const result = executeRgCommand(["--endpoint", "kb", "needle", "--count"], context);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("a.md: 2");
      expect(result.stdout).toContain("b.md: 1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("limit truncates matches and marks the endpoint truncated", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-limit-"));
    try {
      const context = setup(root, "kb", [
        { path: "a.md", content: "needle\nneedle\nneedle\n" },
      ]);
      const result = executeRgCommand(["--endpoint", "kb", "needle", "--limit", "2", "--json"], context);
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.endpoints[0].match_count).toBe(2);
      expect(envelope.endpoints[0].truncated).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing rg executable degrades to skipped + warning (ADR-RG-003 / R-7)", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-missing-"));
    try {
      const service = createService(root, "kb");
      writeFiles(service, [{ path: "a.md", content: "needle\n" }]);
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", service);
      const context: RgContext = {
        currentDirectory: root,
        registryPath,
        rgCommand: ["ukp-rg-definitely-missing-executable"],
      };
      const result = executeRgCommand(["--endpoint", "kb", "needle"], context);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("rg executable is not available");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("provider failure fails the run; multi-endpoint serial order holds", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-fail-"));
    try {
      const good = createService(root, "good");
      writeFiles(good, [{ path: "a.md", content: "needle\n" }]);
      const bad = createService(root, "rg-fail");
      writeFiles(bad, [{ path: "a.md", content: "needle\n" }]);
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "good", good);
      registerAt(registryPath, "rg-fail", bad);
      const context: RgContext = { currentDirectory: root, registryPath, rgCommand };
      const result = executeRgCommand(["-g", "needle"], context);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("== good ==");
      expect(result.stderr).toContain("rg failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("base tier needs no declaration; a bare [capabilities.rg] declaration is accepted", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-bare-"));
    try {
      const context = setup(
        root,
        "kb",
        [{ path: "a.md", content: "needle\n" }],
        '[capabilities.rg]\n',
      );
      const result = executeRgCommand(["--endpoint", "kb", "needle"], context);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("a.md:1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ADR 0023 / spec §3 + T7: a match path resolving outside the Service
  // folder (symlink escape) silently drops its ukp_uri — the match and its
  // path stay, no warning, endpoint status unchanged. Tool output is not a
  // user error (search/ADR 0019 stance); the passthrough allowlist is the
  // first line of defense, this output-side filter the second.
  test("drops ukp_uri for a symlink escape but keeps the match (ADR 0019 emission rule)", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-containment-"));
    try {
      const service = createService(root, "kb");
      writeFiles(service, [{ path: "inside.md", content: "needle inside\n" }]);
      writeFileSync(join(root, "outside.md"), "needle outside\n");
      try {
        symlinkSync(join(root, "outside.md"), join(service, "escape.md"), "file");
      } catch {
        return; // Skip if the platform does not allow symlinks (read precedent)
      }
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", service);
      const context: RgContext = { currentDirectory: root, registryPath, rgCommand };
      const result = executeRgCommand(["--endpoint", "kb", "needle", "--json"], context);
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.endpoints[0].status).toBe("succeeded");
      expect(envelope.warnings).toEqual([]);
      const byPath = new Map<string, { path: string; ukp_uri?: string }>(
        envelope.endpoints[0].matches.map((m: { path: string }) => [m.path, m]),
      );
      expect(byPath.get("inside.md")?.ukp_uri).toBe("ukp://kb/inside.md");
      // The escaped match survives with its path but carries no slot promise.
      expect(byPath.get("escape.md")).toBeDefined();
      expect(byPath.get("escape.md")).not.toHaveProperty("ukp_uri");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ADR-RG-005 (D-092): --files enumeration mode — true tree walk, so empty
// and binary files are visible; visibility shares the search-mode root
// (hidden files, including .ukp/, stay behind -- --hidden); pattern is
// omitted; the full list is sorted before the client-side cap.
describe("ukp rg --files (ADR-RG-005)", () => {
  const tree: FileSpec[] = [
    { path: "README.md", content: "# readme\nneedle here\n" },
    { path: "docs/a.md", content: "# a\nneedle\n" },
    { path: "data.json", content: "{\"needle\": true}\n" },
    { path: "empty.txt", content: "" },
    { path: "blob.bin", content: "\x00\x01\x02binary-needle-bytes" },
  ];

  test("parse layer: pattern omitted, 500 default limit, three mutual exclusions", () => {
    const parsed = parseRgArgs(["--endpoint", "kb", "--files"]);
    expect(parsed.request).toEqual({ query: "", limit: 500 });
    expect(parsed.options.files).toBe(true);
    expect(parseRgArgs(["--endpoint", "kb", "--files", "--limit", "10"]).request.limit).toBe(10);
    // Mode switches cannot combine; a pattern in files mode points at --glob.
    expect(() => parseRgArgs(["--endpoint", "kb", "--files", "--count"])).toThrow(/--files and --count/);
    expect(() => parseRgArgs(["--endpoint", "kb", "--files", "-i"])).toThrow(/--iglob/);
    expect(() => parseRgArgs(["--endpoint", "kb", "--files", "pattern"])).toThrow(/--files takes no pattern/);
    // The missing-pattern error teaches the files-mode alternative.
    expect(() => parseRgArgs(["--endpoint", "kb"])).toThrow(/--files/);
  });

  test("repeated --glob is collected in order; --iglob rides the passthrough allowlist", () => {
    const parsed = parseRgArgs(["--endpoint", "kb", "needle", "--glob", "*.md", "--glob", "!docs/*"]);
    expect(parsed.options.globs).toEqual(["*.md", "!docs/*"]);
    expect(() => validateRgPassthrough(["--iglob", "*.MD"])).not.toThrow();
  });

  test("enumerates every file type as sorted ukp:// lines (empty and binary visible)", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-files-"));
    try {
      const context = setup(root, "kb", tree);
      const result = executeRgCommand(["--endpoint", "kb", "--files"], context);
      expect(result.exitCode).toBe(0);
      // The fixture emits the tree REVERSED with a ./ prefix: the sorted,
      // stripped one-uri-per-line form below is entirely UKP's doing.
      expect(result.stdout).toBe(
        "== kb ==\n"
          + "ukp://kb/README.md\n"
          + "ukp://kb/blob.bin\n"
          + "ukp://kb/data.json\n"
          + "ukp://kb/docs/a.md\n"
          + "ukp://kb/empty.txt\n",
      );
      // Hidden tier stays hidden by default (.ukp/ wiring included).
      expect(result.stdout).not.toContain(".ukp");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("-- --hidden reveals the hidden tier, including the .ukp/ wiring", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-files-hidden-"));
    try {
      const context = setup(root, "kb", tree);
      const result = executeRgCommand(["--endpoint", "kb", "--files", "--", "--hidden"], context);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ukp://kb/.ukp/service.toml");
      expect(result.stdout).toContain("ukp://kb/README.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--glob filters apply to the enumeration, including include+exclude combos", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-files-glob-"));
    try {
      const context = setup(root, "kb", tree);
      const jsonOnly = executeRgCommand(["--endpoint", "kb", "--files", "--glob", "*.json"], context);
      expect(jsonOnly.exitCode).toBe(0);
      expect(jsonOnly.stdout).toContain("ukp://kb/data.json");
      expect(jsonOnly.stdout).not.toContain("README.md");
      // include+exclude combination: md files but nothing under docs/.
      const combo = executeRgCommand(["--endpoint", "kb", "--files", "--glob", "*.md", "--glob", "!docs/*"], context);
      expect(combo.exitCode).toBe(0);
      expect(combo.stdout).toContain("ukp://kb/README.md");
      expect(combo.stdout).not.toContain("docs/a.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("limit truncates the SORTED enumeration (deterministic window) and marks truncated", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-files-limit-"));
    try {
      const context = setup(root, "kb", tree);
      const result = executeRgCommand(["--endpoint", "kb", "--files", "--limit", "2", "--json"], context);
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.files_mode).toBe(true);
      expect(envelope.query).toBeUndefined();
      expect(envelope.endpoints[0].file_count).toBe(2);
      expect(envelope.endpoints[0].truncated).toBe(true);
      // The window is the FIRST two paths in sorted order, not an arbitrary
      // subset of the (reversed) emission order.
      expect(envelope.endpoints[0].files.map((file: { path: string }) => file.path)).toEqual(["README.md", "blob.bin"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("json envelope: files_mode, no query field, entries carry ukp_uri", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-files-json-"));
    try {
      const context = setup(root, "kb", tree);
      const result = executeRgCommand(["--endpoint", "kb", "--files", "--json"], context);
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.schema).toBe("ukp.rg.v1");
      expect(envelope.count_mode).toBe(false);
      expect(envelope.files_mode).toBe(true);
      expect(envelope.limit).toBe(500);
      expect(envelope).not.toHaveProperty("query");
      expect(envelope.endpoints[0].files[0]).toEqual({ path: "README.md", ukp_uri: "ukp://kb/README.md" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an empty enumeration is a successful no-files result", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-files-empty-"));
    try {
      const context = setup(root, "kb", []);
      const result = executeRgCommand(["--endpoint", "kb", "--files"], context);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("(no files)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("enumerated ukp:// uris round-trip through ukp read", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-rg-files-roundtrip-"));
    try {
      const context = setup(root, "kb", tree);
      const rgResult = executeRgCommand(["--endpoint", "kb", "--files", "--json"], context);
      const envelope = JSON.parse(rgResult.stdout);
      const uri = envelope.endpoints[0].files.find((file: { path: string }) => file.path === "docs/a.md").ukp_uri;
      const { executeReadCommand } = await import("../src/commands/read.ts");
      const readMaybeAsync = executeReadCommand([uri], { currentDirectory: root, registryPath: context.registryPath });
      if (readMaybeAsync instanceof Promise) throw new Error("local read unexpectedly took the async path");
      expect(readMaybeAsync.exitCode).toBe(0);
      expect(readMaybeAsync.stdout).toContain("needle");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
