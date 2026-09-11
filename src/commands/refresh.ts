import { Command, CommanderError } from "commander";
import {
  runRefresh,
  renderRefreshHuman,
  RefreshUsageError,
  type ParsedRefresh,
  type RefreshAggregateStatus,
  type RefreshContext,
} from "../capabilities/refresh.ts";

export type { RefreshContext } from "../capabilities/refresh.ts";
import { ScopeError } from "../scope.ts";
import { countFlagOccurrences, isHelpRequest } from "./flags.ts";

/** CLI-owned command result shape (ADR 0021). */
export interface RefreshCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Aggregate classification → exit code (ADR 0021). */
const REFRESH_EXIT_BY_AGGREGATE: Record<RefreshAggregateStatus, number> = {
  "succeeded": 0,
  "failed": 1,
  "no-success": 1,
  "cancelled": 130,
};

function collectValues(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function createRefreshCommand(): Command {
  return new Command("ukp refresh")
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(true)
    .helpOption("-h, --help", "show this help")
    .usage("[--endpoint <name> ... | -g]")
    .description("Trigger provider-owned maintenance for selected Service endpoints.")
    .option(
      "-c, --endpoint <name>",
      "refresh one endpoint; repeat to refresh multiple endpoints",
      collectValues,
    )
    .option("-g", "refresh every endpoint in the Host Registry; takes no value");
}

function parseRefreshCommand(args: readonly string[]): {
  positionals: string[];
  endpoints: string[];
  global?: boolean;
} {
  const command = createRefreshCommand()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new RefreshUsageError(error.message.replace(/^error: /, ""));
    }
    throw error;
  }

  const options = command.opts<{
    endpoint?: string[];
    g?: boolean;
  }>();
  return {
    positionals: command.args,
    endpoints: options.endpoint ?? [],
    global: options.g,
  };
}

export function parseRefreshArgs(args: readonly string[]): ParsedRefresh {
  const parsed = parseRefreshCommand(args);
  const explicit: string[] = [];
  const warnings: string[] = [];

  if (countFlagOccurrences(args, "-g") > 1) throw new RefreshUsageError("-g may only be specified once");
  const [unexpected] = parsed.positionals;
  if (unexpected !== undefined) {
    throw new RefreshUsageError(
      `unexpected argument '${unexpected}'. Use '--endpoint <name>' to select an endpoint; '-g' takes no value.`,
    );
  }

  for (const endpoint of parsed.endpoints) {
    if (explicit.includes(endpoint)) warnings.push(`duplicate endpoint '${endpoint}' ignored`);
    else explicit.push(endpoint);
  }

  if (parsed.global && explicit.length > 0) {
    throw new RefreshUsageError("--endpoint and -g cannot be used together");
  }

  return {
    options: {
      explicitEndpoints: explicit.length > 0 ? explicit : undefined,
      global: parsed.global ?? false,
    },
    warnings,
  };
}

/** CLI composition of the structured outcome (ADR 0021); kept as the test
 * entry so suites exercise the exact adapter path the bin takes. */
export function executeRefresh(parsed: ParsedRefresh, context: RefreshContext): RefreshCommandResult {
  const result = runRefresh(parsed, context);
  const view = renderRefreshHuman(result);
  return {
    exitCode: REFRESH_EXIT_BY_AGGREGATE[result.aggregate],
    stdout: view.body,
    stderr: view.diagnostics,
  };
}

export function executeRefreshCommand(args: readonly string[], context: RefreshContext): RefreshCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderRefreshHelp(), stderr: "" };
  }

  try {
    return executeRefresh(parseRefreshArgs(args), context);
  } catch (error) {
    if (error instanceof RefreshUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderRefreshUsageError(error.message) };
    }
    if (error instanceof ScopeError) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: [
          `ukp refresh: ${error.message}`,
          "Hint: run 'ukp list' to inspect registrations, 'ukp register' from a Service folder to add one, or pass '-g' to explicitly refresh every registered endpoint.",
          "",
        ].join("\n"),
      };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp refresh: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

export function renderRefreshHelp(): string {
  return createRefreshCommand().helpInformation();
}

export function renderRefreshUsageError(message: string): string {
  return [
    `ukp refresh: ${message}`,
    "Usage: ukp refresh [--endpoint <name> ... | -g]",
    "Run 'ukp refresh --help' for details.",
  ].join("\n");
}
