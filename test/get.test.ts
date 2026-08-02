import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { executeGetCommand, parseGetArgs } from "../src/commands/get.ts";
import { registerAt } from "../src/registry.ts";

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
    expect(() => parseGetArgs(["-c", "cad", "docs/note.md", "extra"])).toThrow("exactly one path");
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
      expect(absolute.stderr).toContain("endpoint-relative");

      const driveQualified = executeGetCommand(["--endpoint", "notes", "C:\\secret.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(driveQualified.exitCode).toBe(2);
      expect(driveQualified.stderr).toContain("endpoint-relative");

      const unc = executeGetCommand(["--endpoint", "notes", "\\\\server\\share\\secret.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(unc.exitCode).toBe(2);
      expect(unc.stderr).toContain("endpoint-relative");
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
});
