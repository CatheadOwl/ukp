import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  });

  test("a down door is a state the report names (exit 0), machine-home facts still render", async () => {
    const path = tokenFileWith([{ label: "liku", scopes: "notes:ro" }]);
    const door = startDoor({ tokenFilePath: path });
    const port = doorPort(door);
    door.stopAll();
    const result = await runServeCommand(["status", "--port", port], context);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`door: not answering at http://127.0.0.1:${port}`);
    expect(result.stdout).toContain("start it, or correct --host/--port");
    expect(result.stdout).toContain(`tokens: 1 key(s) at ${path}`);
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

  test("a name hidden by --select refuses to mint and teaches the rebuilt widen command", async () => {
    const path = tokenFileWith([{ label: "liku", scopes: "notes:ro" }]);
    const door = startDoor({ tokenFilePath: path, select: ["notes"] });
    const before = parseTokenFileText(readFileSync(path, "utf8"));
    const result = await runServeCommand(
      ["share", "cad", "--to", "alice", "--at", `http://127.0.0.1:${doorPort(door)}`],
      context,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("'cad' is registered on this host but the door's roster does not carry it");
    expect(result.stderr).toContain(
      `ukp serve --select cad,notes --host 127.0.0.1 --port ${doorPort(door)}`,
    );
    expect(result.stderr).toContain("re-add any flags you originally set, such as --tls-san or --tls-cert");
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
    expect(result.stdout).toContain("the label already held 1 active key(s) - both stay valid until revoked");
  });
});
