import { describe, expect, test, afterAll, afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertRemoteUrlAllowed,
  parseRemoteUrl,
  parseSshUrl,
  readRegistry,
  registerAt,
  registerRemoteAt,
  serializeRegistry,
  unregisterAt,
} from "../src/registry.ts";
import { startUkpServer, type StartedServe } from "../src/server.ts";
import {
  executeListCommand,
  executeRegisterCommand,
} from "../src/commands/inventory.ts";
import { executeSearchCommand } from "../src/commands/search.ts";
import { executeReadCommand } from "../src/commands/read.ts";
import { executeRgCommand } from "../src/commands/rg.ts";
import { createQmdFixtureCopy } from "./helpers/qmd-fixture.ts";
import { openRemoteTransport, fetchDiscoveryDocument } from "../src/capabilities/remote-client.ts";

// ukp_remote W7 client-side tests: host door access (ADR-REM-004). The
// "remote" is a real door-mode server on loopback http (admissible by the
// D-078 admission rules): register --url imports the whole roster, day-2
// usage must be byte-identical to today's remote experience, drift shows as
// list notes, and the ssh:// pooling test drives the whole flow through a
// fake ssh binary (helpers/fake-ssh.mjs) that really forwards TCP.

const nodeExecutable = Bun.which("node") ?? process.execPath;
const root = mkdtempSync(join(tmpdir(), "ukp-host-door-"));
const serverRegistryPath = join(root, "server-registry.toml");
const registryPath = join(root, "client-registry.toml");
const fixture = createQmdFixtureCopy("host-door");
const qmdCommand = [nodeExecutable, join(fixture, "qmd-fixture.mjs")];

function createService(folderName: string, endpointName: string): string {
  const folder = join(root, folderName);
  mkdirSync(join(folder, ".ukp"), { recursive: true });
  mkdirSync(join(folder, "documents"), { recursive: true });
  writeFileSync(
    join(folder, ".ukp", "service.toml"),
    `name = "${endpointName}"\n\n[capabilities.search]\nprovider = "qmd"\n`,
    "utf8",
  );
  writeFileSync(
    join(folder, "documents", "cad-notes.md"),
    "# CAD notes\n\nCAD fixture note content.\n",
    "utf8",
  );
  return folder;
}

// The ali-shaped topology: one host, several endpoints behind one door.
registerAt(serverRegistryPath, "notes", createService("door-notes-svc", "notes"));
registerAt(serverRegistryPath, "archive", createService("door-archive-svc", "archive"));

