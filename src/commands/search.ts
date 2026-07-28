import { Command, CommanderError } from "commander";
import {
  executeHumanSearch,
  SearchUsageError,
  type HumanSearchContext,
  type HumanSearchResult,
  type ParsedSearch,
} from "../capabilities/search.ts";
import { ScopeError } from "../scope.ts";
import { countFlagOccurrences, isHelpRequest } from "./flags.ts";

function collectValues(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function createSearchCommand(): Command {
  return new Command("ukp search")
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(true)
    .helpOption("-h, --help", "show this help")
    .usage("<query> [--limit <1-1000>] [--endpoint <name> ... | -g] [--json]")
    .description("Run atomic lexical search against the selected Service endpoints.")
    .argument("[query]", "one non-empty search query; quote multi-word queries")
    .option("--limit <1-1000>", "maximum results requested from each endpoint (default: 20)")
    .option(
      "-c, --endpoint <name>",
      "select one endpoint; repeat to select multiple endpoints",
      collectValues,
    )
    .option("-g", "search every endpoint in the Host Registry; takes no value")
    .option("--json", "write provider-native results to artifacts and print an envelope");
}

function parseSearchCommand(args: readonly string[]): {
  positionals: string[];
  limit?: string;
  endpoints: string[];
  global?: boolean;
  json?: boolean;
} {
  const command = createSearchCommand()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new SearchUsageError(error.message.replace(/^error: /, ""));
    }
    throw error;
  }

  const options = command.opts<{
    limit?: string;
    endpoint?: string[];
    g?: boolean;
    json?: boolean;
  }>();
  return {
    positionals: command.args,
    limit: options.limit,
    endpoints: options.endpoint ?? [],
    global: options.g,
    json: options.json,
  };
}

export function parseSearchArgs(args: readonly string[]): ParsedSearch {
  let limit = 20;
  const explicit: string[] = [];
  const warnings: string[] = [];
  const parsed = parseSearchCommand(args);

  if (countFlagOccurrences(args, "--limit") > 1) throw new SearchUsageError("--limit may only be specified once");
  if (countFlagOccurrences(args, "-g") > 1) throw new SearchUsageError("-g may only be specified once");
  if (countFlagOccurrences(args, "--json") > 1) throw new SearchUsageError("--json may only be specified once");

  if (parsed.limit !== undefined) {
    if (!/^[0-9]+$/.test(parsed.limit)) throw new SearchUsageError("--limit must be a decimal integer");
    limit = Number(parsed.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new SearchUsageError("--limit must be between 1 and 1000");
    }
  }

  for (const endpoint of parsed.endpoints) {
    if (explicit.includes(endpoint)) warnings.push(`duplicate endpoint '${endpoint}' ignored`);
    else explicit.push(endpoint);
  }

  const [query, unexpected] = parsed.positionals;
  if (unexpected !== undefined) {
    throw new SearchUsageError(
      `unexpected argument '${unexpected}'; search accepts exactly one query. `
      + "Use '--endpoint <name>' to select an endpoint; '-g' takes no value.",
    );
  }
  if (query === undefined || query.length === 0) throw new SearchUsageError("search query must be non-empty");
  if (parsed.global && explicit.length > 0) {
    throw new SearchUsageError("--endpoint and -g cannot be used together");
  }
  return {
    request: { query, limit },
    options: {
      explicitEndpoints: explicit.length > 0 ? explicit : undefined,
      global: parsed.global ?? false,
      json: parsed.json ?? false,
    },
    warnings,
  };
}

export function executeSearchCommand(args: readonly string[], context: HumanSearchContext): HumanSearchResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderSearchHelp(), stderr: "" };
  }

  try {
    return executeHumanSearch(parseSearchArgs(args), context);
  } catch (error) {
    if (error instanceof SearchUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderSearchUsageError(error.message) };
    }
    if (error instanceof ScopeError) {
      return { exitCode: 1, stdout: "", stderr: `ukp search: ${error.message}\n` };
    }
    throw error;
  }
}

export function renderSearchHelp(): string {
  return createSearchCommand().helpInformation();
}

export function renderSearchUsageError(message: string): string {
  return [
    `ukp search: ${message}`,
    "Usage: ukp search <query> [--limit <1-1000>] [--endpoint <name> ... | -g] [--json]",
    "Run 'ukp search --help' for details.",
  ].join("\n");
}
