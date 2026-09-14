import { describe, expect, test, afterAll, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseRegistry,
  readRegistry,
  registerAt,
  registerRemoteAt,
  serializeRegistry,
  unregisterAt,
} from "../src/registry.ts";
import { startUkpServer, type StartedServe } from "../src/server.ts";
import { executeListCommand, executeRegisterCommand } from "../src/commands/inventory.ts";
import { executeSearchCommand } from "../src/commands/search.ts";
import { executeReadCommand } from "../src/commands/read.ts";
import { createQmdFixtureCopy } from "./helpers/qmd-fixture.ts";

// ukp_remote W2 client-side tests. The "remote" is real: startUkpServer (the
// W1 product surface) serves a fixture endpoint out of the SERVER-side
// registry, while the client-side registry is a separate file that only ever
// holds remote bindings — the realistic two-machine topology (name
// uniqueness applies per registry, so both sides legitimately call the
// endpoint "serve-fixture").

const nodeExecutable = Bun.which("node") ?? process.execPath;
const root = mkdtempSync(join(tmpdir(), "ukp-remote-client-"));
const serverRegistryPath = join(root, "server-registry.toml");
const registryPath = join(root, "client-registry.toml");
const fixture = createQmdFixtureCopy("remote-client");
const qmdCommand = [nodeExecutable, join(fixture, "qmd-fixture.mjs")];

const serviceFolder = (() => {
  const folder = join(root, "remote-svc");
  mkdirSync(join(folder, ".ukp"), { recursive: true });
  mkdirSync(join(folder, "documents"), { recursive: true });
  writeFileSync(
    join(folder, ".ukp", "service.toml"),
    'name = "serve-fixture"\n\n[capabilities.search]\nprovider = "qmd"\n',
    "utf8",
  );
  writeFileSync(join(folder, "documents", "cad-notes.md"), "# CAD notes\n\nCAD fixture note content.\n", "utf8");
  return folder;
})();
registerAt(serverRegistryPath, "serve-fixture", serviceFolder);

// A second served endpoint whose fixture results live OUTSIDE the Service
// folder (provider "outside-result" branch): the server declares no ukp_uri
// for them, exercising the remote no-direct-read handoff (RQ-09).
const outsideFolder = (() => {
  const folder = join(root, "outside-result-svc");
  mkdirSync(join(folder, ".ukp"), { recursive: true });
  writeFileSync(join(root, "outside.md"), "# Outside note\n", "utf8");
  writeFileSync(
    join(folder, ".ukp", "service.toml"),
    'name = "outside-endpoint"\n\n[capabilities.search]\nprovider = "qmd"\n',
    "utf8",
  );
  return folder;
})();
registerAt(serverRegistryPath, "outside-endpoint", outsideFolder);

const started: StartedServe[] = [];
function startRemote(overrides: Partial<Parameters<typeof startUkpServer>[0]> = {}): StartedServe {
  const handle = startUkpServer({
    endpointName: "serve-fixture",
    currentDirectory: root,
    registryPath: serverRegistryPath,
    qmdCommand,
    port: 0,
    ...overrides,
  });
  started.push(handle);
  return handle;
}

async function asResult(value: unknown): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (value instanceof Promise) return value;
  throw new Error("expected the async remote path");
}

function registerLocal(name: string, folder: string): void {
  registerAt(registryPath, name, folder);
}

beforeEach(() => {
  for (const binding of readRegistry(registryPath)) {
    unregisterAt(registryPath, binding.name);
  }
});

afterAll(() => {
  for (const { server } of started) server.stop(true);
  rmSync(root, { recursive: true, force: true });
  rmSync(fixture, { recursive: true, force: true });
});

