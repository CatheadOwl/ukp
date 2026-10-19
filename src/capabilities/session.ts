// ukp_session W1→W2/G3 (line spec: workunits/ukp_session/spec/session-command.md;
// ADR-SESSION-001/002/003; extraction ruling w2-extraction-ruling.md X4):
// the session capability core in WRAPPER form. UKP owns naming and relay
// only (core-idea D-1): conversation history lives in the agent's own
// global space, so this module persists the host-scoped address book and
// nothing else — the no-transcript invariant is a spec §6 test anchor.
//
// The substrate mechanism (argv mapping, AG-UI synthesis, resume, sandbox
// pinning) retired to the amux binary in W2/G3 — ukp spawns it per
// invocation and consumes its structured face (the rg precedent: the
// wrapped tool holds the structured surface; the wrapper holds policy).
// amux's README is the tool contract authority; ukp never imports its
// source. The migration is provenance, not implementation.
//
// Layers (ADR 0021): this module owns the amux consumption mechanism and
// classified errors; the CLI adapter (commands/session.ts) owns argument
// surfaces, exit codes and channel text.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionWriteTier } from "../config/agent-backed.ts";
import { toolRelayArgv, TOOL_NOT_FOUND_EXIT } from "../spawn-relay.ts";

// ---- Classified errors (ADR 0021: capability classifies, CLI maps codes)

export type SessionErrorClass =
  | "usage"
  | "not-authorized"
  | "run-failed"
  | "substrate-unavailable";

export class SessionError extends Error {
  constructor(
    readonly errorClass: SessionErrorClass,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionError";
  }
}

// ---- Address book (spec §6): host-scoped, id = the agent's native id

export interface SessionRecord {
  id: string;
  endpoint: string;
  agent: string;
  tier: "sdk";
  owner: string;
  created_at: string;
  last_run_at: string;
  last_outcome: "finished" | "failed" | "unknown";
}

export function sessionStorePath(registryPath: string): string {
  return join(dirname(registryPath), "sessions.json");
}

