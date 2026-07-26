import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { executeHumanSearch, parseSearchArgs } from "../src/capabilities/search.ts";
import { registerAt } from "../src/registry.ts";

const fixture = join(import.meta.dir, "fixtures", "qmd-provider");
const fixtureExecutable = join(fixture, "qmd-fixture.mjs");
const nodeExecutable = Bun.which("node") ?? process.execPath;

function createService(
  root: string,
  folderName: string,
  endpointName: string,
  capability: "search" | "rg" = "search",
  provider = "qmd",
): string {
  const folder = join(root, folderName);
  mkdirSync(join(folder, ".ukp"), { recursive: true });
  writeFileSync(
    join(folder, ".ukp", "service.toml"),
    `name = "${endpointName}"\n\n[capabilities.${capability}]\nprovider = "${provider}"\n`,
    "utf8",
  );
  return folder;
}

function invocationCount(service: string): number {
  const path = join(service, "qmd-fixture-invocations.jsonl");
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length;
}

describe("search", () => {
  test("parses the stable UKP query and limit contract", () => {
    expect(parseSearchArgs(["hello", "--limit", "30"]).request).toEqual({ query: "hello", limit: 30 });
    expect(parseSearchArgs(["hello"]).request.limit).toBe(20);
    expect(() => parseSearchArgs(["hello", "--limit", "0"])).toThrow("between 1 and 1000");
    expect(() => parseSearchArgs(["hello", "extra"])).toThrow("exactly one query");
  });

  test("uses Service cwd and translates limit to QMD -n", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-"));
    const registryPath = join(root, "registry.toml");
    const invocationPath = join(fixture, "qmd-fixture-invocation.json");
    const invocationLogPath = join(fixture, "qmd-fixture-invocations.jsonl");
    registerAt(registryPath, "fixture-qmd", fixture);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "--limit",
        "20",
        "-c",
        "fixture-qmd",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("== fixture-qmd (search/qmd) ==");
      expect(result.stdout).toContain("CAD fixture note");
      const invocation = JSON.parse(readFileSync(invocationPath, "utf8"));
      expect(invocation.cwd).toBe(fixture);
      expect(invocation.query).toBe("fixture-cad-search-token");
      expect(invocation.nativeLimit).toBe(20);
    } finally {
      if (existsSync(invocationPath)) rmSync(invocationPath);
      if (existsSync(invocationLogPath)) rmSync(invocationLogPath);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("runs two successful endpoints serially in explicit scope order", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-multi-"));
    const registryPath = join(root, "registry.toml");
    const first = createService(root, "first-success", "first");
    const second = createService(root, "second-success", "second");
    registerAt(registryPath, "first", first);
    registerAt(registryPath, "second", second);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "-c",
        "second",
        "-c",
        "first",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.indexOf("== second")).toBeLessThan(result.stdout.indexOf("== first"));
      expect(invocationCount(first)).toBe(1);
      expect(invocationCount(second)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("treats no matches as a successful endpoint result", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-empty-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "no-match-service", "empty");
    registerAt(registryPath, "empty", service);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "-c",
        "empty",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("(no matches)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("skips an unsupported capability while executing a valid endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-skip-"));
    const registryPath = join(root, "registry.toml");
    const skipped = createService(root, "skipped-service", "skipped", "search", "grep");
    const valid = createService(root, "valid-service", "valid");
    registerAt(registryPath, "skipped", skipped);
    registerAt(registryPath, "valid", valid);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "-c",
        "skipped",
        "-c",
        "valid",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("unsupported search provider 'grep'");
      expect(invocationCount(skipped)).toBe(0);
      expect(invocationCount(valid)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("continues after provider failure and returns aggregate exit 1", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-failure-"));
    const registryPath = join(root, "registry.toml");
    const failing = createService(root, "provider-fail-service", "failing");
    const valid = createService(root, "later-success", "later");
    registerAt(registryPath, "failing", failing);
    registerAt(registryPath, "later", valid);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "-c",
        "failing",
        "-c",
        "later",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("fixture provider failure");
      expect(result.stdout).toContain("== later (search/qmd) ==");
      expect(invocationCount(failing)).toBe(1);
      expect(invocationCount(valid)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("finishes planning before starting providers and deduplicates explicit endpoints", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-plan-"));
    const registryPath = join(root, "registry.toml");
    const valid = createService(root, "planning-valid", "valid");
    registerAt(registryPath, "valid", valid);
    try {
      expect(() => executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "-c",
        "missing",
        "-c",
        "valid",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      })).toThrow("unknown endpoint 'missing'");
      expect(invocationCount(valid)).toBe(0);

      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "-c",
        "valid",
        "-c",
        "valid",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("duplicate endpoint 'valid' ignored");
      expect(invocationCount(valid)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("writes a short JSON envelope with per-endpoint native artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-json-"));
    const registryPath = join(root, "registry.toml");
    const artifactRoot = join(root, "artifacts");
    const succeeded = createService(root, "json-success", "success");
    const noMatch = createService(root, "json-no-match", "empty");
    const failed = createService(root, "json-provider-fail", "failed");
    const skipped = createService(root, "json-skipped", "skipped", "rg", "rg");
    registerAt(registryPath, "success", succeeded);
    registerAt(registryPath, "empty", noMatch);
    registerAt(registryPath, "failed", failed);
    registerAt(registryPath, "skipped", skipped);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "--json",
        "-c",
        "success",
        "-c",
        "empty",
        "-c",
        "failed",
        "-c",
        "skipped",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
        artifactRoot,
        artifactRunId: "test-run",
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      const envelope = JSON.parse(result.stdout);
      expect(envelope.schema).toBe("ukp.search.v1");
      expect(envelope.run_id).toBe("test-run");
      expect(envelope.endpoints.map((endpoint: { status: string }) => endpoint.status)).toEqual([
        "succeeded",
        "no_matches",
        "failed",
        "skipped",
      ]);
      const successArtifact = envelope.endpoints[0].artifact;
      expect(isAbsolute(successArtifact)).toBe(true);
      expect(JSON.parse(readFileSync(successArtifact, "utf8"))).toHaveLength(1);
      expect(JSON.parse(readFileSync(envelope.endpoints[1].artifact, "utf8"))).toEqual([]);
      expect(readFileSync(envelope.endpoints[2].error_artifact, "utf8")).toContain("fixture provider failure");
      expect(result.stdout).not.toContain("CAD fixture note");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
