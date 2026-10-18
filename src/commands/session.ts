// ukp_session W1 command surface (line spec §3/§5; ADR-SESSION-003 command
// group). Two-level dispatch like init/guide: `ukp session <sub>`. The
// capability core (capabilities/session.ts) owns mechanisms and classified
// errors; this adapter owns argument surfaces, exit codes and channel text
// (ADR 0021): stdout = machine channel (AG-UI event JSONL on spawn/send),
// stderr = human notes and classified error lines.

import { readFileSync } from "node:fs";
import {
  appendSessionRecord,
  loadSessionRecords,
  resolveSessionRecord,
  runAgentSubstrate,
  sessionStorePath,
  updateSessionRecord,
  SessionError,
  type AgentSubstrate,
  type SessionErrorClass,
} from "../capabilities/session.ts";
import { resolveSessionAgents } from "../config/agent-backed.ts";
import { loadManifest, ManifestError } from "../config/manifest.ts";
import { isRemoteBinding, localPathOf, readRegistry, readRegistryAgents, RegistryError } from "../registry.ts";
import type { RegistryBinding } from "../registry.ts";

export interface SessionCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SessionCommandContext {
  registryPath: string;
  now?: () => Date;
}

/** Root-help one-liner (spec §3); feeds COMMAND_DESCRIPTIONS in cli.ts. */
export const SESSION_SUMMARY =
  "spawn and converse with agent sessions anchored to an endpoint (sdk tier; spawn, send, status, list)";

const SUBCOMMANDS = ["spawn", "send", "status", "list"] as const;
type SessionSubcommand = (typeof SUBCOMMANDS)[number];
/** app-server-tier verbs shown in help but not implemented in v0 (spec §3). */
const RESERVED_SUBCOMMANDS = ["wait", "answer", "stop"] as const;

/** Spec §5: usage = 2 (nav/search discipline), runtime failures = 1 with the
 * classification carried in the stderr line, not the code. */
const SESSION_EXIT_BY_CLASS: Record<SessionErrorClass, number> = {
  usage: 2,
  "not-authorized": 1,
  "run-failed": 1,
  "substrate-unavailable": 1,
};

const SESSION_USAGE_LINES: Record<SessionSubcommand, string> = {
  spawn: "ukp session spawn --endpoint <name> --agent <handle> (--brief <file> | --text <string>)",
  send: "ukp session send <id> (--brief <file> | --text <string>)",
  status: "ukp session status <id>",
  list: "ukp session list [--endpoint <name>]",
};

function usageError(subcommand: SessionSubcommand, message: string): SessionError {
  return new SessionError(
    "usage",
    `${message}\n\nusage: ${SESSION_USAGE_LINES[subcommand]}\nsee 'ukp session ${subcommand} --help'`,
  );
}

function renderSessionHelp(): string {
  return [
    "Spawn and converse with agent sessions anchored to an endpoint",
    "",
    "A session is a named relay to an agent harness process running with the",
    "endpoint folder as its working context. The conversation history stays in",
    "the agent's own global space; UKP records only the address book entry",
    "(id, endpoint, agent, tier, owner, timestamps).",
    "",
    "Usage: ukp session <sub> [options]",
    "",
    "Subcommands:",
    "  spawn   start a session: launch the authorized agent in the endpoint folder and stream AG-UI events",
    "  send    continue a session by id (resume run); same event stream as spawn",
    "  status  show one address-book entry",
    "  list    list sessions, one per line (optional --endpoint filter)",
    "",
    "Reserved (app-server tier, not in v0): wait, answer, stop",
    "",
    `Events are AG-UI JSONL on stdout (anchored: ag-ui-protocol@0.1.19); stderr carries human notes.`,
    `Hosting is opt-in: the endpoint manifest must declare [capabilities.session] agents.`,
  ].join("\n");
}

interface ParsedFlags {
  values: Map<string, string>;
  positionals: string[];
}

/** Minimal flag parser: every supported flag takes a value; anything else
 * starting with '-' is a usage error. Command-specific validation is on the
 * callers so the spec §5 messages stay exact. */
