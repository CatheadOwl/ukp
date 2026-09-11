import { Command, CommanderError } from "commander";
import {
  runNav,
  projectNavEnvelope,
  renderNavHuman,
  renderNavJson,
  NAV_MAX_DEPTH,
  NavProviderError,
  NavUsageError,
  validateNavRoutePath,
  type NavContext,
  type NavErrorClass,
  type NavRequest,
} from "../capabilities/nav.ts";
import { ScopeError } from "../scope.ts";
import { ManifestError } from "../config/manifest.ts";
import { countFlagOccurrences, isHelpRequest } from "./flags.ts";

/** CLI-owned command result shape (ADR 0021: exit codes and channel text
 * belong to the surface adapter, not the capability). */
export interface NavCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Error-class → exit-code mapping (ADR 0021: owned by the CLI adapter per
 * the Capability Contract; every nav failure class is a hard stop today). */
const NAV_EXIT_BY_ERROR_CLASS: Record<NavErrorClass, number> = {
  "no-endpoint": 1,
  "endpoint-name-mismatch": 1,
  "provider-unsupported": 1,
  "route-root-not-found": 1,
  "route-root-not-directory": 1,
};

function createNavCommand(): Command {
  return new Command("ukp nav")
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(true)
    .helpOption("-h, --help", "show this help")
    .usage("--endpoint <name> [path] [--depth <n>] [--json]")
    .description("Navigate the Markdown structure of one Service endpoint (endpoint names come from 'ukp list').")
    .option("-c, --endpoint <name>", "select the endpoint to navigate")
    .option("--depth <n>", "how many directory levels to expand from the route root (0-10, default 0; deeper folders appear as [truncated: N], where N is that folder's total recursive .md count)")
    .option("--json", "emit the structured response envelope")
    .option("-g", "not supported by nav; use --endpoint <name>");
}

function parseNavCommand(args: readonly string[]): {
  positionals: string[];
  endpoint?: string;
  depth?: number;
  json: boolean;
  global?: boolean;
} {
  const command = createNavCommand()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new NavUsageError(error.message.replace(/^error: /, ""));
    }
    throw error;
  }

  const options = command.opts<{
    endpoint?: string;
    depth?: string;
    json?: boolean;
    g?: boolean;
  }>();
  let depth: number | undefined;
  if (options.depth !== undefined) {
    // Strict decimal form only: Number() would accept "1e1"/"0x2" variants
    // that are almost certainly typos on a 0-10 flag.
    if (!/^\d+$/.test(options.depth.trim())) {
      throw new NavUsageError("--depth must be a non-negative integer");
    }
    const parsed = Number(options.depth.trim());
    if (parsed < 0) {
      throw new NavUsageError("--depth must be a non-negative integer");
    }
    depth = parsed;
  }
  return {
    positionals: command.args,
    endpoint: options.endpoint,
    depth,
    json: options.json === true,
    global: options.g,
  };
}

export function parseNavArgs(args: readonly string[]): NavRequest {
  const parsed = parseNavCommand(args);

  if (countFlagOccurrences(args, "--endpoint") + countFlagOccurrences(args, "-c") > 1) {
    throw new NavUsageError("--endpoint may only be specified once");
  }
  if (countFlagOccurrences(args, "--depth") > 1) {
    throw new NavUsageError("--depth may only be specified once");
  }
  if (parsed.global) throw new NavUsageError("nav requires --endpoint <name> and does not support -g");
  if (parsed.endpoint === undefined || parsed.endpoint.length === 0) {
    throw new NavUsageError("nav requires --endpoint <name>");
  }
  if (parsed.positionals.length > 1) {
    throw new NavUsageError(
      `unexpected argument '${parsed.positionals[1]}'; nav takes at most one [path] argument`,
    );
  }
  // Lexical validation lives at the parse layer so usage errors surface as
  // exit 2 before any endpoint work starts; the capability re-validates.
  if (parsed.depth !== undefined && (parsed.depth < 0 || parsed.depth > NAV_MAX_DEPTH)) {
    throw new NavUsageError(`--depth must be an integer between 0 and ${NAV_MAX_DEPTH}`);
  }
  if (parsed.positionals[0] !== undefined) {
    validateNavRoutePath(parsed.positionals[0]);
  }

  return {
    endpoint: parsed.endpoint,
    ...(parsed.positionals[0] === undefined ? {} : { path: parsed.positionals[0] }),
    ...(parsed.depth === undefined ? {} : { depth: parsed.depth }),
    json: parsed.json,
  };
}

export function executeNavCommand(args: readonly string[], context: NavContext): NavCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderNavHelp(), stderr: "" };
  }

  let request: NavRequest;
  try {
    request = parseNavArgs(args);
  } catch (error) {
    if (error instanceof NavUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderNavUsageError(error.message) };
    }
    throw error;
  }

  try {
    const outcome = runNav(request, context);
    if (!outcome.ok) {
      // Single render source for failures too: the factual message is
      // capability data; only the prefix, exit code, and hint wording are
      // CLI renderings.
      return {
        exitCode: NAV_EXIT_BY_ERROR_CLASS[outcome.failure.errorClass],
        stdout: "",
        stderr: `ukp nav: ${outcome.failure.message}\n`,
      };
    }

    const envelope = projectNavEnvelope(outcome.result);
    // Diagnostics go to stderr in BOTH render modes (read's channel
    // discipline: stdout is the payload, stderr is the operational
    // channel). Without this, a Human-mode budget hit would be silent —
    // violating ADR 0018's loud contract. JSON keeps the diagnostics in
    // the envelope too.
    const diagnosticLines = envelope.diagnostics
      .map((diagnostic) => `ukp nav: ${diagnostic.code}: ${diagnostic.message}`)
      .join("\n");
    return {
      exitCode: 0,
      stdout: request.json ? renderNavJson(envelope) : renderNavHuman(envelope),
      stderr: diagnosticLines.length > 0 ? `${diagnosticLines}\n` : "",
    };
  } catch (error) {
    if (error instanceof NavUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderNavUsageError(error.message) };
    }
    if (error instanceof ScopeError) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `ukp nav: ${error.message}\nRun 'ukp list' to inspect registrations and 'ukp register' from a Service folder, then retry.\n`,
      };
    }
    if (error instanceof ManifestError) {
      return { exitCode: 1, stdout: "", stderr: `ukp nav: ${error.message}\n` };
    }
    if (error instanceof NavProviderError) {
      return { exitCode: 1, stdout: "", stderr: `ukp nav: ${error.message}\n` };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp nav: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

export function renderNavHelp(): string {
  return createNavCommand().helpInformation();
}

export function renderNavUsageError(message: string): string {
  return [
    `ukp nav: ${message}`,
    "Usage: ukp nav --endpoint <name> [path] [--depth <n>] [--json]",
    "Run 'ukp nav --help' for details.",
  ].join("\n");
}
