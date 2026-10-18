import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executeSessionCommand,
} from "../src/commands/session.ts";
import { loadSessionRecords, mapSubstrateItem, sessionStorePath } from "../src/capabilities/session.ts";
import { loadManifest, ManifestError } from "../src/config/manifest.ts";
import { registerAt } from "../src/registry.ts";

const fixtureExecutable = join(import.meta.dir, "fixtures", "session-provider", "agent-fixture.mjs");
const nodeExecutable = Bun.which("node") ?? process.execPath;

interface Fixture {
  root: string;
  registryPath: string;
  endpointFolder: string;
  /** Appends verbatim TOML content (e.g. [[agents]] tables) to the registry. */
  extendRegistry: (content: string) => void;
}

const fixtures: Fixture[] = [];

function createFixture(options: { manifestSession?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ukp-session-"));
  const endpointFolder = join(root, "kb-service");
  mkdirSync(join(endpointFolder, ".ukp"), { recursive: true });
  writeFileSync(
    join(endpointFolder, ".ukp", "service.toml"),
    `name = "kb"\n[capabilities.nav]\nprovider = "file"\n${options.manifestSession ?? ""}`,
  );
  const registryPath = join(root, "registry.toml");
  registerAt(registryPath, "kb", endpointFolder);
  const fixture: Fixture = {
    root,
    registryPath,
    endpointFolder,
    extendRegistry(content) {
      appendFileSync(registryPath, content);
    },
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop()!;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

/** [[agents]] block with TOML-safe (JSON-produced basic) strings. */
function agentsTable(entries: ReadonlyArray<{ handle: string; command: readonly string[] }>): string {
  return entries
    .map((entry) => `[[agents]]\nhandle = ${JSON.stringify(entry.handle)}\ntier = "sdk"\ncommand = [${entry.command.map((part) => JSON.stringify(part)).join(", ")}]\n`)
    .join("");
}

async function run(args: readonly string[], fixture: Fixture, scenario?: string) {
  const had = Object.hasOwn(process.env, "AGENT_FIXTURE_SCENARIO");
  const previous = process.env.AGENT_FIXTURE_SCENARIO;
  if (scenario !== undefined) process.env.AGENT_FIXTURE_SCENARIO = scenario;
  try {
    return await executeSessionCommand(args, { registryPath: fixture.registryPath });
  } finally {
    if (scenario !== undefined) {
      if (had) process.env.AGENT_FIXTURE_SCENARIO = previous;
      else delete process.env.AGENT_FIXTURE_SCENARIO;
    }
  }
}

function stdoutEvents(result: { stdout: string }): Array<Record<string, unknown>> {
  return result.stdout.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("ukp session · help and dispatch", () => {
  test("group help lists subcommands and reserved verbs", async () => {
    const result = await run(["--help"], createFixture());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("spawn");
    expect(result.stdout).toContain("final report");
    expect(result.stdout).toContain("--events");
    expect(result.stdout).toContain("Reserved (app-server tier, not in v0): wait, answer, stop");
  });

  test("reserved verbs are usage errors pointing at v0 surface", async () => {
    const result = await run(["wait"], createFixture());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage error");
    expect(result.stderr).toContain("reserved for the app-server tier");
  });

  test("unknown subcommand is a usage error", async () => {
    const result = await run(["frobnicate"], createFixture());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown session subcommand 'frobnicate'");
  });
});

describe("ukp session spawn · authorization gate (spec §1/§5)", () => {
  test("no [capabilities.session] declaration → not authorized, exit 1", async () => {
    const fixture = createFixture();
    fixture.extendRegistry(agentsTable([{ handle: "fixture", command: [nodeExecutable, fixtureExecutable] }]));
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "hi"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("session-hosting not authorized");
    expect(result.stderr).toContain("hosting is off for endpoint 'kb'");
    expect(result.stdout).toBe("");
  });

  test("empty allowlist = explicit off → not authorized", async () => {
    const fixture = createFixture({ manifestSession: "[capabilities.session]\nagents = []\n" });
    fixture.extendRegistry(agentsTable([{ handle: "fixture", command: [nodeExecutable, fixtureExecutable] }]));
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "hi"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("session-hosting not authorized");
  });

  test("handle not in allowlist → not authorized, allowed list shown", async () => {
    const fixture = createFixture({ manifestSession: '[capabilities.session]\nagents = ["fixture"]\n' });
    fixture.extendRegistry(agentsTable([{ handle: "fixture", command: [nodeExecutable, fixtureExecutable] }]));
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "other", "--text", "hi"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("agent 'other' is not in endpoint 'kb' [capabilities.session] agents (allowed: fixture)");
  });

  test("handle without a registry [[agents]] entry → substrate unavailable", async () => {
    const fixture = createFixture({ manifestSession: '[capabilities.session]\nagents = ["fixture"]\n' });
    fixture.extendRegistry(agentsTable([{ handle: "someone-else", command: [nodeExecutable, fixtureExecutable] }]));
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "hi"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("agent substrate unavailable");
    expect(result.stderr).toContain("[[agents]]");
  });

  test("substrate binary missing → substrate unavailable", async () => {
    const fixture = createFixture({ manifestSession: '[capabilities.session]\nagents = ["fixture"]\n' });
    fixture.extendRegistry(agentsTable([{ handle: "fixture", command: ["definitely-not-a-real-binary-xyz"] }]));
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "hi"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("agent substrate unavailable");
  });

  test("unknown endpoint and missing prompt are usage errors (exit 2)", async () => {
    const fixture = createFixture({ manifestSession: '[capabilities.session]\nagents = ["fixture"]\n' });
    fixture.extendRegistry(agentsTable([{ handle: "fixture", command: [nodeExecutable, fixtureExecutable] }]));
    const unknownEndpoint = await run(["spawn", "--endpoint", "nope", "--agent", "fixture", "--text", "hi"], fixture);
    expect(unknownEndpoint.exitCode).toBe(2);
    expect(unknownEndpoint.stderr).toContain("unknown endpoint 'nope'");
    const noPrompt = await run(["spawn", "--endpoint", "kb", "--agent", "fixture"], fixture);
    expect(noPrompt.exitCode).toBe(2);
    expect(noPrompt.stderr).toContain("--brief <file> or --text <string> is required");
  });
});

describe("ukp session spawn · event stream and address book (spec §3/§4/§6)", () => {
  test("happy path prints the final report, records the address book, exits 0", async () => {
    const fixture = createFixture({ manifestSession: '[capabilities.session]\nagents = ["fixture"]\n' });
    fixture.extendRegistry(agentsTable([{ handle: "fixture", command: [nodeExecutable, fixtureExecutable] }]));

    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "hello brief"], fixture, "ok");
    expect(result.exitCode).toBe(0);
    // Default face = the plain-text report (final agent message), pipe-friendly;
    // no protocol framing for the common delegation case.
    expect(result.stdout).toBe("echo:hello brief\n");

    const records = loadSessionRecords(sessionStorePath(fixture.registryPath));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "fix-thread-1",
      endpoint: "kb",
      agent: "fixture",
      tier: "sdk",
      last_outcome: "finished",
    });
    expect(result.stderr).toContain("session fix-thread-1 started (agent fixture, tier sdk, endpoint kb)");
    expect(result.stderr).toContain("session fix-thread-1 finished");
  });

  test("--events opts into the AG-UI JSONL stream with the §4 mapping and one boundary pair", async () => {
    const fixture = createFixture({ manifestSession: '[capabilities.session]\nagents = ["fixture"]\n' });
    fixture.extendRegistry(agentsTable([{ handle: "fixture", command: [nodeExecutable, fixtureExecutable] }]));

    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "hello brief", "--events"], fixture, "ok");
    expect(result.exitCode).toBe(0);
    const events = stdoutEvents(result);
    expect(events[0]).toMatchObject({ type: "RUN_STARTED", threadId: "fix-thread-1" });
    const boundaries = events.filter((event) => event.type === "RUN_STARTED" || event.type === "RUN_FINISHED" || event.type === "RUN_ERROR");
    expect(boundaries.map((event) => event.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
    expect(events.some((event) => event.type === "STEP_STARTED" && event.stepName === "turn")).toBe(true);

    const textStart = events.find((event) => event.type === "TEXT_MESSAGE_START");
    expect(textStart).toMatchObject({ role: "assistant", messageId: "m1" });
    const textContent = events.find((event) => event.type === "TEXT_MESSAGE_CONTENT");
    expect(textContent).toMatchObject({ messageId: "m1", content: "echo:hello brief" });

    const toolStart = events.find((event) => event.type === "TOOL_CALL_START");
    expect(toolStart).toMatchObject({ toolCallId: "c1", toolCallName: "echo hi" });
    const toolArgs = events.find((event) => event.type === "TOOL_CALL_ARGS");
    expect(toolArgs).toMatchObject({ toolCallId: "c1", args: "echo hi" });
    expect(events.some((event) => event.type === "TOOL_CALL_RESULT")).toBe(true);
  });

  test("turn.failed followed by a trailing error emits exactly one RUN_ERROR, exit 1", async () => {
    const fixture = createFixture({ manifestSession: '[capabilities.session]\nagents = ["fixture"]\n' });
    fixture.extendRegistry(agentsTable([{ handle: "fixture", command: [nodeExecutable, fixtureExecutable] }]));
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "x", "--events"], fixture, "failed");
    expect(result.exitCode).toBe(1);
    const events = stdoutEvents(result);
    expect(events.filter((event) => event.type === "RUN_ERROR")).toHaveLength(1);
    expect(events.filter((event) => event.type === "RUN_STARTED")).toHaveLength(1);
    expect(events.find((event) => event.type === "RUN_ERROR")).toMatchObject({ message: "fixture boom" });
    expect(result.stderr).toContain("session fix-thread-1 failed");
    expect(loadSessionRecords(sessionStorePath(fixture.registryPath))[0]?.last_outcome).toBe("failed");
  });

  test("failed run still prints the last agent message as the default face", async () => {
    const fixture = createFixture({ manifestSession: '[capabilities.session]\nagents = ["fixture"]\n' });
    fixture.extendRegistry(agentsTable([{ handle: "fixture", command: [nodeExecutable, fixtureExecutable] }]));
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "x"], fixture, "failed");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("about to fail\n");
    expect(result.stderr).toContain("session fix-thread-1 failed");
  });

  test("stream without a terminal event closes with synthesized RUN_FINISHED (rule 2)", async () => {
    const fixture = createFixture({ manifestSession: '[capabilities.session]\nagents = ["fixture"]\n' });
    fixture.extendRegistry(agentsTable([{ handle: "fixture", command: [nodeExecutable, fixtureExecutable] }]));
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "x", "--events"], fixture, "no-terminal");
    expect(result.exitCode).toBe(0);
    const events = stdoutEvents(result);
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
  });

  test("substrate that never emits events is substrate failure, not run failure", async () => {
    const fixture = createFixture({ manifestSession: '[capabilities.session]\nagents = ["fixture"]\n' });
    fixture.extendRegistry(agentsTable([{ handle: "fixture", command: [nodeExecutable, fixtureExecutable] }]));
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "x"], fixture, "no-events");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("agent substrate unavailable");
    expect(result.stdout).toBe("");
    expect(loadSessionRecords(sessionStorePath(fixture.registryPath))).toHaveLength(0);
  });

  test("claimed RUN_FINISHED with non-zero exit still fails the run", async () => {
    const fixture = createFixture({ manifestSession: '[capabilities.session]\nagents = ["fixture"]\n' });
    fixture.extendRegistry(agentsTable([{ handle: "fixture", command: [nodeExecutable, fixtureExecutable] }]));
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "x"], fixture, "finish-exit-1");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("session fix-thread-1 failed");
  });
});