function parseSessionFlags(
  subcommand: SessionSubcommand,
  args: readonly string[],
  allowed: readonly string[],
): ParsedFlags {
  const values = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--help") {
      throw new SessionHelpRequest();
    }
    if (token.startsWith("-")) {
      if (!allowed.includes(token)) {
        throw usageError(subcommand, `unknown option '${token}' for 'ukp session ${subcommand}'`);
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw usageError(subcommand, `'${token}' requires a value`);
      }
      if (values.has(token)) {
        throw usageError(subcommand, `'${token}' may only be specified once`);
      }
      values.set(token, value);
      index += 1;
    } else {
      positionals.push(token);
    }
  }
  return { values, positionals };
}

class SessionHelpRequest extends Error {}

/** --brief <file> | --text <string>, exactly one (spec §3); non-empty. */
function readPrompt(
  subcommand: "spawn" | "send",
  flags: ParsedFlags,
): string {
  const brief = flags.values.get("--brief");
  const text = flags.values.get("--text");
  if (brief !== undefined && text !== undefined) {
    throw usageError(subcommand, "--brief and --text are mutually exclusive");
  }
  if (brief === undefined && text === undefined) {
    throw usageError(subcommand, "one of --brief <file> or --text <string> is required");
  }
  if (text !== undefined) {
    if (text.trim() === "") throw usageError(subcommand, "--text must be non-empty");
    return text;
  }
  try {
    const content = readFileSync(brief!, "utf8");
    if (content.trim() === "") throw usageError(subcommand, `--brief file is empty: ${brief}`);
    return content;
  } catch (error) {
    if (error instanceof SessionError) throw error;
    throw usageError(subcommand, `--brief file is not readable: ${brief}`);
  }
}

function resolveLocalFolder(registryPath: string, endpoint: string): { binding: RegistryBinding; folder: string } {
  const bindings = readRegistry(registryPath);
  const binding = bindings.find((candidate) => candidate.name === endpoint);
  if (binding === undefined) {
    throw usageError("spawn", `unknown endpoint '${endpoint}' (see 'ukp list')`);
  }
  if (isRemoteBinding(binding)) {
    throw usageError("spawn", `endpoint '${endpoint}' is remote — remote session hosting is out of scope in v0`);
  }
  return { binding, folder: localPathOf(binding) };
}

/** Spec §1/§5 authorization gate + substrate resolution. The manifest is the
 * single trust anchor (ADR-SESSION-001); the registry only names binaries. */
