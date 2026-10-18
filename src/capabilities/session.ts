// ukp_session W1 (line spec: workunits/ukp_session/spec/session-command.md;
// ADR-SESSION-001/002/003): the session capability core. UKP owns naming
// and relay only (core-idea D-1): conversation history lives in the agent's
// own global space, so this module persists the host-scoped address book
// and nothing else — the no-transcript invariant is a spec §6 test anchor.
//
// Layers (ADR 0021): this module owns mechanisms and classified errors;
// the CLI adapter (commands/session.ts) owns argument surfaces, exit codes
// and channel text.

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

// ---- Substrate adapter (SDK tier, spec §4): spawn / resume + AG-UI mapping

export interface AgentSubstrate {
  handle: string;
  tier: "sdk";
  command: readonly string[];
}

export interface SessionRunRequest {
  /** Endpoint folder — the session's working anchor (cwd + --cd). */
  folder: string;
  /** Brief (spawn) or message (send); passed through verbatim (spec §7). */
  prompt: string;
  /** Native id to resume (send); absent on spawn. */
  resumeId?: string;
}

export interface SessionRunOutcome {
  /** Native id captured from thread.started (spawn); undefined when the
   * substrate never announced one (run failed before the first event). */
  nativeId?: string;
  outcome: "finished" | "failed";
  detail?: string;
}

/** AG-UI event emitted to the consumer; `threadId` is the session id. */
export interface SessionEvent {
  type: string;
  threadId: string;
  runId: string;
  [key: string]: unknown;
}

/** Same env knob and defaults as the provider timeout (qmd) — spec §5
 * deliberately reuses UKP_PROVIDER_TIMEOUT_MS; minimum 1s. */
export function sessionSubstrateTimeoutMs(): number {
  const raw = process.env.UKP_PROVIDER_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return 60_000;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000) return 60_000;
  return parsed;
}

interface RunBoundaryState {
  threadId: string;
  runId: string;
  runStartedEmitted: boolean;
  /** Terminal kind once a RUN_FINISHED/RUN_ERROR boundary has been emitted
   * (substrate or synthesized) — drives the address-book outcome. */
  terminalKind?: "finished" | "error";
  nativeId?: string;
}

/** Maps one substrate JSONL item to zero or more AG-UI events per the
 * spec §4 table; pure — the run-boundary synthesis rules are applied by
 * the caller so the table stays independently testable. */
