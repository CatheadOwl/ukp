import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { binAvailable } from "./helpers/bin-probe.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerAt } from "../src/registry.ts";
import { startUkpServer, type StartedServe } from "../src/server.ts";
import { runServeCommand } from "../src/commands/serve.ts";
import {
  appendTokenLine,
  mintTokenFileKey,
  parseTokenFileText,
  storeTokenFile,
} from "../src/plumbing/token-file.ts";

/** W16 / ADR-REM-015: the owner-side door faces against a live door —
 * status assembles the live roster (well-known) with machine-home facts
 * (token summary, task vs manual deployment), and share validates against
 * the roster, mints through the token-add path, and emits the paste-ready
 * register command with the raw key embedded exactly once. */

const root = mkdtempSync(join(tmpdir(), "ukp-serve-owner-"));
const registryPath = join(root, "registry.toml");
const homeDir = join(root, "home");

function createService(folderName: string, endpointName: string): string {
  const folder = join(root, folderName);
  mkdirSync(join(folder, ".ukp"), { recursive: true });
  mkdirSync(join(folder, "documents"), { recursive: true });
  writeFileSync(
    join(folder, ".ukp", "service.toml"),
    `name = "${endpointName}"\n\n[capabilities]\n`,
    "utf8",
  );
  writeFileSync(join(folder, "documents", "note.md"), "# note\n\nowner-face fixture content.\n", "utf8");
  return folder;
}

registerAt(registryPath, "notes", createService("notes-svc", "notes"));
registerAt(registryPath, "cad", createService("cad-svc", "cad"));
registerAt(registryPath, "writer", createService("writer-svc", "writer"));

function tokenFileWith(keys: Array<{ label: string; scopes: string }>): string {
  const path = join(homeDir, ".ukp", "tokens");
  let text = "";
  for (const key of keys) text = appendTokenLine(text, mintTokenFileKey(key.label, key.scopes).line);
  storeTokenFile(path, text);
  return path;
}

const started: StartedServe[] = [];
function startDoor(overrides: Partial<Parameters<typeof startUkpServer>[0]> = {}): StartedServe {
  const handle = startUkpServer({
    currentDirectory: root,
    registryPath,
    port: 0,
    ...overrides,
  });
  started.push(handle);
  return handle;
}

const context = { currentDirectory: root, registryPath, homeDir };
const doorPort = (door: StartedServe): string => new URL(door.info.url).port;

afterAll(() => {
  for (const handle of started) handle.stopAll();
  rmSync(root, { recursive: true, force: true });
});