function authorizedSubstrate(
  registryPath: string,
  folder: string,
  endpoint: string,
  handle: string,
): AgentSubstrate {
  let allowlist: readonly string[];
  try {
    const loaded = loadManifest(folder);
    allowlist = resolveSessionAgents(loaded.manifest);
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new SessionError(
        "not-authorized",
        `endpoint '${endpoint}' authorization declaration is unreadable: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (!allowlist.includes(handle)) {
    throw new SessionError(
      "not-authorized",
      allowlist.length === 0
        ? `session hosting is off for endpoint '${endpoint}' — declare [capabilities.session] agents in its .ukp/service.toml`
        : `agent '${handle}' is not in endpoint '${endpoint}' [capabilities.session] agents (allowed: ${allowlist.join(", ")})`,
    );
  }
  let substrates;
  try {
    substrates = readRegistryAgents(registryPath);
  } catch (error) {
    if (error instanceof RegistryError) {
      throw new SessionError("substrate-unavailable", error.message, { cause: error });
    }
    throw error;
  }
  const substrate = substrates.find((candidate) => candidate.handle === handle);
  if (substrate === undefined) {
    throw new SessionError(
      "substrate-unavailable",
      `agent '${handle}' has no [[agents]] entry in the Host Registry (${registryPath}) — add one to spawn sessions with it`,
    );
  }
  return substrate;
}

function ownerName(): string {
  return process.env.USERNAME ?? process.env.USER ?? "unknown";
}

function renderSessionCommandError(error: unknown): SessionCommandResult {
  if (error instanceof SessionHelpRequest) {
    return { exitCode: 0, stdout: renderSessionHelp(), stderr: "" };
  }
  const classified = error instanceof SessionError
    ? error
    : new SessionError("run-failed", error instanceof Error ? error.message : String(error));
  const label: Record<SessionErrorClass, string> = {
    usage: "usage error",
    "not-authorized": "session-hosting not authorized",
    "run-failed": "run failed",
    "substrate-unavailable": "agent substrate unavailable",
  };
  const hint: Partial<Record<SessionErrorClass, string>> = {
    "not-authorized": " — hosting is opt-in via [capabilities.session] agents in the endpoint manifest",
    "substrate-unavailable": " — check the [[agents]] entries in the Host Registry",
  };
  const stderr = `ukp session: ${label[classified.errorClass]}: ${classified.message}${hint[classified.errorClass] ?? ""}`;
  return { exitCode: SESSION_EXIT_BY_CLASS[classified.errorClass], stdout: "", stderr };
}

async function runSpawn(
  args: readonly string[],
  context: SessionCommandContext,
): Promise<SessionCommandResult> {
  const flags = parseSessionFlags("spawn", args, ["--endpoint", "--agent", "--brief", "--text"]);
  const endpoint = flags.values.get("--endpoint");
  const handle = flags.values.get("--agent");
  if (endpoint === undefined) throw usageError("spawn", "--endpoint <name> is required");
  if (handle === undefined) throw usageError("spawn", "--agent <handle> is required");
  if (flags.positionals.length > 0) throw usageError("spawn", "spawn takes no positional arguments");
  const prompt = readPrompt("spawn", flags);

  const { folder } = resolveLocalFolder(context.registryPath, endpoint);
  const substrate = authorizedSubstrate(context.registryPath, folder, endpoint, handle);
  const storePath = sessionStorePath(context.registryPath);

  const lines: string[] = [];
  const outcome = await runAgentSubstrate(substrate, { folder, prompt }, crypto.randomUUID(), (line) => {
    lines.push(line);
  });

  const nowIso = (context.now?.() ?? new Date()).toISOString();
  const notes: string[] = [];
  const id = outcome.nativeId;
  if (id !== undefined) {
    appendSessionRecord(storePath, {
      id,
      endpoint,
      agent: handle,
      tier: "sdk",
      owner: ownerName(),
      created_at: nowIso,
      last_run_at: nowIso,
      last_outcome: outcome.outcome,
    });
    notes.push(`session ${id} started (agent ${handle}, tier sdk, endpoint ${endpoint})`);
  } else {
    notes.push(`session run in endpoint '${endpoint}' ended without a session id (no address-book entry)`);
  }
  const label = id ?? "(no id)";
  notes.push(outcome.outcome === "finished"
    ? `session ${label} finished`
    : `session ${label} failed${outcome.detail === undefined ? "" : ` — ${outcome.detail}`}`);
  return {
    exitCode: outcome.outcome === "finished" ? 0 : 1,
    stdout: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
    stderr: `${notes.join("\n")}\n`,
  };
}

async function runSend(
  args: readonly string[],
  context: SessionCommandContext,
): Promise<SessionCommandResult> {
  const flags = parseSessionFlags("send", args, ["--brief", "--text"]);
  if (flags.positionals.length !== 1) {
    throw usageError("send", "send takes exactly one session id");
  }
  const id = flags.positionals[0]!;
  const prompt = readPrompt("send", flags);

  const storePath = sessionStorePath(context.registryPath);
  const record = resolveSessionRecord(loadSessionRecords(storePath), id);
  const { folder } = resolveLocalFolder(context.registryPath, record.endpoint);
  let substrate: AgentSubstrate;
  try {
    substrate = readRegistryAgents(context.registryPath).find((candidate) => candidate.handle === record.agent)!;
  } catch (error) {
    if (error instanceof RegistryError) {
      throw new SessionError("substrate-unavailable", error.message, { cause: error });
    }
    throw error;
  }
  if (substrate === undefined) {
    throw new SessionError(
      "substrate-unavailable",
      `agent '${record.agent}' (session ${id}) has no [[agents]] entry in the Host Registry (${context.registryPath})`,
    );
  }

  const lines: string[] = [];
  const outcome = await runAgentSubstrate(
    substrate,
    { folder, prompt, resumeId: record.id },
    record.id,
    (line) => {
      lines.push(line);
    },
  );
  updateSessionRecord(storePath, record.id, (context.now?.() ?? new Date()).toISOString(), outcome.outcome);
  return {
    exitCode: outcome.outcome === "finished" ? 0 : 1,
    stdout: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
    stderr: `session ${record.id} resumed (agent ${record.agent}, tier sdk, endpoint ${record.endpoint})\n`
      + (outcome.outcome === "finished"
        ? `session ${record.id} finished\n`
        : `session ${record.id} failed${outcome.detail === undefined ? "" : ` — ${outcome.detail}`}\n`),
  };
}

function runStatus(args: readonly string[], context: SessionCommandContext): SessionCommandResult {
  const flags = parseSessionFlags("status", args, []);
  if (flags.positionals.length !== 1) {
    throw usageError("status", "status takes exactly one session id");
  }
  const record = resolveSessionRecord(loadSessionRecords(sessionStorePath(context.registryPath)), flags.positionals[0]!);
  const stdout = [
    `id:           ${record.id}`,
    `endpoint:     ${record.endpoint}`,
    `agent:        ${record.agent}`,
    `tier:         ${record.tier}`,
    `owner:        ${record.owner}`,
    `created_at:   ${record.created_at}`,
    `last_run_at:  ${record.last_run_at}`,
    `last_outcome: ${record.last_outcome}`,
  ].join("\n");
  return { exitCode: 0, stdout: `${stdout}\n`, stderr: "" };
}

function runList(args: readonly string[], context: SessionCommandContext): SessionCommandResult {
  const flags = parseSessionFlags("list", args, ["--endpoint"]);
  const endpoint = flags.values.get("--endpoint");
  if (flags.positionals.length > 0) throw usageError("list", "list takes no positional arguments");
  const records = loadSessionRecords(sessionStorePath(context.registryPath))
    .filter((record) => endpoint === undefined || record.endpoint === endpoint);
  const stdout = records
    .map((record) => `${record.id}  ${record.endpoint}  ${record.agent}  ${record.tier}  ${record.last_outcome}`)
    .join("\n");
  return { exitCode: 0, stdout: stdout === "" ? "" : `${stdout}\n`, stderr: "" };
}

export async function executeSessionCommand(
  args: readonly string[],
  context: SessionCommandContext,
): Promise<SessionCommandResult> {
  try {
    const [first] = args;
    if (first === undefined || first === "-h" || first === "--help") {
      return { exitCode: 0, stdout: renderSessionHelp(), stderr: "" };
    }
    if ((RESERVED_SUBCOMMANDS as readonly string[]).includes(first)) {
      throw new SessionError(
        "usage",
        `'${first}' is reserved for the app-server tier and not implemented in v0 (available: ${SUBCOMMANDS.join(", ")})\n\nusage: ukp session <sub> [options]\nsee 'ukp session --help'`,
      );
    }
    if (!(SUBCOMMANDS as readonly string[]).includes(first)) {
      throw new SessionError(
        "usage",
        `unknown session subcommand '${first}' (available: ${SUBCOMMANDS.join(", ")})\n\nusage: ukp session <sub> [options]\nsee 'ukp session --help'`,
      );
    }
    const rest = args.slice(1);
    switch (first as SessionSubcommand) {
      case "spawn":
        return await runSpawn(rest, context);
      case "send":
        return await runSend(rest, context);
      case "status":
        return runStatus(rest, context);
      case "list":
        return runList(rest, context);
    }
  } catch (error) {
    return renderSessionCommandError(error);
  }
}
