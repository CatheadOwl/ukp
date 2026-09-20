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
  for (const handle of started) handle.stopAll();
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
    expect(partial.stdout).toContain("skipped:  notes");
    expect(partial.stdout).toContain("name 'notes' already bound to https://elsewhere.example/notes");
    expect(partial.stdout).toContain("re-register this endpoint with --name <handle> to land it under another");
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

describe("naming residence (W11 / ADR-REM-007 / D-086)", () => {
  test("--name lands a different handle; declared name becomes provenance everywhere", async () => {
    const { info } = startDoor();
    const result = await asResult(executeRegisterCommand(["--url", `${info.url}/notes`, "--name", "ali-notes"], context));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("imported: ali-notes  (declares notes;");
    const bindings = readRegistry(registryPath);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.name).toBe("ali-notes");
    expect(bindings[0]!.declared_name).toBe("notes");
    // N-5: the url path segment stays the door-declared name — the door
    // routes by it; only the local handle differs.
    expect(bindings[0]!.url).toBe(`${info.url}/notes`);

    const list = await asResult(executeListCommand([], context));
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain(`ali-notes (declares notes)\t${info.url}/notes\tsearch`);
    // Drift accounts by declared names: notes IS imported (as ali-notes);
    // only archive counts as unimported.
    expect(list.stderr).toContain(`door ${info.url}: 1 unimported endpoint(s): archive`);
    expect(list.stderr).not.toContain("unimported endpoint(s): notes");

    const search = await asResult(executeSearchCommand(["fixture-cad-search-token", "--endpoint", "ali-notes"], context));
    expect(search.exitCode).toBe(0);
    expect(search.stdout).toContain("read: ukp read ukp://ali-notes/documents/cad-notes.md#L1");

    // The rg face re-anchors the same way: server-declared ukp_uri must
    // resolve under the local handle.
    const rg = await asResult(executeRgCommand(["CAD", "--endpoint", "ali-notes"], context));
    expect(rg.exitCode).toBe(0);
    expect(rg.stdout).toContain("uri: ukp://ali-notes/documents/cad-notes.md");
  });

  test("day-2 without --name refreshes the tracked instance under its existing handle", async () => {
    const { info } = startDoor();
    await asResult(executeRegisterCommand(["--url", `${info.url}/notes`, "--name", "ali-notes"], context));
    const again = await asResult(executeRegisterCommand(["--url", `${info.url}/notes`], context));
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("refreshed: ali-notes");
    const bindings = readRegistry(registryPath);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.name).toBe("ali-notes");
    expect(bindings[0]!.declared_name).toBe("notes");
  });

  test("an explicitly different --name for a tracked instance is refused with the existing handle", async () => {
    const { info } = startDoor();
    await asResult(executeRegisterCommand(["--url", `${info.url}/notes`, "--name", "ali-notes"], context));
    const refused = await asResult(executeRegisterCommand(["--url", `${info.url}/notes`, "--name", "other-notes"], context));
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toContain("already bound to 'ali-notes'; unregister it to change the handle");
    expect(readRegistry(registryPath)).toHaveLength(1);

    // Explicit means explicit: --name equal to the DECLARED name but not the
    // existing handle is still a rename attempt, not a default gesture.
    const renegade = await asResult(executeRegisterCommand(["--url", `${info.url}/notes`, "--name", "notes"], context));
    expect(renegade.exitCode).toBe(1);
    expect(renegade.stdout).toContain("already bound to 'ali-notes'; unregister it to change the handle");
  });

  test("a taken name is the --name remedy path: skip line names it, --name then lands", async () => {
    const { info } = startDoor();
    registerAt(registryPath, "notes", createService("local-notes-svc", "notes"));
    const skipped = await asResult(executeRegisterCommand(["--url", `${info.url}/notes`], context));
    expect(skipped.exitCode).toBe(1);
    expect(skipped.stdout).toContain("re-register this endpoint with --name <handle> to land it under another");

    const landed = await asResult(executeRegisterCommand(["--url", `${info.url}/notes`, "--name", "ali-notes"], context));
    expect(landed.exitCode).toBe(0);
    expect(readRegistry(registryPath).map((binding) => binding.name).sort()).toEqual(["ali-notes", "notes"]);
  });

  test("--name is a usage error for multi-endpoint imports and for local registration", async () => {
    const { info } = startDoor();
    const multi = await asResult(executeRegisterCommand(["--url", info.url, "--name", "x"], context));
    expect(multi.exitCode).toBe(2);
    expect(multi.stderr).toContain("--name applies to a single endpoint, but this import targets 2");
    expect(readRegistry(registryPath)).toHaveLength(0);

    const localOutcome = executeRegisterCommand(["--name", "x"], context);
    const local = localOutcome instanceof Promise ? await localOutcome : localOutcome;
    expect(local.exitCode).toBe(2);
    expect(local.stderr).toContain("--name chooses a remote registration handle and requires --url");
  });

  test("--endpoint stays an assertion on the DECLARED name when --name renames the handle", async () => {
    const { info } = startDoor();
    // Positive: the assertion matches the declared name alongside a rename.
    const ok = await asResult(
      executeRegisterCommand(["--url", `${info.url}/notes`, "--endpoint", "notes", "--name", "ali-notes"], context),
    );
    expect(ok.exitCode).toBe(0);
    expect(readRegistry(registryPath).map((binding) => [binding.name, binding.declared_name]))
      .toEqual([["ali-notes", "notes"]]);

    // Negative: asserting the HANDLE (not the declared name) fails.
    const assertedHandle = await asResult(executeRegisterCommand(["--url", info.url, "--endpoint", "ali-notes"], context));
    expect(assertedHandle.exitCode).toBe(1);
    expect(assertedHandle.stderr).toContain(`no such endpoint 'ali-notes' on door ${info.url} (available: archive, notes)`);
  });

  test("single-endpoint (non-door) registration: --name output, idempotent re-register, refusal", async () => {
    registerAt(serverRegistryPath, "skills", createService("w11-skills-svc", "skills"));
    const single = startUkpServer({
      endpointName: "skills",
      currentDirectory: root,
      registryPath: serverRegistryPath,
      qmdCommand,
      port: 0,
    });
    started.push(single);
    const named = await asResult(executeRegisterCommand(["--url", single.info.url, "--name", "ali-skills"], context));
    expect(named.exitCode).toBe(0);
    expect(named.stdout).toContain("registered (remote): ali-skills");
    expect(named.stdout).toContain("declares: skills (remote-declared name, stored as provenance)");
    expect(readRegistry(registryPath).map((binding) => [binding.name, binding.declared_name]))
      .toEqual([["ali-skills", "skills"]]);

    // Default-gesture day-2 refresh lands under the existing handle.
    const again = await asResult(executeRegisterCommand(["--url", single.info.url], context));
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("registered (remote): ali-skills");
    expect(readRegistry(registryPath)).toHaveLength(1);

    const refused = await asResult(executeRegisterCommand(["--url", single.info.url, "--name", "pi-skills"], context));
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("already registered as 'ali-skills'");

    const renegade = await asResult(executeRegisterCommand(["--url", single.info.url, "--name", "skills"], context));
    expect(renegade.exitCode).toBe(1);
    expect(renegade.stderr).toContain("already registered as 'ali-skills'");
  });

  test("drift notes split free vs taken names; taken names point at the --name remedy", async () => {
    const { info } = startDoor();
    registerAt(registryPath, "notes", createService("w11-drift-local-notes", "notes"));
    await asResult(executeRegisterCommand(["--url", `${info.url}/archive`], context));
    const list = await asResult(executeListCommand([], context));
    expect(list.exitCode).toBe(0);
    // `notes` is unimported only because the name is held locally: the note
    // must not suggest the bulk import (it would skip again) — the single
    // endpoint --name form is the remedy. (The shared server registry may
    // serve extra endpoints; only `notes`'s classification matters here.)
    expect(list.stderr).toContain(
      `door ${info.url}: name(s) taken: notes — import under another handle: 'ukp register --url ${info.url}/<name> --name <handle>'`,
    );
    expect(list.stderr).not.toContain("unimported endpoint(s): notes");
  });

  test("one service under two handles (different urls, same instance_uid) notes in list", async () => {
    const { info } = startDoor();
    await asResult(executeRegisterCommand(["--url", `${info.url}/notes`, "--name", "ali-notes"], context));
    const uid = readRegistry(registryPath).find((binding) => binding.name === "ali-notes")!.instance_uid;
    registerRemoteAt(registryPath, { name: "mirror-notes", url: "https://mirror.example/notes", declared_name: "notes", instance_uid: uid });

    const list = await asResult(executeListCommand([], context));
    expect(list.exitCode).toBe(0);
    expect(list.stderr).toContain("'ali-notes' and 'mirror-notes' pin the same instance_uid");
    expect(list.stderr).toContain("one service under two handles");
    // The declared annotation survives row degradation (unreachable mirror).
    expect(list.stdout).toContain("mirror-notes (declares notes)\t");
    expect(list.stdout).toContain("(unavailable)");
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

  test("cmd.exe host (Windows OpenSSH): the %OS% pre-probe selects the cmd form directly, no pty", async () => {
    const cmdRegistry = join(root, "wake-cmd-server-registry.toml");
    registerAt(cmdRegistry, "notes", createService("wake-cmd-notes-svc", "notes"));
    const logPath = join(root, "fake-ssh-cmd.log");
    rmSync(logPath, { force: true });
    // --shell cmd: the fake sshd answers the family pre-probe with
    // Windows_NT, so the first wake attempt already carries the pinned cmd
    // form without -tt (pty sessions lose quoted commands on at least one
    // Win32-OpenSSH 9.5 build — the real-machine finding behind this).
    const sshCommand = [
      process.execPath,
      join(import.meta.dir, "helpers", "fake-ssh.mjs"),
      "--log", logPath,
      "--registry", cmdRegistry,
      "--shell", "cmd",
    ];
    const binding = { name: "notes", kind: "remote" as const, url: "ssh://wake-cmd-host/notes" };
    const transport = await openRemoteTransport(binding, { sshCommand });
    try {
      const fetched = await fetchDiscoveryDocument(binding, transport);
      expect(fetched.doc.name).toBe("notes");
      expect(fetched.doc.protocol).toBe("ukp-remote");
    } finally {
      transport.close();
    }
    // One wake tunnel, first attempt, cmd form.
    const log = readFileSync(logPath, "utf8").trim().split("\n");
    expect(log.length).toBe(1);
    // The cmd allowlist contract, byte-for-byte modulo the port: Windows-
    // shaped PATH prefix (bun official, scoop, npm user prefix) + the door.
    // The `set "PATH=…"` quoting is load-bearing (an unquoted set breaks on
    // '&' inside the expanded PATH) and survives the sshd double-cmd layer.
    expect(log[0]).toMatch(
      / wake=cmd \/d \/c "set "PATH=%USERPROFILE%\\\.bun\\bin;%USERPROFILE%\\scoop\\shims;%APPDATA%\\npm;%PATH%"&&ukp serve --allow-anonymous --host 127\.0\.0\.1 --port \d+ --max-idle 60"$/,
    );
  }, 20_000);

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
    // Two spawns: the `%OS%` family pre-probe (no -L, no pty) and the wake
    // client — still no bare `-N` master, no mux trio.
    expect(dumps.length).toBe(2);
    const probe = dumps.find((args) => args.includes("echo %OS%"));
    expect(probe).toBeDefined();
    expect(probe).not.toContain("-tt");
    const wakeClient = dumps.find((args) => args.some((arg) => arg.startsWith("sh -c ") && arg.includes("ukp serve ")));
    expect(wakeClient).toBeDefined();
    expect(wakeClient).not.toContain("-N");
    expect(wakeClient).not.toContain("ControlMaster");
    expect(wakeClient!.some((arg) => arg.startsWith("127.0.0.1:"))).toBe(true);
  }, 20_000);

  afterEach(() => {
    // The Tier 1 tests spoof process.platform (the mux gate is the only
    // platform dependence and the flow runs entirely against fakes); restore
    // here, not in per-test finally — a test timeout must not leak the spoof.
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });
});