describe("ukp serve status (W16 / ADR-REM-015)", () => {
  test("up door: live roster, select width vs the registry, token summary, manual deployment", async () => {
    const path = tokenFileWith([{ label: "liku", scopes: "notes:ro" }]);
    const door = startDoor({ tokenFilePath: path });
    const result = await runServeCommand(["status", "--port", doorPort(door)], context);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `door: up at http://127.0.0.1:${doorPort(door)} - 3 endpoint(s) on the roster: cad, notes, writer`,
    );
    expect(result.stdout).toContain(
      "select: the roster serves every registered endpoint (3) - no hidden names",
    );
    expect(result.stdout).toContain(`tokens: 1 key(s) at ${path} - labels: liku`);
    expect(result.stdout).toContain(`deployment: manual (no print-task artifacts in ${join(homeDir, ".ukp")})`);
    expect(result.stdout).not.toContain("tls:");
  });

  test("a subset door names the hidden registered endpoints (the roster is the truth, not the process)", async () => {
    const path = tokenFileWith([{ label: "liku", scopes: "notes:ro" }]);
    const door = startDoor({ tokenFilePath: path, select: ["notes"] });
    const result = await runServeCommand(["status", "--port", doorPort(door)], context);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("- 1 endpoint(s) on the roster: notes");
    expect(result.stdout).toContain(
      "select: the roster hides 2 registered endpoint(s): cad, writer (a subset door's whitelist is fixed at start - restart to change it)",
    );
    // Pure select scenario: the hidden names are healthy, so ONLY the subset
    // line renders — the door-skip line must not ride along (N1).
    expect(result.stdout).not.toContain("skipped by the door");
  });

  // Learnability N1 (2026-11-14): hidden-∧-healthy is select exclusion, but
  // hidden-∧-broken is the door skipping the binding (manifest unreadable or
  // name drift) — two causes, two lines; the subset phrase must not cover
  // for a broken binding.
  test("a door-skipped binding gets its own roster line with a reason, not the subset phrase (learnability N1)", async () => {
    const brokenRegistry = join(root, "n1-broken-registry.toml");
    registerAt(brokenRegistry, "notes", createService("n1-notes-svc", "notes"));
    registerAt(brokenRegistry, "cad", createService("n1-cad-svc", "cad"));
    registerAt(brokenRegistry, "writer", createService("n1-writer-svc", "writer"));
    const ghost = createService("n1-ghost-svc", "ghost");
    registerAt(brokenRegistry, "ghost", ghost);
    // Break the manifest AFTER registration: the binding stays, but the
    // door's fresh per-request manifest read throws, so the door omits it.
    rmSync(join(ghost, ".ukp", "service.toml"), { force: true });
    const path = tokenFileWith([{ label: "liku", scopes: "notes:ro" }]);
    const door = startDoor({ registryPath: brokenRegistry, tokenFilePath: path });
    const result = await runServeCommand(
      ["status", "--port", doorPort(door)],
      { currentDirectory: root, registryPath: brokenRegistry, homeDir },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("- 3 endpoint(s) on the roster: cad, notes, writer");
    expect(result.stdout).toContain(
      "roster: 1 registered endpoint(s) skipped by the door (binding unreadable or name drift)",
    );
    // The per-name reason rides the line: the loadManifest failure headline,
    // the same sentence the door's serve-side stderr note carries.
    expect(result.stdout).toContain("ghost (no Service manifest in this folder");
    expect(result.stdout).toContain("'ukp list' shows the same row degradation");
    expect(result.stdout).not.toContain("whitelist is fixed at start");
    expect(result.stdout).not.toContain("the roster serves every registered endpoint");
  });

  test("a down door is named on stdout but exits 1 (report text stays, exit code carries health)", async () => {
    const path = tokenFileWith([{ label: "liku", scopes: "notes:ro" }]);
    const door = startDoor({ tokenFilePath: path });
    const port = doorPort(door);
    door.stopAll();
    const result = await runServeCommand(["status", "--port", port], context);
    // Learnability N5 (2026-11-14): exit 0 ⇔ the probe state is `up` — a
    // `status && share` script must not read a dead door as healthy.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`door: not answering at http://127.0.0.1:${port}`);
    // Walkthrough F2: the down line is address-scoped and names the default
    // probe + same-port retry (a custom-port door is alive elsewhere).
    expect(result.stdout).toContain("this address did not answer");
    expect(result.stdout).toContain("retry status with the same value (the default probe is 8570)");
    expect(result.stdout).toContain(`tokens: 1 key(s) at ${path}`);
  });

  // Walkthrough N4 (2026-11-13): an answering non-UKP service is a different
  // beast from a dead address — the report must not claim "this address did
  // not answer" when something plainly did.
  test("an answering non-ukp service is named as not-a-door, not as a dead address (walkthrough N4)", async () => {
    const stub = Bun.serve({
      port: 0,
      fetch: () => new Response("<html>not a ukp door</html>", { headers: { "content-type": "text/html" } }),
    });
    try {
      const result = await runServeCommand(["status", "--port", String(stub.port)], context);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(`door: something answered at http://127.0.0.1:${stub.port}, but it is not a ukp door`);
      expect(result.stdout).toContain("check the address and port, and the http/https scheme");
      expect(result.stdout).not.toContain("this address did not answer");
    } finally {
      stub.stop(true);
    }
  });

  test("task artifacts in the machine home flip the deployment line", async () => {
    const path = tokenFileWith([{ label: "liku", scopes: "notes:ro" }]);
    const door = startDoor({ tokenFilePath: path });
    writeFileSync(join(homeDir, ".ukp", "start-door.cmd"), "@echo off\r\n", "utf8");
    try {
      const result = await runServeCommand(["status", "--port", doorPort(door)], context);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("deployment: task-managed (start-door.cmd present in");
    } finally {
      rmSync(join(homeDir, ".ukp", "start-door.cmd"), { force: true });
    }
  });
});