describe("ukp session send · resume semantics (spec §3/§4 rule 1)", () => {
  async function spawnOnce(fixture: Fixture): Promise<void> {
    await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "first"], fixture, "ok");
  }

  test("resume passes the native id and synthesizes RUN_STARTED from the address book", async () => {
    const fixture = createFixture({ manifestSession: '[capabilities.session]\nagents = ["fixture"]\n' });
    fixture.extendRegistry(agentsTable([{ handle: "fixture", command: [nodeExecutable, fixtureExecutable] }]));
    await spawnOnce(fixture);

    const result = await run(["send", "fix-thread-1", "--text", "second turn"], fixture, "resume-ok");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("resume:fix-thread-1 echo:second turn\n");
    const eventsResult = await run(["send", "fix-thread-1", "--text", "third turn", "--events"], fixture, "resume-ok");
    expect(eventsResult.exitCode).toBe(0);
    const events = stdoutEvents(eventsResult);
    expect(events[0]).toMatchObject({ type: "RUN_STARTED", threadId: "fix-thread-1" });

    const record = loadSessionRecords(sessionStorePath(fixture.registryPath))[0]!;
    expect(record.last_outcome).toBe("finished");
    expect(result.stderr).toContain("session fix-thread-1 resumed");
  });

  test("unknown id is a usage error listing the way out", async () => {
    const fixture = createFixture({ manifestSession: '[capabilities.session]\nagents = ["fixture"]\n' });
    const result = await run(["send", "no-such-id", "--text", "x"], fixture);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown session 'no-such-id'");
  });

  test("id collision across agents is a usage error listing candidates", async () => {
    const fixture = createFixture({ manifestSession: '[capabilities.session]\nagents = ["fixture"]\n' });
    const storePath = sessionStorePath(fixture.registryPath);
    writeFileSync(storePath, `${JSON.stringify([
      { id: "dup", endpoint: "kb", agent: "fixture", tier: "sdk", owner: "t", created_at: "t", last_run_at: "t", last_outcome: "finished" },
      { id: "dup", endpoint: "kb", agent: "another", tier: "sdk", owner: "t", created_at: "t", last_run_at: "t", last_outcome: "finished" },
    ], null, 2)}\n`);
    const result = await run(["send", "dup", "--text", "x"], fixture);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("ambiguous across agents");
    expect(result.stderr).toContain("agent fixture");
    expect(result.stderr).toContain("agent another");
  });
});

