import { describe, expect, test, afterAll, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    ].join("\n"))).toThrow("https (plain http is loopback-only)");
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
    expect(refused.stderr).toContain("https (plain http is loopback-only)");

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
