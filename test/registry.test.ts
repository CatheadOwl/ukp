import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hostname, tmpdir } from "node:os";
import { readRegistry, registerAt, registerRemoteBinding, serializeRegistry, unregisterAt, parseRegistry, RegistryError } from "../src/registry.ts";

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
    const absPath = resolve("/cad");
    const encoded = serializeRegistry([{ name: "cad", path: absPath }]);
    expect(parseRegistry(encoded)).toEqual([{ name: "cad", path: absPath }]);
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

describe("remote binding naming residence (W11 / ADR-REM-007 / D-086)", () => {
  test("declared_name round-trips on remote bindings; locals reject it", () => {
    const remote = { name: "ali-notes", kind: "remote" as const, url: "https://ali.example/notes", declared_name: "notes", instance_uid: "u-1" };
    expect(parseRegistry(serializeRegistry([remote]))).toEqual([remote]);

    const source = `
[[endpoints]]
name = "cad"
path = "${resolve("/cad").replaceAll("\\", "\\\\")}"
declared_name = "cad"
`;
    expect(() => parseRegistry(source)).toThrow("must not carry remote fields");
  });

  test("an invalid declared_name is rejected at parse time", () => {
    const source = `
[[endpoints]]
name = "ali-notes"
kind = "remote"
url = "https://ali.example/notes"
declared_name = "Not_A_Valid_Name"
instance_uid = "u-1"
`;
    expect(() => parseRegistry(source)).toThrow("invalid declared name");
  });

  test("idempotency keys on url+declared name and refreshes under the EXISTING handle", () => {
    const tracked = { name: "ali-notes", kind: "remote" as const, url: "https://ali.example/notes", declared_name: "notes", instance_uid: "u-1" };
    // Default gesture (handle = declared name): refresh keeps ali-notes.
    const refreshed = registerRemoteBinding([tracked], {
      name: "notes", kind: "remote", url: "https://ali.example/notes", declared_name: "notes", instance_uid: "u-2",
    });
    expect(refreshed).toEqual([{ ...tracked, instance_uid: "u-2" }]);
  });

  test("an explicitly different handle for a tracked url is refused; the taken-name error names --name", () => {
    const tracked = { name: "ali-notes", kind: "remote" as const, url: "https://ali.example/notes", declared_name: "notes", instance_uid: "u-1" };
    expect(() => registerRemoteBinding([tracked], {
      name: "other-notes", kind: "remote", url: "https://ali.example/notes", declared_name: "notes", instance_uid: "u-2",
    })).toThrow("already registered as 'ali-notes'");

    expect(() => registerRemoteBinding([tracked], {
      name: "ali-notes", kind: "remote", url: "https://pi.example/notes", declared_name: "notes", instance_uid: "u-3",
    })).toThrow("already bound");
    try {
      registerRemoteBinding([tracked], { name: "ali-notes", kind: "remote", url: "https://pi.example/notes", declared_name: "notes" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("register this endpoint under another handle with --name <handle>");
    }
  });

  test("a declared-name drift at the same url refuses and points at re-registration", () => {
    const tracked = { name: "ali-notes", kind: "remote" as const, url: "https://ali.example/notes", declared_name: "notes", instance_uid: "u-1" };
    expect(() => registerRemoteBinding([tracked], {
      name: "ali-notes", kind: "remote", url: "https://ali.example/notes", declared_name: "journal", instance_uid: "u-2",
    })).toThrow("now declares 'journal'");
  });

  test("a legacy binding (no declared_name) refreshes and backfills the declared name", () => {
    const legacy = { name: "notes", kind: "remote" as const, url: "https://ali.example/notes", instance_uid: "u-1" };
    const refreshed = registerRemoteBinding([legacy], {
      name: "notes", kind: "remote", url: "https://ali.example/notes", declared_name: "notes", instance_uid: "u-2",
    });
    expect(refreshed).toEqual([{ ...legacy, declared_name: "notes", instance_uid: "u-2" }]);
  });
});
