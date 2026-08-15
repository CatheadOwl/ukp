import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { executeGetCommand, parseGetArgs } from "../src/commands/get.ts";
import { registerAt } from "../src/registry.ts";
import { stripQmdHeader } from "../src/capabilities/qmd.ts";

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
      expect(absolute.stderr).toContain("endpoint-scoped");

      const driveQualified = executeGetCommand(["--endpoint", "notes", "C:\\secret.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(driveQualified.exitCode).toBe(2);
      expect(driveQualified.stderr).toContain("endpoint-scoped");

      const unc = executeGetCommand(["--endpoint", "notes", "\\\\server\\share\\secret.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(unc.exitCode).toBe(2);
      expect(unc.stderr).toContain("endpoint-scoped");
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
      expect(unknown.stderr).toContain("ukp get: unknown endpoint 'missing'");
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
// translations QMD ignores, docs/english.md is exact-path readable, and the QMD
// fixture is the provider-owned resolver for weak references.
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
  test("delegates an unresolved reference to qmd get and strips the provider header", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-weak-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand(["--endpoint", "fixture-qmd", "running_agents.md"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("# Running agents\n\nOperating the OpenAI Agents SDK service.\n");
      expect(result.stderr).toBe("");
      const invocation = readQmdInvocation(service);
      expect(invocation.reference).toBe("running_agents.md");
      expect(invocation.noLineNumbers).toBe(true);
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

  test("forwards a line range as reference:start:count", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-range-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand([
        "--endpoint",
        "fixture-qmd",
        "running_agents.md",
        "--lines",
        "1:2",
      ], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      const invocation = readQmdInvocation(service);
      expect(invocation.reference).toBe("running_agents.md:1:2");
      expect(invocation.noLineNumbers).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("surfaces a provider miss as a recovery message without fuzzy candidates", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-miss-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand(["--endpoint", "fixture-qmd", "missing-thing"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("resource not found");
      expect(result.stderr).not.toContain("Did you mean");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports an unavailable qmd executable without falling back to fuzzy scan", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-get-qmd-unavailable-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "fixture-qmd");
    registerAt(registryPath, "fixture-qmd", service);
    try {
      const result = executeGetCommand(["--endpoint", "fixture-qmd", "running_agents.md"], {
        currentDirectory: root,
        registryPath,
        qmdCommand: ["/definitely/not-a-real-qmd"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("failed to run qmd");
      expect(result.stderr).not.toContain("Did you mean");
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
      const result = executeGetCommand(["--endpoint", "no-lines-qmd", "running_agents.md"], {
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
      const result = executeGetCommand(["--endpoint", "provider-sigint-qmd", "running_agents.md"], {
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
        "running_agents.md",
        "--lines",
        "2",
      ], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, qmdFixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(readQmdInvocation(service).reference).toBe("running_agents.md:2");
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
      const result = executeGetCommand(["--endpoint", "fixture-qmd", "emptybody-ref"], {
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

  test("reports a qmd:// reference with an unavailable qmd without fuzzy fallback", () => {
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
      expect(result.stderr).toContain("failed to run qmd");
      expect(result.stderr).not.toContain("Did you mean");
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

  test("delegates a config.md weak reference with a line range instead of a fuzzy multi-match", () => {
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
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      // The translated docs/ja + docs/zh copies exist, but the adapter must
      // return the QMD-visible English body, never a candidate list.
      expect(result.stdout).not.toContain("multiple resources match");
      // Exact body of the fixture's `config` branch after header stripping —
      // a fuzzy multi-match or a get/file read of docs/config.md would fail this.
      expect(result.stdout).toBe("# Configuration\n\nSDK-wide defaults configured at startup.\n");
      const invocation = readQmdInvocation(service);
      expect(invocation.reference).toBe("config.md:1:80");
      expect(invocation.noLineNumbers).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
