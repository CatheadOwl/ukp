import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveScope, ScopeError, type RegistryBinding } from "../src/scope.ts";

const registry: RegistryBinding[] = [
  { name: "cad", path: "C:/services/cad" },
  { name: "mem0", path: "C:/services/mem0" },
];

function workspace(config?: string): string {
  const root = mkdtempSync(join(tmpdir(), "ukp-scope-"));
  mkdirSync(join(root, "workspace", ".ukp"), { recursive: true });
  if (config !== undefined) writeFileSync(join(root, "workspace", ".ukp", "client.toml"), config);
  return root;
}

describe("Client scope resolution", () => {
  test("explicit endpoints completely override client defaults", () => {
    const root = workspace("default_endpoints = [\"mem0\"]\n");
    try {
      const result = resolveScope({ currentDirectory: join(root, "workspace"), registry, explicitEndpoints: ["cad"] });
      expect(result.source).toBe("explicit");
      expect(result.bindings.map((binding) => binding.name)).toEqual(["cad"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nearest client config wins and dangling defaults warn", () => {
    const root = workspace("default_endpoints = [\"cad\", \"gone\"]\n");
    try {
      const result = resolveScope({ currentDirectory: join(root, "workspace", "child"), registry });
      expect(result.source).toBe("client-config");
      expect(result.configPath).toBe(join(root, "workspace", ".ukp", "client.toml"));
      expect(result.bindings.map((binding) => binding.name)).toEqual(["cad"]);
      expect(result.dangling).toEqual([
        { name: "gone", configPath: join(root, "workspace", ".ukp", "client.toml"), index: 1 },
      ]);
      expect(result.warnings).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a folder that declares both Client and Service roles", () => {
    const root = workspace("default_endpoints = [\"cad\"]\n");
    writeFileSync(
      join(root, "workspace", ".ukp", "service.toml"),
      "[capabilities.search]\nprovider = \"qmd\"\n",
    );
    try {
      expect(() => resolveScope({ currentDirectory: join(root, "workspace"), registry }))
        .toThrow("Folder role conflict");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no client config falls back to all registry bindings", () => {
    const root = workspace();
    try {
      const result = resolveScope({ currentDirectory: join(root, "workspace"), registry });
      expect(result.source).toBe("registry-fallback");
      expect(result.bindings).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("explicit endpoint scope and global scope conflict", () => {
    const root = workspace();
    try {
      expect(() => resolveScope({
        currentDirectory: root,
        registry,
        explicitEndpoints: ["cad"],
        global: true,
      })).toThrow("explicit endpoint scope and global scope cannot be used together");
      expect(() => resolveScope({ currentDirectory: root, registry, explicitEndpoints: ["cad"], global: true }))
        .toThrow(ScopeError);
      expect(() => resolveScope({ currentDirectory: root, registry, explicitEndpoints: ["gone"] })).toThrow("unknown endpoint");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
