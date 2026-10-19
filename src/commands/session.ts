// ukp_session W1→W2/G3 command surface (line spec §3/§5; ADR-SESSION-003
// command group). Two-level dispatch like init/guide: `ukp session <sub>`.
// The capability core (capabilities/session.ts) owns the amux consumption
// mechanism and classified errors (the substrate mechanism itself retired
// to the amux binary — extraction ruling X4); this adapter owns the policy
// face: endpoint addressing, the manifest authorization gate, argument
// surfaces, exit codes and channel text (ADR 0021): stdout prints the
// agent's final report by default (plain text, pipe-friendly — repo
// discipline) with the AG-UI event JSONL behind --events; stderr carries
// ukp's own human notes (amux's notes are suppressed on success) and
// classified error lines.

import { readFileSync } from "node:fs";
import {
  appendSessionRecord,
  amuxSandboxTier,
  loadSessionRecords,
  resolveSessionRecord,
  runAmuxSession,
  sessionStorePath,
  updateSessionRecord,
  SessionError,
  type SessionErrorClass,
} from "../capabilities/session.ts";
import { resolveSessionAgents, resolveSessionWriteTier, type SessionWriteTier } from "../config/agent-backed.ts";
import { loadManifest, ManifestError } from "../config/manifest.ts";
import { isRemoteBinding, localPathOf, readRegistry, readRegistryAgents, RegistryError } from "../registry.ts";
import type { RegistryAgent, RegistryBinding } from "../registry.ts";

export interface SessionCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SessionCommandContext {
  registryPath: string;
  now?: () => Date;
  /** amux binary override (test injection / explicit deployments), the
   * rg.ts rgCommand precedent; defaults to PATH lookup + UKP_AMUX. */
  amuxCommand?: readonly string[];
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
  spawn: "ukp session spawn --endpoint <name> --agent <handle> (--brief <file> | --text <string>) [--events]",
  send: "ukp session send <id> (--brief <file> | --text <string>) [--events]",
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
    "  spawn   start a session: launch the authorized agent in the endpoint folder and print its final report",
    "  send    continue a session by id (resume run); same report output as spawn",
    "  status  show one address-book entry",
    "  list    list sessions, one per line (optional --endpoint filter)",
    "",
    "Reserved (app-server tier, not in v0): wait, answer, stop",
    "",
    `stdout carries the agent's final report (the turn's last agent message);`,
    `pass --events for the AG-UI JSONL event stream (anchored: ag-ui-protocol@0.1.19).`,
    `stderr carries human notes. Hosting is opt-in: the endpoint manifest must`,
    `declare [capabilities.session] agents.`,
  ].join("\n");
}

/** Per-subcommand help (TODO 20261018-2345, eaten with the G3 command-layer
 * rewrite): `ukp session <sub> --help` renders the subcommand's own usage
 * face — the group help is never a substitute for the flag surface. */
function renderSessionSubcommandHelp(subcommand: SessionSubcommand): string {
  switch (subcommand) {
    case "spawn":
      return [
        "ukp session spawn — start a session in an endpoint folder",
        "",
        `Usage: ${SESSION_USAGE_LINES.spawn}`,
        "",
        "--endpoint <name>   the endpoint hosting the session (required)",
        "--agent <handle>    an agent handle allowed by the endpoint manifest (required)",
        "--brief <file>      brief file; its full verbatim content is the prompt (one of --brief/--text)",
        "--text <string>     the prompt text (one of --brief/--text)",
        "--events            print the AG-UI JSONL event stream instead of the final report",
        "",
        "stdout carries the agent's final report by default; stderr carries",
        "human notes. Hosting is opt-in: the endpoint manifest must declare",
        "[capabilities.session] with the agent in its allowlist, and the agent",
        "needs a [[agents]] entry in the Host Registry.",
      ].join("\n");
    case "send":
      return [
        "ukp session send — continue a session by id (resume run)",
        "",
        `Usage: ${SESSION_USAGE_LINES.send}`,
        "",
        "<id>                the session id from spawn/status/list",
        "--brief <file>      brief file; its full verbatim content is the prompt (one of --brief/--text)",
        "--text <string>     the prompt text (one of --brief/--text)",
        "--events            print the AG-UI JSONL event stream instead of the final report",
        "",
        "The conversation history stays in the agent's own global space; send",
        "delivers one more turn. The write tier is re-read from the endpoint's",
        "current declaration every run — revoking write downgrades the next",
        "send, not just the next spawn.",
      ].join("\n");
    case "status":
      return [
        "ukp session status — show one address-book entry",
        "",
        `Usage: ${SESSION_USAGE_LINES.status}`,
        "",
        "Prints id / endpoint / agent / tier / owner / created_at /",
        "last_run_at / last_outcome for one session.",
      ].join("\n");
    case "list":
      return [
        "ukp session list — list sessions, one per line",
        "",
        `Usage: ${SESSION_USAGE_LINES.list}`,
        "",
        "One line per session: id, endpoint, agent, tier, last_outcome;",
        "--endpoint filters to one endpoint's sessions.",
      ].join("\n");
  }
}

interface ParsedFlags {
  values: Map<string, string>;
  positionals: string[];
}

/** Minimal flag parser: value flags take an argument, boolean flags stand
 * alone; anything else starting with '-' is a usage error. Command-specific
 * validation is on the callers so the spec §5 messages stay exact. */