describe("registry remote bindings (D-077)", () => {
  test("parses, validates, and round-trips remote bindings; locals stay byte-identical", () => {
    const source = [
      "[[endpoints]]",
      'name = "cad"',
      'path = "C:/abs/cad"',
      "",
      "[[endpoints]]",
      'name = "cad-remote"',
      'kind = "remote"',
      'url = "https://host.example:8570"',
      'instance_uid = "0b0c0d0e-1111-2222-3333-444455556666"',
      "",
    ].join("\n");
    const bindings = parseRegistry(source);
    expect(bindings[0]).toEqual({ name: "cad", path: "C:/abs/cad" });
    expect(bindings[1]).toEqual({
      name: "cad-remote",
      kind: "remote",
      url: "https://host.example:8570",
      instance_uid: "0b0c0d0e-1111-2222-3333-444455556666",
    });
    const encoded = serializeRegistry(bindings);
    expect(encoded).toContain('kind = "remote"');
    expect(parseRegistry(encoded)).toEqual(bindings);
  });

  test("rejects field bleed and non-https non-loopback urls", () => {
    expect(() => parseRegistry([
      "[[endpoints]]",
      'name = "bad"',
      'kind = "remote"',
      'url = "https://x.example"',
      'path = "C:/abs"',
      "",
    ].join("\n"))).toThrow("must not carry a local path");
    expect(() => parseRegistry([
      "[[endpoints]]",
      'name = "bad"',
      'kind = "remote"',
      'url = "http://lan-host:8570"',
      "",
    ].join("\n"))).toThrow("must be https, ssh://host[:port], or loopback http");
    expect(() => parseRegistry([
      "[[endpoints]]",
      'name = "bad"',
      'path = "C:/abs"',
      'url = "https://x.example"',
      "",
    ].join("\n"))).toThrow("must not carry remote fields");
  });

  test("registerRemoteBinding: same name+url refreshes the TOFU pin; conflicts reject", () => {
    const first = registerRemoteAt(registryPath, { name: "rem", url: "http://127.0.0.1:9000", instance_uid: "a" });
    expect(first.find((b) => b.name === "rem")?.instance_uid).toBe("a");
    const refreshed = registerRemoteAt(registryPath, { name: "rem", url: "http://127.0.0.1:9000", instance_uid: "b" });
    expect(refreshed.find((b) => b.name === "rem")?.instance_uid).toBe("b");
    expect(() => registerRemoteAt(registryPath, { name: "rem", url: "http://127.0.0.1:9001" })).toThrow("already bound");
    registerLocal("keep-local", serviceFolder);
    expect(() => registerRemoteAt(registryPath, { name: "keep-local", url: "http://127.0.0.1:9002" })).toThrow("already bound");
  });
});

