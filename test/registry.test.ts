import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { readRegistry, registerAt, serializeRegistry, unregisterAt, parseRegistry, RegistryError } from "../src/registry.ts";

function tempRegistry() {
  const root = mkdtempSync(join(tmpdir(), "ukp-registry-"));
  const service = join(root, "service");
  mkdirSync(service);
  return { root, service, registry: join(root, "registry.toml") };
}

describe("Registry", () => {
  test("missing registry is a logical empty registry", () => {
    const { registry } = tempRegistry();
    expect(readRegistry(registry)).toEqual([]);
  });

  test("serializes and parses canonical empty and non-empty states", () => {
    expect(serializeRegistry([])).toContain("endpoints = []");
    const encoded = serializeRegistry([{ name: "cad", path: "C:/cad" }]);
    expect(parseRegistry(encoded)).toEqual([{ name: "cad", path: "C:/cad" }]);
  });

  test("register is idempotent and rejects both conflict dimensions", () => {
    const { registry, service } = tempRegistry();
    const first = registerAt(registry, "cad", service);
    expect(first).toHaveLength(1);
    expect(registerAt(registry, "cad", service)).toEqual(first);
    expect(() => registerAt(registry, "other", service)).toThrow("already bound");
    const otherService = join(dirname(registry), "other-service");
    mkdirSync(otherService);
    expect(() => registerAt(registry, "cad", otherService)).toThrow("already bound");
  });

  test("unregister writes empty registry and keeps a backup", () => {
    const { registry, service } = tempRegistry();
    registerAt(registry, "cad", service);
    unregisterAt(registry, "cad");
    expect(readRegistry(registry)).toEqual([]);
    expect(readFileSync(registry, "utf8")).toContain("endpoints = []");
    expect(existsSync(`${registry}.bak`)).toBe(true);
    expect(() => unregisterAt(registry, "missing")).toThrow(RegistryError);
  });

  test("existing empty registry is invalid", () => {
    const { registry } = tempRegistry();
    writeFileSync(registry, "\n");
    expect(() => readRegistry(registry)).toThrow("Registry is empty");
  });

  test("reclaims only a safely identifiable stale lock", () => {
    const { registry, service } = tempRegistry();
    writeFileSync(
      `${registry}.lock`,
      `pid = 2147483647\nhostname = ${JSON.stringify(hostname())}\ncreated_at = \"2000-01-01T00:00:00.000Z\"\ntoken = \"stale-fixture\"\n`,
    );
    expect(registerAt(registry, "cad", service)).toHaveLength(1);
    expect(existsSync(`${registry}.lock`)).toBe(false);
  });
});
