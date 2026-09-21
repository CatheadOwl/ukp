import { describe, expect, test, afterAll, afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  assertRemoteUrlAllowed,
  parseRemoteUrl,
  parseSshUrl,
  readRegistry,
  registerAt,
  registerRemoteAt,
  serializeRegistry,
  unregisterAt,
} from "../../src/registry.ts";
import { startUkpServer, type StartedServe } from "../../src/server.ts";
import {
  executeListCommand,
  executeRegisterCommand,
} from "../../src/commands/inventory.ts";
import { executeSearchCommand } from "../../src/commands/search.ts";
import { executeReadCommand } from "../../src/commands/read.ts";
import { executeRgCommand } from "../../src/commands/rg.ts";
import { createQmdFixtureCopy } from "../helpers/qmd-fixture.ts";
import { openRemoteTransport, fetchDiscoveryDocument } from "../../src/capabilities/remote-client.ts";

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
    expect(list.stdout).toMatch(new RegExp(`^ali-notes \\(declares notes\\)[ ]{2,}${info.url}/notes[ ]{2,}search$`, "m"));
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
      `door ${info.url}: name(s) taken: notes - import under another handle: 'ukp register --url ${info.url}/<name> --name <handle>'`,
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
    expect(list.stdout).toMatch(/^mirror-notes \(declares notes\)[ ]{2,}https:\/\/mirror\.example\/notes[ ]{2,}\(unavailable\)$/m);
    expect(list.stdout).toContain("(unavailable)");
  });
});

