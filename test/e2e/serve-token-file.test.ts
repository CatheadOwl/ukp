import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerAt } from "../../src/registry.ts";
import { DISCOVERY_PATH, startUkpServer, type StartedServe } from "../../src/server.ts";
import { executeServeCommand, resolveServeAuthSources } from "../../src/commands/serve.ts";
import {
  mintTokenFileKey,
  parseTokenFileText,
  storeTokenFile,
  appendTokenLine,
} from "../../src/plumbing/token-file.ts";

/** W13 / RQ-16c integration: the token-file gate on a live serve listener —
 * chain order (env wins, file not consulted), fresh-read revocation with the
 * gate alive (delete a line, next request 401s), scoped overreach shaped
 * exactly like an unknown name (roster 404, no 403 class), the rw bit on the
 * write face, single-endpoint scope refusals, and the `serve token` command
 * family against a scratch home. */

const root = mkdtempSync(join(tmpdir(), "ukp-serve-token-"));
const registryPath = join(root, "registry.toml");

function createService(folderName: string, endpointName: string, propose: boolean): string {
  const folder = join(root, folderName);
  mkdirSync(join(folder, ".ukp"), { recursive: true });
  mkdirSync(join(folder, "documents"), { recursive: true });
  writeFileSync(
    join(folder, ".ukp", "service.toml"),
    propose
      ? `name = "${endpointName}"\n\n[capabilities.propose]\n`
      : `name = "${endpointName}"\n\n[capabilities]\n`,
    "utf8",
  );
  writeFileSync(join(folder, "documents", "note.md"), "# note\n\ntoken-file fixture content.\n", "utf8");
  return folder;
}

registerAt(registryPath, "notes", createService("notes-svc", "notes", false));
registerAt(registryPath, "cad", createService("cad-svc", "cad", false));
registerAt(registryPath, "writer", createService("writer-svc", "writer", true));

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

/** Scratch token file per test group: mint directly through the plumbing
 * module (the command path has its own tests below). */
function tokenFileOf(keys: Array<{ label: string; scopes: string }>): string {
  const path = join(root, `tokens-${Math.random().toString(36).slice(2)}`);
  let text = "";
  for (const key of keys) text = appendTokenLine(text, mintTokenFileKey(key.label, key.scopes).line);
  storeTokenFile(path, text);
  return path;
}

/** Mint a key AND append its line to an existing token file. */
function issueInto(path: string, label: string, scopes: string): string {
  const minted = mintTokenFileKey(label, scopes);
  const current = readFileSync(path, "utf8");
  storeTokenFile(path, appendTokenLine(current, minted.line));
  return minted.token;
}

