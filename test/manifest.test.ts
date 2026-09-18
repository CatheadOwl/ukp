import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadManifest } from "../src/config/manifest.ts";
import { defaultProviderResolver, diagnoseService, renderDiagnose } from "../src/commands/diagnose.ts";

const fixture = join(import.meta.dir, "fixtures", "qmd-provider");

describe("Service Manifest and diagnose", () => {
  test("loads the fixture and derives its explicit endpoint name", () => {
    const loaded = loadManifest(fixture);
    expect(loaded.effectiveName).toBe("fixture-qmd");
    expect(loaded.nameSource).toBe("manifest");
    expect(loaded.manifest.description).toBe("Deterministic QMD-compatible search fixture for UKP tests.");
    expect(loaded.manifest.dependencies).toBeUndefined();
    expect(loaded.manifest.capabilities.search.provider).toBe("qmd");
    expect(loaded.manifest.capabilities.update.provider).toBe("qmd");
    expect(loaded.manifest.capabilities.get).toBeUndefined();
  });

  test("resolves supported and unsupported providers independently", () => {
    const report = diagnoseService(fixture, (provider) => ({
      supported: provider === "qmd",
      reason: provider === "qmd" ? undefined : "unsupported",
    }));
    // search + update from the Manifest; get and nav as derived-local
    // defaults; rg as the external-tool base tier (ADR-RG-003)
    expect(report.capabilities).toHaveLength(5);
    expect(report.capabilities.filter((capability) => capability.source === "manifest")).toHaveLength(2);
    expect(report.capabilities.some((capability) =>
      capability.name === "rg"
      && capability.provider === "external"
      && capability.source === "base-tier"
      && capability.status === "warning"
    )).toBe(true);
    expect(report.capabilities.some((capability) =>
      capability.name === "read"
      && capability.provider === "file"
      && capability.source === "derived-local"
      && capability.status === "warning"
    )).toBe(true);
    expect(report.capabilities.some((capability) =>
      capability.name === "nav"
      && capability.provider === "file"
      && capability.source === "derived-local"
      && capability.status === "warning"
    )).toBe(true);
    expect(renderDiagnose(report)).toContain("endpoint: fixture-qmd");
    expect(renderDiagnose(report)).toContain("description: Deterministic QMD-compatible search fixture");
    expect(renderDiagnose(report)).toContain("capability: read (derived local baseline)");
    expect(renderDiagnose(report)).not.toContain("indexed content");
    const diagnoseOutput = renderDiagnose(report, { includeSearchabilityHint: true });
    expect(diagnoseOutput).toContain("hint: diagnose checks wiring, not indexed content");
    expect(diagnoseOutput).toContain("ukp guide service qmd");
    expect(diagnoseOutput).not.toMatch(/qmd init|collection add/);
    expect(diagnoseOutput.match(/indexed content/g)).toHaveLength(1);
  });

  test("default provider resolver remains compatible with provider-only calls", () => {
    expect(defaultProviderResolver("not-qmd").supported).toBe(false);
    expect(defaultProviderResolver("not-qmd").reason).toContain("provider 'not-qmd' is not supported");
    expect(defaultProviderResolver("file", "read").supported).toBe(true);
    expect(defaultProviderResolver("qmd", "read").reason).toContain("provider 'qmd' is not supported for capability 'read'");
    expect(typeof defaultProviderResolver("qmd", "update").supported).toBe("boolean");
    expect(defaultProviderResolver("file", "update").reason).toContain(
      "provider 'file' is not supported for capability 'update'",
    );
    expect(defaultProviderResolver("qmd", "vsearch").supported).toBe(false);
    expect(defaultProviderResolver("qmd", "vsearch").reason).toContain("capability 'vsearch' is not implemented");
    expect(defaultProviderResolver("file", "propose").supported).toBe(true);
    expect(defaultProviderResolver("remote", "propose").supported).toBe(false);
    expect(defaultProviderResolver("remote", "propose").reason).toContain(
      "provider 'remote' is not supported for capability 'propose'",
    );
  });

  test("diagnose reports propose/file as supported without false warnings", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-diagnose-propose-"));
    const folder = join(root, "propose-service");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), [
      'name = "propose-service"',
      "",
      "[capabilities.propose]",
      'provider = "file"',
      "",
    ].join("\n"));
    try {
      const report = diagnoseService(folder);
      const propose = report.capabilities.find((capability) => capability.name === "propose");
      expect(propose?.status).toBe("ok");
      expect(propose?.reason).toBeUndefined();
      const rendered = renderDiagnose(report);
      expect(rendered).toContain("capability: propose");
      expect(rendered).not.toContain("capability 'propose' is not implemented");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("diagnose front-loads propose folder config typos as warnings", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-diagnose-propose-folder-"));
    const folder = join(root, "propose-service");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), [
      'name = "propose-service"',
      "",
      "[capabilities.propose]",
      'provider = "file"',
      "",
      "[capabilities.propose.config]",
      'folder = "../escape"',
      "",
    ].join("\n"));
    try {
      const report = diagnoseService(folder);
      const propose = report.capabilities.find((capability) => capability.name === "propose");
      expect(propose?.status).toBe("warning");
      expect(propose?.reason).toContain("propose config 'folder'");
      expect(renderDiagnose(report)).toContain("propose config 'folder' has unsafe path segments");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("derives a valid basename without writing back to the Manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-"));
    const folder = join(root, "derived-service");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), "[capabilities.search]\nprovider = \"qmd\"\n");
    try {
      const loaded = loadManifest(folder);
      const derivedName = folder.split(/[\\/]/).at(-1);
      expect(loaded.nameSource).toBe("folder-name");
      expect(derivedName).toBeDefined();
      expect(loaded.effectiveName).toBe(derivedName as string);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a folder may hold both Service and Client roles; the Manifest loads", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-dual-role-"));
    mkdirSync(join(root, ".ukp"));
    writeFileSync(join(root, ".ukp", "service.toml"), "name = \"dual-role\"\n\n[capabilities.search]\nprovider = \"qmd\"\n");
    writeFileSync(join(root, ".ukp", "client.toml"), "default_endpoints = [\"docs\"]\n");
    try {
      const loaded = loadManifest(root);
      expect(loaded.manifest.capabilities.search?.provider).toBe("qmd");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores legacy get capability contents before schema validation", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-"));
    const folder = join(root, "legacy-get");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), [
      "[capabilities.get]",
      'provider = "qmd"',
      'legacy_field = "ignored"',
      "",
    ].join("\n"));
    try {
      const loaded = loadManifest(folder);
      expect(loaded.effectiveName).toBe("legacy-get");
      expect(Object.keys(loaded.manifest.capabilities)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads a zero-declaration Manifest (empty capabilities table)", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-"));
    const folder = join(root, "zero-declaration");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), 'name = "zero-declaration"\n\n[capabilities]\n');
    try {
      const loaded = loadManifest(folder);
      expect(loaded.effectiveName).toBe("zero-declaration");
      expect(loaded.manifest.capabilities).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("zero-declaration service stays diagnosable through derived read/nav", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-"));
    const folder = join(root, "zero-declaration");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), 'name = "zero-declaration"\n\n[capabilities]\n');
    try {
      const report = diagnoseService(folder);
      expect(report.capabilities.filter((capability) => capability.source === "manifest")).toHaveLength(0);
      expect(report.capabilities.some((capability) =>
        capability.name === "read" && capability.source === "derived-local" && capability.status === "ok"
      )).toBe(true);
      expect(report.capabilities.some((capability) =>
        capability.name === "nav" && capability.source === "derived-local" && capability.status === "ok"
      )).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("still rejects a Manifest missing the capabilities table", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-"));
    const folder = join(root, "no-capabilities");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), 'name = "no-capabilities"\n');
    try {
      expect(() => loadManifest(folder)).toThrow(
        "missing required [capabilities] table; use an empty [capabilities] table",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps unrelated Manifest capability fields strict", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-"));
    const folder = join(root, "invalid-capability-field");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), [
      "[capabilities.search]",
      'provider = "qmd"',
      'legacy_field = "not ignored"',
      "",
    ].join("\n"));
    try {
      expect(() => loadManifest(folder)).toThrow("Service Manifest schema is invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads a propose capability with provider config table", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-"));
    const folder = join(root, "propose-service");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), [
      "[capabilities.propose]",
      'provider = "file"',
      "",
      "[capabilities.propose.config]",
      'folder = "proposals"',
      "",
    ].join("\n"));
    try {
      const loaded = loadManifest(folder);
      expect(loaded.manifest.capabilities.propose?.provider).toBe("file");
      expect(loaded.manifest.capabilities.propose?.config).toEqual({ folder: "proposals" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bare [capabilities.propose] declaration defaults to the file provider", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-"));
    const folder = join(root, "propose-bare");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), "[capabilities.propose]\n");
    try {
      const loaded = loadManifest(folder);
      expect(loaded.manifest.capabilities.propose?.provider).toBe("file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads a propose capability without config (provider defaults apply)", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-"));
    const folder = join(root, "propose-default-config");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), [
      "[capabilities.search]",
      'provider = "qmd"',
      "",
      "[capabilities.propose]",
      'provider = "file"',
      "",
    ].join("\n"));
    try {
      const loaded = loadManifest(folder);
      expect(loaded.manifest.capabilities.propose?.provider).toBe("file");
      expect(loaded.manifest.capabilities.propose?.config).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an invalid explicit endpoint name", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-"));
    const folder = join(root, "invalid-service");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), "name = \"CAD\"\n[capabilities.search]\nprovider = \"qmd\"\n");
    try {
      expect(() => loadManifest(folder)).toThrow("invalid endpoint name");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an empty description", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-"));
    const folder = join(root, "invalid-description");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(
      join(folder, ".ukp", "service.toml"),
      "description = \"\"\n[capabilities.search]\nprovider = \"qmd\"\n",
    );
    try {
      expect(() => loadManifest(folder)).toThrow("Service Manifest schema is invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads declared endpoint dependencies with unique endpoint-name grammar", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-"));
    const folder = join(root, "dependency-service");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), [
      'name = "agent-dev"',
      "",
      "[[dependencies]]",
      'endpoint = "anthropic-agent-patterns"',
      'kind = "context"',
      "",
      "[[dependencies]]",
      'endpoint = "ukp-product"',
      'kind = "authority"',
      'reason = "Current product specs constrain this development endpoint."',
      "",
      "[capabilities.search]",
      'provider = "qmd"',
      "",
    ].join("\n"));
    try {
      const loaded = loadManifest(folder);
      expect(loaded.manifest.dependencies).toEqual([
        { endpoint: "anthropic-agent-patterns", kind: "context" },
        {
          endpoint: "ukp-product",
          kind: "authority",
          reason: "Current product specs constrain this development endpoint.",
        },
      ]);
      const rendered = renderDiagnose({
        service: loaded,
        capabilities: [
          { name: "search", provider: "qmd", source: "manifest", status: "ok" },
          { name: "read", provider: "file", source: "derived-local", status: "ok" },
        ],
      });
      expect(rendered).toContain("dependency: depends_on -> ukp-product (kind: authority)");
      expect(rendered).toContain("dependency_reason: Current product specs constrain this development endpoint.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects empty declared dependencies", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-"));
    const folder = join(root, "empty-dependencies");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), [
      'name = "agent-dev"',
      "dependencies = []",
      "",
      "[capabilities.search]",
      'provider = "qmd"',
      "",
    ].join("\n"));
    try {
      expect(() => loadManifest(folder)).toThrow("Service Manifest schema is invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects duplicate declared dependencies", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-"));
    const folder = join(root, "duplicate-dependencies");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), [
      'name = "agent-dev"',
      "",
      "[[dependencies]]",
      'endpoint = "anthropic-agent-patterns"',
      'kind = "context"',
      "",
      "[[dependencies]]",
      'endpoint = "anthropic-agent-patterns"',
      'kind = "authority"',
      "",
      "[capabilities.search]",
      'provider = "qmd"',
      "",
    ].join("\n"));
    try {
      expect(() => loadManifest(folder)).toThrow("duplicate dependency");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid declared dependency names", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-"));
    const folder = join(root, "invalid-dependency");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), [
      'name = "agent-dev"',
      "",
      "[[dependencies]]",
      'endpoint = "Bad Name"',
      'kind = "context"',
      "",
      "[capabilities.search]",
      'provider = "qmd"',
      "",
    ].join("\n"));
    try {
      expect(() => loadManifest(folder)).toThrow("Service Manifest schema is invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects self-targeting declared dependencies", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-"));
    const folder = join(root, "self-dependency");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), [
      'name = "agent-dev"',
      "",
      "[[dependencies]]",
      'endpoint = "agent-dev"',
      'kind = "context"',
      "",
      "[capabilities.search]",
      'provider = "qmd"',
      "",
    ].join("\n"));
    try {
      expect(() => loadManifest(folder)).toThrow("dependency cannot target the Service itself");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects unsupported dependency kinds", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-test-"));
    const folder = join(root, "invalid-dependency-kind");
    mkdirSync(folder);
    mkdirSync(join(folder, ".ukp"));
    writeFileSync(join(folder, ".ukp", "service.toml"), [
      'name = "agent-dev"',
      "",
      "[[dependencies]]",
      'endpoint = "ukp-product"',
      'kind = "related_to"',
      "",
      "[capabilities.search]",
      'provider = "qmd"',
      "",
    ].join("\n"));
    try {
      expect(() => loadManifest(folder)).toThrow("Service Manifest schema is invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