describe("ukp serve share (W16 / ADR-REM-015)", () => {
  test("the happy path: roster admission, a scope-aligned key in the file, one paste-ready line", async () => {
    const path = tokenFileWith([{ label: "liku", scopes: "notes:ro" }]);
    const door = startDoor({ tokenFilePath: path });
    const result = await runServeCommand(
      ["share", "notes", "--to", "alice", "--at", `http://127.0.0.1:${doorPort(door)}`],
      context,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("shared 'notes' with 'alice' (scope notes:ro)");
    const command = result.stdout.split("\n").find((line) => line.includes("ukp register --url"));
    expect(command).toBeDefined();
    expect(command).toContain(`ukp register --url http://127.0.0.1:${doorPort(door)}/notes --token `);
    // The embedded raw key is real: the file's hash row answers for it.
    const raw = /^  ukp register --url \S+ --token (\S+)$/.exec(command!)?.[1];
    expect(raw).toBeDefined();
    expect(raw!.length).toBeGreaterThanOrEqual(20);
    const entries = parseTokenFileText(readFileSync(path, "utf8"));
    expect("error" in entries ? [] : entries.entries).toContainEqual(
      expect.objectContaining({ label: "alice", scopes: { notes: "ro" } }),
    );
    // Shown once: the raw key appears in exactly one stdout line.
    expect(result.stdout.split(raw!).length - 1).toBe(1);
    expect(result.stdout).toContain("shown ONCE, stored hash-only");
    expect(result.stdout).toContain("revoke with 'ukp serve token revoke alice'");
  });

  test("--rw widens the minted scope (the second lever of the write face)", async () => {
    const path = tokenFileWith([{ label: "liku", scopes: "notes:ro" }]);
    const door = startDoor({ tokenFilePath: path });
    const result = await runServeCommand(
      ["share", "writer", "--to", "bob", "--rw", "--at", `http://127.0.0.1:${doorPort(door)}`],
      context,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("shared 'writer' with 'bob' (scope writer:rw)");
    const entries = parseTokenFileText(readFileSync(path, "utf8"));
    expect("error" in entries ? [] : entries.entries).toContainEqual(
      expect.objectContaining({ label: "bob", scopes: { writer: "rw" } }),
    );
  });

  test("a name hidden by --select refuses to mint and teaches the widen delta, never a full start command (walkthrough N3)", async () => {
    const path = tokenFileWith([{ label: "liku", scopes: "notes:ro" }]);
    const door = startDoor({ tokenFilePath: path, select: ["notes"] });
    const before = parseTokenFileText(readFileSync(path, "utf8"));
    const result = await runServeCommand(
      ["share", "cad", "--to", "alice", "--at", `http://127.0.0.1:${doorPort(door)}`],
      context,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("'cad' is registered on this host but the door's roster does not carry it");
    // Only the provably-correct delta is printed (2026-11-13 ruling): the
    // wider --select set, merged into the door's OWN start command - the
    // probe origin must never be assembled into a seemingly paste-ready
    // rebuild line (it silently narrows a 0.0.0.0 door to loopback).
    expect(result.stderr).toContain("set --select to the wider set and restart, keeping your own --host/--port and TLS flags unchanged");
    expect(result.stderr).toContain("--select cad,notes");
    expect(result.stderr).toContain("share cannot see the door's original listen address or TLS setup and will not reconstruct a full start command");
    expect(result.stderr).not.toMatch(/ukp serve --select [^\n]*--host/);
    // The durable widen for a task-managed door: the quick foreground
    // rebuild alone leaves the saved start-door.cmd narrower (flag drift,
    // 2026-11-12 field finding) and the next logon re-launches it - the
    // teaching must point at the stop/re-save/start sequence.
    expect(result.stderr).toContain("make the widen durable");
    expect(result.stderr).toContain("'ukp serve --print-task' Notes carry the kill command");
    expect(result.stderr).toContain("move the current pair aside first - --write never overwrites");
    expect(result.stderr).toContain("the next logon re-launches it");
    // No key was minted for a name the door will not route.
    expect(parseTokenFileText(readFileSync(path, "utf8"))).toEqual(before);
  });

  test("an unregistered name points at register first; a down door points at status", async () => {
    const path = tokenFileWith([{ label: "liku", scopes: "notes:ro" }]);
    const door = startDoor({ tokenFilePath: path });
    const unregistered = await runServeCommand(
      ["share", "ghost", "--to", "alice", "--at", `http://127.0.0.1:${doorPort(door)}`],
      context,
    );
    expect(unregistered.exitCode).toBe(1);
    expect(unregistered.stderr).toContain("'ghost' is not registered on this host - register its folder first");

    const port = doorPort(door);
    door.stopAll();
    const down = await runServeCommand(
      ["share", "notes", "--to", "alice", "--at", `http://127.0.0.1:${port}`],
      context,
    );
    expect(down.exitCode).toBe(1);
    expect(down.stderr).toContain(`the door is not answering at http://127.0.0.1:${port}`);
    expect(down.stderr).toContain("check 'ukp serve status'");
  });

  test("an anonymous door refuses to mint (a key would change nothing)", async () => {
    const door = startDoor({});
    const result = await runServeCommand(
      ["share", "notes", "--to", "alice", "--at", `http://127.0.0.1:${doorPort(door)}`],
      context,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("admits anonymous requests - its gate is not armed");
  });

  test("--at is explicit and honest: required, path-free, scheme-matched, no plain http off loopback", async () => {
    const path = tokenFileWith([{ label: "liku", scopes: "notes:ro" }]);
    const door = startDoor({ tokenFilePath: path });
    const port = doorPort(door);
    const missing = await runServeCommand(["share", "notes", "--to", "alice"], context);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("--at <consumer-url> is required");

    const withPath = await runServeCommand(
      ["share", "notes", "--to", "alice", "--at", `http://127.0.0.1:${port}/notes`],
      context,
    );
    expect(withPath.exitCode).toBe(2);
    expect(withPath.stderr).toContain("--at is the door origin; share derives the endpoint path itself");

    const plainHttp = await runServeCommand(
      ["share", "notes", "--to", "alice", "--at", "http://192.168.1.10:8570"],
      context,
    );
    // Plain http off loopback is inadmissible at the url grammar itself
    // (the same admission register applies) - a usage error that teaches.
    expect(plainHttp.exitCode).toBe(2);
    expect(plainHttp.stderr).toContain("plain http is loopback-only - share an https door for other hosts");
  });

  test("a repeated label mints a rotation key and says so (zero-downtime idiom)", async () => {
    const path = tokenFileWith([{ label: "alice", scopes: "notes:ro" }]);
    const door = startDoor({ tokenFilePath: path });
    const result = await runServeCommand(
      ["share", "cad", "--to", "alice", "--at", `http://127.0.0.1:${doorPort(door)}`],
      context,
    );
    expect(result.exitCode).toBe(0);
    // Walkthrough N5: a repeated label states the resulting active-key count
    // and the revoke scope (every key under the label - older consumers go
    // down with it), instead of an unquantified "both stay valid".
    expect(result.stdout).toContain(
      "the label already held 1 active key(s); now 2, all valid until revoked - revoke removes EVERY key under 'alice'",
    );
  });
});

describe("door probe TLS anchoring (M4, 2026-11-14): one resolution rule, honest failure", () => {
  // Skip without openssl: self-signed doors need it (the unanchored case
  // deletes the machine-home identities after the door loaded them).
  const opensslAvailable = binAvailable("openssl", ["version"]);

  test.skipIf(!opensslAvailable)("a single-endpoint https door is reachable and named, never a false down", async () => {
    // Own registry so the door's identity lands beside it (same machine
    // home the probe resolves — server.ts keeps identities per-endpoint).
    const singleRegistry = join(root, "m4-single-registry.toml");
    registerAt(singleRegistry, "notes", createService("m4-notes-svc", "notes"));
    const door = startDoor({ registryPath: singleRegistry, endpointName: "notes", tls: { mode: "self-signed" } });

    // No --tls flag: the probe sees the endpoint identity in the machine
    // home and anchors https by itself (the pre-fix behavior reported the
    // live door as "not answering" here).
    const status = await runServeCommand(["status", "--port", doorPort(door)], context);
    expect(status.exitCode).toBe(1);
    expect(status.stdout).toContain("is serving a single endpoint, not a host door");
    expect(status.stdout).toContain("tls: self-signed door identity");
    expect(status.stdout).not.toContain("not answering");
  });

  test.skipIf(!opensslAvailable)("share against a single-endpoint https door says so and teaches the host-door shape", async () => {
    const singleRegistry = join(root, "m4-share-registry.toml");
    registerAt(singleRegistry, "notes", createService("m4-share-notes-svc", "notes"));
    const door = startDoor({ registryPath: singleRegistry, endpointName: "notes", tls: { mode: "self-signed" } });

    const result = await runServeCommand(
      ["share", "notes", "--to", "liku", "--at", door.info.url],
      context,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is serving a single endpoint, not a host door");
    expect(result.stderr).toContain("start the door without --endpoint to serve every registered endpoint as one host door");
    expect(result.stderr).not.toContain("not answering");
  });

  test.skipIf(!opensslAvailable)("an https door no machine-home identity anchors reports tls-unanchored, not down", async () => {
    const singleRegistry = join(root, "m4-unanchored-registry.toml");
    registerAt(singleRegistry, "cad", createService("m4-cad-svc", "cad"));
    const door = startDoor({ registryPath: singleRegistry, endpointName: "cad", tls: { mode: "self-signed" } });
    // The door loaded its identity at start; removing the machine-home
    // material leaves the probe nothing to anchor with — the verdict must
    // name the unanchorable trust, not a dead address.
    rmSync(join(root, "tls"), { recursive: true, force: true });

    const status = await runServeCommand(["status", "--port", doorPort(door), "--tls"], context);
    expect(status.exitCode).toBe(1);
    expect(status.stdout).toContain("answered but its TLS identity could not be anchored from the machine home");
    expect(status.stdout).toContain("the door may still be live");
    expect(status.stdout).not.toContain("not answering");
  });
});
