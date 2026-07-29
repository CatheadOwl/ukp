import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COMMANDS, renderDiagnoseHelp, renderHelp, renderSearchHelp, runCli } from "../src/cli.ts";
import { registerAt } from "../src/registry.ts";

const fixture = join(import.meta.dir, "fixtures", "qmd-provider");
const fixtureExecutable = join(fixture, "qmd-fixture.mjs");
const nodeExecutable = Bun.which("node") ?? process.execPath;

describe("CLI bootstrap", () => {
  test("renders every P0 command in help", () => {
    const help = renderHelp();
    for (const [name] of COMMANDS) {
      expect(help).toContain(name);
    }
  });

  test("help exits successfully", () => {
    const output: string[] = [];
    expect(runCli(["--help"], (message) => output.push(message))).toBe(0);
    expect(output.join("\n")).toContain("Usage: ukp");
  });

  test("search help documents selectors and exits successfully", () => {
    const output: string[] = [];
    expect(renderSearchHelp()).toContain("Usage: ukp search <query>");
    expect(runCli(["search", "--help"], (message) => output.push(message))).toBe(0);
    const help = output.join("\n");
    expect(help).toContain("--endpoint <name>");
    expect(help).toContain("-c, --endpoint <name>");
    expect(help).toContain("-g");
    expect(help.replace(/\s+/g, " ")).toContain("takes no value");
    expect(help).not.toContain("default: []");
  });

  test("diagnose help documents endpoint selectors and exits successfully", () => {
    const output: string[] = [];
    expect(renderDiagnoseHelp()).toContain("Usage: ukp diagnose");
    expect(runCli(["diagnose", "--help"], (message) => output.push(message))).toBe(0);
    const help = output.join("\n");
    expect(help).toContain("--endpoint <name>");
    expect(help).toContain("-c, --endpoint <name>");
    expect(help).toContain("-g");
    expect(help.replace(/\s+/g, " ")).toContain("takes no value");
  });

  test("inventory command help is owned by command handlers", () => {
    const listOutput: string[] = [];
    const registerOutput: string[] = [];
    const unregisterOutput: string[] = [];
    expect(runCli(["list", "--help"], (message) => listOutput.push(message))).toBe(0);
    expect(runCli(["register", "--help"], (message) => registerOutput.push(message))).toBe(0);
    expect(runCli(["unregister", "--help"], (message) => unregisterOutput.push(message))).toBe(0);
    expect(listOutput.join("\n")).toContain("Usage: ukp list");
    expect(registerOutput.join("\n")).toContain("Usage: ukp register");
    expect(unregisterOutput.join("\n")).toContain("Usage: ukp unregister");
    expect(unregisterOutput.join("\n")).toContain("[name]");
  });

  test("search usage errors include recovery guidance", () => {
    const errors: string[] = [];
    expect(runCli(["search", "query", "-g", "product"], undefined, (message) => errors.push(message))).toBe(2);
    const error = errors.join("\n");
    expect(error).toContain("unexpected argument 'product'");
    expect(error).toContain("'-g' takes no value");
    expect(error).toContain("--endpoint <name>");
    expect(error).toContain("Run 'ukp search --help' for details.");
  });

  test("diagnose usage errors include recovery guidance", () => {
    const errors: string[] = [];
    expect(runCli(["diagnose", "-g", "product"], undefined, (message) => errors.push(message))).toBe(2);
    const error = errors.join("\n");
    expect(error).toContain("unexpected argument 'product'");
    expect(error).toContain("'-g' takes no value");
    expect(error).toContain("--endpoint <name>");
    expect(error).toContain("Run 'ukp diagnose --help' for details.");
  });

  test("diagnose local Service errors are rendered without a stack trace", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-diagnose-missing-manifest-"));
    const errors: string[] = [];
    try {
      expect(runCli(["diagnose"], undefined, (message) => errors.push(message), {
        currentDirectory: root,
        registryPath: join(root, "registry.toml"),
      })).toBe(1);
      const error = errors.join("\n");
      expect(error).toContain("error: Service Manifest is not readable:");
      expect(error).toContain(join(root, ".ukp", "service.toml"));
      expect(error).toContain("Hint: 'ukp diagnose' checks the current folder as a Service.");
      expect(error).toContain("Use 'ukp diagnose -g' to validate every registered endpoint");
      expect(error).toContain("ukp diagnose --endpoint <name>");
      expect(error).not.toContain("ManifestError:");
      expect(error).not.toContain("at loadManifest");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("diagnose registered endpoint errors when the Service folder has no manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-diagnose-stale-endpoint-"));
    const registryPath = join(root, "registry.toml");
    const endpointRoot = join(root, "meeting-room");
    const output: string[] = [];
    const errors: string[] = [];
    mkdirSync(endpointRoot, { recursive: true });
    registerAt(registryPath, "stale-meeting-room", endpointRoot);
    try {
      expect(runCli(["diagnose", "--endpoint", "stale-meeting-room"], (message) => output.push(message), (message) => errors.push(message), {
        currentDirectory: root,
        registryPath,
      })).toBe(1);
      const error = [...output, ...errors].join("\n");
      expect(error).toContain("error: Service Manifest is not readable:");
      expect(error).toContain(join(endpointRoot, ".ukp", "service.toml"));
      expect(error).not.toContain("ManifestError:");
      expect(error).not.toContain("at loadManifest");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty Registry search explains how to recover", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-empty-"));
    const output: string[] = [];
    expect(runCli(["search", "query", "--json"], (message) => output.push(message), undefined, {
      currentDirectory: root,
      registryPath: join(root, "registry.toml"),
      artifactRoot: join(root, "artifacts"),
    })).toBe(1);
    expect(output.join("\n")).toContain("the Host Registry is empty");
    expect(output.join("\n")).toContain("ukp register");
  });

  test("search -c compatibility alias executes end-to-end", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-search-alias-"));
    const registryPath = join(root, "registry.toml");
    const invocationPath = join(fixture, "qmd-fixture-invocation.json");
    const invocationLogPath = join(fixture, "qmd-fixture-invocations.jsonl");
    const output: string[] = [];
    registerAt(registryPath, "fixture-qmd", fixture);
    try {
      expect(runCli([
        "search",
        "fixture-cad-search-token",
        "-c",
        "fixture-qmd",
        "--limit=2",
      ], (message) => output.push(message), undefined, {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      })).toBe(0);
      expect(output.join("\n")).toContain("CAD fixture note");
      const invocation = JSON.parse(readFileSync(invocationPath, "utf8"));
      expect(invocation.cwd).toBe(fixture);
      expect(invocation.query).toBe("fixture-cad-search-token");
      expect(invocation.nativeLimit).toBe(2);
    } finally {
      if (existsSync(invocationPath)) rmSync(invocationPath);
      if (existsSync(invocationLogPath)) rmSync(invocationLogPath);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("search unknown endpoint errors without a stack trace", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-search-unknown-endpoint-"));
    const registryPath = join(root, "registry.toml");
    const errors: string[] = [];
    registerAt(registryPath, "fixture-qmd", fixture);
    try {
      expect(runCli([
        "search",
        "operation surface",
        "--endpoint",
        "does-not-exist",
      ], undefined, (message) => errors.push(message), {
        currentDirectory: root,
        registryPath,
      })).toBe(1);
      const error = errors.join("\n");
      expect(error).toContain("ukp search: unknown endpoint 'does-not-exist'");
      expect(error).not.toContain("ScopeError:");
      expect(error).not.toContain("at resolveScope");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("diagnose endpoint selectors execute against registered Service folders", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-diagnose-scope-"));
    const registryPath = join(root, "registry.toml");
    const output: string[] = [];
    const aliasOutput: string[] = [];
    registerAt(registryPath, "fixture-qmd", fixture);
    try {
      const context = {
        currentDirectory: root,
        registryPath,
        resolveProvider: () => ({ supported: true }),
      };
      expect(runCli(["diagnose", "--endpoint", "fixture-qmd"], (message) => output.push(message), undefined, context))
        .toBe(0);
      expect(output.join("\n")).toContain("== fixture-qmd ==");
      expect(output.join("\n")).toContain("endpoint: fixture-qmd");
      expect(output.join("\n")).toContain("description: Deterministic QMD-compatible search fixture");
      expect(output.join("\n")).toContain(`location: ${fixture}`);

      expect(runCli(["diagnose", "-c", "fixture-qmd"], (message) => aliasOutput.push(message), undefined, context))
        .toBe(0);
      expect(aliasOutput.join("\n")).toContain("endpoint: fixture-qmd");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("diagnose global scope validates every registered endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-diagnose-global-"));
    const registryPath = join(root, "registry.toml");
    const output: string[] = [];
    registerAt(registryPath, "fixture-qmd", fixture);
    try {
      expect(runCli(["diagnose", "-g"], (message) => output.push(message), undefined, {
        currentDirectory: root,
        registryPath,
        resolveProvider: () => ({ supported: true }),
      })).toBe(0);
      expect(output.join("\n")).toContain("== fixture-qmd ==");
      expect(output.join("\n")).toContain("status: ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("diagnose rejects bundled repeated global flags like -gg", () => {
    const errors: string[] = [];
    expect(runCli(["diagnose", "-gg"], undefined, (message) => errors.push(message))).toBe(2);
    expect(errors.join("\n")).toContain("-g may only be specified once");
  });

  test("diagnose rejects endpoint scope combined with global scope", () => {
    const errors: string[] = [];
    expect(runCli(["diagnose", "--endpoint", "fixture-qmd", "-g"], undefined, (message) => errors.push(message)))
      .toBe(2);
    expect(errors.join("\n")).toContain("--endpoint and -g cannot be used together");
  });

  test("inventory misuse includes command recovery guidance", () => {
    const listErrors: string[] = [];
    const unregisterErrors: string[] = [];
    expect(runCli(["list", "extra"], undefined, (message) => listErrors.push(message))).toBe(2);
    expect(listErrors.join("\n")).toContain("ukp list:");
    expect(listErrors.join("\n")).toContain("Run 'ukp list --help' for details.");

    expect(runCli(["unregister", "BadName"], undefined, (message) => unregisterErrors.push(message))).toBe(2);
    expect(unregisterErrors.join("\n")).toContain("valid endpoint name");
    expect(unregisterErrors.join("\n")).toContain("Run 'ukp unregister --help' for details.");
  });

  test("unknown command is a usage error", () => {
    const errors: string[] = [];
    expect(runCli(["wat"], undefined, (message) => errors.push(message))).toBe(2);
    expect(errors.join("\n")).toContain("unknown command");
  });

  test("register, list, and unregister form an inventory lifecycle", () => {
    const registryPath = join(mkdtempSync(join(tmpdir(), "ukp-cli-")), "registry.toml");
    const context = {
      currentDirectory: fixture,
      registryPath,
      resolveProvider: () => ({ supported: true }),
    };
    const output: string[] = [];
    expect(runCli(["register"], (message) => output.push(message), undefined, context)).toBe(0);
    expect(runCli(["list"], (message) => output.push(message), undefined, context)).toBe(0);
    expect(output.join("\n")).toContain("fixture-qmd");
    expect(output.join("\n")).toContain("description: Deterministic QMD-compatible search fixture");
    expect(readFileSync(registryPath, "utf8")).not.toContain("description");
    expect(runCli(["unregister", "fixture-qmd"], (message) => output.push(message), undefined, context)).toBe(0);
    expect(runCli(["list"], (message) => output.push(message), undefined, context)).toBe(0);
    expect(output.at(-1)).toBe("No endpoints registered.");
  });
});
