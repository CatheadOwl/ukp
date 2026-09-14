import {
  runSearch,
  projectSearchEnvelope,
  renderSearchHuman,
  renderSearchJson,
  SearchPlanningError,
  type ParsedSearch,
  type SearchAggregateStatus,
  type SearchContext,
  type SearchEndpointOutcome,
  type SearchResult,
} from "../capabilities/search.ts";
import {
  fetchDiscoveryDocument,
  openRemoteTransport,
  remoteSearch,
  resolveRemoteToken,
  type RemoteTransportHandle,
} from "../capabilities/remote-client.ts";
import { isRemoteBinding, readRegistry } from "../registry.ts";
import { resolveScope, ScopeError } from "../scope.ts";
import { ManifestError } from "../config/manifest.ts";
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
    "  scope); with no Client Config, every registered endpoint. -g cannot",
    "  be combined with --endpoint.",
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

/** Remote-in-scope detection (sync): when the selected scope contains remote
 * bindings, execution switches to the async mixed driver — local endpoints
 * keep the exact sync runSearch path (zero contract change), remote
 * endpoints run over the wire. The conditional-async seam is the ukp_remote
 * W2 migration boundary; full async-native execution is a later refactor. */
function selectedRemoteBindings(parsed: ParsedSearch, context: SearchContext) {
  const registry = readRegistry(context.registryPath);
  const scope = resolveScope({
    currentDirectory: context.currentDirectory,
    registry,
    explicitEndpoints: parsed.options.explicitEndpoints,
    global: parsed.options.global,
  });
  return { registry, scope, remotes: scope.bindings.filter(isRemoteBinding) };
}

export function executeSearchCommand(
  args: readonly string[],
  context: SearchContext,
): SearchCommandResult | Promise<SearchCommandResult> {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderSearchHelp(), stderr: "" };
  }

  try {
    const parsed = parseSearchArgs(args);
    const { scope, remotes } = selectedRemoteBindings(parsed, context);
    if (remotes.length === 0) {
      return executeHumanSearch(parsed, context);
    }
    return executeMixedSearch(parsed, context, scope, remotes);
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

/** Mixed local+remote execution: locals via the unchanged sync runSearch,
 * remotes via discovery-check + POST /v1/search, merged in scope order under
 * the D-036 aggregation. */
async function executeMixedSearch(
  parsed: ParsedSearch,
  context: SearchContext,
  scope: ReturnType<typeof resolveScope>,
  remotes: ReturnType<typeof selectedRemoteBindings>["remotes"],
): Promise<SearchCommandResult> {
  const remoteNames = new Set(remotes.map((binding) => binding.name));
  const localNames = scope.bindings.filter((binding) => !remoteNames.has(binding.name)).map((b) => b.name);
  const baseWarnings: string[] = [...parsed.warnings, ...scope.warnings];

  let localResult: SearchResult | undefined;
  if (localNames.length > 0) {
    localResult = runSearch(
      {
        ...parsed,
        options: { ...parsed.options, explicitEndpoints: localNames, global: false },
        warnings: [...baseWarnings],
      },
      context,
    );
  }
  // Local run warnings (provider failures, duplicate-endpoint notes) carry
  // into the merged view; remote-phase warnings append after them.
  const warnings: string[] = localResult !== undefined ? [...localResult.warnings] : [...baseWarnings];

  const remoteOutcomes = new Map<string, SearchEndpointOutcome>();
  for (const binding of remotes) {
    const token = resolveRemoteToken(binding);
    let transport: RemoteTransportHandle | undefined;
    try {
      transport = await openRemoteTransport(binding, { registryPath: context.registryPath });
      const discovery = await fetchDiscoveryDocument(binding, transport, token);
      warnings.push(...discovery.warnings);
      if (discovery.bearerRequired && token === undefined) {
        warnings.push(
          `endpoint '${binding.name}' requires a bearer token; pass --token at registration or set UKP_ENDPOINT_${binding.name.toUpperCase().replace(/-/g, "_")}_TOKEN`,
        );
      }
      if (!("search" in discovery.doc.capabilities)) {
        const message = `endpoint '${binding.name}' declares no search capability`;
        // Local planned skips surface their reason as a warning (D-036 render
        // contract); the remote skip joins them so stderr stays informative.
        warnings.push(message);
        remoteOutcomes.set(binding.name, {
          name: binding.name,
          provider: null,
          status: "skipped",
          message,
        });
        continue;
      }
      const execution = await remoteSearch(binding, transport, token, parsed.request.query, parsed.request.limit);
      remoteOutcomes.set(binding.name, {
        ...execution.outcome,
        ...(execution.results.length > 0 ? { providerOutput: JSON.stringify(execution.results) } : {}),
        ...(execution.references !== undefined
          ? { remoteUris: execution.references.map((entry) => entry.ukp_uri) }
          : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Local failures surface via warnings (D-036 render contract); remote
      // transport failures join them so stderr stays the failure channel.
      warnings.push(`endpoint '${binding.name}' provider failed: ${message}`);
      remoteOutcomes.set(binding.name, {
        name: binding.name,
        provider: null,
        status: "failed",
        message,
      });
    } finally {
      transport?.close();
    }
  }

  const byName = new Map((localResult?.endpoints ?? []).map((outcome) => [outcome.name, outcome]));
  const endpoints: SearchEndpointOutcome[] = scope.bindings.map(
    (binding) => byName.get(binding.name) ?? remoteOutcomes.get(binding.name)!,
  );
  const statuses = endpoints.map((outcome) => outcome.status);
  const aggregate: SearchAggregateStatus = statuses.includes("cancelled")
    ? "cancelled"
    : statuses.includes("failed")
      ? "provider-failure"
      : statuses.includes("succeeded")
        ? "succeeded"
        : "no-success";
  const merged: SearchResult = {
    query: parsed.request.query,
    limit: parsed.request.limit,
    ...(localResult?.runId !== undefined ? { runId: localResult.runId } : {}),
    endpoints,
    warnings,
    aggregate,
  };
  return renderSearchCommandResult(parsed.options.json, merged);
}

function renderSearchCommandResult(json: boolean, result: SearchResult): SearchCommandResult {
  const exitCode = SEARCH_EXIT_BY_AGGREGATE[result.aggregate];
  if (json) {
    return { exitCode, stdout: renderSearchJson(projectSearchEnvelope(result)), stderr: "" };
  }
  return {
    exitCode,
    stdout: renderSearchHuman(result),
    stderr: result.warnings.length > 0 ? `${result.warnings.join("\n")}\n` : "",
  };
}

/** CLI composition of the structured outcome (ADR 0021): the shared renders
 * plus the aggregate → exit-code mapping. Kept as the test entry so suites
 * exercise the exact adapter path the `ukp search` bin takes. */
export function executeHumanSearch(parsed: ParsedSearch, context: SearchContext): SearchCommandResult {
  return renderSearchCommandResult(parsed.options.json, runSearch(parsed, context));
}

export function renderSearchHelp(): string {
  return renderKitHelp(SEARCH_SPEC);
}

export function renderSearchUsageError(message: string): string {
  return renderKitUsageError(SEARCH_SPEC, message);
}
