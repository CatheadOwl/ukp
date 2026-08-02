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
import { executeHumanSearch } from "../src/capabilities/search.ts";
import { parseSearchArgs } from "../src/commands/search.ts";
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
    expect(parseSearchArgs(["hello", "--limit=30"]).request).toEqual({ query: "hello", limit: 30 });
    expect(() => parseSearchArgs(["hello", "--limit", "0"])).toThrow("between 1 and 1000");
    expect(() => parseSearchArgs(["hello", "--limit", "2", "--limit", "3"])).toThrow(
      "--limit may only be specified once",
    );
    expect(() => parseSearchArgs(["hello", "--limit=2", "--limit=3"])).toThrow(
      "--limit may only be specified once",
    );
    expect(() => parseSearchArgs(["hello", "--limit=2", "--limit", "3"])).toThrow(
      "--limit may only be specified once",
    );
    expect(() => parseSearchArgs(["hello", "extra"])).toThrow("exactly one query");
  });

  test("parses canonical endpoint selectors and keeps -c as an alias", () => {
    expect(parseSearchArgs([
      "hello",
      "--endpoint",
      "cad",
      "-c",
      "mem0",
    ]).options.explicitEndpoints).toEqual(["cad", "mem0"]);
    expect(() => parseSearchArgs(["hello", "--endpoint", "cad", "-g"])).toThrow("--endpoint and -g");
  });

  test("rejects bundled repeated global flags like -gg", () => {
    expect(() => parseSearchArgs(["hello", "-gg"])).toThrow("-g may only be specified once");
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
      expect(result.stdout).toContain("UKP reference: ukp get --endpoint fixture-qmd documents/cad-notes.md --lines 1");
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

  test("skips stale default endpoint bindings while executing valid endpoints", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-stale-default-"));
    const registryPath = join(root, "registry.toml");
    const workspace = join(root, "workspace");
    const stale = join(root, "missing-service");
    const valid = createService(root, "valid-service", "valid");
    mkdirSync(join(workspace, ".ukp"), { recursive: true });
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(workspace, ".ukp", "client.toml"), 'default_endpoints = ["stale", "valid"]\n', "utf8");
    registerAt(registryPath, "stale", stale);
    registerAt(registryPath, "valid", valid);
    rmSync(stale, { recursive: true, force: true });
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
      ]), {
        currentDirectory: workspace,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("endpoint 'stale' is not accessible");
      expect(result.stderr).toContain("Service folder is not accessible");
      expect(result.stderr).toContain("ukp inspect --endpoint stale");
      expect(result.stdout).toContain("== valid (search/qmd) ==");
      expect(invocationCount(valid)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("skips default endpoint bindings when the Service Manifest is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-missing-manifest-"));
    const registryPath = join(root, "registry.toml");
    const workspace = join(root, "workspace");
    const stale = join(root, "manifestless-service");
    const valid = createService(root, "valid-service", "valid");
    mkdirSync(join(workspace, ".ukp"), { recursive: true });
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(workspace, ".ukp", "client.toml"), 'default_endpoints = ["stale", "valid"]\n', "utf8");
    registerAt(registryPath, "stale", stale);
    registerAt(registryPath, "valid", valid);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
      ]), {
        currentDirectory: workspace,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Service Manifest is not readable");
      expect(result.stderr).toContain("ukp inspect --endpoint stale");
      expect(result.stdout).toContain("== valid (search/qmd) ==");
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
      const successReferencesArtifact = envelope.endpoints[0].references_artifact;
      expect(isAbsolute(successReferencesArtifact)).toBe(true);
      expect(envelope.endpoints[0].references_format).toBe("ukp-search-references-v1");
      const successReferences = JSON.parse(readFileSync(successReferencesArtifact, "utf8"));
      expect(successReferences.schema).toBe("ukp.search.references.v1");
      expect(successReferences.results[0]).toMatchObject({
        index: 0,
        endpoint: "success",
        status: "provider_only",
      });
      expect(JSON.parse(readFileSync(envelope.endpoints[1].artifact, "utf8"))).toEqual([]);
      const noMatchReferencesArtifact = envelope.endpoints[1].references_artifact;
      expect(isAbsolute(noMatchReferencesArtifact)).toBe(true);
      expect(JSON.parse(readFileSync(noMatchReferencesArtifact, "utf8")).results).toEqual([]);
      expect(readFileSync(envelope.endpoints[2].error_artifact, "utf8")).toContain("fixture provider failure");
      expect(result.stdout).not.toContain("CAD fixture note");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("writes UKP-owned get-ready references for safe QMD result locations", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-references-"));
    const registryPath = join(root, "registry.toml");
    const artifactRoot = join(root, "artifacts");
    const collectionShaped = createService(root, "collection-shaped", "collection-shaped");
    const pathShaped = createService(root, "path-shaped", "path-shaped");
    const outsideResult = createService(root, "outside-result", "outside-result");
    mkdirSync(join(collectionShaped, "docs"), { recursive: true });
    mkdirSync(join(pathShaped, "docs"), { recursive: true });
    writeFileSync(join(collectionShaped, "docs", "collection-note.md"), "alpha\nbeta\ngamma\n", "utf8");
    writeFileSync(join(pathShaped, "docs", "path-note.md"), "one\ntwo\n", "utf8");
    writeFileSync(join(root, "outside.md"), "outside\n", "utf8");
    registerAt(registryPath, "collection-shaped", collectionShaped);
    registerAt(registryPath, "path-shaped", pathShaped);
    registerAt(registryPath, "outside-result", outsideResult);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "--json",
        "-c",
        "collection-shaped",
        "-c",
        "path-shaped",
        "-c",
        "outside-result",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
        artifactRoot,
        artifactRunId: "reference-run",
      });
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      const references = envelope.endpoints.map((endpoint: { references_artifact: string }) =>
        JSON.parse(readFileSync(endpoint.references_artifact, "utf8")).results[0]
      );
      expect(references[0]).toMatchObject({
        endpoint: "collection-shaped",
        reference: "docs/collection-note.md",
        line: 3,
        status: "get_ready",
      });
      expect(references[1]).toMatchObject({
        endpoint: "path-shaped",
        reference: "docs/path-note.md",
        line: 7,
        status: "get_ready",
      });
      expect(references[2]).toMatchObject({
        endpoint: "outside-result",
        status: "provider_only",
      });
      expect(references[2].reference).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("prints provider-only QMD locations in human output without trailing punctuation", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-human-provider-only-"));
    const registryPath = join(root, "registry.toml");
    const embedded = createService(root, "embedded-uri", "embedded-uri");
    registerAt(registryPath, "embedded-uri", embedded);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "--endpoint",
        "embedded-uri",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Embedded provider location (qmd://external-collection/docs/provider-note.md:5).");
      expect(result.stdout).toContain("Provider-only location: qmd://external-collection/docs/provider-note.md:5");
      expect(result.stdout).not.toContain("Provider-only location: qmd://external-collection/docs/provider-note.md:5).");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
