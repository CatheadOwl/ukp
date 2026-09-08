import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { executeGetCommand, parseGetArgs } from "../src/commands/get.ts";
import { registerAt } from "../src/registry.ts";
import { buildQmdInvocation, stripQmdHeader } from "../src/capabilities/qmd.ts";

const qmdFixture = join(import.meta.dir, "fixtures", "qmd-provider");
const qmdFixtureExecutable = join(qmdFixture, "qmd-fixture.mjs");
const nodeExecutable = Bun.which("node") ?? process.execPath;

function createService(root: string, endpointName: string, provider = "file", capability = "get"): string {
  const service = join(root, endpointName);
  mkdirSync(join(service, ".ukp"), { recursive: true });
  mkdirSync(join(service, "docs"), { recursive: true });
  writeFileSync(
    join(service, ".ukp", "service.toml"),
    `name = "${endpointName}"\n\n[capabilities.${capability}]\nprovider = "${provider}"\n`,
    "utf8",
  );
  writeFileSync(join(service, "docs", "note.md"), "one\ntwo\nthree\nfour\n", "utf8");
  return service;
}

describe("get", () => {
  test("parses endpoint-local reference and line range", () => {
    expect(parseGetArgs(["--endpoint", "cad", "docs/note.md"])).toEqual({
      endpoint: "cad",
      path: "docs/note.md",
    });
    expect(parseGetArgs(["-c", "cad", "docs/note.md", "--lines", "2:3"]).lines).toEqual({
      start: 2,
      count: 3,
    });
    expect(parseGetArgs(["-c", "cad", "docs/note.md", "--lines", "2"]).lines).toEqual({
      start: 2,
    });
    expect(() => parseGetArgs(["docs/note.md"])).toThrow("requires --endpoint");
    expect(() => parseGetArgs(["-c", "cad", "docs/note.md", "-g"])).toThrow("does not support -g");
    expect(() => parseGetArgs(["-c", "cad", "docs/note.md", "--lines", "0:1"])).toThrow("positive");
    expect(() => parseGetArgs(["-c", "cad", "docs/note.md", "--lines", "1:0"])).toThrow("positive");
    expect(() => parseGetArgs(["-c", "cad", "docs/note.md", "--lines", "1", "--lines", "2"])).toThrow(
      "--lines may only be specified once",
    );
    expect(() => parseGetArgs([
      "--endpoint",
      "cad",
      "--endpoint",
      "other",
      "docs/note.md",
    ])).toThrow("--endpoint may only be specified once");
    expect(() => parseGetArgs(["-c", "cad", "docs/note.md", "extra"])).toThrow("exactly one reference");
  });

  test("reads a file-backed endpoint resource and line range", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-file-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    registerAt(registryPath, "notes", service);
    try {
      const full = executeGetCommand(["--endpoint", "notes", "docs/note.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(full).toEqual({ exitCode: 0, stdout: "one\ntwo\nthree\nfour\n", stderr: "" });

      const range = executeGetCommand(["--endpoint", "notes", "docs/note.md", "--lines", "2:2"], {
        currentDirectory: root,
        registryPath,
      });
      expect(range).toEqual({ exitCode: 0, stdout: "two\nthree\n", stderr: "" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("errors when a file-backed --lines start is beyond the end of the resource", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-file-start-beyond-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    registerAt(registryPath, "notes", service);
    try {
      const result = executeGetCommand(["--endpoint", "notes", "docs/note.md", "--lines", "5"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--lines start 5 is beyond the end of 'docs/note.md' (4 lines)");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("truncates a file-backed --lines window that extends past the end of the resource", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-file-window-past-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    registerAt(registryPath, "notes", service);
    try {
      const result = executeGetCommand(["--endpoint", "notes", "docs/note.md", "--lines", "3:5"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("three\nfour\n");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects traversal before reading outside the Service folder", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-traversal-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    writeFileSync(join(root, "secret.md"), "secret\n", "utf8");
    registerAt(registryPath, "notes", service);
    try {
      const result = executeGetCommand(["--endpoint", "notes", "../secret.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("must not contain '.' or '..'");
      expect(result.stdout).toBe("");

      const absolute = executeGetCommand(["--endpoint", "notes", resolve(root, "secret.md")], {
        currentDirectory: root,
        registryPath,
      });
      expect(absolute.exitCode).toBe(2);
      expect(absolute.stderr).toContain("carries its own endpoint");

      const driveQualified = executeGetCommand(["--endpoint", "notes", "C:\\secret.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(driveQualified.exitCode).toBe(2);
      expect(driveQualified.stderr).toContain("carries its own endpoint");

      const unc = executeGetCommand(["--endpoint", "notes", "\\\\server\\share\\secret.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(unc.exitCode).toBe(2);
      expect(unc.stderr).toContain("carries its own endpoint");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects symlink escape from the Service folder when the platform allows symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-symlink-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    writeFileSync(join(root, "secret.md"), "secret\n", "utf8");
    try {
      symlinkSync(join(root, "secret.md"), join(service, "docs", "secret-link.md"), "file");
    } catch {
      rmSync(root, { recursive: true, force: true });
      return;
    }
    registerAt(registryPath, "notes", service);
    try {
      const result = executeGetCommand(["--endpoint", "notes", "docs/secret-link.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("inside the selected Service folder");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves document-relative references against --from (tolerant tier)", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-from-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    mkdirSync(join(service, "principles"), { recursive: true });
    writeFileSync(join(service, "principles", "background.md"), "background\n", "utf8");
    writeFileSync(join(service, "docs", "changelog.md"), "changelog\n", "utf8");
    registerAt(registryPath, "notes", service);
    try {
      // ../ reference: docs/changelog.md -> ../principles/background.md
      const parent = executeGetCommand([
        "--endpoint", "notes", "--from", "docs/changelog.md", "../principles/background.md",
      ], { currentDirectory: root, registryPath });
      expect(parent.exitCode).toBe(0);
      expect(parent.stdout).toBe("background\n");
      expect(parent.stderr).toContain("resolved '../principles/background.md' from 'docs/changelog.md' -> 'principles/background.md'");

      // bare filename resolves in the source document's directory
      const bare = executeGetCommand([
        "--endpoint", "notes", "--from", "docs/changelog.md", "changelog.md",
      ], { currentDirectory: root, registryPath });
      expect(bare.exitCode).toBe(0);
      expect(bare.stdout).toBe("changelog\n");

      // ./ prefix is normalized away
      const dot = executeGetCommand([
        "--endpoint", "notes", "--from", "docs/changelog.md", "./changelog.md",
      ], { currentDirectory: root, registryPath });
      expect(dot.exitCode).toBe(0);
      expect(dot.stdout).toBe("changelog\n");

      // escaping the endpoint root is a usage error, not a containment miss
      const escape = executeGetCommand([
        "--endpoint", "notes", "--from", "docs/changelog.md", "../../outside.md",
      ], { currentDirectory: root, registryPath });
      expect(escape.exitCode).toBe(2);
      expect(escape.stderr).toContain("resolves outside the endpoint");

      // a miss reports the resolved canonical route
      const miss = executeGetCommand([
        "--endpoint", "notes", "--from", "docs/changelog.md", "../principles/missing.md",
      ], { currentDirectory: root, registryPath });
      expect(miss.exitCode).toBe(1);
      expect(miss.stderr).toContain("-> 'principles/missing.md'");

      // parse-level guards
      expect(() => parseGetArgs(["--from", "docs/x.md", "../y.md"])).toThrow("requires --endpoint");
      expect(() => parseGetArgs(["--endpoint", "notes", "--from", "docs/x.md", "--from", "docs/y.md", "a.md"])).toThrow(
        "--from may only be specified once",
      );
      expect(() => parseGetArgs(["--endpoint", "notes", "--from", "docs/x.md", "ukp://notes/a.md"])).toThrow(
        "--from is for document-relative references",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("maps absolute filesystem references to the owning endpoint (tolerant tier)", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-absolute-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    registerAt(registryPath, "notes", service);
    try {
      const hit = executeGetCommand([resolve(service, "docs", "note.md")], {
        currentDirectory: root,
        registryPath,
      });
      expect(hit.exitCode).toBe(0);
      expect(hit.stdout).toBe("one\ntwo\nthree\nfour\n");
      expect(hit.stderr).toContain("absolute path matched endpoint 'notes', route 'docs/note.md'");

      // non-existing target inside the Service folder still maps (lexical containment)
      const missing = executeGetCommand([resolve(service, "docs", "missing.md")], {
        currentDirectory: root,
        registryPath,
      });
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain("route 'docs/missing.md'");
      expect(missing.stderr).toContain("was not found");

      // outside every registered endpoint → usage error naming the registry
      writeFileSync(join(root, "secret.md"), "secret\n", "utf8");
      const outside = executeGetCommand([resolve(root, "secret.md")], {
        currentDirectory: root,
        registryPath,
      });
      expect(outside.exitCode).toBe(2);
      expect(outside.stderr).toContain("matches no registered endpoint");
      expect(outside.stderr).toContain("notes");

      // parse-level guards: --endpoint and --from conflict with the absolute tier
      expect(() => parseGetArgs(["--endpoint", "notes", resolve(root, "secret.md")])).toThrow(
        "carries its own endpoint",
      );
      expect(() => parseGetArgs(["--from", "docs/x.md", resolve(root, "secret.md")])).toThrow(
        "cannot be combined with --from",
      );

      // drive-relative (no separator) is NOT the absolute tier; the plain tier rejects it
      const driveRelative = executeGetCommand(["--endpoint", "notes", "C:note.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(driveRelative.exitCode).toBe(2);
      expect(driveRelative.stderr).toContain("endpoint-scoped");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects ambiguous absolute references spanning nested endpoints", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-absolute-ambiguous-"));
    const registryPath = join(root, "registry.toml");
    const outer = createService(root, "outer");
    const inner = createService(outer, "inner");
    registerAt(registryPath, "outer", outer);
    registerAt(registryPath, "inner", inner);
    try {
      const result = executeGetCommand([resolve(inner, "docs", "note.md")], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("matches multiple endpoints");
      expect(result.stderr).toContain("outer");
      expect(result.stderr).toContain("inner");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads through the derived file baseline without a declared get capability", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-capability-"));
    const registryPath = join(root, "registry.toml");
    const searchOnly = createService(root, "search-only", "qmd", "search");
    const qmdGet = createService(root, "qmd-get", "qmd", "get");
    registerAt(registryPath, "search-only", searchOnly);
    registerAt(registryPath, "qmd-get", qmdGet);
    try {
      const searchOnlyRead = executeGetCommand(["--endpoint", "search-only", "docs/note.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(searchOnlyRead).toEqual({ exitCode: 0, stdout: "one\ntwo\nthree\nfour\n", stderr: "" });

      const legacyQmdGet = executeGetCommand(["--endpoint", "qmd-get", "docs/note.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(legacyQmdGet).toEqual({ exitCode: 0, stdout: "one\ntwo\nthree\nfour\n", stderr: "" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unknown endpoint and missing resource recover without stack traces", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-errors-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    registerAt(registryPath, "notes", service);
    try {
      const unknown = executeGetCommand(["--endpoint", "missing", "docs/note.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(unknown.exitCode).toBe(1);
      expect(unknown.stderr).toContain("ukp read: unknown endpoint 'missing'");
      expect(unknown.stderr).not.toContain("ScopeError");

      const missing = executeGetCommand(["--endpoint", "notes", "docs/missing.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain("was not found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fuzzy suffix match returns single match directly", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-fuzzy-suffix-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    // Create a nested file that matches suffix
    mkdirSync(join(service, "docs", "sub"), { recursive: true });
    writeFileSync(join(service, "docs", "sub", "note.md"), "nested\n", "utf8");
    registerAt(registryPath, "notes", service);
    try {
      // Request "sub/note.md" - exact suffix match, single result
      const result = executeGetCommand(["--endpoint", "notes", "sub/note.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("nested\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fuzzy suffix match lists multiple candidates", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-fuzzy-multi-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    // Create multiple files with same name in different directories
    mkdirSync(join(service, "docs", "en"), { recursive: true });
    mkdirSync(join(service, "docs", "zh"), { recursive: true });
    writeFileSync(join(service, "docs", "en", "note.md"), "english\n", "utf8");
    writeFileSync(join(service, "docs", "zh", "note.md"), "chinese\n", "utf8");
    registerAt(registryPath, "notes", service);
    try {
      // Request "note.md" - multiple matches
      const result = executeGetCommand(["--endpoint", "notes", "note.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("multiple resources match");
      expect(result.stderr).toContain("note.md");
      expect(result.stderr).toContain("Use a more specific path");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fuzzy name match normalizes hyphens and underscores", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-fuzzy-name-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    writeFileSync(join(service, "docs", "my_note.md"), "content\n", "utf8");
    registerAt(registryPath, "notes", service);
    try {
      // Request "my-note" (hyphen) should match "my_note.md" (underscore)
      const result = executeGetCommand(["--endpoint", "notes", "my-note"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Did you mean");
      expect(result.stderr).toContain("my_note.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fuzzy name match ignores extension", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-fuzzy-ext-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    writeFileSync(join(service, "docs", "readme.md"), "readme\n", "utf8");
    registerAt(registryPath, "notes", service);
    try {
      // Request "readme" (no extension) should match "readme.md"
      const result = executeGetCommand(["--endpoint", "notes", "readme"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Did you mean");
      expect(result.stderr).toContain("readme.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fuzzy name match respects path prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-fuzzy-prefix-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    mkdirSync(join(service, "docs", "api"), { recursive: true });
    mkdirSync(join(service, "docs", "cli"), { recursive: true });
    writeFileSync(join(service, "docs", "api", "guide.md"), "api guide\n", "utf8");
    writeFileSync(join(service, "docs", "cli", "guide.md"), "cli guide\n", "utf8");
    registerAt(registryPath, "notes", service);
    try {
      // Request "api/guide" should only match docs/api/guide.md
      const result = executeGetCommand(["--endpoint", "notes", "api/guide"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Did you mean");
      expect(result.stderr).toContain("guide.md");
      expect(result.stderr).toContain("api");
      // Should not contain "cli" in the path
      const lines = result.stderr.split("\n");
      const matchLine = lines.find((l) => l.includes("guide.md"));
      expect(matchLine).toBeDefined();
      expect(matchLine).not.toContain("cli");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fuzzy match scans through symlink directories", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-fuzzy-symlink-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    const realDir = join(service, "real-docs");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "linked.md"), "linked\n", "utf8");
    try {
      symlinkSync(realDir, join(service, "docs", "linked"), "dir");
    } catch {
      rmSync(root, { recursive: true, force: true });
      return; // Skip if symlinks not supported
    }
    registerAt(registryPath, "notes", service);
    try {
      // Request "linked" should find docs/linked/linked.md through symlink
      const result = executeGetCommand(["--endpoint", "notes", "linked"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Did you mean");
      expect(result.stderr).toContain("linked.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fuzzy match handles dotfiles correctly", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-fuzzy-dotfile-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    writeFileSync(join(service, "docs", ".env"), "SECRET=value\n", "utf8");
    writeFileSync(join(service, "docs", ".my_config"), "config\n", "utf8");
    registerAt(registryPath, "notes", service);
    try {
      // Request ".env" should match .env exactly (suffix match)
      const exact = executeGetCommand(["--endpoint", "notes", ".env"], {
        currentDirectory: root,
        registryPath,
      });
      expect(exact.exitCode).toBe(0);
      expect(exact.stdout).toBe("SECRET=value\n");

      // Request ".my-config" (hyphen) should fuzzy match ".my_config" (underscore)
      // This verifies dotfiles are normalized correctly (not stripped to empty string)
      const fuzzy = executeGetCommand(["--endpoint", "notes", ".my-config"], {
        currentDirectory: root,
        registryPath,
      });
      expect(fuzzy.exitCode).toBe(1);
      expect(fuzzy.stderr).toContain("Did you mean");
      expect(fuzzy.stderr).toContain(".my_config");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A QMD-backed Service simulates the ISSUE-007 repro: docs/ja and docs/zh hold
// translations QMD ignores, docs/english.md is exact-path readable. Since ADR
// 0017 the provider is entered only by explicit shapes (bare docid, qmd://);
// a plain-path miss never delegates.
function writeQmdServiceToml(service: string, endpointName: string): void {
  writeFileSync(
    join(service, ".ukp", "service.toml"),
    `name = "${endpointName}"\n\n[capabilities.search]\nprovider = "qmd"\n`,
    "utf8",
  );
}

function createQmdBackedService(root: string, endpointName: string): string {
  const service = join(root, endpointName);
  mkdirSync(join(service, ".ukp"), { recursive: true });
  mkdirSync(join(service, "docs", "ja"), { recursive: true });
  mkdirSync(join(service, "docs", "zh"), { recursive: true });
  writeQmdServiceToml(service, endpointName);
  writeFileSync(join(service, "docs", "ja", "running_agents.md"), "日本語\n", "utf8");
  writeFileSync(join(service, "docs", "zh", "running_agents.md"), "中文\n", "utf8");
  writeFileSync(join(service, "docs", "english.md"), "english\n", "utf8");
  return service;
}

// Mirrors the real-world E2E cases behind the get/qmd adapter:
// - deepeval-docs: an exact endpoint-local `.mdx` path read through get/file.
// - openai-agents: a weak `config.md` reference that also exists in translated
//   folders (ja/zh) — previously tripped the fuzzy scan into a multi-match error.
function createMdxService(root: string, endpointName: string): string {
  const service = join(root, endpointName);
  mkdirSync(join(service, ".ukp"), { recursive: true });
  mkdirSync(join(service, "integrations", "frameworks"), { recursive: true });
  writeQmdServiceToml(service, endpointName);
  writeFileSync(
    join(service, "integrations", "frameworks", "openai-agents.mdx"),
    "# OpenAI Agents integration\n\nTracing via DeepEvalTracingProcessor.\n",
    "utf8",
  );
  return service;
}

function createConfigService(root: string, endpointName: string): string {
  const service = join(root, endpointName);
  mkdirSync(join(service, ".ukp"), { recursive: true });
  mkdirSync(join(service, "docs", "ja"), { recursive: true });
  mkdirSync(join(service, "docs", "zh"), { recursive: true });
  writeQmdServiceToml(service, endpointName);
  writeFileSync(join(service, "docs", "config.md"), "english config\n", "utf8");
  writeFileSync(join(service, "docs", "ja", "config.md"), "日本語 config\n", "utf8");
  writeFileSync(join(service, "docs", "zh", "config.md"), "中文 config\n", "utf8");
  return service;
}

function readQmdInvocation(service: string): { reference?: string; noLineNumbers?: boolean } {
  return JSON.parse(readFileSync(join(service, "qmd-fixture-invocation.json"), "utf8"));
}

describe("get/qmd adapter", () => {
  test("reports a plain-path miss on a QMD-backed endpoint as resource-missing with file candidates, without delegation", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-plain-miss-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand(["--endpoint", "fixture-qmd", "running_agents.md"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      // ADR 0017: shape-based dispatch — a plain-path miss never enters the
      // provider; it fails as resource-missing with the file layer's
      // candidate list (advisory only, never a silent weak-read hit).
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("resource-missing 'running_agents.md' in endpoint 'fixture-qmd'");
      expect(result.stderr).toContain("Did you mean");
      expect(result.stderr).toContain("docs/ja/running_agents.md");
      expect(result.stdout).toBe("");
      expect(existsSync(join(service, "qmd-fixture-invocation.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("routes a qmd:// provider reference to the adapter before path validation", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-uri-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand(["--endpoint", "fixture-qmd", "qmd://fixture-qmd/running-agents.md"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("# Running agents\n\nOperating the OpenAI Agents SDK service.\n");
      const invocation = readQmdInvocation(service);
      expect(invocation.reference).toBe("qmd://fixture-qmd/running-agents.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps exact file hits on the get/file baseline even for a QMD-backed endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-exact-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand(["--endpoint", "fixture-qmd", "docs/english.md"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("english\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("forwards a docid line range as reference:start:count", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-range-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand([
        "--endpoint",
        "fixture-qmd",
        "d4e5f6",
        "--lines",
        "1:2",
      ], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      const invocation = readQmdInvocation(service);
      expect(invocation.reference).toBe("#d4e5f6:1:2");
      expect(invocation.noLineNumbers).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("surfaces a provider miss as a resource-missing recovery message without fuzzy candidates", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-miss-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand(["--endpoint", "fixture-qmd", "qmd://fixture-qmd/missing-thing"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("resource-missing");
      expect(result.stderr).toContain("resource not found");
      expect(result.stderr).not.toContain("Did you mean");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifies a failed qmd spawn as provider-unavailable with a recovery hint", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-unavailable-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      // A bare docid is an explicit provider shape (ADR 0017), so it still
      // enters the provider channel even when the executable is broken.
      const result = executeGetCommand(["--endpoint", "fixture-qmd", "d4e5f6"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: ["/definitely/not-a-real-qmd"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("provider-unavailable");
      expect(result.stderr).toContain("'fixture-qmd'");
      expect(result.stderr).toContain("ukp nav --endpoint fixture-qmd");
      expect(result.stderr).not.toContain("resource-missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports an incompatible qmd build that lacks --no-line-numbers", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-no-lines-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "no-lines-qmd");
    registerAt(registryPath, "no-lines-qmd", service);
    try {
      const result = executeGetCommand(["--endpoint", "no-lines-qmd", "d4e5f6"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("does not support '--no-line-numbers'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects qmd:// references on a non-QMD-backed endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-nonqmd-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "file-notes");
    registerAt(registryPath, "file-notes", service);
    try {
      const result = executeGetCommand(["--endpoint", "file-notes", "qmd://fixture-qmd/running-agents.md"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("require a QMD-backed endpoint");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports provider cancellation when the provider exits 130", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-cancel-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "provider-sigint-qmd");
    registerAt(registryPath, "provider-sigint-qmd", service);
    try {
      const result = executeGetCommand(["--endpoint", "provider-sigint-qmd", "d4e5f6"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(130);
      expect(result.stderr).toContain("provider cancelled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("forwards a bare line start as reference:start", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-range-start-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand([
        "--endpoint",
        "fixture-qmd",
        "d4e5f6",
        "--lines",
        "2",
      ], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(readQmdInvocation(service).reference).toBe("#d4e5f6:2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("surfaces an empty provider body as a no-content recovery message", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-empty-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand(["--endpoint", "fixture-qmd", "qmd://fixture-qmd/emptybody-ref"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("provider returned no content");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifies an unavailable qmd on a qmd:// reference as provider-unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-uri-unavailable-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand(["--endpoint", "fixture-qmd", "qmd://fixture-qmd/running-agents.md"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: ["/definitely/not-a-real-qmd"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("provider-unavailable");
      expect(result.stderr).not.toContain("resource-missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a traversal reference on a QMD-backed endpoint before delegation", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-traversal-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    writeFileSync(join(root, "secret.md"), "secret\n", "utf8");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand(["--endpoint", "fixture-qmd", "../secret.md"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("must not contain '.' or '..'");
      expect(existsSync(join(service, "qmd-fixture-invocation.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads an exact .mdx endpoint-local path through get/file on a QMD-backed endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-mdx-"));
    const registryPath = join(root, "registry.toml");
    const service = createMdxService(root, "deepeval-docs");
    registerAt(registryPath, "deepeval-docs", service);
    try {
      const result = executeGetCommand(["--endpoint", "deepeval-docs", "integrations/frameworks/openai-agents.mdx"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("# OpenAI Agents integration\n\nTracing via DeepEvalTracingProcessor.\n");
      // Exact hit stays on the get/file baseline: qmd is never invoked.
      expect(existsSync(join(service, "qmd-fixture-invocation.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports a config.md plain-path miss on a QMD-backed endpoint as resource-missing with candidates", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-config-"));
    const registryPath = join(root, "registry.toml");
    const service = createConfigService(root, "openai-agents");
    registerAt(registryPath, "openai-agents", service);
    try {
      const result = executeGetCommand(["--endpoint", "openai-agents", "config.md", "--lines", "1:80"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      // ADR 0017: the weak-reference delegation tier is retired. The exact
      // docs/config.md file exists, but "config.md" is not its exact path, so
      // the plain-path tier fails as resource-missing and lists the file
      // layer's candidates — the QMD-visible English body is never silently
      // weak-matched, and the translations are never auto-read either.
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("resource-missing 'config.md' in endpoint 'openai-agents'");
      expect(result.stderr).toContain("docs/config.md");
      expect(result.stderr).toContain("docs/ja/config.md");
      expect(result.stdout).toBe("");
      expect(existsSync(join(service, "qmd-fixture-invocation.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildQmdInvocation", () => {
  test("appends provider arguments verbatim for a plain command", () => {
    expect(buildQmdInvocation(["/usr/bin/qmd", "--flag"], ["get", "#a1b2c3:2"])).toEqual({
      file: "/usr/bin/qmd",
      args: ["--flag", "get", "#a1b2c3:2"],
      verbatim: false,
    });
  });

  test("cmd.exe wrappers get one cmd-escaped /c payload (ISSUE-011)", () => {
    const wrapper = ["C:\\Windows\\cmd.exe", "/d", "/s", "/c", "C:\\npm\\qmd.cmd"];
    // Arbitrary user text (search queries) must never be re-parsed by cmd:
    // every element quoted (inner quotes doubled), payload wrapped in one
    // extra outer quote pair for /s, spawned verbatim so the runtime does not
    // re-quote it — neutralizing `& | < > ^` and spaces.
    const inner = '"C:\\npm\\qmd.cmd" "search" "foo&calc" "-n" "20"';
    expect(buildQmdInvocation(wrapper, ["search", "foo&calc", "-n", "20"])).toEqual({
      file: "C:\\Windows\\cmd.exe",
      args: ["/d", "/s", "/c", `"${inner}"`],
      verbatim: true,
    });
    expect(buildQmdInvocation(wrapper, ["get", 'a b"c'])).toEqual({
      file: "C:\\Windows\\cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\npm\\qmd.cmd" "get" "a b""c""'],
      verbatim: true,
    });
  });

  test("powershell wrappers are not treated as cmd.exe wrappers", () => {
    const ps = ["powershell.exe", "-NoProfile", "-File", "qmd.ps1"];
    expect(buildQmdInvocation(ps, ["update"])).toEqual({
      file: "powershell.exe",
      args: ["-NoProfile", "-File", "qmd.ps1", "update"],
      verbatim: false,
    });
  });
});

describe("stripQmdHeader", () => {
  test("leaves a body-only output containing a --- divider intact", () => {
    expect(stripQmdHeader("First line of body\n---\nrest after hr\n")).toBe(
      "First line of body\n---\nrest after hr\n",
    );
  });

  test("normalizes CRLF line endings", () => {
    expect(stripQmdHeader("qmd://coll/doc.md  #ab\r\nFolder Context: x\r\n---\r\n\r\n# Body\r\n\r\nText.\r\n")).toBe(
      "# Body\n\nText.\n",
    );
  });
});

describe("docid handoff (ADR 0011)", () => {
  test("re-adds # and resolves a bare docid reference via qmd get", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-docid-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand(["--endpoint", "fixture-qmd", "d4e5f6"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("# Outside note\n\nBody from a path-shaped collection.\n");
      expect(readQmdInvocation(service).reference).toBe("#d4e5f6");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("forwards a docid line suffix as reference:start", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-docid-line-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand(["--endpoint", "fixture-qmd", "d4e5f6:2"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(readQmdInvocation(service).reference).toBe("#d4e5f6:2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a bare docid reference on a non-QMD-backed endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-docid-nonqmd-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "file-notes");
    registerAt(registryPath, "file-notes", service);
    try {
      const result = executeGetCommand(["--endpoint", "file-notes", "d4e5f6"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      // Shape-based dispatch (ADR 0017): a bare docid is a provider shape;
      // without a QMD-backed route there is no provider tier to enter.
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("docid[:line] reference requires a QMD-backed endpoint");
      expect(existsSync(join(service, "qmd-fixture-invocation.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects --lines when a docid reference already carries a line", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-docid-lines-clash-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand(["--endpoint", "fixture-qmd", "d4e5f6:2", "--lines", "2"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("already carries a line");
      // The usage error is raised before any provider invocation.
      expect(existsSync(join(service, "qmd-fixture-invocation.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects --lines for a hash-prefixed docid reference carrying a line", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-docid-hash-lines-clash-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand(["--endpoint", "fixture-qmd", "#d4e5f6:2", "--lines", "2"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("already carries a line");
      expect(existsSync(join(service, "qmd-fixture-invocation.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("get ukp:// URI input (exact slot addressing)", () => {
  test("parses a ukp:// URI into endpoint, rel-path, and uri addressing", () => {
    expect(parseGetArgs(["ukp://notes/docs/note.md"])).toEqual({
      endpoint: "notes",
      path: "docs/note.md",
      addressing: "uri",
    });
    expect(parseGetArgs(["ukp://notes/docs/note.md#L2"]).lines).toEqual({ start: 2 });
    // Opaque navigation fragments are ignored for reading (ADR 0014 rule 5).
    expect(parseGetArgs(["ukp://notes/docs/note.md#recovery"]).lines).toBeUndefined();
  });

  test("rejects malformed ukp:// URI usage", () => {
    expect(() => parseGetArgs(["ukp://notes"])).toThrow("non-empty endpoint-relative path");
    expect(() => parseGetArgs(["ukp:///docs/note.md"])).toThrow("must name an endpoint");
    expect(() => parseGetArgs(["ukp://notes/docs/note.md#L2", "--lines", "3"])).toThrow(
      "already carries a line",
    );
    expect(() => parseGetArgs(["--endpoint", "notes", "ukp://notes/docs/note.md"])).toThrow(
      "carries its own endpoint",
    );
    expect(() => parseGetArgs(["ukp://notes/docs/note.md#L0"])).toThrow("positive line number");
    expect(() => parseGetArgs(["ukp://notes/docs/note.md#L99999999999999999999"])).toThrow(
      "positive line number",
    );
    expect(() => parseGetArgs(["ukp://notes\\docs\\note.md"])).toThrow(
      "'/' as the path separator",
    );
    expect(() => parseGetArgs(["foo", "ukp://notes/docs/note.md"])).toThrow(
      "unexpected argument",
    );
    expect(() => parseGetArgs(["ukp://notes/docs/note.md", "extra"])).toThrow(
      "unexpected argument",
    );
  });

  test("reads a file-backed resource through a ukp:// URI, honoring #L<line>", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-uri-file-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    registerAt(registryPath, "notes", service);
    try {
      const full = executeGetCommand(["ukp://notes/docs/note.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(full).toEqual({ exitCode: 0, stdout: "one\ntwo\nthree\nfour\n", stderr: "" });

      const window = executeGetCommand(["ukp://notes/docs/note.md#L2"], {
        currentDirectory: root,
        registryPath,
      });
      expect(window).toEqual({ exitCode: 0, stdout: "two\nthree\nfour\n", stderr: "" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports resource-missing for a ukp:// URI miss without fuzzy fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-uri-missing-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    // Fuzzy bait: a similarly named file must NOT be suggested under URI addressing.
    writeFileSync(join(service, "docs", "nope-similar.md"), "bait\n", "utf8");
    registerAt(registryPath, "notes", service);
    try {
      const result = executeGetCommand(["ukp://notes/docs/nope.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("resource-missing 'docs/nope.md' in endpoint 'notes'");
      expect(result.stderr).not.toContain("Did you mean");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports a directory tail as not-a-readable-resource without leaking EISDIR", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-uri-dir-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    registerAt(registryPath, "notes", service);
    try {
      const result = executeGetCommand(["ukp://notes/docs"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("'docs' is a directory, not a readable resource");
      expect(result.stderr).not.toContain("EISDIR");

      // Path tier parity: the same directory-tail failure must be worded and
      // classified identically without a URI.
      const pathTier = executeGetCommand(["--endpoint", "notes", "docs"], {
        currentDirectory: root,
        registryPath,
      });
      expect(pathTier.exitCode).toBe(1);
      expect(pathTier.stderr).toContain("'docs' is a directory, not a readable resource");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not delegate a ukp:// URI miss to a QMD-backed provider", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-uri-qmd-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand(["ukp://fixture-qmd/docs/absent.md"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("resource-missing 'docs/absent.md'");
      // Exact slot addressing: no provider invocation on a URI miss.
      expect(existsSync(join(service, "qmd-fixture-invocation.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("treats a qmd://-shaped ukp:// rel-path as a literal path, never provider input", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-uri-qmd-shaped-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand(["ukp://fixture-qmd/qmd://running-agents.md"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      // The rel-path is a literal segment sequence ("qmd:", "", "running-agents.md"):
      // rejected as a usage error by path validation, never routed to the provider.
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("empty path segments");
      expect(existsSync(join(service, "qmd-fixture-invocation.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("words a #L beyond-end miss by its URI origin, not --lines", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-uri-eof-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    registerAt(registryPath, "notes", service);
    try {
      const result = executeGetCommand(["ukp://notes/docs/note.md#L9"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "line window start 9 is beyond the end of 'docs/note.md' (4 lines)",
      );
      expect(result.stderr).not.toContain("--lines");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifies an unregistered URI endpoint as a resolution failure", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-uri-dangling-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    registerAt(registryPath, "notes", service);
    try {
      const result = executeGetCommand(["ukp://ghost/docs/note.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unknown endpoint 'ghost'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps containment for ukp:// URI traversal segments", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-uri-containment-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    registerAt(registryPath, "notes", service);
    try {
      const result = executeGetCommand(["ukp://notes/docs/../docs/note.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("'..' path segments");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("get ukp:// URI encoding and normalization (G3 pin, D-059)", () => {
  test("percent-decodes %XX per component, unifying the double-spelling trap", () => {
    // Markdown-legal spelling (`embedding%20practice.md`) and raw spelling
    // must hit the same file (D-059: decode is required for the embedding
    // loop, since CommonMark cannot carry a raw space in a link target).
    expect(parseGetArgs(["ukp://notes/embedding%20practice.md"])).toEqual({
      endpoint: "notes",
      path: "embedding practice.md",
      addressing: "uri",
    });
    expect(parseGetArgs(["ukp://notes/embedding practice.md"])).toEqual({
      endpoint: "notes",
      path: "embedding practice.md",
      addressing: "uri",
    });
    // Multi-byte UTF-8 escapes decode to the same target as raw CJK (IRI stance).
    expect(parseGetArgs(["ukp://notes/%E4%B8%AD%E6%96%87.md"])).toEqual({
      endpoint: "notes",
      path: "中文.md",
      addressing: "uri",
    });
    expect(parseGetArgs(["ukp://notes/中文.md"])).toEqual({
      endpoint: "notes",
      path: "中文.md",
      addressing: "uri",
    });
    // Fragment is decoded too; #L<n> recognition is unaffected.
    expect(parseGetArgs(["ukp://notes/docs/note.md#L2"]).lines).toEqual({ start: 2 });
  });

  test("keeps invalid percent sequences literal and lets %2F act as a separator", () => {
    // `%of` is not a hex triplet, so it stays literal. (Note the flip side,
    // pinned behavior: any `%xx` with hex digits decodes unconditionally —
    // e.g. `%be` in "100%best" is a valid escape.)
    expect(parseGetArgs(["ukp://notes/50%off.md"]).path).toBe("50%off.md");
    expect(parseGetArgs(["ukp://notes/do%2Fcs/note.md"])).toEqual({
      // A decoded `%2F` becomes a separator character (D-059): unambiguous
      // because no filesystem allows `/` inside a name.
      endpoint: "notes",
      path: "do/cs/note.md",
      addressing: "uri",
    });
  });

  test("decoder edge cases: trailing %, incomplete escape, invalid UTF-8", () => {
    // Trailing `%` and incomplete `%A` stay literal (D-059 lenient stance).
    expect(parseGetArgs(["ukp://notes/100%"]).path).toBe("100%");
    expect(parseGetArgs(["ukp://notes/100%A.md"]).path).toBe("100%A.md");
    // `%FF` is a valid escape but invalid UTF-8 → U+FFFD replacement char.
    expect(parseGetArgs(["ukp://notes/bad%FF.md"]).path).toBe("bad\ufffd.md");
    // Consecutive valid escapes decode as one byte run: %E4 %B8 form an
    // incomplete UTF-8 sequence → a single U+FFFD, then literal `x`.
    expect(parseGetArgs(["ukp://notes/%E4%B8x.md"]).path).toBe("\ufffdx.md");
  });

  test("rejects an encoded traversal segment after decoding (containment holds)", () => {
    // `%2E%2E` decodes to `..` before the capability layer's containment
    // check, so the encoded spelling of a traversal is rejected identically.
    const root = mkdtempSync(join(tmpdir(), "ukp-get-uri-encoded-traversal-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    registerAt(registryPath, "notes", service);
    try {
      const result = executeGetCommand(["ukp://notes/docs/%2E%2E/docs/note.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("'..' path segments");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recognizes the scheme case-insensitively but requires the hierarchical //", () => {
    // RFC 3986: scheme comparison is case-insensitive (ASCII).
    expect(parseGetArgs(["UKP://notes/docs/note.md"])).toEqual({
      endpoint: "notes",
      path: "docs/note.md",
      addressing: "uri",
    });
    // Single-slash `ukp:/...` is not the hierarchical form: it is not a URI
    // input and falls back to the plain-reference path, which then demands
    // --endpoint (D-059).
    expect(() => parseGetArgs(["ukp:/notes/docs/note.md"])).toThrow("read requires --endpoint");
  });

  test("reads a spaced filename through its percent-encoded markdown spelling", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-uri-decode-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "notes");
    writeFileSync(join(service, "embedding practice.md"), "spaced\n", "utf8");
    registerAt(registryPath, "notes", service);
    try {
      const encoded = executeGetCommand(["ukp://notes/embedding%20practice.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(encoded).toEqual({ exitCode: 0, stdout: "spaced\n", stderr: "" });

      const raw = executeGetCommand(["ukp://notes/embedding practice.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(raw).toEqual({ exitCode: 0, stdout: "spaced\n", stderr: "" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
