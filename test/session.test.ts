import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executeSessionCommand,
} from "../src/commands/session.ts";
import { loadSessionRecords, sessionStorePath } from "../src/capabilities/session.ts";
import { loadManifest, ManifestError } from "../src/config/manifest.ts";
import { registerAt } from "../src/registry.ts";

// W2/G3 wrapper tests: the substrate mechanism (argv mapping, AG-UI
// synthesis, resume) retired to the amux repo — ukp tests drive the
// wrapper through a fake amux binary (fixtures/session-provider/amux-shim.mjs)
// that speaks the amux --events face, and keep every policy anchor:
// authorization gate states, write-tier per-run re-evaluation, exit-code
// mapping, per-subcommand help, send resume passthrough, the address-book
// whitelist (INV-19) and the no-transcript invariant.

const amuxShim = join(import.meta.dir, "fixtures", "session-provider", "amux-shim.mjs");
const nodeExecutable = Bun.which("node") ?? process.execPath;
const amuxCommand = [nodeExecutable, amuxShim];

interface Fixture {
  root: string;
  registryPath: string;
  endpointFolder: string;
  /** Appends verbatim TOML content (e.g. [[agents]] tables) to the registry. */
  extendRegistry: (content: string) => void;
  /** Appends the default [[agents]] block exactly once (duplicate handles
   * are a registry schema error, not a no-op). */
  ensureDefaultAgents: () => void;
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
  let defaultAgentsSeeded = false;
  const fixture: Fixture = {
    root,
    registryPath,
    endpointFolder,
    extendRegistry(content) {
      appendFileSync(registryPath, content);
    },
    ensureDefaultAgents() {
      if (defaultAgentsSeeded) return;
      appendFileSync(registryPath, defaultAgents);
      defaultAgentsSeeded = true;
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

/** [[agents]] block with TOML-safe (JSON-produced basic) strings. The
 * command is policy data (passed through to amux verbatim); the fake amux
 * never spawns it — the echo-argv scenario reflects it instead. */
function agentsTable(entries: ReadonlyArray<{ handle: string; command: readonly string[] }>): string {
  return entries
    .map((entry) => `[[agents]]\nhandle = ${JSON.stringify(entry.handle)}\ntier = "sdk"\ncommand = [${entry.command.map((part) => JSON.stringify(part)).join(", ")}]\n`)
    .join("");
}

const defaultAgents = agentsTable([{ handle: "fixture", command: ["fake-agent"] }]);

function hostingOn(write?: string): string {
  return `[capabilities.session]\nagents = ["fixture"]${write === undefined ? "" : `\nwrite = ${JSON.stringify(write)}`}\n`;
}

async function run(args: readonly string[], fixture: Fixture, scenario?: string) {
  const had = Object.hasOwn(process.env, "AMUX_SHIM_SCENARIO");
  const previous = process.env.AMUX_SHIM_SCENARIO;
  if (scenario !== undefined) process.env.AMUX_SHIM_SCENARIO = scenario;
  try {
    return await executeSessionCommand(args, { registryPath: fixture.registryPath, amuxCommand });
  } finally {
    if (scenario !== undefined) {
      if (had) process.env.AMUX_SHIM_SCENARIO = previous;
      else delete process.env.AMUX_SHIM_SCENARIO;
    }
  }
}

function stdoutEvents(result: { stdout: string }): Array<Record<string, unknown>> {
  return result.stdout.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The echo-argv scenario reflects ukp's full amux argv as the report. */
async function echoAmuxArgv(args: readonly string[], fixture: Fixture): Promise<{ args: string[]; isSend: boolean }> {
  fixture.ensureDefaultAgents();
  const result = await run(args, fixture, "echo-argv");
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as { args: string[]; isSend: boolean };
}

describe("ukp session · help and dispatch (spec §3; TODO 20261018-2345)", () => {
  test("group help lists subcommands and reserved verbs", async () => {
    const result = await run(["--help"], createFixture());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("spawn");
    expect(result.stdout).toContain("final report");
    expect(result.stdout).toContain("--events");
    expect(result.stdout).toContain("Reserved (app-server tier, not in v0): wait, answer, stop");
  });

  test("spawn --help renders the spawn usage face, not the group help", async () => {
    const result = await run(["spawn", "--help"], createFixture());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: ukp session spawn --endpoint <name> --agent <handle> (--brief <file> | --text <string>) [--events]");
    expect(result.stdout).toContain("--brief <file>");
    expect(result.stdout).toContain("--text <string>");
    expect(result.stdout).not.toContain("Subcommands:");
  });

  test("send --help renders the send usage face including the per-run write re-read", async () => {
    const result = await run(["send", "--help"], createFixture());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: ukp session send <id> (--brief <file> | --text <string>) [--events]");
    expect(result.stdout).toContain("<id>");
    expect(result.stdout).toContain("revoking write downgrades the next");
    expect(result.stdout).not.toContain("Subcommands:");
  });

  test("status and list --help render their own single usage lines", async () => {
    const status = await run(["status", "--help"], createFixture());
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Usage: ukp session status <id>");
    expect(status.stdout).not.toContain("spawn");
    const list = await run(["list", "--help"], createFixture());
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("Usage: ukp session list [--endpoint <name>]");
    expect(list.stdout).not.toContain("spawn");
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

describe("ukp session · wrapper→amux argv (spec §4 consumption face)", () => {
  test("spawn passes amux <folder> <command...> --events --sandbox read-only --text <prompt>", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    const argv = await echoAmuxArgv(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "hello world"], fixture);
    expect(argv.isSend).toBe(false);
    expect(argv.args[0]).toBe(fixture.endpointFolder);
    expect(argv.args[1]).toBe("fake-agent");
    expect(argv.args).toContain("--events");
    expect(argv.args).toEqual(expect.arrayContaining(["--sandbox", "read-only"]));
    expect(argv.args.slice(-2)).toEqual(["--text", "hello world"]);
  });

  test("write = \"workspace\" maps to the workspace-write sandbox tier", async () => {
    const fixture = createFixture({ manifestSession: hostingOn("workspace") });
    const argv = await echoAmuxArgv(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "hi"], fixture);
    expect(argv.args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
  });

  test("--brief file content rides --text verbatim (INV-20)", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    fixture.ensureDefaultAgents();
    const briefPath = join(fixture.root, "brief.md");
    writeFileSync(briefPath, "hello brief", "utf8");
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--brief", briefPath], fixture, "ok");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("echo:hello brief\n");
  });

  test("send passes amux send <id> --events --sandbox <tier> --text <prompt>", async () => {
    const fixture = createFixture({ manifestSession: hostingOn("workspace") });
    fixture.ensureDefaultAgents();
    await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "first"], fixture, "ok");
    const argv = await echoAmuxArgv(["send", "fix-thread-1", "--text", "again"], fixture);
    expect(argv.isSend).toBe(true);
    expect(argv.args[0]).toBe("send");
    expect(argv.args[1]).toBe("fix-thread-1");
    expect(argv.args).toContain("--events");
    expect(argv.args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
    expect(argv.args.slice(-2)).toEqual(["--text", "again"]);
  });

  test("UKP_AMUX overrides the amux binary (unavailable binary is classified)", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    fixture.ensureDefaultAgents();
    const had = Object.hasOwn(process.env, "UKP_AMUX");
    const previous = process.env.UKP_AMUX;
    process.env.UKP_AMUX = "definitely-not-amux-xyz";
    try {
      const result = await executeSessionCommand(
        ["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "x"],
        { registryPath: fixture.registryPath },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("agent substrate unavailable");
      expect(result.stderr).toContain("amux is not available");
      expect(result.stderr).toContain("UKP_AMUX");
    } finally {
      if (had) process.env.UKP_AMUX = previous;
      else delete process.env.UKP_AMUX;
    }
  });
});

describe("ukp session · write tier (endpoint-declared, owner ruling 2026-10-18)", () => {
  test("an invalid write value fails at manifest load as not-authorized", async () => {
    const fixture = createFixture({ manifestSession: hostingOn("full") });
    fixture.ensureDefaultAgents();
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "hi"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("authorization declaration is unreadable");
    expect(result.stderr).toContain("'write' must be \"workspace\"");
  });

  test("write declared both flat and under .config is a declaration conflict", () => {
    const fixture = createFixture({
      manifestSession: '[capabilities.session]\nagents = ["fixture"]\nwrite = "workspace"\n[capabilities.session.config]\nwrite = "workspace"\n',
    });
    expect(() => loadManifest(fixture.endpointFolder)).toThrow(ManifestError);
    expect(() => loadManifest(fixture.endpointFolder)).toThrow("declared both directly and under");
  });

  test("send re-reads the write tier per run — revoking write downgrades the next send", async () => {
    const fixture = createFixture({ manifestSession: hostingOn("workspace") });
    const argv = await echoAmuxArgv(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "hi"], fixture);
    expect(argv.args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
    // The owner revokes write; identity (the address-book entry) survives.
    writeFileSync(
      join(fixture.endpointFolder, ".ukp", "service.toml"),
      `name = "kb"\n[capabilities.nav]\nprovider = "file"\n${hostingOn()}`,
    );
    const sent = await echoAmuxArgv(["send", "fix-thread-1", "--text", "again"], fixture);
    expect(sent.args).toEqual(expect.arrayContaining(["--sandbox", "read-only"]));
  });

  test("send re-reads the declaration too — an unreadable manifest refuses the send", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    fixture.ensureDefaultAgents();
    await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "hi"], fixture, "ok");
    writeFileSync(
      join(fixture.endpointFolder, ".ukp", "service.toml"),
      `name = "kb"\n[capabilities.nav]\nprovider = "file"\n[capabilities.session]\nagents = ["fixture"]\nwrite = "full"\n`,
    );
    const result = await run(["send", "fix-thread-1", "--text", "again"], fixture, "ok");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("session-hosting not authorized");
    expect(result.stderr).toContain("authorization declaration is unreadable");
  });
});

describe("ukp session spawn · authorization gate (spec §1/§5)", () => {
  test("no [capabilities.session] declaration → not authorized, exit 1", async () => {
    const fixture = createFixture();
    fixture.ensureDefaultAgents();
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "hi"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("session-hosting not authorized");
    expect(result.stderr).toContain("hosting is off for endpoint 'kb'");
    expect(result.stdout).toBe("");
  });

  test("empty allowlist = explicit off → not authorized", async () => {
    const fixture = createFixture({ manifestSession: "[capabilities.session]\nagents = []\n" });
    fixture.ensureDefaultAgents();
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "hi"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("session-hosting not authorized");
  });

  test("handle not in allowlist → not authorized, allowed list shown", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    fixture.ensureDefaultAgents();
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "other", "--text", "hi"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("agent 'other' is not in endpoint 'kb' [capabilities.session] agents (allowed: fixture)");
  });

  test("handle without a registry [[agents]] entry → substrate unavailable", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    fixture.extendRegistry(agentsTable([{ handle: "someone-else", command: ["fake-agent"] }]));
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "hi"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("agent substrate unavailable");
    expect(result.stderr).toContain("[[agents]]");
  });

  test("unknown endpoint and missing prompt are usage errors (exit 2)", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    fixture.ensureDefaultAgents();
    const unknown = await run(["spawn", "--endpoint", "nope", "--agent", "fixture", "--text", "hi"], fixture);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain("unknown endpoint 'nope'");
    const noPrompt = await run(["spawn", "--endpoint", "kb", "--agent", "fixture"], fixture);
    expect(noPrompt.exitCode).toBe(2);
    expect(noPrompt.stderr).toContain("one of --brief <file> or --text <string> is required");
  });
});