describe("ukp session status/list · address-book reads (spec §3)", () => {
  test("status renders the full record; list filters by endpoint", async () => {
    const fixture = createFixture({ manifestSession: '[capabilities.session]\nagents = ["fixture"]\n' });
    fixture.extendRegistry(agentsTable([{ handle: "fixture", command: [nodeExecutable, fixtureExecutable] }]));
    await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "x"], fixture, "ok");

    const status = await run(["status", "fix-thread-1"], fixture);
    expect(status.exitCode).toBe(0);
    for (const field of ["id:", "endpoint:", "agent:", "tier:", "owner:", "created_at:", "last_run_at:", "last_outcome:"]) {
      expect(status.stdout).toContain(field);
    }

    const list = await run(["list"], fixture);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toMatch(/^fix-thread-1 {2}kb {2}fixture {2}sdk {2}finished\n$/);

    const filtered = await run(["list", "--endpoint", "elsewhere"], fixture);
    expect(filtered.exitCode).toBe(0);
    expect(filtered.stdout).toBe("");
  });
});

describe("ukp session · no-transcript invariant (spec §6)", () => {
  test("the data directory holds only the whitelisted files after spawn + send", async () => {
    const fixture = createFixture({ manifestSession: '[capabilities.session]\nagents = ["fixture"]\n' });
    fixture.extendRegistry(agentsTable([{ handle: "fixture", command: [nodeExecutable, fixtureExecutable] }]));
    await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "first"], fixture, "ok");
    await run(["send", "fix-thread-1", "--text", "second"], fixture, "resume-ok");

    const dataDir = join(fixture.root);
    const allowed = new Set(["registry.toml", "registry.toml.bak", "registry.toml.lock", "sessions.json", "kb-service"]);
    const unexpected = readdirSync(dataDir).filter((entry) => !allowed.has(entry));
    expect(unexpected).toEqual([]);
    const storeRaw = JSON.parse(JSON.stringify(loadSessionRecords(sessionStorePath(fixture.registryPath))));
    expect(JSON.stringify(storeRaw)).not.toContain("first");
    expect(JSON.stringify(storeRaw)).not.toContain("second");
  });
});