const started: StartedServe[] = [];
function startDoor(overrides: Partial<Parameters<typeof startUkpServer>[0]> = {}): StartedServe {
  const handle = startUkpServer({
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

const context = { currentDirectory: root, registryPath, qmdCommand };

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

describe("remote url decomposition (W7 / O-3)", () => {
  test("parseRemoteUrl: door-endpoint path segment, userinfo, and canonical origin", () => {
    expect(parseRemoteUrl("ssh://ali")).toEqual({ scheme: "ssh", host: "ali", port: 8570, origin: "ssh://ali" });
    expect(parseRemoteUrl("ssh://ali:8570/notes")).toEqual({
      scheme: "ssh", host: "ali", port: 8570, endpointName: "notes", origin: "ssh://ali",
    });
    expect(parseRemoteUrl("ssh://deploy@ali:9443/notes")).toEqual({
      scheme: "ssh", user: "deploy", host: "ali", port: 9443, endpointName: "notes",
      origin: "ssh://deploy@ali:9443",
    });
    expect(parseRemoteUrl("https://kb.example.com:8570/notes")).toEqual({
      scheme: "https", host: "kb.example.com", port: 8570, endpointName: "notes",
      origin: "https://kb.example.com:8570",
    });
    expect(parseRemoteUrl("https://kb.example.com/notes")?.origin).toBe("https://kb.example.com");
    expect(parseRemoteUrl("http://127.0.0.1:9000/notes")?.endpointName).toBe("notes");
  });

  test("multi-segment paths, invalid names, and non-loopback http are inadmissible", () => {
    expect(parseRemoteUrl("ssh://ali/a/b")).toBeUndefined();
    expect(parseRemoteUrl("ssh://ali/Notes")).toBeUndefined();
    expect(parseRemoteUrl("http://10.0.0.5/notes")).toBeUndefined();
    expect(() => assertRemoteUrlAllowed("ssh://ali/a/b")).toThrow(
      "remote endpoint url path must be a single endpoint name",
    );
    expect(() => assertRemoteUrlAllowed("http://10.0.0.5")).toThrow(
      "remote endpoint url must be https, ssh://host[:port], or loopback http",
    );
  });

  test("parseSshUrl keeps its host[:port] contract and adds the path segment", () => {
    expect(parseSshUrl("ssh://ali")).toEqual({ host: "ali", port: 8570 });
    expect(parseSshUrl("ssh://ali:9443")).toEqual({ host: "ali", port: 9443 });
    expect(parseSshUrl("ssh://ali/notes")).toEqual({ host: "ali", port: 8570, endpointName: "notes" });
    expect(parseSshUrl("http://ali")).toBeUndefined();
    expect(parseSshUrl("ssh://ali:0")).toBeUndefined();
  });
});

describe("ukp register --url <door> (W7 import)", () => {
  test("one gesture imports the whole door: bindings carry url+path and TOFU pins", async () => {
    const { info } = startDoor();
    const result = await asResult(executeRegisterCommand(["--url", info.url], context));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`door ${info.url}: 2 endpoint(s)`);
    expect(result.stdout).toContain("imported: archive");
    expect(result.stdout).toContain("imported: notes");

    const bindings = readRegistry(registryPath);
    expect(bindings.map((binding) => [binding.name, binding.url])).toEqual([
      ["archive", `${info.url}/archive`],
      ["notes", `${info.url}/notes`],
    ]);
    for (const binding of bindings) {
      expect(binding.kind).toBe("remote");
      // N=1 door import is indistinguishable from a direct registration: the
      // registry gains zero concepts beyond the ordinary remote binding.
      expect(binding.instance_uid).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  test("a path segment imports exactly that endpoint through the door", async () => {
    const { info } = startDoor();
    const result = await asResult(executeRegisterCommand(["--url", `${info.url}/notes`], context));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("imported: notes");
    const bindings = readRegistry(registryPath);
    expect(bindings.map((binding) => binding.name)).toEqual(["notes"]);
    expect(bindings[0]!.url).toBe(`${info.url}/notes`);
  });

  test("--endpoint imports exactly one host-door endpoint and refuses mismatched path assertions", async () => {
    const { info } = startDoor();
    const result = await asResult(executeRegisterCommand(["--url", info.url, "--endpoint", "notes"], context));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("imported: notes");
    expect(readRegistry(registryPath).map((binding) => binding.name)).toEqual(["notes"]);

    const mismatch = await asResult(executeRegisterCommand(["--url", `${info.url}/archive`, "--endpoint", "notes"], context));
    expect(mismatch.exitCode).toBe(2);
    expect(mismatch.stderr).toContain("remote url selects endpoint 'archive', but --endpoint asserts 'notes'");
  });

  test("--select narrows; unknown names are usage errors with the door roster", async () => {
    const { info } = startDoor();
    const narrowed = await asResult(executeRegisterCommand(["--url", info.url, "--select", "notes"], context));
    expect(narrowed.exitCode).toBe(0);
    expect(readRegistry(registryPath).map((binding) => binding.name)).toEqual(["notes"]);

    const typo = await asResult(executeRegisterCommand(["--url", info.url, "--select", "notes,caad"], context));
    expect(typo.exitCode).toBe(2);
    expect(typo.stderr).toContain(`--select names not on door ${info.url}: caad (available: archive, notes)`);
    // The usage error wrote nothing.
    expect(readRegistry(registryPath).map((binding) => binding.name)).toEqual(["notes"]);
  });

  test("re-running the import is an idempotent refresh", async () => {
    const { info } = startDoor();
    await asResult(executeRegisterCommand(["--url", info.url], context));
    const again = await asResult(executeRegisterCommand(["--url", info.url], context));
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("refreshed: notes");
    expect(again.stdout).toContain("refreshed: archive");
    expect(readRegistry(registryPath).length).toBe(2);
  });

  test("name collisions are skipped with a visible reason; ≥1 success exits 0, all-skipped exits 1", async () => {
    const { info } = startDoor();
    // Pre-bind `notes` to somewhere else: the door import must refuse to
    // shadow it (RQ-14: never silently renamed) but still land the rest.
    registerRemoteAt(registryPath, { name: "notes", url: "https://elsewhere.example/notes", instance_uid: "u-1" });
    const partial = await asResult(executeRegisterCommand(["--url", info.url], context));
    expect(partial.exitCode).toBe(0);
    expect(partial.stdout).toContain("skipped:  notes  (already bound to https://elsewhere.example/notes)");
    expect(partial.stdout).toContain("imported: archive");
    expect(readRegistry(registryPath).find((binding) => binding.name === "notes")?.url)
      .toBe("https://elsewhere.example/notes");

    // All targets skipped → exit 1 (the second door endpoint also collides).
    unregisterAt(registryPath, "archive");
    registerRemoteAt(registryPath, { name: "archive", url: "https://elsewhere.example/archive", instance_uid: "u-2" });
    const allSkipped = await asResult(executeRegisterCommand(["--url", info.url], context));
    expect(allSkipped.exitCode).toBe(1);
    expect(allSkipped.stdout).toContain("skipped:  archive");
    expect(allSkipped.stdout).toContain("skipped:  notes");
  });

  test("negative: a path naming an endpoint not on the door refuses with the roster", async () => {
    const { info } = startDoor();
    const result = await asResult(executeRegisterCommand(["--url", `${info.url}/nonexistent`], context));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`no such endpoint 'nonexistent' on door ${info.url} (available: archive, notes)`);
    expect(readRegistry(registryPath).length).toBe(0);
  });

  test("old serve (no scope field) keeps today's single registration behavior", async () => {
    const single = startUkpServer({
      endpointName: "notes",
      currentDirectory: root,
      registryPath: serverRegistryPath,
      qmdCommand,
      port: 0,
    });
    started.push(single);
    const result = await asResult(executeRegisterCommand(["--url", single.info.url], context));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("registered (remote): notes");
    const binding = readRegistry(registryPath).find((candidate) => candidate.name === "notes");
    expect(binding?.url).toBe(single.info.url);
  });
});

describe("day-2 through the door (byte-identical remote usage)", () => {
  test("list stays flat, search/read/rg work through door bindings", async () => {
    const { info } = startDoor();
    await asResult(executeRegisterCommand(["--url", info.url], context));

    const list = await asResult(executeListCommand([], context));
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain(`notes\t${info.url}/notes\tsearch`);
    expect(list.stdout).toContain(`archive\t${info.url}/archive\tsearch`);
    expect(list.stderr).toBe("");

    const search = await asResult(executeSearchCommand(["fixture-cad-search-token", "--endpoint", "notes"], context));
    expect(search.exitCode).toBe(0);
    expect(search.stdout).toContain("read: ukp read ukp://notes/documents/cad-notes.md#L1");

    const read = await asResult(executeReadCommand(["ukp://notes/documents/cad-notes.md"], context));
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain("CAD fixture note content");

    const rg = await asResult(executeRgCommand(["CAD", "--endpoint", "notes"], context));
    expect(rg.exitCode).toBe(0);
    expect(rg.stdout).toContain("cad-notes.md");
  });

  test("TOFU through the door: a tampered per-endpoint pin warns at call time", async () => {
    const { info } = startDoor();
    await asResult(executeRegisterCommand(["--url", info.url], context));
    const tampered = readRegistry(registryPath).map((binding) =>
      binding.name === "notes" ? { ...binding, instance_uid: "00000000-0000-4000-8000-000000000000" } : binding,
    );
    writeFileSync(registryPath, serializeRegistry(tampered), { encoding: "utf8", mode: 0o600 });

    const read = await asResult(executeReadCommand(["ukp://notes/documents/cad-notes.md"], context));
    expect(read.exitCode).toBe(0);
    expect(read.stderr).toContain("identity changed");
    // The archive pin is untouched: pins anchor per endpoint, not per door.
    expect(read.stderr).not.toContain("archive");
  });
});

describe("door drift notes (view dynamic, ledger static)", () => {
  test("door growth shows on stderr, exit stays 0, importing resolves it", async () => {
    const { info } = startDoor();
    await asResult(executeRegisterCommand(["--url", info.url], context));

    registerAt(serverRegistryPath, "pi-dev", createService("door-pidev-svc", "pi-dev"));
    const drifted = await asResult(executeListCommand([], context));
    expect(drifted.exitCode).toBe(0);
    expect(drifted.stderr).toContain(
      `door ${info.url}: 1 unimported endpoint(s): pi-dev — run 'ukp register --url ${info.url}' to import`,
    );
    // Rows keep the flat shape; nothing about the registered rows changed.
    expect(drifted.stdout).toContain(`notes\t${info.url}/notes\tsearch`);

    const resolved = await asResult(executeRegisterCommand(["--url", info.url, "--select", "pi-dev"], context));
    expect(resolved.exitCode).toBe(0);
    expect(resolved.stdout).toContain("imported: pi-dev");
    const settled = await asResult(executeListCommand([], context));
    expect(settled.exitCode).toBe(0);
    expect(settled.stderr).toBe("");
  });

  test("an unreachable door skips its drift check silently (rows degrade on their own)", async () => {
    const door = startDoor();
    await asResult(executeRegisterCommand(["--url", door.info.url], context));
    door.server.stop(true);

    const list = await asResult(executeListCommand([], context));
    expect(list.exitCode).toBe(0);
    // No drift note — only the per-row (unavailable) degradation.
    expect(list.stderr).not.toContain("unimported");
    expect(list.stdout).toContain("(unavailable)");
  });
});

describe("ssh transport pooling (W7 / O-5) on the wake path (W9)", () => {
  test("wake spawns the door; one tunnel per origin per invocation: register=1, list(2 rows + door check)=1", async () => {
    // Own server-side registry: other tests in this file grow the shared one.
    const poolingServerRegistry = join(root, "pooling-server-registry.toml");
    registerAt(poolingServerRegistry, "notes", createService("pooling-notes-svc", "notes"));
    registerAt(poolingServerRegistry, "archive", createService("pooling-archive-svc", "archive"));
    // No pre-started door: the wake command must spawn it (fake-ssh executes
    // the pinned "ukp serve" by running a real door from this registry — the
    // --registry test seam; fake-ssh itself runs under bun so it can import
    // src/server.ts).
    const logPath = join(root, "fake-ssh.log");
    rmSync(logPath, { force: true });
    const sshCommand = [
      process.execPath,
      join(import.meta.dir, "helpers", "fake-ssh.mjs"),
      "--log", logPath,
      "--registry", poolingServerRegistry,
    ];
    const origin = "ssh://fake-door";

    const registered = await asResult(executeRegisterCommand(["--url", origin], { ...context, sshCommand }));
    expect(registered.exitCode).toBe(0);
    expect(registered.stdout).toContain(`door ${origin}: 2 endpoint(s)`);

    const listed = await asResult(executeListCommand([], { ...context, sshCommand }));
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain(`notes\t${origin}/notes\tsearch`);
    // The invocation seam, proven: two invocations, two wake tunnels — the
    // three same-origin fetches inside list (2 rows + 1 door check) shared one.
    const log = readFileSync(logPath, "utf8").trim().split("\n");
    expect(log.length).toBe(2);
    // Pin the operator-facing allowlist contract (ADR-REM-006 §4): the wake
    // command's exact shape, byte-for-byte modulo the client-chosen port.
    for (const line of log) {
      // The full pinned allowlist contract, byte-for-byte: standard-install
      // PATH prefix + the door command (client-chosen port interpolated).
      expect(line).toMatch(
        / wake=sh -c 'PATH="\$HOME\/\.bun\/bin:\$HOME\/\.npm-global\/bin:\/opt\/homebrew\/bin:\/home\/linuxbrew\/.linuxbrew\/bin:\$PATH" exec ukp serve --allow-anonymous --host 127\.0\.0\.1 --port \d+ --max-idle 60'$/,
      );
    }
  }, 20_000);
});

describe("on-demand wake (W9 / ADR-REM-006, Tier 0)", () => {
  const originalPlatform = process.platform;

  test("no pre-started door: wake brings it up and discovery answers through the forward", async () => {
    const wakeRegistry = join(root, "wake-server-registry.toml");
    registerAt(wakeRegistry, "notes", createService("wake-notes-svc", "notes"));
    const sshCommand = [
      process.execPath,
      join(import.meta.dir, "helpers", "fake-ssh.mjs"),
      "--registry", wakeRegistry,
    ];
    const binding = {
      name: "notes",
      kind: "remote" as const,
      url: "ssh://wake-host/notes",
    };
    const transport = await openRemoteTransport(binding, { sshCommand });
    try {
      const fetched = await fetchDiscoveryDocument(binding, transport);
      expect(fetched.doc.name).toBe("notes");
      expect(fetched.doc.protocol).toBe("ukp-remote");
    } finally {
      transport.close();
    }
  }, 20_000);

  test("missing ukp on the remote PATH: stderr is surfaced with the remedy hint", async () => {
    const failing = join(root, "fake-ssh-missing.mjs");
    writeFileSync(
      failing,
      `console.error("bash: line 1: ukp: command not found");\nprocess.exit(127);\n`,
      "utf8",
    );
    const binding = { name: "notes", kind: "remote" as const, url: "ssh://wake-host" };
    let message = "";
    try {
      await openRemoteTransport(binding, { sshCommand: [process.execPath, failing] });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("cannot find 'ukp'");
    expect(message).toContain("ukp on the remote PATH");
    expect(message).toContain("command not found");
  });

  test("Tier 1: a detached -N mux master precedes the wake client, which attaches only", async () => {
    // The whole flow runs against fakes, so the platform gate (win32 native
    // ssh has no ControlMaster) is spoofed to exercise the Tier-1 path on
    // every dev platform; afterEach restores unconditionally (timeout-safe).
    Object.defineProperty(process, "platform", { value: "linux" });
    const wakeRegistry = join(root, "mux-server-registry.toml");
    registerAt(wakeRegistry, "notes", createService("mux-notes-svc", "notes"));
    const dumpPath = join(root, "mux-argv-dump.jsonl");
    rmSync(dumpPath, { force: true });
    const sshCommand = [
      process.execPath,
      join(import.meta.dir, "helpers", "fake-ssh.mjs"),
      "--registry", wakeRegistry,
      "--dump", dumpPath,
    ];
    const binding = { name: "notes", kind: "remote" as const, url: "ssh://mux-host/notes" };
    const transport = await openRemoteTransport(binding, { sshCommand });
    try {
      const fetched = await fetchDiscoveryDocument(binding, transport);
      expect(fetched.doc.name).toBe("notes");
    } finally {
      transport.close();
    }
    const dumps = readFileSync(dumpPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    // The detached master: -N, BatchMode, the candidate mux trio, no wake
    // command. Found by shape, not by log order — candidate and client are
    // separate processes racing on the same journal file.
    const master = dumps.find((argv) => argv.includes("-N"));
    expect(master).toBeDefined();
    expect(master).toContain("ControlMaster=auto");
    expect(master).toContain("ControlPersist=120");
    expect(master).toContain("ControlPath=~/.ssh/ukp-cm-%r@%h-%p");
    expect(master!.some((arg) => arg.startsWith("sh -c ") && arg.includes("ukp serve "))).toBe(false);
    // The wake client: attach-only — ControlMaster=no + the shared
    // ControlPath, plus -tt (session-bound door) and the pinned door command.
    const wakeClient = dumps.find((argv) => argv.some((arg) => arg.startsWith("sh -c ") && arg.includes("ukp serve ")));
    expect(wakeClient).toBeDefined();
    expect(wakeClient).toContain("-tt");
    expect(wakeClient).toContain("ControlMaster=no");
    expect(wakeClient).not.toContain("ControlMaster=auto");
    expect(wakeClient).toContain("ControlPath=~/.ssh/ukp-cm-%r@%h-%p");
    expect(wakeClient!.some((arg) => arg.startsWith("127.0.0.1:"))).toBe(true);
  });

  test("Tier 1 on win32: no master spawn, no mux options in the wake client", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const wakeRegistry = join(root, "mux-win-registry.toml");
    registerAt(wakeRegistry, "notes", createService("mux-win-svc", "notes"));
    const dumpPath = join(root, "mux-win-dump.jsonl");
    rmSync(dumpPath, { force: true });
    const sshCommand = [
      process.execPath,
      join(import.meta.dir, "helpers", "fake-ssh.mjs"),
      "--registry", wakeRegistry,
      "--dump", dumpPath,
    ];
    const binding = { name: "notes", kind: "remote" as const, url: "ssh://mux-win-host/notes" };
    const transport = await openRemoteTransport(binding, { sshCommand });
    try {
      const fetched = await fetchDiscoveryDocument(binding, transport);
      expect(fetched.doc.name).toBe("notes");
    } finally {
      transport.close();
    }
    const dumps = readFileSync(dumpPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    // Exactly one spawn (the wake client) — no bare `-N` master, no mux trio.
    expect(dumps.length).toBe(1);
    expect(dumps[0]).not.toContain("-N");
    expect(dumps[0]).not.toContain("ControlMaster");
    expect(dumps[0].some((arg) => arg.startsWith("sh -c ") && arg.includes("ukp serve "))).toBe(true);
  }, 20_000);

  afterEach(() => {
    // The Tier 1 tests spoof process.platform (the mux gate is the only
    // platform dependence and the flow runs entirely against fakes); restore
    // here, not in per-test finally — a test timeout must not leak the spoof.
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });
});
