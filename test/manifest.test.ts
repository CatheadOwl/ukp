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
    expect(loaded.manifest.capabilities.search.provider).toBe("qmd");
    expect(loaded.manifest.capabilities.refresh.provider).toBe("qmd");
    expect(loaded.manifest.capabilities.get).toBeUndefined();
  });

  test("resolves supported and unsupported providers independently", () => {
    const report = diagnoseService(fixture, (provider) => ({
      supported: provider === "qmd",
      reason: provider === "qmd" ? undefined : "unsupported",
    }));
    expect(report.capabilities).toHaveLength(3);
    expect(report.capabilities.filter((capability) => capability.source === "manifest")).toHaveLength(2);
    expect(report.capabilities.some((capability) =>
      capability.name === "get"
      && capability.provider === "file"
      && capability.source === "derived-local"
      && capability.status === "warning"
    )).toBe(true);
    expect(renderDiagnose(report)).toContain("endpoint: fixture-qmd");
    expect(renderDiagnose(report)).toContain("description: Deterministic QMD-compatible search fixture");
    expect(renderDiagnose(report)).toContain("capability: get (derived local baseline)");
  });

  test("default provider resolver remains compatible with provider-only calls", () => {
    expect(defaultProviderResolver("not-qmd").supported).toBe(false);
    expect(defaultProviderResolver("not-qmd").reason).toContain("provider 'not-qmd' is not supported");
    expect(defaultProviderResolver("file", "get").supported).toBe(true);
    expect(defaultProviderResolver("qmd", "get").reason).toContain("provider 'qmd' is not supported for capability 'get'");
    expect(typeof defaultProviderResolver("qmd", "refresh").supported).toBe("boolean");
    expect(defaultProviderResolver("file", "refresh").reason).toContain(
      "provider 'file' is not supported for capability 'refresh'",
    );
    expect(defaultProviderResolver("qmd", "vsearch").supported).toBe(false);
    expect(defaultProviderResolver("qmd", "vsearch").reason).toContain("capability 'vsearch' is not implemented");
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
});
