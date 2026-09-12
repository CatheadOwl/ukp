import {
  runSearch,
  projectSearchEnvelope,
  renderSearchHuman,
  renderSearchJson,
  SearchPlanningError,
  type ParsedSearch,
  type SearchAggregateStatus,
  type SearchContext,
} from "../capabilities/search.ts";
import { ManifestError } from "../config/manifest.ts";
import { ScopeError } from "../scope.ts";
import { KitUsageError, parseKitArgs, renderKitHelp, renderKitUsageError, type UkpCommandSpec } from "./kit.ts";
import { HelpRequestError, isHelpRequest } from "./flags.ts";

/** CLI-owned command result shape (ADR 0021: exit codes and channel text
 * belong to the surface adapter, not the capability). */
export interface SearchCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Aggregate classification → exit code (ADR 0021: the D-036 aggregation
 * rule lives here, driven by the capability's structured classification —
 * skip never changes the success state; a provider failure fails the run;
 * an interrupt is 130). */
const SEARCH_EXIT_BY_AGGREGATE: Record<SearchAggregateStatus, number> = {
  "succeeded": 0,
  "provider-failure": 1,
  "no-success": 1,
  "cancelled": 130,
};

/** Single-source command spec (ADR 0024). Options-only form: `-c`/`-g` are
 * declared inline rather than via `scope` so the rendered option order and
 * the error precedence (limit validation before duplicate warnings, excess
 * check before the conflict) stay byte-identical with the pre-kit command;
 * adopting the generated scope family waits for an adjudicated
 * precedence-unification pass. */
export const SEARCH_SPEC: UkpCommandSpec = {
  name: "search",
  summary: "search a Service's indexed content (provider-backed; use 'ukp rg' to grep raw files)",
  group: "endpoint",
  description: "Run atomic lexical search against the selected Service endpoints.",
  usage: "<query> [--limit <1-1000>] [--endpoint <name> ... | -g] [--recursive] [--json]",
  arguments: [{ name: "query", help: "one non-empty search query; quote multi-word queries" }],
  options: [
    { flags: "--limit <1-1000>", help: "maximum results requested from each endpoint (default: 20)" },
    { flags: "-c, --endpoint <name>", help: "select one endpoint; repeat to select multiple endpoints", multi: true },
    { flags: "-g", help: "search every endpoint in the Host Registry; takes no value" },
    { flags: "--recursive", help: "include direct authority and context dependencies" },
    { flags: "--json", help: "write provider-native results to artifacts and print an envelope" },
  ],
  helpSuffix: [
    "",
    "Result scope:",
    "  With no --endpoint or -g, the workspace default scope applies: the",
    "  Client Config's default endpoints ('ukp inspect' shows the resolved",
    "  scope); with no Client Config, every registered endpoint.",
    "  --endpoint <name> requests that Service's search capability. The result",
    "  range is decided by the Service's provider configuration and may include",
    "  shared collections; results are not guaranteed to be the endpoint's own",
    "  content. '== <name> ==' reports which Service was asked, not content",
    "  ownership.",
    "  --recursive keeps selected endpoints as depth-0 seeds and adds their",
    "  registered authority/context dependencies at depth 1.",
    "  Human results carry a copyable 'read:'/'uri:' handoff line that",
    "  'ukp read' accepts directly.",
    "",
  ].join("\n"),
};

interface SearchCommandOptions extends Record<string, unknown> {
  limit?: string;
  endpoint?: string[];
  g?: boolean;
  recursive?: boolean;
  json?: boolean;
}

export function parseSearchArgs(args: readonly string[]): ParsedSearch {
  let limit = 20;
  const explicit: string[] = [];
  const warnings: string[] = [];
  const parsed = parseKitArgs<SearchCommandOptions>(SEARCH_SPEC, args);

  // Command-side semantic checks, in the pre-kit order (limit validation
  // directly after the generated singleton checks, then duplicates, excess,
  // emptiness, conflict).
  if (parsed.options.limit !== undefined) {
    if (!/^[0-9]+$/.test(parsed.options.limit)) throw new KitUsageError("--limit must be a decimal integer");
    limit = Number(parsed.options.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new KitUsageError("--limit must be between 1 and 1000");
    }
  }

  for (const endpoint of parsed.options.endpoint ?? []) {
    if (explicit.includes(endpoint)) warnings.push(`duplicate endpoint '${endpoint}' ignored`);
    else explicit.push(endpoint);
  }

  const [query, unexpected] = parsed.positionals;
  if (unexpected !== undefined) {
    throw new KitUsageError(
      `unexpected argument '${unexpected}'; search accepts exactly one query. `
      + "Use '--endpoint <name>' to select an endpoint; '-g' takes no value.",
    );
  }
  if (query === undefined || query.length === 0) throw new KitUsageError("search query must be non-empty");
  if (parsed.options.g && explicit.length > 0) {
    throw new KitUsageError("--endpoint and -g cannot be used together");
  }
  return {
    request: { query, limit },
    options: {
      explicitEndpoints: explicit.length > 0 ? explicit : undefined,
      global: parsed.options.g ?? false,
      recursive: parsed.options.recursive ?? false,
      json: parsed.options.json ?? false,
    },
    warnings,
  };
}

export function executeSearchCommand(args: readonly string[], context: SearchContext): SearchCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderSearchHelp(), stderr: "" };
  }

  try {
    return executeHumanSearch(parseSearchArgs(args), context);
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderSearchHelp(), stderr: "" };
    }
    if (error instanceof KitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderSearchUsageError(error.message) };
    }
    if (error instanceof ScopeError) {
      return { exitCode: 1, stdout: "", stderr: `ukp search: ${error.message}\n` };
    }
    if (error instanceof SearchPlanningError) {
      return { exitCode: 1, stdout: "", stderr: `ukp search: ${error.message}\n` };
    }
    if (error instanceof ManifestError) {
      return { exitCode: 1, stdout: "", stderr: `ukp search: ${error.message}\n` };
    }
    throw error;
  }
}

/** CLI composition of the structured outcome (ADR 0021): the shared renders
 * plus the aggregate → exit-code mapping. Kept as the test entry so suites
 * exercise the exact adapter path the `ukp search` bin takes. */
export function executeHumanSearch(parsed: ParsedSearch, context: SearchContext): SearchCommandResult {
  const result = runSearch(parsed, context);
  const exitCode = SEARCH_EXIT_BY_AGGREGATE[result.aggregate];
  if (parsed.options.json) {
    return { exitCode, stdout: renderSearchJson(projectSearchEnvelope(result)), stderr: "" };
  }
  return {
    exitCode,
    stdout: renderSearchHuman(result),
    stderr: result.warnings.length > 0 ? `${result.warnings.join("\n")}\n` : "",
  };
}

export function renderSearchHelp(): string {
  return renderKitHelp(SEARCH_SPEC);
}

export function renderSearchUsageError(message: string): string {
  return renderKitUsageError(SEARCH_SPEC, message);
}