const read = (info: { url: string }, name: string, token?: string) =>
  fetch(`${info.url}/e/${name}/v1/read?ref=documents/note.md`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

afterAll(() => {
  for (const handle of started) handle.stopAll();
  rmSync(root, { recursive: true, force: true });
});

describe("serve token file: gate mechanics (fresh read, revocation, uniform 401)", () => {
  test("the gate arms from the file; discovery stays public and declares bearer", async () => {
    const path = tokenFileOf([{ label: "liku", scopes: "notes:ro" }]);
    const door = startDoor({ tokenFilePath: path });
    const discovery = await fetch(`${door.info.url}${DISCOVERY_PATH}`);
    expect(discovery.status).toBe(200);
    expect(((await discovery.json()) as { security: { schemes: string[] } }).security.schemes).toEqual(["bearer"]);
    expect(door.info.authRequired).toBe(true);
    expect(door.info.tokenFile?.keys).toBe(1);
  });

  test("valid key reads an in-scope endpoint; failure classes share one 401 body", async () => {
    const path = tokenFileOf([{ label: "liku", scopes: "notes:ro,cad:rw" }]);
    const key = issueInto(path, "liku-live", "notes:ro,cad:rw");
    const door = startDoor({ tokenFilePath: path });
    const ok = await read(door.info, "notes", key);
    expect(ok.status).toBe(200);
    // Missing header, wrong scheme, tampered secret: byte-identical refusal.
    const missing = await read(door.info, "notes");
    const wrongScheme = await fetch(`${door.info.url}/e/notes/v1/read?ref=documents/note.md`, {
      headers: { authorization: `bearer ${key}` },
    });
    const tamperedKey = key.slice(0, -1) + (key.endsWith("X") ? "Y" : "X");
    const tampered = await read(door.info, "notes", tamperedKey);
    const missingBody = await missing.text();
    for (const response of [wrongScheme, tampered]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toBe(missing.headers.get("content-type"));
      expect(await response.text()).toBe(missingBody);
    }
  });

  test("fresh-read revocation: the gate is alive, deleting the line 401s the NEXT request (hard anchor)", async () => {
    const path = tokenFileOf([{ label: "liku", scopes: "notes:ro" }]);
    const key = issueInto(path, "rotation-holder", "notes:ro");
    const door = startDoor({ tokenFilePath: path });
    expect((await read(door.info, "notes", key)).status).toBe(200);
    // Revoke by hand: rewrite the file without the key's line (the manual
    // idiom — no restart, no signal to the gate).
    const parsed = parseTokenFileText(readFileSync(path, "utf8"));
    if ("error" in parsed) throw new Error(parsed.error.message);
    const surviving = parsed.entries.filter((entry) => entry.label !== "rotation-holder");
    const lines = readFileSync(path, "utf8").split("\n").filter(
      (line) => line.trim() !== "" && !line.trim().startsWith("#") && !line.startsWith("rotation-holder"),
    );
    expect(lines.length).toBe(surviving.length);
    storeTokenFile(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
    expect((await read(door.info, "notes", key)).status).toBe(401);
    // The other key still works — revocation is per line, not per file.
    const otherKey = issueInto(path, "post-revoke", "notes:ro");
    expect((await read(door.info, "notes", otherKey)).status).toBe(200);
  });

  test("a file that goes malformed mid-flight fails closed (401), never opens", async () => {
    const path = tokenFileOf([{ label: "liku", scopes: "notes:ro" }]);
    const key = issueInto(path, "liku-live", "notes:ro");
    const door = startDoor({ tokenFilePath: path });
    expect((await read(door.info, "notes", key)).status).toBe(200);
    // mode 0o600: on POSIX the product's permission gate (tokenFileModeProblem)
    // refuses group/other-readable files before the behavior under test runs —
    // default-mode fixtures 401 for the wrong reason (ali leg, 2026-11-04).
    writeFileSync(path, "garbage while an operator edits\n", { encoding: "utf8", mode: 0o600 });
    expect((await read(door.info, "notes", key)).status).toBe(401);
  });

  test("auth-source resolution: env wins, a keyless file stays anonymous, keys arm the gate", () => {
    const home = join(root, "auth-sources-home");
    // Missing file: unarmed (RQ-18's anonymous opt-in decides).
    expect(resolveServeAuthSources([], home)).toEqual({ tokens: [] });
    // File with comments only: still unarmed — an empty file must not wall
    // an --allow-anonymous door off (review P1 regression anchor).
    mkdirSync(join(home, ".ukp"), { recursive: true });
    writeFileSync(join(home, ".ukp", "tokens"), "# all keys revoked\n", { encoding: "utf8", mode: 0o600 });
    expect(resolveServeAuthSources([], home)).toEqual({ tokens: [] });
    // One key: armed from the file.
    const minted = mintTokenFileKey("liku", "notes:ro");
    writeFileSync(join(home, ".ukp", "tokens"), `${minted.line}\n`, { encoding: "utf8", mode: 0o600 });
    expect(resolveServeAuthSources([], home)).toEqual({ tokens: [], tokenFilePath: join(home, ".ukp", "tokens") });
    // Malformed file: loud refusal.
    writeFileSync(join(home, ".ukp", "tokens"), "not a row\n", { encoding: "utf8", mode: 0o600 });
    const bad = resolveServeAuthSources([], home);
    expect("error" in bad && bad.error).toContain("expected 4 columns");
    // Env present: the file is not consulted at all — even a malformed one.
    expect(resolveServeAuthSources(["env-secret"], home)).toEqual({ tokens: ["env-secret"] });
  });
});

describe("serve token file: scoped overreach (two refusal tiers — 2026-11-11 ruling)", () => {
  test("roster-present names answer route denials uniform across causes; roster-absent names stay existence-shaped", async () => {
    const path = tokenFileOf([{ label: "liku", scopes: "notes:ro" }]);
    const key = issueInto(path, "liku-live", "notes:ro");
    const door = startDoor({ tokenFilePath: path });
    // Tier 2 (2026-11-11): 'cad' is on the door's public roster, but this
    // key's effective set is notes-only — an honest route denial, never an
    // existence denial. The roster carried is still the key's own set.
    const outOfScope = await read(door.info, "cad", key);
    expect(outOfScope.status).toBe(404);
    const outOfScopeText = await outOfScope.text();
    const body = JSON.parse(outOfScopeText) as { error: { class: string; message: string } };
    expect(body.error.class).toBe("not-found");
    expect(body.error.message).toContain("no route for 'cad' under your key");
    expect(body.error.message).toMatch(/\(available: notes\)$/);
    expect(body.error.message).not.toMatch(/\(available: [^)]*\bcad\b/);
    // Cross-cause uniformity (the E-prime anchor): an ro-scoped write
    // attempt and an absent-scope write attempt on the same name produce
    // byte-identical denials — the message never reveals which cause
    // applies, nor whether any other key could write.
    const roWriteKey = issueInto(path, "ro-writer", "writer:ro");
    const absentWriteKey = issueInto(path, "absent-writer", "notes:ro");
    const propose = (k: string) =>
      fetch(`${door.info.url}/e/writer/v1/propose/x`, {
        method: "PUT",
        headers: { authorization: `Bearer ${k}`, "content-type": "text/plain" },
        body: "proposal text",
      });
    const roWrite = await propose(roWriteKey);
    const absentWrite = await propose(absentWriteKey);
    expect(roWrite.status).toBe(404);
    const roWriteText = await roWrite.text();
    expect(roWriteText).toBe(await absentWrite.text());
    expect((JSON.parse(roWriteText) as { error: { message: string } }).error.message)
      .toContain("no route for 'writer' under your key");
    // Tier 1 is unchanged: on a subset door, a select-excluded name and an
    // unknown name differ only in the echoed name (ADR-REM-010 / INV-07).
    const subsetDoor = startDoor({ tokens: ["env-secret"], select: ["notes"] });
    const selectExcluded = await read(subsetDoor.info, "cad", "env-secret");
    expect(selectExcluded.status).toBe(404);
    const selectExcludedText = await selectExcluded.text();
    expect((JSON.parse(selectExcludedText) as { error: { message: string } }).error.message)
      .toContain("no such endpoint 'cad'");
    const unknown = await read(subsetDoor.info, "never-registered", "env-secret");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe(selectExcludedText.replace("'cad'", "'never-registered'"));
  });

  test("a subset door narrows the key further (select ∩ scope ∩ registry)", async () => {
    const path = tokenFileOf([{ label: "liku", scopes: "notes:ro,cad:ro" }]);
    const key = issueInto(path, "liku-live", "notes:ro,cad:ro");
    const door = startDoor({ tokenFilePath: path, select: ["cad"] });
    expect((await read(door.info, "cad", key)).status).toBe(200);
    // In scope for the key, excluded by the door: the roster-404 the key
    // sees lists the door's OWN effective set for it (select ∩ scope).
    const excluded = await read(door.info, "notes", key);
    expect(excluded.status).toBe(404);
    expect(((await excluded.json()) as { error: { message: string } }).error.message).toContain("(available: cad)");
  });

  test("the rw bit gates the write face: ro keys see route-denial 404s on propose, rw keys may write", async () => {
    const path = tokenFileOf([{ label: "reader", scopes: "writer:ro" }]);
    const roKey = issueInto(path, "reader", "writer:ro");
    const rwKey = issueInto(path, "writer-client", "writer:rw");
    const door = startDoor({ tokenFilePath: path });
    const roRefused = await fetch(`${door.info.url}/e/writer/v1/propose/test-prop`, {
      method: "PUT",
      headers: { authorization: `Bearer ${roKey}`, "content-type": "text/plain" },
      body: "proposal text",
    });
    expect(roRefused.status).toBe(404);
    const roRefusedText = await roRefused.text();
    expect((JSON.parse(roRefusedText) as { error: { message: string } }).error.message)
      .toContain("no route for 'writer' under your key");
    // N3 (2026-11-14): the ro key's effective write set is empty, and the
    // empty roster renders the key's own grants for the write face — caller-
    // held knowledge — never the bare `(available: )`.
    const roRefusedMessage = (JSON.parse(roRefusedText) as { error: { message: string } }).error.message;
    expect(roRefusedMessage).toContain("(your key grants no write routes on this door)");
    expect(roRefusedMessage).not.toContain("(available: )");
    const rwAccepted = await fetch(`${door.info.url}/e/writer/v1/propose/test-prop`, {
      method: "PUT",
      headers: { authorization: `Bearer ${rwKey}`, "content-type": "text/plain" },
      body: "proposal text",
    });
    expect(rwAccepted.status).toBe(200);
    // The ro key still READS the same endpoint — ro scopes read faces only.
    expect((await read(door.info, "writer", roKey)).status).toBe(200);
  });

  test("env tokens win outright: the file is not consulted while UKP_SERVE_TOKEN is set", async () => {
    const path = tokenFileOf([{ label: "liku", scopes: "notes:ro" }]);
    const fileKey = issueInto(path, "liku", "notes:ro");
    const door = startDoor({ tokens: ["env-secret"], tokenFilePath: path });
    expect((await read(door.info, "notes", "env-secret")).status).toBe(200);
    // A perfectly valid file key is a 401 while the env shortcut is armed
    // (chain order: env is the full-power shortcut form, file skipped).
    expect((await read(door.info, "notes", fileKey)).status).toBe(401);
    expect(door.info.tokenFile).toBeUndefined();
  });
});

describe("door key-echo (ADR-REM-014 / INV-23): the well-known document admits its own key", () => {
  test("a valid file key earns its admission roster; anonymous, invalid, and env fetches stay byte-identical public", async () => {
    const path = tokenFileOf([{ label: "liku", scopes: "notes:ro,cad:ro" }]);
    const key = issueInto(path, "liku-live", "notes:ro,cad:ro");
    const door = startDoor({ tokenFilePath: path });
    // The echo: this key's own effective set (scope ∩ select ∩ registry,
    // read tier). 'writer' stays on the PUBLIC roster — its existence is
    // discovery knowledge — while the echo speaks only for this key.
    const echoed = await fetch(`${door.info.url}${DISCOVERY_PATH}`, { headers: { authorization: `Bearer ${key}` } });
    expect(echoed.status).toBe(200);
    const echoDoc = await echoed.json() as { endpoints: Array<{ name: string }>; admitted?: string[] };
    expect(echoDoc.endpoints.map((endpoint) => endpoint.name).sort()).toEqual(["cad", "notes", "writer"]);
    expect([...echoDoc.admitted ?? []].sort()).toEqual(["cad", "notes"]);
    // INV-23, three-state uniformity: anonymous and invalid-credential
    // fetches keep the PUBLIC document byte-identical — no echo, and the
    // difference never becomes a credential oracle.
    const anonymous = await fetch(`${door.info.url}${DISCOVERY_PATH}`);
    const invalid = await fetch(`${door.info.url}${DISCOVERY_PATH}`, {
      headers: { authorization: "Bearer not-a-valid-key" },
    });
    const anonymousText = await anonymous.text();
    expect(await invalid.text()).toBe(anonymousText);
    expect(anonymousText).not.toContain("admitted");
    // Same source, same function: the echo equals the roster the tier-2
    // route denial prints as `available:` for the same key (the ADR's
    // "disclosure already in the field" claim, as a mechanical anchor).
    const denial = await read(door.info, "writer", key);
    expect(denial.status).toBe(404);
    const denialBody = JSON.parse(await denial.text()) as { error: { message: string } };
    const available = /\(available: (.*)\)$/.exec(denialBody.error.message)?.[1]?.split(", ").sort() ?? [];
    expect(available).toEqual([...echoDoc.admitted!].sort());
    // Env credentials never earn an echo (scopeAdmit's undefined = the
    // door's own width): a valid env bearer and an anonymous fetch of the
    // same door answer byte-identically.
    const envDoor = startDoor({ tokens: ["env-secret"] });
    const envEcho = await fetch(`${envDoor.info.url}${DISCOVERY_PATH}`, {
      headers: { authorization: "Bearer env-secret" },
    });
    const envText = await envEcho.text();
    expect(envText).toBe(await (await fetch(`${envDoor.info.url}${DISCOVERY_PATH}`)).text());
    expect(envText).not.toContain("admitted");
  });

  test("the echo stays inside the public roster: select-excluded names never surface (INV-23 bound)", async () => {
    const path = tokenFileOf([{ label: "broad", scopes: "*:ro" }]);
    const key = issueInto(path, "broad-live", "*:ro");
    const door = startDoor({ tokenFilePath: path, select: ["notes"] });
    const doc = await (await fetch(`${door.info.url}${DISCOVERY_PATH}`, {
      headers: { authorization: `Bearer ${key}` },
    })).json() as { endpoints: Array<{ name: string }>; admitted?: string[] };
    // The public roster is the select ∩ registry set; the echo is a subset
    // of it even though this key's scopes cover the whole registry — a
    // select-excluded name stays indistinguishable from an unknown one
    // (INV-07 / INV-22 tier-1, untouched by the echo).
    expect(doc.endpoints.map((endpoint) => endpoint.name)).toEqual(["notes"]);
    expect(doc.admitted).toEqual(["notes"]);
  });
});

describe("serve token file: single-endpoint mode scopes", () => {
  test("out-of-scope and ro-on-write keys are uniform 401s on this gate", async () => {
    const path = tokenFileOf([{ label: "cad-client", scopes: "cad:rw" }]);
    const cadKey = issueInto(path, "cad-client", "cad:rw");
    const notesRoKey = issueInto(path, "notes-client", "notes:ro");
    const single = startUkpServer({
      endpointName: "notes",
      currentDirectory: root,
      registryPath,
      port: 0,
      tokenFilePath: path,
    });
    started.push(single);
    const readUrl = `${single.info.url}/v1/read?ref=documents/note.md`;
    // Key scoped elsewhere: not a valid token for THIS gate.
    expect((await fetch(readUrl, { headers: { authorization: `Bearer ${cadKey}` } })).status).toBe(401);
    // In-scope ro key: reads fine.
    expect((await fetch(readUrl, { headers: { authorization: `Bearer ${notesRoKey}` } })).status).toBe(200);
    // The endpoint declares no propose; the rw question is moot here — use
    // the writer endpoint for the write-face variant below.
  });

  test("rw demanded on the write face of a single-endpoint gate", async () => {
    const path = tokenFileOf([{ label: "reader", scopes: "writer:ro" }]);
    const roKey = issueInto(path, "reader", "writer:ro");
    const rwKey = issueInto(path, "writer-client", "writer:rw");
    const single = startUkpServer({
      endpointName: "writer",
      currentDirectory: root,
      registryPath,
      port: 0,
      tokenFilePath: path,
    });
    started.push(single);
    const propose = (key: string) =>
      fetch(`${single.info.url}/v1/propose/single-prop`, {
        method: "PUT",
        headers: { authorization: `Bearer ${key}`, "content-type": "text/plain" },
        body: "proposal text",
      });
    expect((await propose(roKey)).status).toBe(401);
    expect((await propose(rwKey)).status).toBe(200);
  });
});

describe("serve token: the issuance command family (scratch home)", () => {
  const home = join(root, "issue-home");
  const tokenPath = join(home, ".ukp", "tokens");
  const context = { currentDirectory: root, registryPath, tokens: [] as string[], homeDir: home };

  const run = (args: readonly string[]) => executeServeCommand(["token", ...args], context);

  test("add mints (raw shown once, hash-only file), list tabulates, revoke deletes", () => {
    const add = run(["add", "liku", "notes:ro,cad:rw"]);
    expect(add.exitCode).toBe(0);
    const minted = /^  (ukp_liku_[A-Za-z0-9_-]+)$/m.exec(add.stdout);
    expect(minted).not.toBeNull();
    const rawKey = minted![1]!;
    // The file holds the hash row but never the raw key.
    const stored = readFileSync(tokenPath, "utf8");
    expect(stored).toMatch(/^liku [0-9a-f]{16} sha256\$[0-9a-f]{64} notes:ro,cad:rw$/m);
    expect(stored).not.toContain(rawKey.split("_")[3]!);

    const list = run(["list"]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("liku");
    expect(list.stdout).toContain("notes:ro,cad:rw");
    expect(list.stdout).not.toContain("sha256$");

    const addSecond = run(["add", "ali", "*:rw"]);
    expect(addSecond.exitCode).toBe(0);
    // Rotation: same label twice is legal, both stay active.
    expect(run(["add", "liku", "notes:ro"]).stdout).toContain("already had 1 active key(s)");

    const revoke = run(["revoke", "liku"]);
    expect(revoke.exitCode).toBe(0);
    expect(revoke.stdout).toContain("revoked 2 key(s) with label 'liku'");
    const after = run(["list"]);
    expect(after.stdout).toContain("ali");
    expect(after.stdout).not.toMatch(/\bliku\b/);
    // Revoking an absent label is a usage error naming what IS present.
    const missing = run(["revoke", "liku"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("labels present: ali");
  });

  test("grammar refusals are usage errors (scope column required, label grammar)", () => {
    const noScopes = run(["add", "ops", ""]);
    expect(noScopes.exitCode).toBe(2);
    expect(noScopes.stderr).toContain("scopes must not be empty");
    const badScope = run(["add", "ops", "notes"]);
    expect(badScope.exitCode).toBe(2);
    expect(badScope.stderr).toContain("expected <endpoint>:(ro|rw)");
    const badLabel = run(["add", "Bad_Label", "notes:ro"]);
    expect(badLabel.exitCode).toBe(2);
    expect(badLabel.stderr).toContain("invalid label");
    const shape = run(["add", "ops"]);
    expect(shape.exitCode).toBe(2);
    expect(shape.stderr).toContain("serve token add takes <label> <scopes>");
    const verb = run(["teleport"]);
    expect(verb.exitCode).toBe(2);
    expect(verb.stderr).toContain("unknown serve token verb 'teleport'");
  });

  test("list on a missing file is a state, not an error; a malformed file refuses loudly", () => {
    const empty = executeServeCommand(["token", "list"], {
      ...context,
      homeDir: join(root, "empty-home"),
    });
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain("no token file at");

    mkdirSync(join(root, "bad-home", ".ukp"), { recursive: true });
    writeFileSync(join(root, "bad-home", ".ukp", "tokens"), "this is not a token row\n", { encoding: "utf8", mode: 0o600 });
    const bad = executeServeCommand(["token", "list"], {
      ...context,
      homeDir: join(root, "bad-home"),
    });
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("expected 4 columns");
    // Serving refuses to start on the same malformed file (fail loudly,
    // never half-arm the gate).
    const serve = executeServeCommand([], {
      currentDirectory: root,
      registryPath,
      tokens: [],
      homeDir: join(root, "bad-home"),
    });
    expect(serve.exitCode).toBe(1);
    expect(serve.stderr).toContain("token file");
    expect(serve.stderr).toContain("expected 4 columns");
  });
});