describe("W4 transparent transport + stored token (D-078)", () => {
  test("binding token round-trips; local bindings reject it", () => {
    const bindings = parseRegistry([
      "[[endpoints]]",
      'name = "cad-remote"',
      'kind = "remote"',
      'url = "ssh://ali:8570"',
      'instance_uid = "0b0c0d0e-1111-2222-3333-444455556666"',
      'token = "s3cret"',
      "",
    ].join("\n"));
    expect(bindings[0]?.token).toBe("s3cret");
    expect(parseRegistry(serializeRegistry(bindings))).toEqual(bindings);
    expect(() => parseRegistry([
      "[[endpoints]]",
      'name = "bad"',
      'path = "C:/abs"',
      'token = "s3cret"',
      "",
    ].join("\n"))).toThrow("must not carry remote fields");
  });

  test("resolveRemoteToken: env wins over the stored binding token", async () => {
    const { resolveRemoteToken } = await import("../src/capabilities/remote-client.ts");
    const binding = { name: "ali-test", kind: "remote" as const, url: "ssh://ali:8570", token: "stored" };
    delete process.env.UKP_ENDPOINT_ALI_TEST_TOKEN;
    expect(resolveRemoteToken(binding)).toBe("stored");
    process.env.UKP_ENDPOINT_ALI_TEST_TOKEN = "from-env";
    try {
      expect(resolveRemoteToken(binding)).toBe("from-env");
    } finally {
      delete process.env.UKP_ENDPOINT_ALI_TEST_TOKEN;
    }
  });

  test("parseSshUrl: host[:port] with default 8570; rejects junk", async () => {
    const { parseSshUrl } = await import("../src/registry.ts");
    expect(parseSshUrl("ssh://ali")).toEqual({ host: "ali", port: 8570 });
    expect(parseSshUrl("ssh://ali:9443")).toEqual({ host: "ali", port: 9443 });
    expect(parseSshUrl("http://ali")).toBeUndefined();
    expect(parseSshUrl("ssh://ali:0")).toBeUndefined();
  });

  test("register --token stores the credential in the binding", async () => {
    const { info } = startRemote({ tokens: ["stored-token"] });
    const result = await asResult(executeRegisterCommand(["--url", info.url, "--token", "stored-token"], {
      currentDirectory: root,
      registryPath,
    }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("token stored in registry binding");
    const binding = readRegistry(registryPath).find((b) => b.name === "serve-fixture");
    expect(binding?.token).toBe("stored-token");
    // Stored token authorizes without any env var.
    delete process.env.UKP_ENDPOINT_SERVE_FIXTURE_TOKEN;
    const search = await asResult(executeSearchCommand(["fixture-cad-search-token", "-c", "serve-fixture"], {
      currentDirectory: root,
      registryPath,
      qmdCommand,
    }));
    expect(search.exitCode).toBe(0);
    expect(search.stdout).toContain("read: ukp read ukp://serve-fixture/documents/cad-notes.md#L1");
  });

  test("openRemoteTransport returns the url base directly for http bindings", async () => {
    const { openRemoteTransport } = await import("../src/capabilities/remote-client.ts");
    const handle = await openRemoteTransport({ name: "x", kind: "remote", url: "http://127.0.0.1:18575/" });
    expect(handle.base).toBe("http://127.0.0.1:18575");
    expect(() => handle.close()).not.toThrow();
  });
});

describe("ukp register --url", () => {
  test("registers a remote endpoint with the discovery-declared name and TOFU pin", async () => {
    const { info } = startRemote();
    const result = await asResult(executeRegisterCommand(["--url", info.url], {
      currentDirectory: root,
      registryPath,
    }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("registered (remote): serve-fixture");
    expect(result.stdout).toContain(`url: ${info.url}`);
    const binding = readRegistry(registryPath).find((b) => b.name === "serve-fixture");
    expect(binding?.kind).toBe("remote");
    expect(binding?.url).toBe(info.url);
    expect(binding?.instance_uid).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("refuses plain http on a non-loopback host and reports unreachable services", async () => {
    const refused = await asResult(executeRegisterCommand(["--url", "http://192.168.1.9:8570"], {
      currentDirectory: root,
      registryPath,
    }));
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("must be https, ssh://host[:port], or loopback http");

    const unreachable = await asResult(executeRegisterCommand(["--url", "http://127.0.0.1:9"], {
      currentDirectory: root,
      registryPath,
    }));
    expect(unreachable.exitCode).toBe(1);
    expect(unreachable.stderr).toContain("ukp register:");
  });
});

describe("remote search (mixed driver)", () => {
  test("human output carries uri-based read lines from the server references", async () => {
    const { info } = startRemote();
    registerRemoteAt(registryPath, { name: "serve-fixture", url: info.url });
    const result = await asResult(executeSearchCommand(["fixture-cad-search-token", "-c", "serve-fixture"], {
      currentDirectory: root,
      registryPath,
      qmdCommand,
    }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("== serve-fixture ==");
    expect(result.stdout).toContain("CAD fixture note");
    expect(result.stdout).toContain("read: ukp read ukp://serve-fixture/documents/cad-notes.md#L1");
    expect(result.stdout).not.toContain("read: ukp read --endpoint serve-fixture");
  });

  test("results without a server-declared ukp_uri have no remote read route (RQ-09)", async () => {
    const { info } = startRemote({ endpointName: "outside-endpoint" });
    registerRemoteAt(registryPath, { name: "outside-endpoint", url: info.url });
    const result = await asResult(executeSearchCommand(["fixture-cad-search-token", "-c", "outside-endpoint"], {
      currentDirectory: root,
      registryPath,
      qmdCommand,
    }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Outside fixture note");
    expect(result.stdout).toContain("(no direct read — provider-managed result)");
    expect(result.stdout).not.toContain("read: ukp read --endpoint outside-endpoint");
  });

  test("a remote endpoint without search declared skips with a visible reason (ali dogfood finding)", async () => {
    // A served endpoint that declares only propose: search must skip cleanly
    // with the reason on stderr — not a silent exit 1 (found on the real
    // cross-machine ali test, 2026-09-13).
    const plainFolder = join(root, "plain-svc");
    mkdirSync(join(plainFolder, ".ukp"), { recursive: true });
    writeFileSync(
      join(plainFolder, ".ukp", "service.toml"),
      'name = "plain-endpoint"\n\n[capabilities.propose]\nprovider = "file"\n',
      "utf8",
    );
    registerAt(serverRegistryPath, "plain-endpoint", plainFolder);
    const { info } = startRemote({ endpointName: "plain-endpoint" });
    registerRemoteAt(registryPath, { name: "plain-endpoint", url: info.url });
    const result = await asResult(executeSearchCommand(["anything", "-c", "plain-endpoint"], {
      currentDirectory: root,
      registryPath,
      qmdCommand,
    }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("plain-endpoint");
    expect(result.stderr).toContain("declares no search capability");
  });

  test("aggregates a failed remote endpoint with exit 1 and preserves other endpoints", async () => {
    const { info } = startRemote();
    registerRemoteAt(registryPath, { name: "serve-fixture", url: info.url });
    registerRemoteAt(registryPath, { name: "dead-remote", url: "http://127.0.0.1:9" });
    const result = await asResult(executeSearchCommand(
      ["fixture-cad-search-token", "-c", "serve-fixture", "-c", "dead-remote"],
      { currentDirectory: root, registryPath, qmdCommand },
    ));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("== serve-fixture ==");
    expect(result.stdout).toContain("== dead-remote ==");
  });

  test("TOFU pin mismatch warns without blocking", async () => {
    const { info } = startRemote();
    registerRemoteAt(registryPath, {
      name: "serve-fixture",
      url: info.url,
      instance_uid: "00000000-0000-0000-0000-000000000000",
    });
    const result = await asResult(executeSearchCommand(["fixture-cad-search-token", "-c", "serve-fixture"], {
      currentDirectory: root,
      registryPath,
      qmdCommand,
    }));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("identity changed");
  });

  test("bearer-token endpoint: missing token fails the remote endpoint with the env hint", async () => {
    const { info } = startRemote({ tokens: ["w2-secret"] });
    registerRemoteAt(registryPath, { name: "serve-fixture", url: info.url });
    delete process.env.UKP_ENDPOINT_SERVE_FIXTURE_TOKEN;
    const denied = await asResult(executeSearchCommand(["fixture-cad-search-token", "-c", "serve-fixture"], {
      currentDirectory: root,
      registryPath,
      qmdCommand,
    }));
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain("UKP_ENDPOINT_SERVE_FIXTURE_TOKEN");

    process.env.UKP_ENDPOINT_SERVE_FIXTURE_TOKEN = "w2-secret";
    try {
      const allowed = await asResult(executeSearchCommand(["fixture-cad-search-token", "-c", "serve-fixture"], {
        currentDirectory: root,
        registryPath,
        qmdCommand,
      }));
      expect(allowed.exitCode).toBe(0);
      expect(allowed.stdout).toContain("read: ukp read ukp://serve-fixture/documents/cad-notes.md#L1");
    } finally {
      delete process.env.UKP_ENDPOINT_SERVE_FIXTURE_TOKEN;
    }
  });
});

describe("TOFU block mode (RQ-17, UKP_TOFU=block)", () => {
  test("identity mismatch refuses search and read instead of warning", async () => {
    const { info } = startRemote();
    registerRemoteAt(registryPath, {
      name: "serve-fixture",
      url: info.url,
      instance_uid: "00000000-0000-0000-0000-000000000000",
    });
    process.env.UKP_TOFU = "block";
    try {
      const search = await asResult(executeSearchCommand(["fixture-cad-search-token", "-c", "serve-fixture"], {
        currentDirectory: root,
        registryPath,
        qmdCommand,
      }));
      expect(search.exitCode).toBe(1);
      expect(search.stderr).toContain("identity changed");
      expect(search.stderr).toContain("UKP_TOFU=block");

      const read = await asResult(executeReadCommand(["--endpoint", "serve-fixture", "documents/cad-notes.md"], {
        currentDirectory: root,
        registryPath,
        qmdCommand,
      }));
      expect(read.exitCode).toBe(1);
      expect(read.stderr).toContain("UKP_TOFU=block");
    } finally {
      delete process.env.UKP_TOFU;
    }
  });
});

describe("remote read", () => {
  test("ref and ukp:// uri reads return remote content; miss maps to resource-missing", async () => {
    const { info } = startRemote();
    registerRemoteAt(registryPath, { name: "serve-fixture", url: info.url });

    const byRef = await asResult(executeReadCommand(["--endpoint", "serve-fixture", "documents/cad-notes.md"], {
      currentDirectory: root,
      registryPath,
      qmdCommand,
    }));
    expect(byRef.exitCode).toBe(0);
    expect(byRef.stdout).toContain("# CAD notes");

    const byUri = await asResult(executeReadCommand(["ukp://serve-fixture/documents/cad-notes.md"], {
      currentDirectory: root,
      registryPath,
      qmdCommand,
    }));
    expect(byUri.exitCode).toBe(0);
    expect(byUri.stdout).toContain("# CAD notes");

    const miss = await asResult(executeReadCommand(["--endpoint", "serve-fixture", "documents/missing.md"], {
      currentDirectory: root,
      registryPath,
      qmdCommand,
    }));
    expect(miss.exitCode).toBe(1);
    expect(miss.stderr).toContain("resource-missing");

    const missJson = await asResult(executeReadCommand(
      ["--endpoint", "serve-fixture", "documents/missing.md", "--format", "json"],
      { currentDirectory: root, registryPath, qmdCommand },
    ));
    expect(missJson.stdout).toContain('"class": "resource-missing"');
  });

  test("unreachable endpoint maps to provider-unavailable; --from is local-only", async () => {
    registerRemoteAt(registryPath, { name: "dead-remote", url: "http://127.0.0.1:9" });
    const unreachable = await asResult(executeReadCommand(["--endpoint", "dead-remote", "a.md"], {
      currentDirectory: root,
      registryPath,
      qmdCommand,
    }));
    expect(unreachable.exitCode).toBe(1);
    expect(unreachable.stderr).toContain("unreachable");
    const unreachableJson = await asResult(executeReadCommand(
      ["--endpoint", "dead-remote", "a.md", "--format", "json"],
      { currentDirectory: root, registryPath, qmdCommand },
    ));
    expect(unreachableJson.stdout).toContain('"class": "provider-unavailable"');

    const { info } = startRemote();
    registerRemoteAt(registryPath, { name: "serve-fixture", url: info.url });
    const fromRef = await asResult(executeReadCommand(
      ["--endpoint", "serve-fixture", "--from", "documents/x.md", "cad-notes.md"],
      { currentDirectory: root, registryPath, qmdCommand },
    ));
    expect(fromRef.exitCode).toBe(1);
    expect(fromRef.stderr).toContain("--from document-relative references are local-only");
  });
});

describe("ukp list with remote rows", () => {
  test("remote rows show url + discovery capabilities and degrade when unreachable", async () => {
    const { info } = startRemote();
    registerRemoteAt(registryPath, { name: "serve-fixture", url: info.url });
    registerRemoteAt(registryPath, { name: "dead-remote", url: "http://127.0.0.1:9" });
    const result = await asResult(executeListCommand([], { currentDirectory: root, registryPath }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`serve-fixture\thttp://127.0.0.1:${info.port}\tsearch`);
    expect(result.stdout).toContain("dead-remote\thttp://127.0.0.1:9\t(unavailable)");
    expect(result.stderr).toContain("dead-remote");
  });
});

// ---------------------------------------------------------------------------
// W5' / D-079: self-signed TLS pinning lifecycle. Real openssl-signed certs
// (Bun.spawn bypasses shell path mangling), the real startUkpServer with TLS,
// and the real register/search adapters — the full bare-IP rehearsal path.

const opensslAvailable =
  Bun.spawnSync(["openssl", "version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

function selfSignPair(name: string, renewFromKey?: string): { certPath: string; keyPath: string } {
  const certPath = join(root, "tls", `${name}.cert.pem`);
  const keyPath = join(root, "tls", `${name}.key.pem`);
  mkdirSync(join(root, "tls"), { recursive: true });
  const argv = [
    "openssl", "req", "-x509", "-days", "3650", "-nodes",
    "-subj", "/CN=ukp-remote-tls-test",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ];
  if (renewFromKey === undefined) argv.push("-newkey", "rsa:2048", "-keyout", keyPath);
  else argv.push("-key", renewFromKey);
  argv.push("-out", certPath);
  const proc = Bun.spawnSync(argv, { stdout: "ignore", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`openssl self-sign failed for ${name} (exit ${proc.exitCode}): ${new TextDecoder().decode(proc.stderr).trim()}`);
  }
  return { certPath, keyPath };
}

describe("remote TLS identity (W5' / D-079)", () => {
  test("registry schema: tls fields pair, pin format is checked, PEM round-trips, locals reject them", async () => {
    expect(() => parseRegistry([
      "[[endpoints]]", 'name = "bad"', 'kind = "remote"', 'url = "https://x.example:8570"',
      'tls_cert = "pem"', "",
    ].join("\n"))).toThrow("must carry tls_cert and tls_pin together");
    expect(() => parseRegistry([
      "[[endpoints]]", 'name = "bad"', 'kind = "remote"', 'url = "https://x.example:8570"',
      'tls_cert = "pem"', 'tls_pin = "md5/abc"', "",
    ].join("\n"))).toThrow("Registry schema is invalid");
    expect(() => parseRegistry([
      "[[endpoints]]", 'name = "bad"', 'path = "C:/abs"', 'tls_pin = "sha256/abc="', "",
    ].join("\n"))).toThrow("must not carry remote fields");

    const { spkiPinOf } = await import("../src/capabilities/tls-identity.ts");
    const pem = [
      "-----BEGIN CERTIFICATE-----",
      "MIIBfakeCertificateBodyForRoundTrip==",
      "-----END CERTIFICATE-----",
      "",
    ].join("\n");
    const pinned = {
      name: "pinned",
      kind: "remote" as const,
      url: "https://x.example:8570",
      instance_uid: "0b0c0d0e-1111-2222-3333-444455556666",
      tls_cert: pem,
      tls_pin: "sha256/QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
    };
    const encoded = serializeRegistry([pinned]);
    expect(encoded).toContain("BEGIN CERTIFICATE");
    expect(parseRegistry(encoded)).toEqual([pinned]);
    expect(spkiPinOf).toBeDefined();
  });

  test.skipIf(!opensslAvailable)(
    "register pins a self-signed identity; renewal keeps going; identity change blocks until re-register",
    async () => {
      const { spkiPinOf } = await import("../src/capabilities/tls-identity.ts");
      const identityA = selfSignPair("a");
      const renewedA = selfSignPair("a-renewed", identityA.keyPath); // same key, new certificate
      const identityB = selfSignPair("b"); // different key = different identity
      const token = "tls-e2e-token";
      const clientContext = { currentDirectory: root, registryPath, qmdCommand };

      // Phase 1: self-signed serve + registration pins anchor + SPKI.
      const first = startRemote({
        tokens: [token],
        tls: { mode: "certificates", certPath: identityA.certPath, keyPath: identityA.keyPath },
      });
      expect(first.info.url.startsWith("https://")).toBe(true);
      const registered = await asResult(executeRegisterCommand(
        ["--url", first.info.url, "--token", token],
        { currentDirectory: root, registryPath },
      ));
      expect(registered.exitCode).toBe(0);
      expect(registered.stdout).toContain("tls: pinned sha256/");
      const pinA = spkiPinOf(readFileSync(identityA.certPath, "utf8"));
      // The stored anchor is the DER-re-encoded PEM (probe capture), so
      // compare certificates by fingerprint, not by bytes.
      const { X509Certificate } = await import("node:crypto");
      const fingerprintOf = (pem: string): string => new X509Certificate(pem).fingerprint256;
      const binding = readRegistry(registryPath).find((b) => b.name === "serve-fixture");
      expect(binding?.tls_pin).toBe(pinA);
      expect(binding?.tls_cert !== undefined && fingerprintOf(binding.tls_cert))
        .toBe(fingerprintOf(readFileSync(identityA.certPath, "utf8")));

      // Day-2: zero ceremony — verification runs inside the transport.
      const search = await asResult(executeSearchCommand(
        ["fixture-cad-search-token", "-c", "serve-fixture"],
        clientContext,
      ));
      expect(search.exitCode).toBe(0);
      expect(search.stdout).toContain("read: ukp read ukp://serve-fixture/documents/cad-notes.md#L1");
      expect(search.stderr).not.toContain("TLS identity");

      // Phase 2: certificate renewed, key kept — transparent re-anchor,
      // persisted into the registry binding.
      first.server.stop(true);
      await new Promise((resolve) => setTimeout(resolve, 150)); // let the OS release the port
      const second = startUkpServer({
        endpointName: "serve-fixture",
        currentDirectory: root,
        registryPath: serverRegistryPath,
        qmdCommand,
        host: "127.0.0.1",
        port: first.info.port,
        tokens: [token],
        tls: { mode: "certificates", certPath: renewedA.certPath, keyPath: identityA.keyPath },
      });
      started.push(second);
      const afterRenew = await asResult(executeSearchCommand(
        ["fixture-cad-search-token", "-c", "serve-fixture"],
        clientContext,
      ));
      expect(afterRenew.exitCode).toBe(0);
      const reanchoredCert = readRegistry(registryPath).find((b) => b.name === "serve-fixture")?.tls_cert;
      expect(reanchoredCert !== undefined && fingerprintOf(reanchoredCert))
        .toBe(fingerprintOf(readFileSync(renewedA.certPath, "utf8")));

      // Phase 3: different key — hard block with the pinned/got fingerprints;
      // an explicit re-register (owner-confirmed) refreshes the trust.
      second.server.stop(true);
      await new Promise((resolve) => setTimeout(resolve, 150)); // let the OS release the port
      const third = startUkpServer({
        endpointName: "serve-fixture",
        currentDirectory: root,
        registryPath: serverRegistryPath,
        qmdCommand,
        host: "127.0.0.1",
        port: first.info.port,
        tokens: [token],
        tls: { mode: "certificates", certPath: identityB.certPath, keyPath: identityB.keyPath },
      });
      started.push(third);
      const blocked = await asResult(executeSearchCommand(
        ["fixture-cad-search-token", "-c", "serve-fixture"],
        clientContext,
      ));
      expect(blocked.exitCode).toBe(1);
      expect(blocked.stderr).toContain("TLS identity changed");
      expect(blocked.stderr).toContain(pinA);

      const refreshed = await asResult(executeRegisterCommand(
        ["--url", first.info.url, "--token", token],
        { currentDirectory: root, registryPath },
      ));
      expect(refreshed.exitCode).toBe(0);
      const searchAfter = await asResult(executeSearchCommand(
        ["fixture-cad-search-token", "-c", "serve-fixture"],
        clientContext,
      ));
      expect(searchAfter.exitCode).toBe(0);
    },
  );
});