describe("ukp session · manifest declaration validation (spec §1)", () => {
  test("agents declared both flat and under config is a declaration conflict", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-session-"));
    fixtures.push({ root, registryPath: join(root, "registry.toml"), endpointFolder: join(root, "s"), extendRegistry: () => {} });
    const folder = join(root, "s");
    mkdirSync(join(folder, ".ukp"), { recursive: true });
    writeFileSync(join(folder, ".ukp", "service.toml"), `name = "kb"\n[capabilities.session]\nagents = ["a"]\n[capabilities.session.config]\nagents = ["b"]\n`);
    expect(() => loadManifest(folder)).toThrow(ManifestError);
    rmSync(root, { recursive: true, force: true });
  });

  test("handle longer than 63 chars is rejected (ENDPOINT_NAME length bound)", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-session-"));
    fixtures.push({ root, registryPath: join(root, "registry.toml"), endpointFolder: join(root, "s"), extendRegistry: () => {} });
    const folder = join(root, "s");
    mkdirSync(join(folder, ".ukp"), { recursive: true });
    const longHandle = "a".repeat(64);
    writeFileSync(join(folder, ".ukp", "service.toml"), `name = "kb"\n[capabilities.session]\nagents = ["${longHandle}"]\n`);
    expect(() => loadManifest(folder)).toThrow(/invalid handle/);
    rmSync(root, { recursive: true, force: true });
  });

  test("a provider other than 'agent' is a hard error", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-session-"));
    fixtures.push({ root, registryPath: join(root, "registry.toml"), endpointFolder: join(root, "s"), extendRegistry: () => {} });
    const folder = join(root, "s");
    mkdirSync(join(folder, ".ukp"), { recursive: true });
    writeFileSync(join(folder, ".ukp", "service.toml"), `name = "kb"\n[capabilities.session]\nprovider = "qmd"\nagents = ["a"]\n`);
    expect(() => loadManifest(folder)).toThrow(/provider must be 'agent'/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("mapSubstrateItem · pairing invariant unit (spec §4)", () => {
  test("items after a terminal boundary map to nothing", () => {
    const state = { threadId: "t", runId: "r", runStartedEmitted: true, terminalKind: undefined } as Parameters<typeof mapSubstrateItem>[1];
    const first = mapSubstrateItem({ type: "turn.failed", error: { message: "x" } }, state);
    expect(first.map((event) => event.type)).toEqual(["RUN_ERROR"]);
    const second = mapSubstrateItem({ type: "error", message: "late" }, state);
    expect(second).toEqual([]);
  });
});