describe("ukp session · run faces through the amux event stream (spec §3/§4)", () => {
  test("ok run: report on stdout, ukp's own endpoint-flavored notes, amux notes suppressed", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    fixture.ensureDefaultAgents();
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "hi"], fixture, "ok");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("echo:hi\n");
    expect(result.stderr).toBe("session fix-thread-1 started (agent fixture, tier sdk, endpoint kb)\nsession fix-thread-1 finished\n");

    const record = loadSessionRecords(sessionStorePath(fixture.registryPath))[0]!;
    expect(record).toMatchObject({ id: "fix-thread-1", endpoint: "kb", agent: "fixture", tier: "sdk", last_outcome: "finished" });
  });

  test("--events passes the amux AG-UI JSONL through verbatim", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    fixture.ensureDefaultAgents();
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "hello brief", "--events"], fixture, "ok");
    expect(result.exitCode).toBe(0);
    const events = stdoutEvents(result);
    expect(events[0]).toMatchObject({ type: "RUN_STARTED", threadId: "fix-thread-1" });
    const boundaries = events.filter((event) => event.type === "RUN_STARTED" || event.type === "RUN_FINISHED" || event.type === "RUN_ERROR");
    expect(boundaries.map((event) => event.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
    const textContent = events.find((event) => event.type === "TEXT_MESSAGE_CONTENT");
    expect(textContent).toMatchObject({ messageId: "m1", content: "echo:hello brief" });
  });

  test("RUN_ERROR run: exit 1, last agent message still the report, failed outcome recorded", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    fixture.ensureDefaultAgents();
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "x"], fixture, "failed");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("about to fail\n");
    expect(result.stderr).toContain("session fix-thread-1 failed");
    expect(result.stderr).toContain("see RUN_ERROR on run run-1");
    expect(loadSessionRecords(sessionStorePath(fixture.registryPath))[0]?.last_outcome).toBe("failed");
  });

  test("claimed RUN_FINISHED with non-zero amux exit still fails the run", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    fixture.ensureDefaultAgents();
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "x"], fixture, "finish-exit-1");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("session fix-thread-1 failed");
    expect(result.stderr).toContain("amux exited with code 1");
  });

  test("stream without a terminal event closes with a synthesized RUN_FINISHED (backstop rule)", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    fixture.ensureDefaultAgents();
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "x", "--events"], fixture, "no-terminal");
    expect(result.exitCode).toBe(0);
    const events = stdoutEvents(result);
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", threadId: "fix-thread-1" });
  });

  test("amux substrate failure (no events, classified stderr) inherits the classification", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    fixture.ensureDefaultAgents();
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "x"], fixture, "substrate-error");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("agent substrate unavailable");
    expect(result.stderr).toContain("agent command 'fake-agent' failed to start");
    expect(result.stdout).toBe("");
    expect(loadSessionRecords(sessionStorePath(fixture.registryPath))).toHaveLength(0);
  });

  test("amux usage error maps to exit 2 with the inherited classification", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    fixture.ensureDefaultAgents();
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "x"], fixture, "usage-error");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage error");
    expect(result.stderr).toContain("--sandbox must be read-only or workspace-write");
  });

  test("amux run-failed classification maps to exit 1 run failed", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    fixture.ensureDefaultAgents();
    const result = await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "x"], fixture, "run-failed-error");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("run failed");
    expect(result.stderr).toContain("fixture boom");
  });
});