describe("day-2 through the door (byte-identical remote usage)", () => {
  test("list stays flat, search/read/rg work through door bindings", async () => {
    const { info } = startDoor();
    await asResult(executeRegisterCommand(["--url", info.url], context));

    const list = await asResult(executeListCommand([], context));
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toMatch(new RegExp(`^notes[ ]{2,}${info.url}/notes[ ]{2,}search$`, "m"));
    expect(list.stdout).toMatch(new RegExp(`^archive[ ]{2,}${info.url}/archive[ ]{2,}search$`, "m"));
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
      `door ${info.url}: 1 unimported endpoint(s): pi-dev - run 'ukp register --url ${info.url}' to import`,
    );
    // Rows keep the flat shape; nothing about the registered rows changed.
    expect(drifted.stdout).toMatch(new RegExp(`^notes[ ]{2,}${info.url}/notes[ ]{2,}search$`, "m"));

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
      join(import.meta.dir, "..", "helpers", "fake-ssh.mjs"),
      "--log", logPath,
      "--registry", poolingServerRegistry,
    ];
    const origin = "ssh://fake-door";

    const registered = await asResult(executeRegisterCommand(["--url", origin], { ...context, sshCommand }));
    expect(registered.exitCode).toBe(0);
    expect(registered.stdout).toContain(`door ${origin}: 2 endpoint(s)`);

    const listed = await asResult(executeListCommand([], { ...context, sshCommand }));
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toMatch(new RegExp(`^notes[ ]{2,}${origin}/notes[ ]{2,}search$`, "m"));
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
      join(import.meta.dir, "..", "helpers", "fake-ssh.mjs"),
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
      join(import.meta.dir, "..", "helpers", "fake-ssh.mjs"),
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
      join(import.meta.dir, "..", "helpers", "fake-ssh.mjs"),
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
  }, 20_000);

  test("Tier 1 on win32: no master spawn, no mux options in the wake client", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const wakeRegistry = join(root, "mux-win-registry.toml");
    registerAt(wakeRegistry, "notes", createService("mux-win-svc", "notes"));
    const dumpPath = join(root, "mux-win-dump.jsonl");
    rmSync(dumpPath, { force: true });
    const sshCommand = [
      process.execPath,
      join(import.meta.dir, "..", "helpers", "fake-ssh.mjs"),
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

describe("W1 responsiveness (ukp_list / ADR 0026 rules 1-2): fan-out, bounded connect, shell cache", () => {
  test("fan-out: origins start together — overlapped probe journals, one tunnel per origin, stdout keeps registry order", async () => {
    // Two doors on two origins, one endpoint each. The journal shim
    // (helpers/journal-ssh.mjs) wraps the fake ssh and records every
    // invocation's start/end in real time; its configuration rides in its
    // own argv (own-flags idiom), not env — on win32 Bun.spawn children do
    // not inherit runtime process.env mutations, verified live while
    // writing this test.
    const serverA = join(root, "fanout-a-server-registry.toml");
    const serverB = join(root, "fanout-b-server-registry.toml");
    registerAt(serverA, "delta", createService("fanout-delta-svc", "delta"));
    registerAt(serverB, "gamma", createService("fanout-gamma-svc", "gamma"));
    const clientRegistry = join(root, "fanout-client-registry.toml");
    const journalPath = join(root, "fanout-journal.jsonl");
    const logA = join(root, "fanout-a.log");
    const logB = join(root, "fanout-b.log");
    const inner = (registry: string, log: string): string[] => [
      process.execPath,
      join(import.meta.dir, "..", "helpers", "fake-ssh.mjs"),
      "--registry", registry,
      "--log", log,
    ];
    const sshCommand = [
      process.execPath,
      join(import.meta.dir, "..", "helpers", "journal-ssh.mjs"),
      "--journal", journalPath,
      "--inner", JSON.stringify({
        "fanout-a-host": inner(serverA, logA),
        "fanout-b-host": inner(serverB, logB),
      }),
    ];

    // Interleaved ledger — locals alpha/zeta around the remotes delta/gamma
    // in the file; since W2 the printed order is locals-first (each group in
    // name-sorted registry order), so the assertion pins exactly that split.
    // Bindings land via direct writes (register --url would spend two full
    // door-wake cycles on machine-warming this ledger and the budget
    // belongs to the list).
    registerAt(clientRegistry, "alpha", createService("fanout-alpha-svc", "alpha"));
    registerRemoteAt(clientRegistry, { name: "delta", url: "ssh://fanout-a-host/delta", instance_uid: "fanout-delta-uid" });
    registerAt(clientRegistry, "zeta", createService("fanout-zeta-svc", "zeta"));
    registerRemoteAt(clientRegistry, { name: "gamma", url: "ssh://fanout-b-host/gamma", instance_uid: "fanout-gamma-uid" });

    // A fresh journal, per-origin logs, and no shell-family cache: the list
    // must probe each origin once, and those probes are the overlap anchor.
    for (const file of [journalPath, logA, logB, join(root, "wake-shell.toml")]) rmSync(file, { force: true });
    const listed = await asResult(executeListCommand([], {
      currentDirectory: root,
      registryPath: clientRegistry,
      sshCommand,
    }));
    expect(listed.exitCode).toBe(0);
    // Locals-first is the printed order since W2 (the one agent-visible
    // change of that slice); each group keeps registry (name-sorted) order.
    const handles = listed.stdout.split("\n").slice(1).map((line) => line.trim().split(/\s{2,}/)[0]);
    expect([...handles].sort()).toEqual(readRegistry(clientRegistry).map((binding) => binding.name).sort());
    expect(handles).toEqual(["alpha", "zeta", "delta", "gamma"]);
    // One spawned tunnel per origin (each row + that origin's drift check
    // converged on the pool's single open promise).
    expect(readFileSync(logA, "utf8").trim().split("\n").length).toBe(1);
    expect(readFileSync(logB, "utf8").trim().split("\n").length).toBe(1);

    // THE fan-out anchor, from start lines only (end lines are racy: a
    // killed wrapper never writes one): both origins' probes started before
    // EITHER origin's wake began. A serial caller cannot produce this — it
    // finishes origin A entirely (probe, wake, door ready) before origin B's
    // first ssh ever spawns, so B's probe would land after A's wake.
    interface JournalEntry { pid: number; phase: string; argv?: string[] }
    const journal = readFileSync(journalPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as JournalEntry);
    const isProbeStart = (entry: JournalEntry) =>
      entry.phase === "start" && entry.argv !== undefined && entry.argv.includes("echo %OS%");
    const isWakeStart = (entry: JournalEntry) =>
      entry.phase === "start" && entry.argv !== undefined && entry.argv.some((arg) => arg.includes("ukp serve"));
    expect(journal.filter(isProbeStart).length).toBe(2);
    expect(journal.filter(isWakeStart).length).toBe(2);
    const lastProbeStart = Math.max(...journal.map((entry, index) => isProbeStart(entry) ? index : -1));
    const firstWakeStart = Math.min(...journal.map((entry, index) => isWakeStart(entry) ? index : journal.length));
    expect(lastProbeStart).toBeLessThan(firstWakeStart);
  }, 40_000);

  test("bounded connect: every spawned ssh carries ConnectTimeout (default 10s; UKP_SSH_CONNECT_TIMEOUT_MS overrides)", async () => {
    const boundServerRegistry = join(root, "bound-server-registry.toml");
    registerAt(boundServerRegistry, "notes", createService("bound-notes-svc", "notes"));
    const clientRegistry = join(root, "bound-client-registry.toml");
    const dumpPath = join(root, "bound-fake-ssh.jsonl");
    rmSync(dumpPath, { force: true });
    const sshCommand = [
      process.execPath,
      join(import.meta.dir, "..", "helpers", "fake-ssh.mjs"),
      "--dump", dumpPath,
      "--registry", boundServerRegistry,
    ];
    const binding = { name: "notes", kind: "remote" as const, url: "ssh://bound-host/notes" };

    const transport = await openRemoteTransport(binding, { sshCommand, registryPath: clientRegistry });
    try {
      const fetched = await fetchDiscoveryDocument(binding, transport);
      expect(fetched.doc.name).toBe("notes");
    } finally {
      transport.close();
    }
    // Every spawn site (shell probe, wake client, and the Tier-1 mux master
    // where the platform allows it) carries the bound — that is the whole
    // point: no UKP-spawned ssh may wait out the OS TCP timeout. The dump
    // lines are raw argv JSON, so assert the exact element: a substring
    // check would let "ConnectTimeout=1" hide inside "ConnectTimeout=10".
    let argvs = readFileSync(dumpPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(argvs.length).toBeGreaterThan(0);
    for (const argv of argvs) expect(argv).toContain("ConnectTimeout=10");

    const dumpPathOverride = join(root, "bound-fake-ssh-override.jsonl");
    rmSync(dumpPathOverride, { force: true });
    const sshCommandOverride = [
      process.execPath,
      join(import.meta.dir, "..", "helpers", "fake-ssh.mjs"),
      "--dump", dumpPathOverride,
      "--registry", boundServerRegistry,
    ];
    const previous = process.env.UKP_SSH_CONNECT_TIMEOUT_MS;
    process.env.UKP_SSH_CONNECT_TIMEOUT_MS = "1500";
    try {
      const second = await openRemoteTransport(binding, { sshCommand: sshCommandOverride, registryPath: clientRegistry });
      try {
        const fetched = await fetchDiscoveryDocument(binding, second);
        expect(fetched.doc.name).toBe("notes");
      } finally {
        second.close();
      }
    } finally {
      if (previous === undefined) delete process.env.UKP_SSH_CONNECT_TIMEOUT_MS;
      else process.env.UKP_SSH_CONNECT_TIMEOUT_MS = previous;
    }
    const overrideLines = readFileSync(dumpPathOverride, "utf8").trim().split("\n");
    expect(overrideLines.length).toBeGreaterThan(0);
    const overrideArgvs = overrideLines.map((line) => JSON.parse(line) as string[]);
    for (const argv of overrideArgvs) expect(argv).toContain("ConnectTimeout=1");
  }, 30_000);

  test("shell-family cache (L-1): the second invocation skips the %OS% probe; a stale entry costs one ladder attempt and self-heals", async () => {
    const cacheServerRegistry = join(root, "shell-cache-server-registry.toml");
    registerAt(cacheServerRegistry, "notes", createService("shell-cache-notes-svc", "notes"));
    const clientRegistry = join(root, "shell-cache-client-registry.toml");
    const dumpPath = join(root, "shell-cache-fake-ssh.jsonl");
    rmSync(dumpPath, { force: true });
    const sshCommand = [
      process.execPath,
      join(import.meta.dir, "..", "helpers", "fake-ssh.mjs"),
      "--dump", dumpPath,
      "--registry", cacheServerRegistry,
    ];
    const binding = { name: "notes", kind: "remote" as const, url: "ssh://cache-host/notes" };
    // The cache lives beside whatever registry the caller carries — all test
    // registries share one temp dir, so assert by key, never by whole-file
    // equality (other tests' targets may ride in the same file).
    const cachePath = join(root, "wake-shell.toml");
    const probeLines = () => readFileSync(dumpPath, "utf8").split("\n").filter((line) => line.includes("echo %OS%")).length;
    const wakeLines = () => readFileSync(dumpPath, "utf8").split("\n").filter((line) => line.includes("ukp serve")).length;
    const cachedForm = () =>
      (parseToml(readFileSync(cachePath, "utf8")) as { shells?: Record<string, unknown> }).shells?.["cache-host"];

    // First invocation: no cache — one probe, one wake, the form persists.
    const first = await openRemoteTransport(binding, { sshCommand, registryPath: clientRegistry });
    try {
      await fetchDiscoveryDocument(binding, first);
    } finally {
      first.close();
    }
    expect(probeLines()).toBe(1);
    expect(wakeLines()).toBe(1);
    expect(cachedForm()).toBe("posix");

    // Second invocation: cache hit — the probe never runs, the wake works.
    const second = await openRemoteTransport(binding, { sshCommand, registryPath: clientRegistry });
    try {
      await fetchDiscoveryDocument(binding, second);
    } finally {
      second.close();
    }
    expect(probeLines()).toBe(1);
    expect(wakeLines()).toBe(2);

    // Stale entry (host reinstalled under a different shell): the cache's
    // lie is used without a probe, the first wake is rejected, the ladder
    // flips, and the WORKING form is written back — cache loses time,
    // never correctness.
    const current = parseToml(readFileSync(cachePath, "utf8")) as { shells?: Record<string, unknown> };
    writeFileSync(
      cachePath,
      stringifyToml({ shells: { ...current.shells, "cache-host": "cmd" } }),
      "utf8",
    );
    const third = await openRemoteTransport(binding, { sshCommand, registryPath: clientRegistry });
    try {
      await fetchDiscoveryDocument(binding, third);
    } finally {
      third.close();
    }
    expect(probeLines()).toBe(1);
    expect(wakeLines()).toBe(4);
    expect(cachedForm()).toBe("posix");
  }, 40_000);

  test("dead origin: each row degrades under its own name (no sibling leak through the shared ladder), exit stays 0", async () => {
    // An ssh that dies instantly, like a real ssh against an unreachable
    // host after ConnectTimeout: no forward, no diagnostics of any
    // recognized class — the ladder exhausts quickly and the origin
    // degrades. Two same-origin bindings pin the fan-out failure shape:
    // both rows share the origin's ONE rejected ladder, so a warning that
    // embedded the first acquirer's endpoint label would leak it into the
    // sibling's warning (the review finding that removed endpoint labels
    // from transport messages — the target is origin-level fact).
    const deadSsh = join(root, "fake-ssh-dead.mjs");
    writeFileSync(
      deadSsh,
      `console.error("ssh: connect to host 'dead-host' port 22: Connection timed out");\nprocess.exit(255);\n`,
      "utf8",
    );
    const clientRegistry = join(root, "dead-client-registry.toml");
    registerAt(clientRegistry, "alpha", createService("dead-alpha-svc", "alpha"));
    registerRemoteAt(clientRegistry, { name: "delta", url: "ssh://dead-host/delta", instance_uid: "dead-delta-uid" });
    registerRemoteAt(clientRegistry, { name: "gamma", url: "ssh://dead-host/gamma", instance_uid: "dead-gamma-uid" });

    const listed = await asResult(executeListCommand([], {
      currentDirectory: root,
      registryPath: clientRegistry,
      sshCommand: [process.execPath, deadSsh],
    }));
    expect(listed.exitCode).toBe(0);
    const handles = listed.stdout.split("\n").slice(1).map((line) => line.trim().split(/\s{2,}/)[0]);
    expect(handles).toEqual(["alpha", "delta", "gamma"]);
    expect(listed.stdout).toMatch(/^delta\s+ssh:\/\/dead-host\/delta\s+\(unavailable\)$/m);
    expect(listed.stdout).toMatch(/^gamma\s+ssh:\/\/dead-host\/gamma\s+\(unavailable\)$/m);
    const warnings = listed.stderr.split("\n");
    const deltaWarning = warnings.find((line) => line.startsWith("endpoint 'delta'"));
    const gammaWarning = warnings.find((line) => line.startsWith("endpoint 'gamma'"));
    expect(deltaWarning).toContain("waking the ukp door on 'dead-host' failed");
    expect(gammaWarning).toContain("waking the ukp door on 'dead-host' failed");
    expect(deltaWarning).not.toContain("gamma");
    expect(gammaWarning).not.toContain("delta");
  }, 20_000);
});

describe("W2 streaming (ukp_list / ADR 0026 rule 3): locals-first, line-by-line, TTY-gated progress", () => {
  test("header + local rows flush before any network; remote rows append in order; streamed text equals the returned text", async () => {
    // A loopback door on its OWN server registry (the shared one grows as
    // other tests exercise door drift) — no ssh, fetches are fast, so
    // ordering is asserted from the emission sequence, not the wall clock.
    const streamServerRegistry = join(root, "stream-server-registry.toml");
    registerAt(streamServerRegistry, "notes", createService("stream-notes-svc", "notes"));
    registerAt(streamServerRegistry, "archive", createService("stream-archive-svc", "archive"));
    const { info } = startDoor({ registryPath: streamServerRegistry });
    const clientRegistry = join(root, "stream-client-registry.toml");
    registerAt(clientRegistry, "alpha", createService("stream-alpha-svc", "alpha"));
    registerAt(clientRegistry, "zeta", createService("stream-zeta-svc", "zeta"));
    const registered = await asResult(executeRegisterCommand(["--url", info.url], { currentDirectory: root, registryPath: clientRegistry }));
    expect(registered.exitCode).toBe(0);
    // A dead loopback binding rides along (connection refused, instant): the
    // streaming path must also carry degraded remotes — `(unavailable)` row
    // in order plus its stderr warning after the table.
    registerRemoteAt(clientRegistry, { name: "a-dead", url: "http://127.0.0.1:1/a-dead", instance_uid: "stream-dead-uid" });

    const emitted: string[] = [];
    const progressFrames: string[] = [];
    const pending = executeListCommand([], {
      currentDirectory: root,
      registryPath: clientRegistry,
      emitStdout: (line) => { emitted.push(line); },
      emitProgress: (frame) => { progressFrames.push(frame); },
    });
    // THE streaming contract, deterministic without any sleep: the command
    // runs synchronously up to its first await, and by design that point
    // sits AFTER the local flush and BEFORE any network work — remote rows
    // cannot have been emitted yet, and the first progress frame is out.
    expect(emitted[0]).toContain("capabilities on every endpoint:");
    const localFlush = emitted.join("\n");
    expect(localFlush).toContain("alpha");
    expect(localFlush).toContain("zeta");
    expect(localFlush).not.toContain("archive");
    expect(localFlush).not.toContain("notes");
    expect(localFlush).not.toContain("a-dead");
    expect(progressFrames).toEqual(["fetching 3 remote endpoint(s)..."]);

    const listed = await asResult(pending);
    expect(listed.exitCode).toBe(0);
    // Streamed delivery: the channel already carried the output, so the
    // returned stdout is empty (writeCommandResult's falsy check then
    // skips the final print — no double emission).
    expect(listed.stdout).toBe("");
    const handles = emitted.slice(1).map((line) => line.trim().split(/\s{2,}/)[0]);
    // Locals-first, then remotes in name-sorted registry order — the dead
    // binding degrades inline, not out of order.
    expect(handles).toEqual(["alpha", "zeta", "a-dead", "archive", "notes"]);
    expect(emitted.find((line) => line.startsWith("a-dead"))).toContain("(unavailable)");
    // Warnings ride stderr after the table (grouped with the rows:
    // locals, then remotes). The warning quotes the REGISTERED binding url
    // — the wire route (`/e/<name>` prefix) the transport actually fetched
    // never reaches the reader.
    expect(listed.stderr).toContain("endpoint 'a-dead' declared capabilities unavailable");
    expect(listed.stderr).toContain("http://127.0.0.1:1/a-dead");
    expect(listed.stderr).not.toContain("/e/");
    // Streamed stdout lines never carry control characters (progress rides
    // the stderr channel only)…
    for (const line of emitted) expect(line).not.toMatch(/[\r\x1b]/);
    // …the first frame announces the count, the final frame clears the
    // line, and THE INTERLOCK holds: every remote row's flush cleared the
    // frame before emitting (a frame without a trailing \n would otherwise
    // let the row print beside it, and the next \r overwrite the row's
    // head — the Windows Terminal dogfood finding that added the
    // clear-before-flush rule).
    expect(progressFrames[0]).toBe("fetching 3 remote endpoint(s)...");
    expect(progressFrames.filter((frame) => /^\r *\r$/.test(frame)).length).toBe(3);
    expect(progressFrames.filter((frame) => frame.startsWith("\rfetching")).length).toBe(2);
    expect(progressFrames[progressFrames.length - 1]).toMatch(/^\r +\r$/);

    // Byte-equality: the un-injected form (tests, non-streaming callers)
    // returns exactly what the stream delivered, in the same locals-first
    // order.
    const piped = await asResult(executeListCommand([], { currentDirectory: root, registryPath: clientRegistry }));
    expect(piped.exitCode).toBe(0);
    expect(piped.stdout).toBe(emitted.join("\n"));
    expect(piped.stderr).toBe(listed.stderr);

    // Virtual terminal: both channels feed ONE surface, \r modeled as
    // cursor return with in-place overwrite (tail preserved — the exact
    // corruption semantics). After the interlock, no rendered line mixes a
    // table row with progress fragments or overwritten tails.
    const rendered: string[] = [""];
    let column = 0;
    const write = (text: string) => {
      for (const character of text) {
        const last = rendered.length - 1;
        if (character === "\r") {
          column = 0;
          continue;
        }
        if (character === "\n") {
          rendered.push("");
          column = 0;
          continue;
        }
        rendered[last] = rendered[last].slice(0, column) + character + rendered[last].slice(column + 1);
        column += 1;
      }
    };
    const vt = await asResult(executeListCommand([], {
      currentDirectory: root,
      registryPath: clientRegistry,
      emitStdout: (line) => write(`${line}\n`),
      emitProgress: write,
    }));
    expect(vt.exitCode).toBe(0);
    for (const line of rendered) {
      const carriesRow = line.includes("ssh://") || line.includes("http://") || line.includes("capabilities on every endpoint");
      const carriesFrame = line.includes("fetching");
      expect(carriesRow && carriesFrame).toBe(false);
    }
    expect(rendered.filter((line) => line.includes("archive")).length).toBe(1);
    expect(rendered.some((line) => line.trim() === "")).toBe(true); // cleared frame row ends blank
  }, 20_000);
});
