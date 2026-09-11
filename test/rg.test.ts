import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseRgArgs,
  executeRgCommand,
  splitRgPassthrough,
} from "../src/commands/rg.ts";
import { RgUsageError, validateRgPassthrough } from "../src/capabilities/rg.ts";
import type { RgContext } from "../src/capabilities/rg.ts";
import { registerAt } from "../src/registry.ts";

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
    expect(() => parseRgArgs(["--endpoint", "kb", "x", "--limit", "0"])).toThrow(RgUsageError);
    expect(() => parseRgArgs(["--endpoint", "kb", "x", "--limit", "1001"])).toThrow(RgUsageError);
    expect(() => parseRgArgs([])).toThrow(RgUsageError);
    expect(() => parseRgArgs(["--endpoint", "kb", "a", "b"])).toThrow(RgUsageError);
    expect(() => parseRgArgs(["-g", "--endpoint", "kb", "x"])).toThrow(RgUsageError);
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
      const read = executeReadCommand([uri], { currentDirectory: root, registryPath: context.registryPath });
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
});