function parseSessionFlags(
  subcommand: SessionSubcommand,
  args: readonly string[],
  allowed: readonly string[],
  booleanFlags: readonly string[] = [],
): ParsedFlags {
  const values = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--help") {
      throw new SessionHelpRequest(subcommand);
    }
    if (token.startsWith("-")) {
      if (!allowed.includes(token) && !booleanFlags.includes(token)) {
        throw usageError(subcommand, `unknown option '${token}' for 'ukp session ${subcommand}'`);
      }
      if (values.has(token)) {
        throw usageError(subcommand, `'${token}' may only be specified once`);
      }
      if (booleanFlags.includes(token)) {
        values.set(token, "true");
        continue;
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw usageError(subcommand, `'${token}' requires a value`);
      }
      values.set(token, value);
      index += 1;
    } else {
      positionals.push(token);
    }
  }
  return { values, positionals };
}

class SessionHelpRequest extends Error {
  constructor(readonly subcommand?: SessionSubcommand) {
    super();
  }
}

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
 * single trust anchor (ADR-SESSION-001); the registry only names binaries.
 * Returns the substrate plus the write tier — hosting (agents) and write
 * (write) are two independent opt-in rungs of the same declaration. */
function authorizedSubstrate(
  registryPath: string,
  folder: string,
  endpoint: string,
  handle: string,
): { substrate: RegistryAgent; write: SessionWriteTier } {
  let allowlist: readonly string[];
  let write: SessionWriteTier;
  try {
    const loaded = loadManifest(folder);
    allowlist = resolveSessionAgents(loaded.manifest);
    write = resolveSessionWriteTier(loaded.manifest);
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
  return { substrate, write };
}

function ownerName(): string {
  return process.env.USERNAME ?? process.env.USER ?? "unknown";
}

/** Default face = the final report (plain text, pipe-friendly — the repo's
 * plain-default / structured-opt-in discipline); `--events` opts into the
 * AG-UI JSONL stream. The stream is substrate, not the default surface. */
function composeRunStdout(
  events: boolean,
  lines: readonly string[],
  finalMessage: string | undefined,
): string {
  if (events) return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  return finalMessage === undefined ? "" : `${finalMessage}\n`;
}

function renderSessionCommandError(error: unknown): SessionCommandResult {
  if (error instanceof SessionHelpRequest) {
    return {
      exitCode: 0,
      stdout: `${error.subcommand === undefined ? renderSessionHelp() : renderSessionSubcommandHelp(error.subcommand)}\n`,
      stderr: "",
    };
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
    "substrate-unavailable": " — check amux availability and the [[agents]] entries in the Host Registry",
  };
  const stderr = `ukp session: ${label[classified.errorClass]}: ${classified.message}${hint[classified.errorClass] ?? ""}`;
  return { exitCode: SESSION_EXIT_BY_CLASS[classified.errorClass], stdout: "", stderr };
}

async function runSpawn(
  args: readonly string[],
  context: SessionCommandContext,
): Promise<SessionCommandResult> {
  const flags = parseSessionFlags("spawn", args, ["--endpoint", "--agent", "--brief", "--text"], ["--events"]);
  const endpoint = flags.values.get("--endpoint");
  const handle = flags.values.get("--agent");
  if (endpoint === undefined) throw usageError("spawn", "--endpoint <name> is required");
  if (handle === undefined) throw usageError("spawn", "--agent <handle> is required");
  if (flags.positionals.length > 0) throw usageError("spawn", "spawn takes no positional arguments");
  const prompt = readPrompt("spawn", flags);

  const { folder } = resolveLocalFolder(context.registryPath, endpoint);
  const { substrate, write } = authorizedSubstrate(context.registryPath, folder, endpoint, handle);
  const storePath = sessionStorePath(context.registryPath);

  const outcome = await runAmuxSession(
    {
      kind: "spawn",
      folder,
      agentCommand: substrate.command,
      prompt,
      sandbox: amuxSandboxTier(write),
    },
    { amuxCommand: context.amuxCommand },
  );

  const nowIso = (context.now?.() ?? new Date()).toISOString();
  const notes: string[] = [];
  const id = outcome.threadId;
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
    stdout: composeRunStdout(flags.values.get("--events") === "true", outcome.eventLines, outcome.finalMessage),
    stderr: `${notes.join("\n")}\n`,
  };
}

async function runSend(
  args: readonly string[],
  context: SessionCommandContext,
): Promise<SessionCommandResult> {
  const flags = parseSessionFlags("send", args, ["--brief", "--text"], ["--events"]);
  if (flags.positionals.length !== 1) {
    throw usageError("send", "send takes exactly one session id");
  }
  const id = flags.positionals[0]!;
  const prompt = readPrompt("send", flags);

  const storePath = sessionStorePath(context.registryPath);
  const record = resolveSessionRecord(loadSessionRecords(storePath), id);
  const { folder } = resolveLocalFolder(context.registryPath, record.endpoint);
  let substrate: RegistryAgent;
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

  // Identity is frozen at spawn (the address book); permissions are not —
  // the write tier is re-read from the endpoint's current declaration every
  // run, so an owner revoking `write` downgrades the next send, not just the
  // next spawn (owner ruling 2026-10-18).
  let write: SessionWriteTier;
  try {
    write = resolveSessionWriteTier(loadManifest(folder).manifest);
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new SessionError(
        "not-authorized",
        `endpoint '${record.endpoint}' authorization declaration is unreadable: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }

  const outcome = await runAmuxSession(
    {
      kind: "send",
      sessionId: record.id,
      prompt,
      sandbox: amuxSandboxTier(write),
    },
    { amuxCommand: context.amuxCommand },
  );
  updateSessionRecord(storePath, record.id, (context.now?.() ?? new Date()).toISOString(), outcome.outcome);
  return {
    exitCode: outcome.outcome === "finished" ? 0 : 1,
    stdout: composeRunStdout(flags.values.get("--events") === "true", outcome.eventLines, outcome.finalMessage),
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
