import { Command, CommanderError } from "commander";
import {
  runRg,
  projectRgEnvelope,
  renderRgHuman,
  RG_DEFAULT_LIMIT,
  RG_MAX_LIMIT,
  RgPlanningError,
  RgUsageError,
  validateRgPassthrough,
  type ParsedRg,
  type RgAggregateStatus,
  type RgContext,
} from "../capabilities/rg.ts";
import { ScopeError } from "../scope.ts";
import { ManifestError } from "../config/manifest.ts";
import { countFlagOccurrences, HelpRequestError, isCommanderHelpIntent, isHelpRequest } from "./flags.ts";

/** CLI-owned command result shape (ADR 0021). */
export interface RgCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Aggregate classification → exit code (ADR 0021 / D-036 semantics). */
const RG_EXIT_BY_AGGREGATE: Record<RgAggregateStatus, number> = {
  "succeeded": 0,
  "failed": 1,
  "no-success": 1,
  "cancelled": 130,
};

function collectValues(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function createRgCommand(): Command {
  return new Command("ukp rg")
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(true)
    .helpOption("-h, --help", "show this help")
    .usage("[--endpoint <name> ... | -g] <pattern> [--limit <1-1000>] [--count] [--glob <glob>] [--type <type>] [-i] [-- <rg flags>]")
    .description(
      "Run base lexical search (ripgrep) across one or more Service endpoints. "
        + "Available on every registered endpoint by default; results are shaped into ukp:// references that 'ukp read' consumes directly. "
        + "For indexed/semantic search use 'ukp search'.",
    )
    .argument("[pattern]", "one non-empty regex pattern; quote to escape the shell")
    .option("-c, --endpoint <name>", "select one endpoint; repeat to select multiple endpoints", collectValues)
    .option("-g", "search every endpoint in the Host Registry; takes no value")
    .option("--limit <1-1000>", `maximum matches per run (default: ${RG_DEFAULT_LIMIT})`)
    .option("--count", "count mode: per-file match counts instead of matches")
    .option("--glob <glob>", "glob filter passed to rg (e.g. \"*.md\")")
    .option("--type <type>", "file type filter passed to rg (e.g. md, py)")
    .option("-i", "case-insensitive search")
    .option("--json", "emit the structured response envelope");
}

function parseRgCommand(args: readonly string[]): {
  positionals: string[];
  endpoints: string[];
  global?: boolean;
  limit?: string;
  count?: boolean;
  glob?: string;
  type?: string;
  ignoreCase?: boolean;
  json?: boolean;
} {
  const command = createRgCommand()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (isCommanderHelpIntent(error)) throw new HelpRequestError();
      throw new RgUsageError(error.message.replace(/^error: /, ""));
    }
    throw error;
  }

  const options = command.opts<{
    endpoint?: string[];
    g?: boolean;
    limit?: string;
    count?: boolean;
    glob?: string;
    type?: string;
    i?: boolean;
    json?: boolean;
  }>();
  return {
    positionals: command.args,
    endpoints: options.endpoint ?? [],
    global: options.g,
    limit: options.limit,
    count: options.count,
    glob: options.glob,
    type: options.type,
    ignoreCase: options.i,
    json: options.json,
  };
}

export function parseRgArgs(args: readonly string[]): ParsedRg {
  const parsed = parseRgCommand(args);
  const explicit: string[] = [];
  const warnings: string[] = [];

  if (countFlagOccurrences(args, "-g") > 1) throw new RgUsageError("-g may only be specified once");
  if (countFlagOccurrences(args, "--limit") > 1) throw new RgUsageError("--limit may only be specified once");
  if (countFlagOccurrences(args, "--json") > 1) throw new RgUsageError("--json may only be specified once");

  let limit = RG_DEFAULT_LIMIT;
  if (parsed.limit !== undefined) {
    if (!/^[0-9]+$/.test(parsed.limit)) throw new RgUsageError("--limit must be a decimal integer");
    limit = Number(parsed.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RG_MAX_LIMIT) {
      throw new RgUsageError(`--limit must be between 1 and ${RG_MAX_LIMIT}`);
    }
  }

  for (const endpoint of parsed.endpoints) {
    if (explicit.includes(endpoint)) warnings.push(`duplicate endpoint '${endpoint}' ignored`);
    else explicit.push(endpoint);
  }

  const [pattern, unexpected] = parsed.positionals;
  if (unexpected !== undefined) {
    throw new RgUsageError(
      `unexpected argument '${unexpected}'; rg accepts exactly one pattern. Use '--endpoint <name>' to select an endpoint; '-g' takes no value.`,
    );
  }
  if (pattern === undefined || pattern.length === 0) throw new RgUsageError("rg pattern must be non-empty");
  if (parsed.global && explicit.length > 0) {
    throw new RgUsageError("--endpoint and -g cannot be used together");
  }

  return {
    request: { query: pattern, limit },
    options: {
      explicitEndpoints: explicit.length > 0 ? explicit : undefined,
      global: parsed.global ?? false,
      ...(parsed.glob === undefined ? {} : { glob: parsed.glob }),
      ...(parsed.type === undefined ? {} : { type: parsed.type }),
      ...(parsed.ignoreCase === true ? { ignoreCase: true } : {}),
      ...(parsed.count === true ? { count: true } : {}),
      ...(parsed.json === true ? { json: true } : {}),
      passthrough: [],
    },
    warnings,
  };
}

