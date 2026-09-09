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
import { executeReadCommand } from "../src/commands/read.ts";
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
  dependencies: Array<{
    endpoint: string;
    kind: "authority" | "context" | "implementation" | "evidence";
    reason?: string;
  }> = [],
): string {
  const folder = join(root, folderName);
  mkdirSync(join(folder, ".ukp"), { recursive: true });
  const dependencyTables = dependencies.map((dependency) => [
    "[[dependencies]]",
    `endpoint = "${dependency.endpoint}"`,
    `kind = "${dependency.kind}"`,
    ...(dependency.reason ? [`reason = ${JSON.stringify(dependency.reason)}`] : []),
    "",
  ].join("\n")).join("\n");
  writeFileSync(
    join(folder, ".ukp", "service.toml"),
    `name = "${endpointName}"\n\n${dependencyTables}[capabilities.${capability}]\nprovider = "${provider}"\n`,
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
    expect(parseSearchArgs(["hello", "--recursive"]).options.recursive).toBe(true);
    expect(parseSearchArgs(["hello"]).options.recursive).toBe(false);
    expect(() => parseSearchArgs(["hello", "--recursive", "--recursive"])).toThrow(
      "--recursive may only be specified once",
    );
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
      expect(result.stdout).toContain("== fixture-qmd ==");
      expect(result.stdout).toContain("1. CAD fixture note — cad-notes.md:1");
      expect(result.stdout).toContain("   CAD fixture note content.");
      expect(result.stdout).toContain("   read: ukp read --endpoint fixture-qmd a1b2c3:1");
      expect(result.stdout).not.toContain("UKP reference:");
      expect(result.stdout).not.toContain("qmd://");
      expect(result.stdout).not.toContain("(search/qmd)");
      expect(result.stdout).not.toContain("--lines");
      const invocation = JSON.parse(readFileSync(invocationPath, "utf8"));
      expect(invocation.cwd).toBe(fixture);
      expect(invocation.query).toBe("fixture-cad-search-token");
      expect(invocation.nativeLimit).toBe(20);
      expect(invocation.outputFormat).toBe("json");
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

  test("does not expand declared dependencies without --recursive", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-non-recursive-"));
    const registryPath = join(root, "registry.toml");
    const target = createService(root, "target-service", "target");
    const seed = createService(root, "seed-service", "seed", "search", "qmd", [
      { endpoint: "target", kind: "authority" },
    ]);
    registerAt(registryPath, "seed", seed);
    registerAt(registryPath, "target", target);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "--endpoint",
        "seed",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("== seed ==");
      expect(result.stdout).not.toContain("== target ==");
      expect(result.stdout).not.toContain("traversal:");
      expect(invocationCount(seed)).toBe(1);
      expect(invocationCount(target)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("expands authority and context dependencies at depth one in stable order", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-recursive-"));
    const registryPath = join(root, "registry.toml");
    const alpha = createService(root, "alpha-service", "alpha", "search", "qmd", [
      { endpoint: "seed", kind: "authority" },
      { endpoint: "third", kind: "context" },
    ]);
    const ignored = createService(root, "ignored-service", "ignored");
    const seed = createService(root, "seed-service", "seed", "search", "qmd", [
      { endpoint: "zeta", kind: "context" },
      { endpoint: "ignored", kind: "implementation" },
      { endpoint: "missing", kind: "authority" },
      { endpoint: "alpha", kind: "authority", reason: "Alpha is authoritative." },
    ]);
    const third = createService(root, "third-service", "third");
    const zeta = createService(root, "zeta-service", "zeta");
    for (const [name, folder] of [
      ["alpha", alpha],
      ["ignored", ignored],
      ["seed", seed],
      ["third", third],
      ["zeta", zeta],
    ] as const) registerAt(registryPath, name, folder);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "--endpoint",
        "seed",
        "--recursive",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.indexOf("== seed ==")).toBeLessThan(result.stdout.indexOf("== alpha =="));
      expect(result.stdout.indexOf("== alpha ==")).toBeLessThan(result.stdout.indexOf("== zeta =="));
      expect(result.stdout).toContain("traversal: depth=0 path=seed");
      expect(result.stdout).toContain("traversal: depth=1 path=seed -> alpha via=authority");
      expect(result.stdout).toContain("traversal_reason: Alpha is authoritative.");
      expect(result.stdout).toContain("traversal: depth=1 path=seed -> zeta via=context");
      expect(result.stdout).not.toContain("== ignored ==");
      expect(result.stdout).not.toContain("== third ==");
      expect(result.stderr).toContain("recursive dependency target 'missing' is not registered");
      expect(result.stderr).toContain("recursive dependency cycle truncated: alpha -> seed");
      expect(invocationCount(seed)).toBe(1);
      expect(invocationCount(alpha)).toBe(1);
      expect(invocationCount(zeta)).toBe(1);
      expect(invocationCount(ignored)).toBe(0);
      expect(invocationCount(third)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("deduplicates recursive targets and emits JSON traversal provenance", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-recursive-json-"));
    const registryPath = join(root, "registry.toml");
    const target = createService(root, "target-service", "target");
    const first = createService(root, "first-service", "first", "search", "qmd", [
      { endpoint: "target", kind: "context", reason: "First path." },
    ]);
    const second = createService(root, "second-service", "second", "search", "qmd", [
      { endpoint: "target", kind: "authority", reason: "Selected first." },
    ]);
    registerAt(registryPath, "first", first);
    registerAt(registryPath, "second", second);
    registerAt(registryPath, "target", target);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "--endpoint",
        "second",
        "--endpoint",
        "first",
        "--recursive",
        "--json",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
        artifactRoot: join(root, "artifacts"),
        artifactRunId: "recursive-run",
      });
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.endpoints.map((endpoint: { name: string }) => endpoint.name)).toEqual([
        "second",
        "first",
        "target",
      ]);
      expect(envelope.endpoints[0]).toMatchObject({ depth: 0, path: ["second"], via: null });
      expect(envelope.endpoints[1]).toMatchObject({ depth: 0, path: ["first"], via: null });
      expect(envelope.endpoints[2]).toMatchObject({
        depth: 1,
        path: ["second", "target"],
        via: { kind: "authority", reason: "Selected first." },
      });
      expect(invocationCount(target)).toBe(1);
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
      expect(result.stdout).toContain("== valid ==");
      expect(invocationCount(valid)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("surfaces a dangling default endpoint as a skipped entry in the JSON envelope", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-json-dangling-"));
    const registryPath = join(root, "registry.toml");
    const artifactRoot = join(root, "artifacts");
    const workspace = join(root, "workspace");
    const valid = createService(root, "json-dangling-valid", "valid");
    mkdirSync(join(workspace, ".ukp"), { recursive: true });
    writeFileSync(join(workspace, ".ukp", "client.toml"), 'default_endpoints = ["ghost", "valid"]\n', "utf8");
    registerAt(registryPath, "valid", valid);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "--json",
      ]), {
        currentDirectory: workspace,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
        artifactRoot,
        artifactRunId: "dangling-run",
      });
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      // The dangling endpoint is listed as a structured skipped endpoint at its
      // `default_endpoints` declaration position (index 0), before the valid one.
      expect(envelope.endpoints.map((endpoint: { name: string; status: string }) => ({
        name: endpoint.name,
        status: endpoint.status,
      }))).toEqual([
        { name: "ghost", status: "skipped" },
        { name: "valid", status: "succeeded" },
      ]);
      expect(envelope.endpoints[0]).toMatchObject({
        name: "ghost",
        provider: null,
        status: "skipped",
      });
      expect(envelope.endpoints[0].message).toContain("'ghost' is not registered");
      expect(envelope.endpoints[0].message).toContain("client.toml");
      // The warning string is still present for Human/other consumers.
      expect(envelope.warnings.some((warning: string) => warning.includes("'ghost' is not registered"))).toBe(true);
      // The selected-scope recovery hint follows the dangling warning (D-051).
      expect(envelope.warnings.some((warning: string) =>
        warning === `Hint: run 'ukp list' or 'ukp diagnose' to check the selected scope, or edit ${join(workspace, ".ukp", "client.toml")}, then retry.`
      )).toBe(true);
      expect(invocationCount(valid)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("Human mode renders no-results stdout plus dangling warning and recovery hint on stderr", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-human-dangling-"));
    const registryPath = join(root, "registry.toml");
    const workspace = join(root, "workspace");
    // Folder name contains "no-match" so the fixture returns an empty result array,
    // exercising `(no matches)` in the default Human surface.
    const valid = createService(root, "no-match-service", "valid");
    mkdirSync(join(workspace, ".ukp"), { recursive: true });
    writeFileSync(join(workspace, ".ukp", "client.toml"), 'default_endpoints = ["ghost", "valid"]\n', "utf8");
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
      // The searched endpoint reports an empty result on stdout.
      expect(result.stdout).toContain("== valid ==");
      expect(result.stdout).toContain("(no matches)");
      // The dangling default endpoint renders the productized wording + the
      // selected-scope recovery hint on stderr (the Human-mode counterpart of
      // the JSON envelope test above; the envelope test never exercises the
      // stderr assembly in `executeHumanMode`).
      expect(result.stderr).toContain(
        `'ghost' is not registered (from ${join(workspace, ".ukp", "client.toml")})`,
      );
      expect(result.stderr).toContain(
        `Hint: run 'ukp list' or 'ukp diagnose' to check the selected scope, or edit ${join(workspace, ".ukp", "client.toml")}, then retry.`,
      );
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
      expect(result.stdout).toContain("== valid ==");
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
      expect(result.stdout).toContain("== later ==");
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
      expect("depth" in envelope.endpoints[0]).toBe(false);
      expect("path" in envelope.endpoints[0]).toBe(false);
      expect("via" in envelope.endpoints[0]).toBe(false);
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
        reference: "a1b2c3",
        line: 1,
        status: "read_ready",
        read_adapter: "qmd",
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

  test("writes UKP-owned read-ready references for safe QMD result locations", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-references-"));
    const registryPath = join(root, "registry.toml");
    const artifactRoot = join(root, "artifacts");
    const collectionShaped = createService(root, "collection-shaped", "collection-shaped");
    const pathShaped = createService(root, "path-shaped", "path-shaped");
    const outsideResult = createService(root, "outside-result", "outside-result");
    const sameAuthorityExternal = createService(root, "same-authority-external", "same-authority-external");
    mkdirSync(join(collectionShaped, "docs"), { recursive: true });
    mkdirSync(join(pathShaped, "docs"), { recursive: true });
    writeFileSync(join(collectionShaped, "docs", "collection-note.md"), "alpha\nbeta\ngamma\n", "utf8");
    writeFileSync(join(pathShaped, "docs", "path-note.md"), "one\ntwo\n", "utf8");
    writeFileSync(join(root, "outside.md"), "outside\n", "utf8");
    registerAt(registryPath, "collection-shaped", collectionShaped);
    registerAt(registryPath, "path-shaped", pathShaped);
    registerAt(registryPath, "outside-result", outsideResult);
    registerAt(registryPath, "same-authority-external", sameAuthorityExternal);
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
        "-c",
        "same-authority-external",
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
        reference: "b2c3d4",
        line: 3,
        status: "read_ready",
        read_adapter: "qmd",
      });
      expect(references[1]).toMatchObject({
        endpoint: "path-shaped",
        reference: "c3d4e5",
        line: 7,
        status: "read_ready",
        read_adapter: "qmd",
        ukp_uri: "ukp://path-shaped/docs/path-note.md",
      });
      expect(references[2]).toMatchObject({
        endpoint: "outside-result",
        reference: "d4e5f6",
        line: 2,
        status: "read_ready",
        read_adapter: "qmd",
      });
      // The path-shaped location resolves outside the Service folder
      // (root/outside.md): no uri may be emitted — including the cross-drive
      // case, where `path.relative` returns the absolute target instead of a
      // `..`-prefixed path (guarded by `isAbsoluteLocationPath` on the
      // relative result in `endpointRelativePathOf`).
      expect(references[2]).not.toHaveProperty("ukp_uri");
      expect(references[2]).not.toHaveProperty("reason");
      expect(references[3]).toMatchObject({
        endpoint: "same-authority-external",
        reference: "e5f6a7",
        line: 4,
        status: "read_ready",
        read_adapter: "qmd",
      });
      expect(references[3]).not.toHaveProperty("reason");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("prints read-ready docid handoff in human output", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-human-docid-"));
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
      expect(result.stdout).toContain("1. Embedded provider location note — provider-note.md:5");
      expect(result.stdout).toContain("   read: ukp read --endpoint embedded-uri f6a7b8:5");
      // A 6-hex token in body content (e.g. a color code) is not a docid and
      // must not become the handoff key or a get hint.
      expect(result.stdout).toContain("Accent color #ff0000.");
      expect(result.stdout).not.toContain("ukp get --endpoint embedded-uri ff0000");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("renders each result as a numbered result unit with title, excerpt, docid, and copyable get", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-units-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "multi-result-service", "multi-result");
    registerAt(registryPath, "multi-result", service);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "--endpoint",
        "multi-result",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("== multi-result ==");
      expect(result.stdout).toContain("1. CAD fixture note — cad-notes.md:1");
      expect(result.stdout).toContain("   CAD fixture note content.");
      expect(result.stdout).toContain("   read: ukp read --endpoint multi-result a1b2c3:1");
      // Result units within one endpoint are separated by a blank line: the get
      // line of unit 1 is directly followed by an empty line before the `2.` unit.
      expect(result.stdout).toContain("a1b2c3:1\n\n2. Collection-shaped fixture note — collection-note.md:3");
      expect(result.stdout).toContain("2. Collection-shaped fixture note — collection-note.md:3");
      expect(result.stdout).toContain("   read: ukp read --endpoint multi-result b2c3d4:3");
      expect(result.stdout).not.toContain("UKP reference:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("omits --lines when a result has no line", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-no-line-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "no-line-service", "no-line");
    registerAt(registryPath, "no-line", service);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "--endpoint",
        "no-line",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("1. No-line fixture note — no-line.md");
      expect(result.stdout).toContain("   read: ukp read --endpoint no-line c1d2e3");
      expect(result.stdout).not.toContain("--lines");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("renders basename:line as the identity when a result has no title", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-no-title-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "no-title-service", "no-title");
    registerAt(registryPath, "no-title", service);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "--endpoint",
        "no-title",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("1. no-title.md:2");
      expect(result.stdout).toContain("   No-title fixture content.");
      expect(result.stdout).toContain("   read: ukp read --endpoint no-title e6f7a8:2");
      // No title means no ` — ` separator — the identity is just `basename:line`.
      expect(result.stdout).not.toContain(" — ");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("marks a no-docid result provider_only and emits no get hint", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-no-docid-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "no-docid-service", "no-docid");
    registerAt(registryPath, "no-docid", service);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "--endpoint",
        "no-docid",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("1. No-docid fixture note — no-docid.md:3");
      expect(result.stdout).toContain("   No-docid fixture content cannot form a get route.");
      expect(result.stdout).toContain("   (no direct read — provider-managed result)");
      expect(result.stdout).not.toContain("read: ukp read");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("does not show a file-head banner snippet as the excerpt", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-banner-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "banner-service", "banner");
    registerAt(registryPath, "banner", service);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "--endpoint",
        "banner",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("1. Banner fixture note — banner.md:1");
      expect(result.stdout).toContain("   read: ukp read --endpoint banner d2e3f4:1");
      expect(result.stdout).not.toContain("---");
      expect(result.stdout).not.toContain("Banner body text.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("falls back to raw provider output plus a reference list when the provider ignores --format json", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-fallback-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "no-json-service", "no-json");
    registerAt(registryPath, "no-json", service);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "--endpoint",
        "no-json",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("== no-json ==");
      expect(result.stdout).toContain("qmd://fixture-qmd/documents/cad-notes.md:1  #a1b2c3");
      expect(result.stdout).toContain("CAD fixture note");
      expect(result.stdout).toContain("UKP reference: ukp read --endpoint no-json a1b2c3 --lines 1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("renders per-endpoint result-unit blocks in scope order without merging", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-unit-multi-"));
    const registryPath = join(root, "registry.toml");
    const collection = createService(root, "collection-shaped-service", "collection-shaped");
    const pathShaped = createService(root, "path-shaped-service", "path-shaped");
    registerAt(registryPath, "collection-shaped", collection);
    registerAt(registryPath, "path-shaped", pathShaped);
    try {
      const result = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "-c",
        "path-shaped",
        "-c",
        "collection-shaped",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.indexOf("== path-shaped ==")).toBeLessThan(
        result.stdout.indexOf("== collection-shaped =="),
      );
      // Endpoint blocks are separated by a blank line: the last unit of the
      // first block is directly followed by an empty line before the second
      // `== <name> ==` header.
      expect(result.stdout).toContain("c3d4e5:7\n\n== collection-shaped ==");
      expect(result.stdout).toContain("   read: ukp read --endpoint path-shaped c3d4e5:7");
      expect(result.stdout).toContain("   read: ukp read --endpoint collection-shaped b2c3d4:3");
      expect(result.stdout).not.toContain("UKP reference:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("qmd search reference round-trips through ukp read by docid", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-roundtrip-"));
    const registryPath = join(root, "registry.toml");
    const artifactRoot = join(root, "artifacts");
    // "outside-result" makes the fixture emit a path-shaped qmd:// provenance URI
    // pointing outside the Service folder; the handoff key is the docid (ADR 0011).
    const service = createService(root, "outside-result", "outside-result");
    writeFileSync(join(root, "outside.md"), "# Outside note\n\nBody from a path-shaped collection.\n", "utf8");
    registerAt(registryPath, "outside-result", service);
    try {
      const searchResult = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "--json",
        "--endpoint",
        "outside-result",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
        artifactRoot,
        artifactRunId: "roundtrip-run",
      });
      expect(searchResult.exitCode).toBe(0);
      const envelope = JSON.parse(searchResult.stdout);
      const sidecar = JSON.parse(readFileSync(envelope.endpoints[0].references_artifact, "utf8"));
      const mapping = sidecar.results[0];
      expect(mapping.status).toBe("read_ready");
      expect(mapping.read_adapter).toBe("qmd");
      // The handoff key is a bare 6-hex docid, not a verbatim path-shaped qmd://
      // URI: no scheme, no drive/anchor, no leading `#`.
      expect(mapping.reference).toBe("d4e5f6");
      expect(mapping.reference).toMatch(/^[a-f0-9]{6}$/);
      // The path-shaped URI survives as display-only provenance.
      expect(mapping.provider_location.startsWith("qmd://")).toBe(true);

      // The self-contained hint — `ukp read --endpoint <name> <docid>:<line>`
      // copied verbatim from search — must execute successfully.
      const ReadResult = executeReadCommand([
        "--endpoint",
        "outside-result",
        `${mapping.reference}:${mapping.line}`,
      ], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(ReadResult.exitCode).toBe(0);
      expect(ReadResult.stdout.length).toBeGreaterThan(0);
      expect(ReadResult.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("emits ukp_uri dual-key output for safely mappable results (ADR 0019)", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-search-dual-key-"));
    const registryPath = join(root, "registry.toml");
    const artifactRoot = join(root, "artifacts");
    const collectionShaped = createService(root, "collection-shaped", "collection-shaped");
    // The default fixture branch emits qmd://fixture-qmd/documents/cad-notes.md,
    // which does NOT exist inside this Service folder: no uri may be emitted.
    const unmapped = createService(root, "unmapped-location", "unmapped-location");
    mkdirSync(join(collectionShaped, "docs"), { recursive: true });
    writeFileSync(
      join(collectionShaped, "docs", "collection-note.md"),
      "# Collection note\n\nalpha\nbeta\ngamma\n",
      "utf8",
    );
    registerAt(registryPath, "collection-shaped", collectionShaped);
    registerAt(registryPath, "unmapped-location", unmapped);
    try {
      const human = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "-c",
        "collection-shaped",
        "-c",
        "unmapped-location",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(human.exitCode).toBe(0);
      // Dual-key result unit: session handoff line + durable slot line.
      expect(human.stdout).toContain("read: ukp read --endpoint collection-shaped b2c3d4:3");
      expect(human.stdout).toContain("uri: ukp://collection-shaped/docs/collection-note.md");
      // A location that does not resolve to an endpoint-local file gets no uri.
      expect(human.stdout).not.toContain("uri: ukp://unmapped-location/");

      const json = executeHumanSearch(parseSearchArgs([
        "fixture-cad-search-token",
        "--json",
        "-c",
        "collection-shaped",
        "-c",
        "unmapped-location",
      ]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
        artifactRoot,
        artifactRunId: "dual-key-run",
      });
      expect(json.exitCode).toBe(0);
      const envelope = JSON.parse(json.stdout);
      const mapped = JSON.parse(
        readFileSync(envelope.endpoints[0].references_artifact, "utf8"),
      ).results[0];
      expect(mapped.ukp_uri).toBe("ukp://collection-shaped/docs/collection-note.md");
      const unmappedResult = JSON.parse(
        readFileSync(envelope.endpoints[1].references_artifact, "utf8"),
      ).results[0];
      expect(unmappedResult).not.toHaveProperty("ukp_uri");

      // Round-trip: the emitted uri, copied verbatim, reads the endpoint-local
      // file through the exact slot route (get/file semantics, ADR 0017).
      const readResult = executeReadCommand([mapped.ukp_uri], {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      });
      expect(readResult.exitCode).toBe(0);
      expect(readResult.stdout).toContain("# Collection note");
      expect(readResult.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