describe("ukp session send · resume semantics (spec §3)", () => {
  async function spawnOnce(fixture: Fixture): Promise<void> {
    await run(["spawn", "--endpoint", "kb", "--agent", "fixture", "--text", "first"], fixture, "ok");
  }

  test("resume delivers one more turn and keeps the same session id", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    fixture.ensureDefaultAgents();
    await spawnOnce(fixture);

    const result = await run(["send", "fix-thread-1", "--text", "second turn"], fixture, "resume-ok");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("resume:fix-thread-1 echo:second turn\n");
    expect(result.stderr).toContain("session fix-thread-1 resumed");

    const eventsResult = await run(["send", "fix-thread-1", "--text", "third turn", "--events"], fixture, "resume-ok");
    expect(eventsResult.exitCode).toBe(0);
    const events = stdoutEvents(eventsResult);
    expect(events[0]).toMatchObject({ type: "RUN_STARTED", threadId: "fix-thread-1" });

    const record = loadSessionRecords(sessionStorePath(fixture.registryPath))[0]!;
    expect(record.last_outcome).toBe("finished");
  });

  test("unknown id is a usage error listing the way out", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    const result = await run(["send", "no-such-id", "--text", "x"], fixture);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown session 'no-such-id'");
  });

  test("id collision across agents is a usage error listing candidates", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
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
    const fixture = createFixture({ manifestSession: hostingOn() });
    fixture.ensureDefaultAgents();
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

describe("ukp session · no-transcript invariant (spec §6, INV-19)", () => {
  test("the data directory holds only the whitelisted files after spawn + send", async () => {
    const fixture = createFixture({ manifestSession: hostingOn() });
    fixture.ensureDefaultAgents();
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
    fixtures.push({ root, registryPath: join(root, "registry.toml"), endpointFolder: join(root, "s"), extendRegistry: () => {}, ensureDefaultAgents: () => {} });
    const folder = join(root, "s");
    mkdirSync(join(folder, ".ukp"), { recursive: true });
    writeFileSync(join(folder, ".ukp", "service.toml"), `name = "kb"\n[capabilities.session]\nagents = ["a"]\n[capabilities.session.config]\nagents = ["b"]\n`);
    expect(() => loadManifest(folder)).toThrow(ManifestError);
    rmSync(root, { recursive: true, force: true });
  });

  test("handle longer than 63 chars is rejected (ENDPOINT_NAME length bound)", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-session-"));
    fixtures.push({ root, registryPath: join(root, "registry.toml"), endpointFolder: join(root, "s"), extendRegistry: () => {}, ensureDefaultAgents: () => {} });
    const folder = join(root, "s");
    mkdirSync(join(folder, ".ukp"), { recursive: true });
    const longHandle = "a".repeat(64);
    writeFileSync(join(folder, ".ukp", "service.toml"), `name = "kb"\n[capabilities.session]\nagents = ["${longHandle}"]\n`);
    expect(() => loadManifest(folder)).toThrow(/invalid handle/);
    rmSync(root, { recursive: true, force: true });
  });

  test("a provider other than 'agent' is a hard error", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-session-"));
    fixtures.push({ root, registryPath: join(root, "registry.toml"), endpointFolder: join(root, "s"), extendRegistry: () => {}, ensureDefaultAgents: () => {} });
    const folder = join(root, "s");
    mkdirSync(join(folder, ".ukp"), { recursive: true });
    writeFileSync(join(folder, ".ukp", "service.toml"), `name = "kb"\n[capabilities.session]\nprovider = "qmd"\nagents = ["a"]\n`);
    expect(() => loadManifest(folder)).toThrow(/provider must be 'agent'/);
    rmSync(root, { recursive: true, force: true });
  });
});