/** Splits argv at the first `--`; everything after is rg passthrough
 * (validated against the allowlist, ADR-RG-002). */
export function splitRgPassthrough(args: readonly string[]): { commandArgs: string[]; passthrough: string[] } {
  const separator = args.indexOf("--");
  if (separator === -1) return { commandArgs: [...args], passthrough: [] };
  return {
    commandArgs: args.slice(0, separator),
    passthrough: args.slice(separator + 1),
  };
}

export function executeRgCommand(args: readonly string[], context: RgContext): RgCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderRgHelp(), stderr: "" };
  }

  const { commandArgs, passthrough } = splitRgPassthrough(args);
  let parsed: ParsedRg;
  try {
    // Validate passthrough before parsing so a rejected flag surfaces as a
    // usage error (exit 2) before any endpoint work starts.
    validateRgPassthrough(passthrough);
    parsed = parseRgArgs(commandArgs);
    parsed.options.passthrough = passthrough;
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderRgHelp(), stderr: "" };
    }
    if (error instanceof RgUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderRgUsageError(error.message) };
    }
    throw error;
  }

  try {
    const result = runRg(parsed, context);
    const view = renderRgHuman(result);
    if (parsed.options.json === true) {
      return {
        exitCode: RG_EXIT_BY_AGGREGATE[result.aggregate],
        stdout: `${JSON.stringify(projectRgEnvelope(result, parsed.options.count === true), null, 2)}\n`,
        stderr: view.diagnostics,
      };
    }
    return {
      exitCode: RG_EXIT_BY_AGGREGATE[result.aggregate],
      stdout: view.body,
      stderr: view.diagnostics,
    };
  } catch (error) {
    if (error instanceof ScopeError) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `ukp rg: ${error.message}\nRun 'ukp list' to inspect registrations and 'ukp register' from a Service folder, then retry.\n`,
      };
    }
    if (error instanceof RgPlanningError) {
      return { exitCode: 1, stdout: "", stderr: `ukp rg: ${error.message}\n` };
    }
    if (error instanceof ManifestError) {
      return { exitCode: 1, stdout: "", stderr: `ukp rg: ${error.message}\n` };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp rg: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

export function renderRgHelp(): string {
  return createRgCommand().helpInformation() + [
    "",
    "Passthrough:",
    "  After '--', rg native flags are passed through on an allowlist",
    "  (-A/-B/-C/-m/--glob/--type/--max-filesize and common boolean flags).",
    "  Path operands and output-changing flags (--json, -r, --pre, --config)",
    "  are rejected: the endpoint selector owns scope, UKP owns the output.",
    "",
    "Result scope:",
    "  With no --endpoint or -g, the workspace default scope applies: the",
    "  Client Config's default endpoints ('ukp inspect' shows the resolved",
    "  scope); with no Client Config, every registered endpoint. 'Available on",
    "  every registered endpoint' refers to capability availability, not this",
    "  default scope.",
    "  rg scans each endpoint's own files (same visibility root as read/file).",
    "  'ukp search' covers indexed search where the Service declares a search",
    "  capability provider.",
    "",
  ].join("\n");
}

export function renderRgUsageError(message: string): string {
  return [
    `ukp rg: ${message}`,
    "Usage: ukp rg [--endpoint <name> ... | -g] <pattern> [flags] [-- <rg flags>]",
    "Run 'ukp rg --help' for details.",
  ].join("\n");
}
