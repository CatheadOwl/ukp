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
import { KitUsageError, parseKitArgs, renderKitHelp, renderKitUsageError, type UkpCommandSpec } from "./kit.ts";
import { HelpRequestError, isHelpRequest } from "./flags.ts";

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

/** Single-source command spec (ADR 0024). Options-only form (like search):
 * `-c`/`-g` declared inline so the rendered option order and the error
 * precedence (limit validation before duplicate warnings, excess before
 * conflict) stay identical with the pre-kit command. */
export const RG_SPEC: UkpCommandSpec = {
  name: "rg",
  summary: "grep raw endpoint files with ripgrep (no index or declaration needed; results as ukp:// references)",
  group: "endpoint",
  description:
    "Run base lexical search (ripgrep) across one or more Service endpoints. "
    + "Available on every registered endpoint by default; results are shaped into ukp:// references that 'ukp read' consumes directly. "
    + "For indexed/semantic search use 'ukp search'.",
  usage: "[--endpoint <name> ... | -g] <pattern> [--limit <1-1000>] [--count] [--glob <glob>] [--type <type>] [-i] [-- <rg flags>]",
  arguments: [{ name: "pattern", help: "one non-empty regex pattern; quote to escape the shell" }],
  options: [
    { flags: "-c, --endpoint <name>", help: "select one endpoint; repeat to select multiple endpoints", multi: true },
    { flags: "-g", help: "search every endpoint in the Host Registry; takes no value" },
    { flags: "--limit <1-1000>", help: `maximum matches per run (default: ${RG_DEFAULT_LIMIT})` },
    { flags: "--count", help: "count mode: per-file match counts instead of matches" },
    { flags: "--glob <glob>", help: "glob filter passed to rg (e.g. \"*.md\")" },
    { flags: "--type <type>", help: "file type filter passed to rg (e.g. md, py)" },
    { flags: "-i", help: "case-insensitive search" },
    { flags: "--json", help: "emit the structured response envelope" },
  ],
  helpSuffix: [
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
    "  scope); with no Client Config, every registered endpoint. -g cannot",
    "  be combined with --endpoint. 'Available on",
    "  every registered endpoint' refers to capability availability, not this",
    "  default scope.",
    "  rg scans each endpoint's own files (same visibility root as read/file).",
    "  'ukp search' covers indexed search where the Service declares a search",
    "  capability provider.",
    "",
  ].join("\n"),
};

interface RgCommandOptions extends Record<string, unknown> {
  endpoint?: string[];
  g?: boolean;
  limit?: string;
  count?: boolean;
  glob?: string;
  type?: string;
  i?: boolean;
  json?: boolean;
}

export function parseRgArgs(args: readonly string[]): ParsedRg {
  const parsed = parseKitArgs<RgCommandOptions>(RG_SPEC, args);
  const explicit: string[] = [];
  const warnings: string[] = [];

  // Command-side semantic checks, in the pre-kit order: limit validation,
  // duplicate warnings, excess positional, emptiness, conflict.
  let limit = RG_DEFAULT_LIMIT;
  if (parsed.options.limit !== undefined) {
    if (!/^[0-9]+$/.test(parsed.options.limit)) throw new KitUsageError("--limit must be a decimal integer");
    limit = Number(parsed.options.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RG_MAX_LIMIT) {
      throw new KitUsageError(`--limit must be between 1 and ${RG_MAX_LIMIT}`);
    }
  }

  for (const endpoint of parsed.options.endpoint ?? []) {
    if (explicit.includes(endpoint)) warnings.push(`duplicate endpoint '${endpoint}' ignored`);
    else explicit.push(endpoint);
  }

  const [pattern, unexpected] = parsed.positionals;
  if (unexpected !== undefined) {
    throw new KitUsageError(
      `unexpected argument '${unexpected}'; rg accepts exactly one pattern. Use '--endpoint <name>' to select an endpoint; '-g' takes no value.`,
    );
  }
  if (pattern === undefined || pattern.length === 0) throw new KitUsageError("rg pattern must be non-empty");
  if (parsed.options.g && explicit.length > 0) {
    throw new KitUsageError("--endpoint and -g cannot be used together");
  }

  return {
    request: { query: pattern, limit },
    options: {
      explicitEndpoints: explicit.length > 0 ? explicit : undefined,
      global: parsed.options.g ?? false,
      ...(parsed.options.glob === undefined ? {} : { glob: parsed.options.glob }),
      ...(parsed.options.type === undefined ? {} : { type: parsed.options.type }),
      ...(parsed.options.i === true ? { ignoreCase: true } : {}),
      ...(parsed.options.count === true ? { count: true } : {}),
      ...(parsed.options.json === true ? { json: true } : {}),
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
    if (error instanceof KitUsageError || error instanceof RgUsageError) {
      // RgUsageError: capability-side passthrough allowlist validation
      // classifies as usage too — same rendering, exit 2.
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
  return renderKitHelp(RG_SPEC);
}

export function renderRgUsageError(message: string): string {
  return renderKitUsageError(RG_SPEC, message);
}