export function loadSessionRecords(storePath: string): SessionRecord[] {
  if (!existsSync(storePath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(storePath, "utf8"));
  } catch (error) {
    throw new SessionError("usage", `session address book is not readable: ${storePath}`, { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new SessionError("usage", `session address book is malformed: ${storePath}`);
  }
  return parsed as SessionRecord[];
}

function writeSessionRecords(storePath: string, records: readonly SessionRecord[]): void {
  // Atomic write (temp + rename), the registry's own durability discipline.
  const directory = dirname(storePath);
  mkdirSync(directory, { recursive: true });
  const tempPath = `${storePath}.tmp.${randomUUID()}`;
  writeFileSync(tempPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  try {
    renameSync(tempPath, storePath);
  } catch (error) {
    unlinkSync(tempPath);
    throw error;
  }
}

export function appendSessionRecord(storePath: string, record: SessionRecord): void {
  const records = loadSessionRecords(storePath);
  records.push(record);
  writeSessionRecords(storePath, records);
}

export function updateSessionRecord(
  storePath: string,
  id: string,
  lastRunAt: string,
  lastOutcome: "finished" | "failed",
): void {
  const records = loadSessionRecords(storePath);
  const record = records.find((candidate) => candidate.id === id);
  if (record === undefined) return;
  record.last_run_at = lastRunAt;
  record.last_outcome = lastOutcome;
  writeSessionRecords(storePath, records);
}

/** Single-id resolution; the agent-native id namespace spans agents, so a
 * collision is possible by construction — it degrades to a usage error
 * listing the candidates (spec §3). */
export function resolveSessionRecord(records: readonly SessionRecord[], id: string): SessionRecord {
  const matches = records.filter((record) => record.id === id);
  if (matches.length === 0) {
    throw new SessionError("usage", `unknown session '${id}' (see 'ukp session list')`);
  }
  if (matches.length > 1) {
    const candidates = matches
      .map((record) => `${record.id} (endpoint ${record.endpoint}, agent ${record.agent})`)
      .join("; ");
    throw new SessionError(
      "usage",
      `session id '${id}' is ambiguous across agents: ${candidates} — address it after re-spawning, or prune the address book`,
    );
  }
  return matches[0]!;
}

// ---- amux consumption (spec §4, wrapper form). The mechanism contract:
// ukp invokes `amux` with `--events`, consumes the AG-UI JSONL, and derives
// everything it needs from the event stream. amux's human stderr is never
// forwarded on the success path (the command layer writes its own
// endpoint-flavored notes); amux's classified stderr lines are consulted
// only when the process exits non-zero without a derivable outcome.

/** amux's sandbox vocabulary (README trust model): pinned in both
 * directions so the substrate's own default is never ridden. */
export type AmuxSandboxTier = "read-only" | "workspace-write";

/** The endpoint-declared write tier mapped onto amux's invocation flag —
 * the policy vocabulary (manifest `write`) never leaks into the mechanism
 * argv (ADR-SESSION-004: the grant is resolved before the spawn). */
export function amuxSandboxTier(write: SessionWriteTier): AmuxSandboxTier {
  return write === "workspace" ? "workspace-write" : "read-only";
}

export type AmuxInvocation =
  | {
      kind: "spawn";
      /** Endpoint folder — amux anchors the session to this path. */
      folder: string;
      /** The registry-declared agent command, passed through verbatim. */
      agentCommand: readonly string[];
      prompt: string;
      sandbox: AmuxSandboxTier;
    }
  | {
      kind: "send";
      /** Native session id to resume. */
      sessionId: string;
      prompt: string;
      sandbox: AmuxSandboxTier;
    };

/** What ukp derives from one amux invocation (spec §4 derivation rules). */
export interface AmuxRunOutcome {
  /** First event's threadId (spawn: the native session id); undefined when
   * amux emitted no events at all. */
  threadId?: string;
  outcome: "finished" | "failed";
  /** The turn's final agent message — the default report face. */
  finalMessage?: string;
  /** Failure detail for the command layer's stderr note. */
  detail?: string;
  /** The AG-UI JSONL lines verbatim (amux's face, ukp never rewrites) —
   * the `--events` passthrough payload. */
  eventLines: readonly string[];
}

export interface AmuxRunOptions {
  /** Explicit amux command (test injection, the rg.ts rgCommand precedent);
   * never wrapped in the win32 relay. */
  amuxCommand?: readonly string[];
}

/** Default amux location: the PATH binary (rg precedent — no bundled copy,
 * no version negotiation; the wrapped tool owns its own distribution). */
export function defaultAmuxCommand(): readonly string[] {
  return ["amux"];
}

/** UKP_AMUX env override: the amux binary to spawn instead of the PATH
 * lookup (explicit override — spawned as given, never relay-wrapped). */
export function amuxCommandFromEnvironment(): readonly string[] | undefined {
  const value = process.env.UKP_AMUX;
  return value === undefined || value.trim() === "" ? undefined : [value];
}

export function resolveAmuxCommand(options?: AmuxRunOptions): readonly string[] {
  return options?.amuxCommand ?? amuxCommandFromEnvironment() ?? defaultAmuxCommand();
}

/** Same env knob and defaults as the provider timeout (qmd) — spec §5
 * deliberately reuses UKP_PROVIDER_TIMEOUT_MS; minimum 1s. The value is
 * forwarded to amux as AMUX_TIMEOUT_MS so both layers run on one deadline
 * instead of racing two different defaults. */
export function sessionSubstrateTimeoutMs(): number {
  const raw = process.env.UKP_PROVIDER_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return 60_000;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000) return 60_000;
  return parsed;
}

/** The amux invocation argv (without the binary): `amux <folder>
 * <command...> --events --sandbox <tier> --text <prompt>` or the send
 * form. `--events` is always on — the event stream is how ukp derives
 * id/outcome/report; the caller's `--events` only selects what ukp
 * re-emits on stdout. */
export function amuxInvocationArgv(request: AmuxInvocation): string[] {
  const tail = ["--events", "--sandbox", request.sandbox, "--text", request.prompt];
  return request.kind === "spawn"
    ? [request.folder, ...request.agentCommand, ...tail]
    : ["send", request.sessionId, ...tail];
}

/** amux's classified stderr line: `amux: <label>: <message>` (exit codes
 * 2 = usage, 1 = runtime, the label carries the classification). Mapped
 * onto ukp's classes; labels inherit amux's vocabulary so the wrapper's
 * classification stays honest about which layer failed. */
const AMUX_ERROR_CLASS_BY_LABEL: Readonly<Record<string, SessionErrorClass>> = {
  "usage error": "usage",
  "run failed": "run-failed",
  "agent substrate unavailable": "substrate-unavailable",
};

function parseAmuxClassifiedLine(stderrText: string): { errorClass: SessionErrorClass; message: string } | undefined {
  for (const line of stderrText.split(/\r?\n/)) {
    const match = /^amux: ([^:]+): (.*)$/.exec(line);
    if (match === null) continue;
    const errorClass = AMUX_ERROR_CLASS_BY_LABEL[match[1]!];
    if (errorClass !== undefined) return { errorClass, message: match[2]! };
  }
  return undefined;
}

/** ukp owns the timeout knob; amux's remedy text is re-pointed so the
 * user-facing knob stays UKP_PROVIDER_TIMEOUT_MS (spec §4). */
function inheritAmuxMessage(message: string): string {
  return message.replaceAll("AMUX_TIMEOUT_MS", "UKP_PROVIDER_TIMEOUT_MS");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function amuxUnavailableMessage(command: readonly string[], reason: string): string {
  return `amux is not available (${reason}: '${command.join(" ")}') — install amux on PATH or set UKP_AMUX to its binary`;
}

/** Runs one amux invocation and derives the outcome from its AG-UI event
 * stream (spec §4): id = first event threadId, finalMessage = last
 * TEXT_MESSAGE_CONTENT, outcome = last RUN_FINISHED/RUN_ERROR with the
 * amux exit code as the final authority. When the stream ends without a
 * terminal event, the exit-code synthesis rule closes the pair — a
 * defensive backstop one layer up from amux's own guarantee. */
export async function runAmuxSession(
  request: AmuxInvocation,
  options: AmuxRunOptions = {},
): Promise<AmuxRunOutcome> {
  const command = resolveAmuxCommand(options);
  const argv = [...command, ...amuxInvocationArgv(request)];
  // Win32 default-PATH spawns ride the powershell relay (the rg precedent:
  // the direct bun→tool edge is Defender-taxed, and npm .cmd shims do not
  // resolve without it). Explicit overrides (context or UKP_AMUX) are
  // spawned as given — the rg rule that test injections stay unwrapped.
  const explicitCommand = options.amuxCommand !== undefined || amuxCommandFromEnvironment() !== undefined;
  const spawnArgv = process.platform === "win32" && !explicitCommand
    ? toolRelayArgv(argv, { notFoundGuard: true })
    : argv;

  let child: import("bun").Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(spawnArgv, {
      // Spec §7.2 (local single-user tier): the process environment equals
      // the caller's, plus the shared timeout knob — amux runs its own
      // substrate timer on the same deadline instead of a second default.
      env: { ...process.env, AMUX_TIMEOUT_MS: String(sessionSubstrateTimeoutMs()) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new SessionError("substrate-unavailable", amuxUnavailableMessage(command, "failed to start"), {
      cause: error,
    });
  }

  const timedOut = { value: false };
  const timer = setTimeout(() => {
    timedOut.value = true;
    child.kill("SIGTERM");
  }, sessionSubstrateTimeoutMs());

  const eventLines: string[] = [];
  let threadId: string | undefined;
  let finalMessage: string | undefined;
  let terminal: { kind: "finished" | "failed"; runId?: string } | undefined;
  let lastRunId: string | undefined;

  const drainStderr = async (): Promise<string> => {
    const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  };
  const drainStdout = async (): Promise<void> => {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === "") continue;
        eventLines.push(line);
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // Non-JSON noise on the events channel: passed through, never derived from.
        }
        if (!isRecord(event)) continue;
        if (threadId === undefined && typeof event.threadId === "string") threadId = event.threadId;
        if (typeof event.runId === "string") lastRunId = event.runId;
        if (event.type === "TEXT_MESSAGE_CONTENT" && typeof event.content === "string") {
          finalMessage = event.content;
        }
        if (event.type === "RUN_FINISHED") terminal = { kind: "finished", runId: lastRunId };
        if (event.type === "RUN_ERROR") terminal = { kind: "failed", runId: lastRunId };
        newline = buffer.indexOf("\n");
      }
    }
  };

  let stderrText = "";
  let amuxExitCode: number | null = null;
  try {
    await Promise.all([
      drainStdout(),
      drainStderr().then((text) => {
        stderrText = text;
      }),
    ]);
    amuxExitCode = await child.exited;
  } finally {
    clearTimeout(timer);
  }

  const stderrTail = stderrText.trim().split(/\r?\n/).filter((line) => line !== "").slice(-3).join(" | ");
  const tailSuffix = stderrTail === "" ? "" : `: ${stderrTail}`;
  const classified = parseAmuxClassifiedLine(stderrText);

  if (timedOut.value) {
    throw new SessionError(
      "substrate-unavailable",
      `amux timed out after ${sessionSubstrateTimeoutMs() / 1000}s (set UKP_PROVIDER_TIMEOUT_MS to adjust)`,
    );
  }
  if (amuxExitCode === TOOL_NOT_FOUND_EXIT && process.platform === "win32" && !explicitCommand) {
    throw new SessionError("substrate-unavailable", amuxUnavailableMessage(command, "not found on PATH"));
  }

  if (eventLines.length === 0) {
    // amux produced no event stream: a mechanism/substrate failure before
    // the first event (amux classifies its own; the classes inherit).
    if (classified !== undefined) {
      throw new SessionError(classified.errorClass, inheritAmuxMessage(classified.message));
    }
    if (amuxExitCode === 2) {
      throw new SessionError("usage", `amux exited with a usage error (code 2)${tailSuffix}`);
    }
    throw new SessionError("substrate-unavailable", `amux exited without events (code ${amuxExitCode ?? "signal"})${tailSuffix}`);
  }

  if (terminal === undefined) {
    // Backstop synthesis (amux already closes every pair; this covers an
    // amux crash mid-stream): the exit code decides the boundary.
    const failed = amuxExitCode !== 0;
    const event = {
      type: failed ? "RUN_ERROR" : "RUN_FINISHED",
      threadId: threadId ?? (request.kind === "send" ? request.sessionId : randomUUID()),
      runId: lastRunId ?? randomUUID(),
      ...(failed ? { message: `amux exited with code ${amuxExitCode ?? "signal"}` } : {}),
    };
    eventLines.push(JSON.stringify(event));
    terminal = { kind: failed ? "failed" : "finished", runId: event.runId };
  }

  // The process is the final authority on its own outcome: a non-zero
  // amux exit fails the run even when the stream claimed RUN_FINISHED.
  const failed = amuxExitCode !== 0 || terminal.kind === "failed";
  return {
    ...(threadId === undefined ? {} : { threadId }),
    outcome: failed ? "failed" : "finished",
    ...(finalMessage === undefined ? {} : { finalMessage }),
    ...(failed
      ? {
          detail: terminal.kind === "failed" && terminal.runId !== undefined
            ? `see RUN_ERROR on run ${terminal.runId}`
            : `amux exited with code ${amuxExitCode ?? "signal"}`,
        }
      : {}),
    eventLines,
  };
}