export function mapSubstrateItem(
  item: Record<string, unknown>,
  state: RunBoundaryState,
): SessionEvent[] {
  // Pairing invariant (spec §4): once a terminal boundary has been emitted,
  // the run is closed — later substrate items (e.g. `error` trailing
  // `turn.failed`) map to nothing. Exactly one RUN_STARTED…terminal pair.
  if (state.terminalKind !== undefined) return [];
  const events: SessionEvent[] = [];
  const boundary = (type: string, extra?: Record<string, unknown>): SessionEvent => ({
    type,
    threadId: state.threadId,
    runId: state.runId,
    ...(extra ?? {}),
  });
  const byId = (id: unknown): string => (typeof id === "string" ? id : randomUUID());

  switch (item.type) {
    case "thread.started": {
      if (typeof item.thread_id === "string") {
        state.nativeId = item.thread_id;
        state.threadId = item.thread_id;
      }
      events.push(boundary("RUN_STARTED"));
      state.runStartedEmitted = true;
      break;
    }
    case "turn.started": {
      if (!state.runStartedEmitted) {
        events.push(boundary("RUN_STARTED"));
        state.runStartedEmitted = true;
      }
      events.push(boundary("STEP_STARTED", { stepName: "turn" }));
      break;
    }
    case "turn.completed": {
      if (!state.runStartedEmitted) {
        events.push(boundary("RUN_STARTED"));
        state.runStartedEmitted = true;
      }
      events.push(boundary("STEP_FINISHED", { stepName: "turn" }));
      events.push(boundary("RUN_FINISHED"));
      state.terminalKind = "finished";
      break;
    }
    case "turn.failed":
    case "error": {
      if (!state.runStartedEmitted) {
        events.push(boundary("RUN_STARTED"));
        state.runStartedEmitted = true;
      }
      const detail = item.type === "turn.failed" && isRecord(item.error)
        ? String(item.error.message ?? "turn failed")
        : String(item.message ?? (item.type === "error" ? "stream error" : "turn failed"));
      events.push(boundary("RUN_ERROR", { message: detail }));
      state.terminalKind = "error";
      break;
    }
    case "item.completed": {
      if (!state.runStartedEmitted) {
        events.push(boundary("RUN_STARTED"));
        state.runStartedEmitted = true;
      }
      const inner = isRecord(item.item) ? item.item : {};
      if (inner.type === "agent_message" && typeof inner.text === "string") {
        const messageId = byId(inner.id);
        events.push(boundary("TEXT_MESSAGE_START", { messageId, role: "assistant" }));
        events.push(boundary("TEXT_MESSAGE_CONTENT", { messageId, content: inner.text }));
        events.push(boundary("TEXT_MESSAGE_END", { messageId }));
      } else if (inner.type === "command_execution" || inner.type === "mcp_tool_call") {
        const toolCallId = byId(inner.id);
        const args = inner.type === "mcp_tool_call"
          ? JSON.stringify(inner.arguments ?? {})
          : String(inner.command ?? "");
        events.push(boundary("TOOL_CALL_START", {
          toolCallId,
          toolCallName: String(inner.command ?? inner.tool ?? inner.type),
        }));
        events.push(boundary("TOOL_CALL_ARGS", { toolCallId, args }));
        events.push(boundary("TOOL_CALL_END", { toolCallId }));
        events.push(boundary("TOOL_CALL_RESULT", {
          toolCallId,
          content: String(inner.aggregated_output ?? inner.result ?? ""),
        }));
      }
      // Other item kinds (reasoning / file_change / …): spec §4 v0 drops them.
      break;
    }
    default:
      break; // item.started / item.updated and unknown kinds carry no v0 output.
  }
  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runs one substrate invocation, streaming mapped AG-UI events through
 * `emit` as JSON lines, and enforces the spec §4 pairing synthesis: exactly
 * one RUN_STARTED…RUN_FINISHED|RUN_ERROR pair per invocation regardless of
 * what the substrate actually printed. */
export async function runAgentSubstrate(
  substrate: AgentSubstrate,
  request: SessionRunRequest,
  knownThreadId: string,
  emit: (line: string) => void,
): Promise<SessionRunOutcome> {
  const state: RunBoundaryState = {
    threadId: knownThreadId,
    runId: randomUUID(),
    runStartedEmitted: false,
  };
  const emitEvent = (event: SessionEvent): void => {
    emit(JSON.stringify(event));
  };

  const argv = [
    ...substrate.command,
    "exec",
    "--experimental-json",
    "--cd",
    request.folder,
    // Endpoint folders are frequently not git repos; codex's own SDK exposes
    // the same skip (KB_codex exec.ts skipGitRepoCheck). The trust gate for
    // hosting is the manifest allowlist (ADR-SESSION-001), not codex's
    // directory check.
    "--skip-git-repo-check",
    ...(request.resumeId !== undefined ? ["resume", request.resumeId] : []),
    request.prompt,
  ];

  let child: import("bun").Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(argv, {
      cwd: request.folder,
      // Spec §7.2: the substrate process environment equals the caller's
      // environment (local single-user tier) — explicit snapshot so the
      // contract is structural, not an inheritance default.
      env: { ...process.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new SessionError(
      "substrate-unavailable",
      `agent substrate '${substrate.handle}' failed to start (${argv.join(" ")})`,
      { cause: error },
    );
  }

  const timedOut = { value: false };
  const timer = setTimeout(() => {
    timedOut.value = true;
    child.kill("SIGTERM");
  }, sessionSubstrateTimeoutMs());

  const stderrChunks: string[] = [];
  const drainStderr = async (): Promise<void> => {
    const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderrChunks.push(decoder.decode(value, { stream: true }));
    }
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
        if (line !== "") {
          let item: unknown;
          try {
            item = JSON.parse(line);
          } catch {
            continue; // Non-JSON substrate noise: ignored (spec §4 resilience).
          }
          if (isRecord(item)) {
            for (const event of mapSubstrateItem(item, state)) emitEvent(event);
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
  };

  let childExit: number | null = null;
  try {
    await Promise.all([drainStdout(), drainStderr()]);
    childExit = await child.exited;
  } finally {
    clearTimeout(timer);
  }

  if (timedOut.value) {
    if (state.runStartedEmitted && state.terminalKind === undefined) {
      emitEvent({ type: "RUN_ERROR", threadId: state.threadId, runId: state.runId, message: "substrate timed out" });
      state.terminalKind = "error";
    }
    throw new SessionError(
      "substrate-unavailable",
      `agent substrate '${substrate.handle}' timed out after ${sessionSubstrateTimeoutMs() / 1000}s (set UKP_PROVIDER_TIMEOUT_MS to adjust)`,
    );
  }

  if (!state.runStartedEmitted) {
    // Substrate produced no mapped events at all: a crash before the first
    // event is substrate failure, not a run failure (spec §5).
    const tail = stderrChunks.join("").trim().split(/\r?\n/).slice(-3).join(" | ");
    throw new SessionError(
      "substrate-unavailable",
      `agent substrate '${substrate.handle}' exited without events (code ${childExit})${tail === "" ? "" : `: ${tail}`} — check the [[agents]] command in the Host Registry`,
    );
  }
  if (state.terminalKind === undefined) {
    // Synthesis rule 2 (spec §4): stream ended without a terminal event —
    // the exit code decides which boundary closes the run.
    if (childExit === 0) {
      emitEvent({ type: "RUN_FINISHED", threadId: state.threadId, runId: state.runId });
      state.terminalKind = "finished";
    } else {
      emitEvent({ type: "RUN_ERROR", threadId: state.threadId, runId: state.runId, message: `substrate exited with code ${childExit}` });
      state.terminalKind = "error";
    }
  }

  // A non-zero exit overrides a substrate-claimed RUN_FINISHED: the process
  // itself is the final authority on its own outcome.
  const failed = state.terminalKind === "error" || childExit !== 0;
  return {
    nativeId: state.nativeId,
    outcome: failed ? "failed" : "finished",
    ...(failed ? { detail: `see RUN_ERROR on run ${state.runId}` } : {}),
  };
}
