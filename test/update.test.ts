import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeUpdate, executeUpdateCommand, parseUpdateArgs, renderUpdateHelp, type UpdateContext } from "../src/commands/update.ts";
import { registerAt } from "../src/registry.ts";

const fixtureExecutable = join(import.meta.dir, "fixtures", "qmd-provider", "qmd-fixture.mjs");
const nodeExecutable = Bun.which("node") ?? process.execPath;

function createService(
  root: string,
  folderName: string,
  endpointName: string,
  capability: "update" | "search" = "update",
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

function context(root: string, registryPath: string): UpdateContext {
  return {
    currentDirectory: root,
    registryPath,
    qmdCommand: [nodeExecutable, fixtureExecutable],
  };
}

function invocationCount(service: string): number {
  const path = join(service, "qmd-fixture-invocations.jsonl");
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length;
}

describe("update", () => {
  test("help states the explicit-scope requirement instead of a silent registry fallback", () => {
    const help = renderUpdateHelp();
    expect(help).toContain("Without a Client Config, update needs an explicit scope");
    expect(help).not.toContain("with no Client Config, every registered endpoint");
  });

  test("parses update selectors and rejects misuse", () => {
    expect(parseUpdateArgs(["--endpoint", "cad", "-c", "mem0"]).options.explicitEndpoints).toEqual([
      "cad",
      "mem0",
    ]);
    expect(parseUpdateArgs(["-g"]).options.global).toBe(true);
    expect(parseUpdateArgs(["-c", "cad", "-c", "cad"]).warnings).toContain(
      "duplicate endpoint 'cad' ignored",
    );
    expect(() => parseUpdateArgs(["--endpoint", "cad", "-g"])).toThrow("--endpoint and -g");
    expect(() => parseUpdateArgs(["-gg"])).toThrow("-g may only be specified once");
    expect(() => parseUpdateArgs(["-g", "cad"])).toThrow("unexpected argument 'cad'");
  });

  test("uses Service cwd and maps update/qmd to qmd update", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-update-qmd-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "service", "fixture");
    registerAt(registryPath, "fixture", service);
    try {
      const result = executeUpdate(parseUpdateArgs(["--endpoint", "fixture"]), context(root, registryPath));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("maintenance_scope: provider-owned");
      expect(result.stdout).toContain("QMD decides which configured collections are maintained");
      expect(result.stdout).toContain("status: updated");
      expect(result.stdout).toContain("fixture update complete");
      const invocation = JSON.parse(readFileSync(join(service, "qmd-fixture-invocation.json"), "utf8"));
      expect(invocation.cwd).toBe(realpathSync(service));
      expect(invocation.args).toEqual(["update"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses Client Config default scope without falling back to the whole Registry", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-update-client-config-"));
    const registryPath = join(root, "registry.toml");
    const workspace = join(root, "workspace");
    const selected = createService(root, "selected-service", "selected");
    const other = createService(root, "other-service", "other");
    mkdirSync(join(workspace, ".ukp"), { recursive: true });
    writeFileSync(join(workspace, ".ukp", "client.toml"), 'default_endpoints = ["selected"]\n', "utf8");
    registerAt(registryPath, "selected", selected);
    registerAt(registryPath, "other", other);
    try {
      const result = executeUpdate(parseUpdateArgs([]), {
        ...context(workspace, registryPath),
        currentDirectory: workspace,
      });
      expect(result.exitCode).toBe(0);
      expect(invocationCount(selected)).toBe(1);
      expect(invocationCount(other)).toBe(0);

      const noConfig = executeUpdateCommand([], context(root, registryPath));
      expect(noConfig.exitCode).toBe(1);
      expect(noConfig.stderr).toContain("requires an explicit scope");
      expect(invocationCount(other)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("-g explicitly updates every registered endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-update-global-"));
    const registryPath = join(root, "registry.toml");
    const first = createService(root, "first-service", "first");
    const second = createService(root, "second-service", "second");
    registerAt(registryPath, "first", first);
    registerAt(registryPath, "second", second);
    try {
      const result = executeUpdate(parseUpdateArgs(["-g"]), context(root, registryPath));
      expect(result.exitCode).toBe(0);
      expect(invocationCount(first)).toBe(1);
      expect(invocationCount(second)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("continues after skipped and failed endpoints with aggregate status", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-update-partial-"));
    const registryPath = join(root, "registry.toml");
    const skipped = createService(root, "search-only-service", "skipped", "search");
    const failing = createService(root, "provider-fail-service", "failing");
    const later = createService(root, "later-success-service", "later");
    registerAt(registryPath, "skipped", skipped);
    registerAt(registryPath, "failing", failing);
    registerAt(registryPath, "later", later);
    try {
      const result = executeUpdate(parseUpdateArgs([
        "-c",
        "skipped",
        "-c",
        "failing",
        "-c",
        "later",
      ]), context(root, registryPath));
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("status: skipped");
      expect(result.stdout).toContain("does not provide update");
      expect(result.stdout).toContain("== later ==");
      expect(result.stderr).toContain("fixture provider failure");
      expect(invocationCount(skipped)).toBe(0);
      expect(invocationCount(failing)).toBe(1);
      expect(invocationCount(later)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unsupported update provider is skipped without starting a backend", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-update-unsupported-"));
    const registryPath = join(root, "registry.toml");
    const unsupported = createService(root, "unsupported-service", "unsupported", "update", "file");
    registerAt(registryPath, "unsupported", unsupported);
    try {
      const result = executeUpdate(parseUpdateArgs(["--endpoint", "unsupported"]), context(root, registryPath));
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("unsupported update provider 'file'");
      expect(invocationCount(unsupported)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unknown endpoint recovery points to inventory commands", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-update-unknown-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "known-service", "known");
    registerAt(registryPath, "known", service);
    try {
      const result = executeUpdateCommand(["--endpoint", "missing"], context(root, registryPath));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("ukp update: unknown endpoint 'missing'");
      expect(result.stderr).toContain("ukp list");
      expect(result.stderr).toContain("ukp register");
      expect(result.stderr).not.toContain("ScopeError");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("manifest failures include inspect and diagnose recovery hints", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-update-manifest-failure-"));
    const registryPath = join(root, "registry.toml");
    const stale = join(root, "stale-service");
    const mismatched = createService(root, "renamed-service", "actual-name");
    mkdirSync(stale, { recursive: true });
    registerAt(registryPath, "stale", stale);
    registerAt(registryPath, "expected-name", mismatched);
    try {
      const result = executeUpdate(parseUpdateArgs([
        "-c",
        "stale",
        "-c",
        "expected-name",
      ]), context(root, registryPath));
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Service Manifest is not readable");
      expect(result.stdout).toContain("ukp inspect --endpoint stale");
      expect(result.stdout).toContain("ukp diagnose --endpoint stale");
      expect(result.stdout).toContain("no longer matches Service effective name 'actual-name'");
      expect(result.stdout).toContain("ukp inspect --endpoint expected-name");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("qmd unavailable is reported before starting provider execution", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-update-qmd-unavailable-"));
    const registryPath = join(root, "registry.toml");
    const service = createService(root, "update-service", "updateable");
    registerAt(registryPath, "updateable", service);
    try {
      const result = executeUpdate(parseUpdateArgs(["--endpoint", "updateable"]), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("qmd executable is not available");
      expect(result.stdout).toContain("install QMD");
      expect(invocationCount(service)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("provider SIGINT returns 130 and does not start later endpoints", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-update-sigint-"));
    const registryPath = join(root, "registry.toml");
    const cancelled = createService(root, "provider-sigint-service", "cancelled");
    const later = createService(root, "later-service", "later");
    registerAt(registryPath, "cancelled", cancelled);
    registerAt(registryPath, "later", later);
    try {
      const result = executeUpdate(parseUpdateArgs(["-c", "cancelled", "-c", "later"]), context(root, registryPath));
      expect(result.exitCode).toBe(130);
      expect(result.stdout).toContain("status: cancelled");
      expect(result.stderr).toContain("provider cancelled");
      expect(invocationCount(cancelled)).toBe(1);
      expect(invocationCount(later)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
