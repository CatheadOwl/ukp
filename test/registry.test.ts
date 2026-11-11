import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hostname, tmpdir } from "node:os";
import { readRegistry, registerAt, rebindAt, rebindBinding, registerRemoteBinding, serializeRegistry, unregisterAt, parseRegistry, parseRemoteUrl, assertRegistrableRemoteUrl, assertRemoteUrlAllowed, RegistryError } from "../src/registry.ts";

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

  test("serializes remote bindings credentials-last (INV-12 canonical field order)", () => {
    // A fully-loaded remote row must serialize in the canonical order:
    // routing/provenance first, then the credential block with the pin
    // last — eye-scan and redaction both cut at one place
    // (configuration-contracts canonical serialization form).
    const encoded = serializeRegistry([{
      name: "notes",
      kind: "remote",
      url: "https://ali.example",
      declared_name: "notes",
      instance_uid: "6f1c2b3a-1111-4000-8000-000000000000",
      token: "t0",
      tls_cert: "-----BEGIN CERTIFICATE-----",
      tls_pin: "sha256/AAAA",
    }]);
    const keys = [
      "name =",
      "kind =",
      "url =",
      "declared_name =",
      "instance_uid =",
      "token =",
      "tls_cert =",
      "tls_pin =",
    ];
    const positions = keys.map((key) => encoded.indexOf(key));
    for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(encoded.trimEnd().endsWith('tls_pin = "sha256/AAAA"')).toBe(true);
  });

  test("token_ref is the store-pointer residence (ADR-REM-013): serializes, round-trips, stays exclusive", () => {
    const encoded = serializeRegistry([{
      name: "notes",
      kind: "remote",
      url: "https://ali.example",
      instance_uid: "6f1c2b3a-1111-4000-8000-000000000001",
      token_ref: "os-store",
    }]);
    expect(encoded).toContain('token_ref = "os-store"');
    const back = parseRegistry(encoded);
    expect(back[0]!.token_ref).toBe("os-store");
    expect(back[0]!.token).toBeUndefined();
    // inline and store residences are mutually exclusive (INV-11)
    expect(() => serializeRegistry([{
      name: "notes",
      kind: "remote",
      url: "https://ali.example",
      instance_uid: "6f1c2b3a-1111-4000-8000-000000000002",
      token: "t0",
      token_ref: "os-store",
    }])).toThrow("mutually exclusive");
    // locals must not carry the pointer either (field-bleed, INV-11)
    const localSource = `
[[endpoints]]
name = "cad"
path = "${resolve("/cad").replaceAll("\\", "\\\\")}"
token_ref = "os-store"
`;
    expect(() => parseRegistry(localSource)).toThrow("must not carry remote fields");
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

  test("rebind relocates a local binding in one step and refuses everything else", () => {
    const { registry, service } = tempRegistry();
    registerAt(registry, "cad", service);
    const moved = join(dirname(registry), "moved-service");
    mkdirSync(moved);
    const rebound = rebindAt(registry, "cad", moved);
    expect(rebound).toEqual([{ name: "cad", path: realpathSync(moved) }]);
    // Same-path rebind is the idempotent no-op.
    expect(rebindAt(registry, "cad", moved)).toEqual(rebound);
    // An unbound name has nothing to rebind.
    expect(() => rebindAt(registry, "ghost", moved)).toThrow("nothing to rebind");
    // A location owned by another name is not reachable through --rebind.
    registerAt(registry, "other", service);
    expect(() => rebindAt(registry, "other", moved)).toThrow("already bound to 'cad'");
    // A remote-held name keeps the unregister path; --rebind never crosses kinds.
    expect(() => rebindBinding(
      [{ name: "notes", kind: "remote", url: "https://ali.example/notes", declared_name: "notes", instance_uid: "u" }],
      { name: "notes", path: moved },
    )).toThrow("remote url");
    // The plain same-name refusal carries the recovery path (spec L140 closure).
    const second = join(dirname(registry), "second-service");
    mkdirSync(second);
    expect(() => registerAt(registry, "cad", second)).toThrow("--rebind");
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

describe("registration-only ssh port admission (D-089)", () => {
  test("parse-time url surfaces stay permissive for legacy ported ssh urls", () => {
    // Call-time parsing must keep accepting W4–W8 resident-door-era bindings
    // (e.g. the owner's ssh://ali:8571): only intake rejects the port.
    expect(parseRemoteUrl("ssh://ali:8571")?.port).toBe(8571);
    expect(parseRemoteUrl("ssh://ali:8571/notes")?.endpointName).toBe("notes");
    expect(() => assertRemoteUrlAllowed("ssh://ali:8571")).not.toThrow();
  });

  test("registration rejects an explicit ssh port — any value, with or without a path", () => {
    for (const url of ["ssh://ali:8571", "ssh://ali:8570", "ssh://ali:22", "ssh://user@ali:2222/notes"]) {
      expect(() => assertRegistrableRemoteUrl(url)).toThrow("ssh:// urls take no port");
    }
    // Ports stay meaningful for the other schemes, and a portless ssh url
    // (with or without the door-endpoint path) is the admissible form.
    expect(() => assertRegistrableRemoteUrl("https://kb.example.com:8570")).not.toThrow();
    expect(() => assertRegistrableRemoteUrl("http://127.0.0.1:8080")).not.toThrow();
    expect(() => assertRegistrableRemoteUrl("ssh://ali")).not.toThrow();
    expect(() => assertRegistrableRemoteUrl("ssh://ali/notes")).not.toThrow();
    expect(() => assertRegistrableRemoteUrl("ssh://user@ali")).not.toThrow();
  });

  test("registerRemoteBinding enforces the rule at the API seam; legacy disk state stays loadable", () => {
    const { registry } = tempRegistry();
    // The registry never gains a NEW ported ssh binding, direct API included.
    expect(() =>
      registerRemoteBinding([], { name: "ali-notes", kind: "remote", url: "ssh://ali:8571" })
    ).toThrow("ssh:// urls take no port");
    // A legacy binding already on disk still loads (validateBindings uses the
    // permissive parse-time admission).
    const legacy = [
      'endpoints = [',
      '  { name = "ali-notes", kind = "remote", url = "ssh://ali:8571", instance_uid = "6f1c2b3a-1111-4000-8000-000000000000" },',
      ']',
    ].join("\n");
    writeFileSync(registry, legacy, "utf8");
    const loaded = readRegistry(registry);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].url).toBe("ssh://ali:8571");
  });
});
