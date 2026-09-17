import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { createArtifactRun } from "../artifacts.ts";
import {
  loadManifest,
  ManifestError,
  type LoadedManifest,
  type ManifestDependency,
} from "../config/manifest.ts";
import { isRemoteBinding, localPathOf, readRegistry, type RegistryBinding } from "../registry.ts";
import { resolveScope } from "../scope.ts";
import { isAbsoluteShapedPath, isInsideRealRoot } from "../path-safety.ts";
import { buildQmdInvocation, defaultQmdCommand, isDocidBody, providerTimeoutMs, stripDocidHash } from "./qmd.ts";

export interface SearchRequest {
  query: string;
  limit: number;
}

export interface SearchOptions {
  explicitEndpoints?: string[];
  global: boolean;
  recursive: boolean;
  json: boolean;
}

export interface ParsedSearch {
  request: SearchRequest;
  options: SearchOptions;
  warnings: string[];
}

export class SearchPlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchPlanningError";
  }
}

/** ADR 0021 context injection (registry path, provider command, artifact
 * root/run id, clock) — no ambient state. */
export interface SearchContext {
  currentDirectory: string;
  registryPath: string;
  qmdCommand?: readonly string[];
  artifactRoot?: string;
  artifactRunId?: string;
  now?: Date;
}

/** ADR 0021 aggregate classification (D-036: skip never changes the success
 * state; a provider failure makes the whole run exit non-zero). The surface
 * adapter maps this onto exit codes — the capability never decides them. */
export type SearchAggregateStatus =
  | "succeeded"
  | "provider-failure"
  | "cancelled"
  | "no-success";

/** One endpoint's structured result. Contract zone: name/provider/status/
 * message plus the json-mode artifact fields. Provider-native zone: the raw
 * provider output and exit status (human-mode render source, passed through
 * unmodeled per ADR 0021 §1). `folder` is internal provenance for the human
 * renderer (ukp:// derivation), never part of the envelope. */
export interface SearchEndpointOutcome {
  name: string;
  provider: string | null;
  /** Undefined only transiently while the run classifies the provider
   * result; every path assigns a final status before the outcome escapes
   * (the envelope projection defaults any stray undefined to `failed`). */
  status?:
    | "succeeded"
    | "no_matches"
    | "skipped"
    | "failed"
    | "cancelled"
    /** human mode only: this endpoint's SIGINT stopped the run — its header
     * was already rendered, its result block never is. */
    | "interrupted";
  /** Factual skip/failure message (envelope `message`), no surface prefix. */
  message?: string;
  traversal?: TraversalProvenance;
  folder?: string;
  /** Raw provider stdout, trimmed (human-mode render source). */
  providerOutput?: string;
  /** Raw provider exit status (null on signal or spawn error). */
  providerExitStatus?: number | null;
  /** Provider stderr detail or spawn error message. */
  providerErrorDetail?: string;
  artifact?: string;
  format?: string;
  references_artifact?: string;
  references_format?: "ukp-search-references-v1";
  error_artifact?: string;
  /** Remote endpoints only (ukp_remote W2): server-declared `ukp_uri` per
   * result index (RQ-06/RQ-09 — the server owns containment). Internal
   * renderer input like `folder`, never part of the envelope. */
  remoteUris?: ReadonlyArray<string | undefined>;
}

/** ADR 0021 structured outcome: everything both render modes and future
 * surfaces (MCP, programmatic) consume. No stdout/stderr/exit codes. */
export interface SearchResult {
  query: string;
  limit: number;
  /** Present only when the run produced an artifact directory (json mode). */
  runId?: string;
  endpoints: SearchEndpointOutcome[];
  warnings: string[];
  aggregate: SearchAggregateStatus;
}

interface PlannedEndpoint {
  name: string;
  provider: string | null;
  status: "executable" | "skipped";
  folder?: string;
  command?: readonly string[];
  warning?: string;
  traversal?: TraversalProvenance;
}

interface TraversalVia {
  kind: ManifestDependency["kind"];
  reason?: string;
}

interface TraversalProvenance {
  depth: 0 | 1;
  path: string[];
  via: TraversalVia | null;
}

function isStaleServiceBinding(error: unknown): boolean {
  if (!(error instanceof ManifestError)) return false;
  return error.message.startsWith("Service folder is not accessible:")
    || error.message.startsWith("Service Manifest is not readable:");
}

export interface SearchEndpointEnvelope {
  name: string;
  provider: string | null;
  status: "succeeded" | "no_matches" | "skipped" | "failed" | "cancelled";
  artifact?: string;
  format?: string;
  references_artifact?: string;
  references_format?: "ukp-search-references-v1";
  error_artifact?: string;
  message?: string;
  depth?: 0 | 1;
  path?: string[];
  via?: TraversalVia | null;
}

export interface SearchEnvelope {
  schema: "ukp.search.v1";
  run_id: string;
  command: "search";
  capability: "search";
  query: string;
  limit: number;
  endpoints: SearchEndpointEnvelope[];
  warnings: string[];
}

function planSearch(parsed: ParsedSearch, context: SearchContext): {
  plan: PlannedEndpoint[];
  warnings: string[];
} {
  const registry = readRegistry(context.registryPath);
  const scope = resolveScope({
    currentDirectory: context.currentDirectory,
    registry,
    explicitEndpoints: parsed.options.explicitEndpoints,
    global: parsed.options.global,
  });

  const qmdCommand = context.qmdCommand ?? defaultQmdCommand();
  const warnings = [...parsed.warnings, ...scope.warnings];
  const plan: PlannedEndpoint[] = [];
  const loadedServices = new Map<string, LoadedManifest>();

  const planBinding = (
    binding: RegistryBinding,
    traversal?: TraversalProvenance,
  ): PlannedEndpoint => {
    if (isRemoteBinding(binding)) {
      // Adapter responsibility: remote endpoints execute through the remote
      // transport (commands/search.ts mixed driver); the local planner only
      // records the skip defensively.
      return {
        name: binding.name,
        provider: null,
        status: "skipped",
        warning: "remote endpoints execute via the remote transport; the local planner skipped it",
      };
    }
    let service;
    try {
      service = loadManifest(localPathOf(binding));
    } catch (error) {
      if (!isStaleServiceBinding(error)) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      const warning = [
        `endpoint '${binding.name}' is not accessible: ${detail}`,
        `Hint: run 'ukp inspect --endpoint ${binding.name}' or re-register/remove the stale endpoint.`,
      ].join("\n");
      warnings.push(warning);
      return { name: binding.name, provider: null, status: "skipped", warning, traversal };
    }
    if (service.effectiveName !== binding.name) {
      throw new SearchPlanningError(
        `endpoint '${binding.name}' no longer matches Service effective name '${service.effectiveName}'`,
      );
    }
    loadedServices.set(binding.name, service);
    const capability = service.manifest.capabilities.search;
    if (!capability) {
      const warning = `endpoint '${binding.name}' does not provide search`;
      warnings.push(warning);
      return { name: binding.name, provider: null, status: "skipped", warning, traversal };
    }
    if (capability.provider !== "qmd") {
      const provider = capability.provider ?? "(none)";
      const warning = `endpoint '${binding.name}' uses unsupported search provider '${provider}'`;
      warnings.push(warning);
      return {
        name: binding.name,
        provider,
        status: "skipped",
        warning,
        traversal,
      };
    }
    if (!qmdCommand) {
      const warning = `endpoint '${binding.name}' search unavailable: qmd executable is not available`;
      warnings.push(warning);
      return { name: binding.name, provider: "qmd", status: "skipped", warning, traversal };
    }
    return {
      name: binding.name,
      provider: "qmd",
      status: "executable",
      folder: service.folder,
      command: qmdCommand,
      traversal,
    };
  };

  for (const binding of scope.bindings) {
    plan.push(planBinding(binding, parsed.options.recursive
      ? { depth: 0, path: [binding.name], via: null }
      : undefined));
  }

  // Dangling `default_endpoints` references never resolve to a binding, so they
  // produce a skipped plan entry at their declared position (not only a warning
  // string) — a JSON consumer must be able to count every skipped endpoint.
  for (const { name, configPath, index } of scope.dangling) {
    const warning = `'${name}' is not registered (from ${configPath})`;
    // `scope.bindings` and `scope.dangling` each preserve declaration order, and
    // each binding produced exactly one plan entry above, so the plan has
    // `index` entries before this dangling reference's declared position.
    plan.splice(index, 0, {
      name,
      provider: null,
      status: "skipped",
      warning,
      ...(parsed.options.recursive
        ? { traversal: { depth: 0 as const, path: [name], via: null } }
        : {}),
    });
  }

  if (scope.dangling.length > 0 && scope.configPath) {
    warnings.push(`Hint: run 'ukp list' or 'ukp diagnose' to check the selected scope, or edit ${scope.configPath}, then retry.`);
  }

  if (parsed.options.recursive) {
    const registryByName = new Map(registry.map((binding) => [binding.name, binding]));
    const visited = new Set(plan.map((endpoint) => endpoint.name));
    const discovered: PlannedEndpoint[] = [];

    for (const binding of scope.bindings) {
      const service = loadedServices.get(binding.name);
      if (!service) continue;
      const dependencies = [...(service.manifest.dependencies ?? [])]
        .filter((dependency) => dependency.kind === "authority" || dependency.kind === "context")
        .sort((left, right) => left.endpoint < right.endpoint ? -1 : left.endpoint > right.endpoint ? 1 : 0);
      for (const dependency of dependencies) {
        if (visited.has(dependency.endpoint)) continue;
        const targetBinding = registryByName.get(dependency.endpoint);
        if (!targetBinding) {
          warnings.push(
            `recursive dependency target '${dependency.endpoint}' is not registered `
            + `(declared by ${binding.name}, kind: ${dependency.kind})`,
          );
          continue;
        }
        visited.add(dependency.endpoint);
        discovered.push(planBinding(targetBinding, {
          depth: 1,
          path: [binding.name, dependency.endpoint],
          via: {
            kind: dependency.kind,
            ...(dependency.reason ? { reason: dependency.reason } : {}),
          },
        }));
      }
    }
    plan.push(...discovered);

    for (const endpoint of discovered) {
      const service = loadedServices.get(endpoint.name);
      if (!service || !endpoint.traversal) continue;
      for (const dependency of service.manifest.dependencies ?? []) {
        if (dependency.kind !== "authority" && dependency.kind !== "context") continue;
        if (!endpoint.traversal.path.includes(dependency.endpoint)) continue;
        warnings.push(
          `recursive dependency cycle truncated: ${endpoint.name} -> ${dependency.endpoint} `
          + `(kind: ${dependency.kind}, path: ${endpoint.traversal.path.join(" -> ")})`,
        );
      }
    }
  }

  if (!plan.some((endpoint) => endpoint.status === "executable")) {
    warnings.push(registry.length === 0
      ? "no executable search endpoints: the Host Registry is empty; run 'ukp register' from a Service folder, then retry"
      : "no executable search endpoints: run 'ukp list' to inspect registrations and 'ukp diagnose' from the selected Service folder(s)");
  }
  return { plan, warnings };
}

function commandFor(endpoint: PlannedEndpoint, parsed: ParsedSearch, json: boolean): {
  file: string;
  args: string[];
  verbatim: boolean;
} {
  const providerArgs = [
    "search",
    parsed.request.query,
    "-n",
    String(parsed.request.limit),
  ];
  if (json) providerArgs.push("--format", "json");
  // The query is arbitrary user text: route through buildQmdInvocation so a
  // cmd.exe shim wrapper never lets cmd re-parse it.
  return buildQmdInvocation(endpoint.command!, providerArgs);
}

function renderTraversalProvenance(traversal: TraversalProvenance | undefined): string[] {
  if (!traversal) return [];
  const via = traversal.via ? ` via=${traversal.via.kind}` : "";
  const lines = [
    `traversal: depth=${traversal.depth} path=${traversal.path.join(" -> ")}${via}`,
  ];
  if (traversal.via?.reason) lines.push(`traversal_reason: ${traversal.via.reason}`);
  return lines;
}

function runHumanMode(
  parsed: ParsedSearch,
  plan: readonly PlannedEndpoint[],
  warnings: string[],
): SearchResult {
  const executable = plan.filter((endpoint) => endpoint.status === "executable");
  const endpoints: SearchEndpointOutcome[] = [];
  if (executable.length === 0) {
    return {
      query: parsed.request.query,
      limit: parsed.request.limit,
      endpoints,
      warnings,
      aggregate: "no-success",
    };
  }

  let failed = false;
  let interrupted = false;
  for (const endpoint of plan) {
    if (endpoint.status === "skipped") {
      endpoints.push({
        name: endpoint.name,
        provider: endpoint.provider,
        status: "skipped",
        message: endpoint.warning,
        ...(endpoint.traversal ? { traversal: endpoint.traversal } : {}),
      });
      continue;
    }
    if (interrupted) {
      // Executables after the SIGINT stop: recorded as cancelled so a JSON
      // consumer can count them, never rendered in human mode.
      endpoints.push({
        name: endpoint.name,
        provider: endpoint.provider,
        status: "cancelled",
        ...(endpoint.traversal ? { traversal: endpoint.traversal } : {}),
      });
      continue;
    }

    const command = commandFor(endpoint, parsed, true);
    const result = spawnSync(command.file, command.args, {
      cwd: endpoint.folder!,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: command.verbatim,
      maxBuffer: 64 * 1024 * 1024,
      timeout: providerTimeoutMs(),
    });
    const providerOutput = (result.stdout ?? "").trimEnd();
    const outcome: SearchEndpointOutcome = {
      name: endpoint.name,
      provider: endpoint.provider,
      ...(endpoint.traversal ? { traversal: endpoint.traversal } : {}),
      folder: endpoint.folder,
      providerOutput,
      providerExitStatus: result.status,
    };
    endpoints.push(outcome);
    if (result.signal === "SIGTERM") {
      // Zero-output hang guard: a timed-out provider is a classified failure,
      // never silence (see qmd.ts providerTimeoutMs).
      failed = true;
      const message = `endpoint '${endpoint.name}' provider timed out after ${providerTimeoutMs() / 1000}s (set UKP_PROVIDER_TIMEOUT_MS to adjust)`;
      warnings.push(message);
      outcome.status = "failed";
      outcome.providerExitStatus = null;
      outcome.message = `endpoint '${endpoint.name}' provider timed out`;
      continue;
    }
    if (result.signal === "SIGINT") {
      warnings.push(`endpoint '${endpoint.name}' provider cancelled`);
      outcome.status = "interrupted";
      outcome.providerExitStatus = null;
      interrupted = true;
      continue;
    }
    if (result.status !== 0 || result.error) {
      failed = true;
      const providerError = (result.stderr ?? "").trimEnd() || result.error?.message;
      warnings.push(`endpoint '${endpoint.name}' provider failed${providerError ? `: ${providerError}` : ""}`);
      outcome.status = "failed";
      outcome.providerErrorDetail = providerError;
      continue;
    }
    outcome.status = providerOutput ? "succeeded" : "no_matches";
    if (outcome.status === "no_matches") {
      // An empty provider result is indistinguishable from an unconfigured
      // provider to a first-run caller — surface the setup path as guidance
      // (search's own contract stays: no matches is a result, not a failure).
      warnings.push(`endpoint '${endpoint.name}' returned no matches; if the QMD provider has not been set up for this Service yet, see 'ukp guide service qmd'`);
    }
  }
  return {
    query: parsed.request.query,
    limit: parsed.request.limit,
    endpoints,
    warnings,
    aggregate: interrupted ? "cancelled" : failed ? "provider-failure" : "succeeded",
  };
}

function appendErrorArtifact(path: string, message: string): void {
  const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${message}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function classifyQmdArtifact(path: string): "succeeded" | "no_matches" {
  const size = statSync(path).size;
  if (size > 1024 * 1024) return "succeeded";
  const value = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(value) && value.length === 0 ? "no_matches" : "succeeded";
}

interface QmdReferenceMapping {
  provider_location: string;
  endpoint: string;
  reference?: string;
  line?: number;
  status: "read_ready" | "provider_only";
  read_adapter?: "qmd";
  ukp_uri?: string;
  reason?: string;
}

interface QmdReferenceSidecar {
  schema: "ukp.search.references.v1";
  endpoint: string;
  source_artifact: string;
  results: Array<QmdReferenceMapping & { index: number }>;
}

function maybeLine(line: number | undefined): { line?: number } {
  return line ? { line } : {};
}

function docidOf(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || !("docid" in result)) return undefined;
  const docid = (result as { docid?: unknown }).docid;
  if (typeof docid !== "string") return undefined;
  const bare = stripDocidHash(docid);
  return isDocidBody(bare) ? bare : undefined;
}

function lineOf(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null || !("line" in result)) return undefined;
  const line = (result as { line?: unknown }).line;
  return Number.isSafeInteger(line) && (line as number) > 0 ? (line as number) : undefined;
}

/** Exported for the rename-recovery L2 re-anchor (ADR 0020): extracts the
 * provider location (`uri`/`file` field) of one parsed QMD result object. */
export function providerLocationOf(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const record = result as { uri?: unknown; file?: unknown };
  if (typeof record.uri === "string") return record.uri;
  if (typeof record.file === "string") return record.file;
  return "";
}

/**
 * Percent-encode a `ukp://` path segment for emission (ADR 0019; the read
 * side percent-decodes symmetrically). Raw UTF-8 stays raw (grep-ability, IRI semantics);
 * only characters that cannot round-trip through the hierarchical form raw are
 * encoded: `%` (would be re-decoded on read), space, and the `#`/`?` delimiters.
 */
function encodeUkpUriSegment(segment: string): string {
  return segment.replace(/[%#? ]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/**
 * Derive the endpoint-relative path of one QMD result location (ADR 0019).
 *
 * The provider location is either path-shaped (`qmd://<absolute path>` — the
 * collection root is a filesystem path) or collection-shaped
 * (`qmd://<collection>/<rel>`). Only a location that resolves *inside* the
 * Service folder to an existing regular file yields a `ukp://` URI: the URI is
 * a slot promise (`ukp read` resolves it exactly), so it must never be emitted
 * for provider-managed or out-of-folder resources. Collection names are never
 * assumed to equal endpoint names — the resolved-containment + existence check,
 * not name matching, decides (lexical containment plus a realpath pass so
 * symlink escapes cannot yield an unreadable slot, mirroring the read hit path).
 */
/** Exported for the rename-recovery L2 re-anchor (ADR 0020): maps a provider
 * location to an endpoint-relative route when it safely resolves inside the
 * Service folder to an existing regular file. */
export function endpointRelativePathOf(providerLocation: string, endpointFolder: string): string | undefined {
  if (!providerLocation.startsWith("qmd://")) return undefined;
  const rest = providerLocation.slice("qmd://".length);
  let candidate: string;
  if (isAbsoluteShapedPath(rest)) {
    const rel = relative(resolve(endpointFolder), resolve(rest));
    // Cross-drive / UNC↔drive targets: `relative()` returns the absolute
    // target itself, which never starts with `..` — reject explicitly so the
    // containment boundary cannot be bypassed (ADR 0019 emission rule).
    if (isAbsoluteShapedPath(rel)) return undefined;
    candidate = rel.split(/[\\/]/).join("/");
  } else {
    const firstSlash = rest.indexOf("/");
    if (firstSlash <= 0) return undefined;
    candidate = rest.slice(firstSlash + 1).split(/[\\/]/).join("/");
  }
  if (candidate === "" || candidate.split("/").includes("..")) return undefined;
  const absolute = resolve(endpointFolder, ...candidate.split("/"));
  if (!isInsideRealRoot(resolve(endpointFolder), absolute)) return undefined;
  // Resolved containment, aligned with the read hit path (G5 defect closure):
  // a folder-internal symlink escaping the Service folder passes the lexical
  // checks above but must not yield a URI the exact slot route would refuse.
  let resolved: string;
  let resolvedFolder: string;
  try {
    resolved = realpathSync(absolute);
    resolvedFolder = realpathSync(endpointFolder);
  } catch {
    return undefined;
  }
  if (!isInsideRealRoot(resolvedFolder, resolved)) return undefined;
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  return candidate;
}

function ukpUriOf(providerLocation: string, endpointName: string, endpointFolder: string): string | undefined {
  const relPath = endpointRelativePathOf(providerLocation, endpointFolder);
  if (!relPath) return undefined;
  return `ukp://${endpointName}/${relPath.split("/").map(encodeUkpUriSegment).join("/")}`;
}

/**
 * Map one QMD search result to a UKP read-ready reference (ADR 0011).
 *
 * QMD-indexed results carry a stable `docid` content fingerprint. `search`
 * emits it as a bare handoff key (`#` stripped), not the weak `qmd://`/path
 * name; `read` re-adds the `#` and resolves by fingerprint exactly. Name, title,
 * and path become display-only provenance (`provider_location`). A result with
 * no usable docid has no UKP read route and is `provider_only`.
 */
function mapQmdResultToReference(
  endpointName: string,
  endpointFolder: string,
  result: unknown,
): QmdReferenceMapping {
  const providerLocation = providerLocationOf(result);
  const ukpUri = ukpUriOf(providerLocation, endpointName, endpointFolder);
  const docid = docidOf(result);
  if (!docid) {
    return {
      provider_location: providerLocation,
      endpoint: endpointName,
      status: "provider_only",
      ...(ukpUri ? { ukp_uri: ukpUri } : {}),
      reason: "qmd result has no usable docid",
    };
  }
  return {
    provider_location: providerLocation,
    endpoint: endpointName,
    reference: docid,
    ...maybeLine(lineOf(result)),
    status: "read_ready",
    read_adapter: "qmd",
    ...(ukpUri ? { ukp_uri: ukpUri } : {}),
  };
}

function rawTitleOf(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const title = (result as { title?: unknown }).title;
  return typeof title === "string" && title.trim() !== "" ? title : "";
}

function basenameOf(location: string): string {
  if (!location) return "";
  return location.split(/[\\/]/).filter(Boolean).pop() ?? location;
}

function snippetOf(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const snippet = (result as { snippet?: unknown }).snippet;
  if (typeof snippet !== "string") return undefined;
  const trimmed = snippet.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * A snippet anchored at file line 1 that starts with a `---` frontmatter banner
 * or a heading is file-head boilerplate, not a hit-location excerpt. It is not
 * shown as the excerpt; the title stands in for it.
 */
function isFileHeadBanner(snippet: string, line: number | undefined): boolean {
  if (line !== 1) return false;
  const head = snippet.trimStart();
  return head.startsWith("---") || head.startsWith("#");
}

/**
 * Render one structured QMD result as a result unit.
 *
 * A result unit answers three reader questions: what it is (`title — basename:line`),
 * why it matches (excerpt), and how to read it (a copyable `read` line addressing
 * the ADR 0011 handoff key `docid[:line]`). Provider vocabulary never reaches the
 * default Human surface: the docid appears only inside the `get` command, and
 * location provenance is reduced to a human-readable basename (the raw `qmd://`
 * stays in the `--json` reference sidecar). A result with no usable docid has no
 * get route and says so in plain words.
 */
function renderResultUnit(
  unitIndex: number,
  endpointName: string,
  endpointFolder: string,
  result: unknown,
  remoteUri?: string,
  remoteEndpoint = false,
): string {
  const providerLocation = providerLocationOf(result);
  const docid = docidOf(result);
  const line = lineOf(result);
  // Remote endpoints carry the server-declared ukp_uri (RQ-06/RQ-09): it is
  // the handoff key, so the read line addresses the URI directly and the
  // local docid serves provenance only.
  const ukpUri = remoteUri ?? ukpUriOf(providerLocation, endpointName, endpointFolder);
  const title = rawTitleOf(result);
  const base = basenameOf(providerLocation);
  const location = base ? (line ? `${base}:${line}` : base) : "";
  const identity = title
    ? (location ? `${title} — ${location}` : title)
    : (location || "");

  const snippet = snippetOf(result);
  const fallback = title || base;
  const excerpt = snippet && !isFileHeadBanner(snippet, line) ? snippet : fallback;

  const lines = [`${unitIndex}. ${identity}`];
  if (excerpt && excerpt !== fallback) lines.push(`   ${excerpt.replace(/\n/g, "\n   ")}`);
  if (remoteUri !== undefined) {
    lines.push(`   read: ukp read ${remoteUri}${line ? `#L${line}` : ""}`);
  } else if (docid && !remoteEndpoint) {
    // Remote endpoints never hand off via docid (RQ-09: session-scoped
    // fingerprint, meaningless across the wire) — a result without a
    // server-declared ukp_uri has no remote read route at all.
    const key = line ? `${docid}:${line}` : docid;
    lines.push(`   read: ukp read --endpoint ${endpointName} ${key}`);
  } else {
    lines.push(`   (no direct read — provider-managed result)`);
  }
  if (ukpUri && remoteUri === undefined) lines.push(`   uri: ${ukpUri}`);
  return lines.join("\n");
}

/**
 * Render an endpoint's structured QMD results as numbered result units.
 *
 * Returns `null` when the provider stdout is not a JSON array (or cannot be
 * parsed), so the caller falls back to the appended raw-provider format. An
 * empty array renders `(no matches)`. Units are separated by a blank line so
 * each `N.` block reads as one self-contained chunk even with multi-line excerpts.
 */
function renderResultUnits(
  providerOutput: string,
  endpointName: string,
  endpointFolder: string,
  remoteUris?: ReadonlyArray<string | undefined>,
): string | null {
  let nativeResults: unknown;
  try {
    nativeResults = JSON.parse(providerOutput);
  } catch {
    return null;
  }
  if (!Array.isArray(nativeResults)) return null;
  if (nativeResults.length === 0) return "(no matches)";
  return nativeResults
    .map((result, index) => renderResultUnit(index + 1, endpointName, endpointFolder, result, remoteUris?.[index], remoteUris !== undefined))
    .join("\n\n");
}

/**
 * Fallback (spec "Fallback"): a provider that did not return a parseable JSON
 * array renders as its raw output block plus a trailing `UKP reference:` list
 * (docid form). Docids are read from the provider's QMD location header lines
 * (`qmd://...:line #docid`); body lines with a 6-hex token (e.g. a color code)
 * are never treated as docids.
 */
function renderFallbackProviderBlock(providerOutput: string, endpointName: string): string {
  const lines = [providerOutput];
  const seen = new Set<string>();
  for (const textLine of providerOutput.split(/\r?\n/)) {
    if (!textLine.startsWith("qmd://")) continue;
    const docid = /#([a-f0-9]{6})/.exec(textLine);
    if (!docid) continue;
    const bare = docid[1];
    if (!isDocidBody(bare) || seen.has(bare)) continue;
    seen.add(bare);
    const lineHit = /:(\d+)\s+#[a-f0-9]{6}/.exec(textLine);
    const lineHint = lineHit ? ` --lines ${Number(lineHit[1])}` : "";
    lines.push(`UKP reference: ukp read --endpoint ${endpointName} ${bare}${lineHint}`);
  }
  return lines.join("\n");
}

function buildQmdReferenceSidecar(
  endpointName: string,
  endpointFolder: string,
  sourceArtifact: string,
): QmdReferenceSidecar {
  if (statSync(sourceArtifact).size > 1024 * 1024) {
    return {
      schema: "ukp.search.references.v1",
      endpoint: endpointName,
      source_artifact: sourceArtifact,
      results: [],
    };
  }
  const nativeResults = JSON.parse(readFileSync(sourceArtifact, "utf8"));
  if (!Array.isArray(nativeResults)) {
    throw new Error("qmd-json output is not an array");
  }
  return {
    schema: "ukp.search.references.v1",
    endpoint: endpointName,
    source_artifact: sourceArtifact,
    results: nativeResults.map((result, index) => ({
      index,
      ...mapQmdResultToReference(endpointName, endpointFolder, result),
    })),
  };
}

function writeQmdReferenceSidecar(
  endpointName: string,
  endpointFolder: string,
  sourceArtifact: string,
  sidecarPath: string,
): void {
  const sidecar = buildQmdReferenceSidecar(endpointName, endpointFolder, sourceArtifact);
  writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** Inline reference payload for artifact-less surfaces (ukp_remote serve,
 * RQ-07: remote responses inline the reference data — the serving side holds
 * no artifact root). Same mapping as the sidecar; `source_artifact` is
 * omitted because there is no artifact. Undefined when the provider output is
 * not a parseable JSON array, matching the sidecar's fallback semantics. */
export interface InlineSearchReferences {
  schema: "ukp.search.references.v1";
  endpoint: string;
  results: Array<QmdReferenceMapping & { index: number }>;
}

export function buildInlineReferences(
  endpointName: string,
  endpointFolder: string,
  providerOutput: string,
): InlineSearchReferences | undefined {
  let nativeResults: unknown;
  try {
    nativeResults = JSON.parse(providerOutput);
  } catch {
    return undefined;
  }
  if (!Array.isArray(nativeResults)) return undefined;
  return {
    schema: "ukp.search.references.v1",
    endpoint: endpointName,
    results: nativeResults.map((result, index) => ({
      index,
      ...mapQmdResultToReference(endpointName, endpointFolder, result),
    })),
  };
}

function runJsonMode(
  parsed: ParsedSearch,
  context: SearchContext,
  plan: readonly PlannedEndpoint[],
  warnings: string[],
): SearchResult {
  const run = createArtifactRun({
    root: context.artifactRoot,
    runId: context.artifactRunId,
    now: context.now,
  });
  let failed = false;
  let succeeded = false;
  let cancelled = false;

  const endpoints: SearchEndpointOutcome[] = [];
  for (const endpoint of plan) {
    if (endpoint.status === "skipped") {
      endpoints.push({
        name: endpoint.name,
        provider: endpoint.provider,
        status: "skipped",
        message: endpoint.warning,
        ...(endpoint.traversal ? { traversal: endpoint.traversal } : {}),
      });
      continue;
    }
    if (cancelled) {
      endpoints.push({
        name: endpoint.name,
        provider: endpoint.provider,
        status: "cancelled",
        ...(endpoint.traversal ? { traversal: endpoint.traversal } : {}),
      });
      continue;
    }

    const artifact = resolve(join(run.directory, `${endpoint.name}.json`));
    const referencesArtifact = resolve(join(run.directory, `${endpoint.name}.references.json`));
    const errorArtifact = resolve(join(run.directory, `${endpoint.name}.stderr.txt`));
    let stdoutFd: number | undefined;
    let stderrFd: number | undefined;
    const outcome: SearchEndpointOutcome = {
      name: endpoint.name,
      provider: endpoint.provider,
      ...(endpoint.traversal ? { traversal: endpoint.traversal } : {}),
      folder: endpoint.folder,
    };
    endpoints.push(outcome);
    try {
      stdoutFd = openSync(artifact, "w", 0o600);
      stderrFd = openSync(errorArtifact, "w", 0o600);
      const command = commandFor(endpoint, parsed, true);
      const result = spawnSync(command.file, command.args, {
        cwd: endpoint.folder!,
        stdio: ["ignore", stdoutFd, stderrFd],
        windowsHide: true,
        windowsVerbatimArguments: command.verbatim,
        timeout: providerTimeoutMs(),
      });
      closeSync(stdoutFd);
      stdoutFd = undefined;
      closeSync(stderrFd);
      stderrFd = undefined;

      outcome.artifact = artifact;
      outcome.format = "qmd-json";

      if (result.signal === "SIGTERM") {
        // Zero-output hang guard: classified failure + error artifact, never
        // silence (see qmd.ts providerTimeoutMs).
        failed = true;
        appendErrorArtifact(errorArtifact, `provider timed out after ${providerTimeoutMs() / 1000}s`);
        const message = `endpoint '${endpoint.name}' provider timed out`;
        warnings.push(message);
        outcome.status = "failed";
        outcome.error_artifact = errorArtifact;
        outcome.message = message;
        continue;
      }

      if (result.signal === "SIGINT") {
        cancelled = true;
        appendErrorArtifact(errorArtifact, "provider cancelled by SIGINT");
        outcome.status = "cancelled";
        outcome.error_artifact = errorArtifact;
        outcome.message = "provider cancelled by SIGINT";
        warnings.push(`endpoint '${endpoint.name}' provider cancelled`);
        continue;
      }

      if (result.status !== 0 || result.error) {
        failed = true;
        if (result.error) appendErrorArtifact(errorArtifact, result.error.message);
        const message = `endpoint '${endpoint.name}' provider failed`;
        warnings.push(message);
        outcome.status = "failed";
        outcome.error_artifact = errorArtifact;
        outcome.message = message;
        continue;
      }

      let status: "succeeded" | "no_matches";
      try {
        status = classifyQmdArtifact(artifact);
      } catch (error) {
        failed = true;
        const detail = error instanceof Error ? error.message : String(error);
        appendErrorArtifact(errorArtifact, `invalid qmd-json output: ${detail}`);
        const message = `endpoint '${endpoint.name}' returned invalid qmd-json`;
        warnings.push(message);
        outcome.status = "failed";
        outcome.error_artifact = errorArtifact;
        outcome.message = message;
        continue;
      }

      succeeded = true;
      outcome.status = status;
      let hasReferenceSidecar = false;
      try {
        writeQmdReferenceSidecar(endpoint.name, endpoint.folder!, artifact, referencesArtifact);
        hasReferenceSidecar = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        appendErrorArtifact(errorArtifact, `invalid qmd-json reference mapping: ${detail}`);
        warnings.push(`endpoint '${endpoint.name}' reference sidecar unavailable: ${detail}`);
      }
      if (hasReferenceSidecar) {
        outcome.references_artifact = referencesArtifact;
        outcome.references_format = "ukp-search-references-v1";
      }
      const hasProviderStderr = statSync(errorArtifact).size > 0;
      if (!hasProviderStderr) unlinkSync(errorArtifact);
      else outcome.error_artifact = errorArtifact;
    } catch (error) {
      failed = true;
      if (stdoutFd !== undefined) closeSync(stdoutFd);
      if (stderrFd !== undefined) closeSync(stderrFd);
      const detail = error instanceof Error ? error.message : String(error);
      try {
        appendErrorArtifact(errorArtifact, detail);
      } catch {
        // The envelope still records the failure if even the error artifact cannot be written.
      }
      const message = `endpoint '${endpoint.name}' artifact or provider execution failed: ${detail}`;
      warnings.push(message);
      outcome.status = "failed";
      if (!existsSync(artifact)) {
        delete outcome.artifact;
        delete outcome.format;
      }
      if (existsSync(errorArtifact)) outcome.error_artifact = errorArtifact;
      outcome.message = message;
    }
  }

  return {
    query: parsed.request.query,
    limit: parsed.request.limit,
    runId: run.runId,
    endpoints,
    warnings,
    aggregate: cancelled
      ? "cancelled"
      : failed
        ? "provider-failure"
        : succeeded
          ? "succeeded"
          : "no-success",
  };
}

/** ADR 0021 core entry: runs the search capability and returns the
 * structured outcome. Scope/planning failures still throw typed errors
 * (`SearchPlanningError`, `ScopeError`, `ManifestError`)
 * for the surface adapter to map. */
export function runSearch(parsed: ParsedSearch, context: SearchContext): SearchResult {
  const { plan, warnings } = planSearch(parsed, context);
  return parsed.options.json
    ? runJsonMode(parsed, context, plan, warnings)
    : runHumanMode(parsed, plan, warnings);
}

// ---------------------------------------------------------------------------
// Presentation (ADR 0021 two-stage form): project a structured view first,
// render text from the view only. Adapters must consume these — never build
// a private rendering pipeline (single render source).
// ---------------------------------------------------------------------------

/** Projection onto the public `ukp.search.v1` envelope: contract-zone fields
 * in the canonical order; internal provenance (`folder`, raw provider
 * output/exit) stays out. `interrupted` never occurs in json mode; it maps
 * to `cancelled` defensively. */
function toEndpointEnvelope(outcome: SearchEndpointOutcome): SearchEndpointEnvelope {
  const status = outcome.status ?? "failed";
  return {
    name: outcome.name,
    provider: outcome.provider,
    status: status === "interrupted" ? "cancelled" : status,
    ...(outcome.artifact !== undefined ? { artifact: outcome.artifact } : {}),
    ...(outcome.format !== undefined ? { format: outcome.format } : {}),
    ...(outcome.references_artifact !== undefined ? { references_artifact: outcome.references_artifact } : {}),
    ...(outcome.references_format !== undefined ? { references_format: outcome.references_format } : {}),
    ...(outcome.error_artifact !== undefined ? { error_artifact: outcome.error_artifact } : {}),
    ...(outcome.message !== undefined ? { message: outcome.message } : {}),
    ...(outcome.traversal ?? {}),
  };
}

export function projectSearchEnvelope(result: SearchResult): SearchEnvelope {
  return {
    schema: "ukp.search.v1",
    run_id: result.runId ?? "",
    command: "search",
    capability: "search",
    query: result.query,
    limit: result.limit,
    endpoints: result.endpoints.map(toEndpointEnvelope),
    warnings: result.warnings,
  };
}

export function renderSearchJson(envelope: SearchEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/** Human view: `== <name> ==` blocks in plan order. Skipped endpoints live
 * only in warnings; the first `interrupted` endpoint keeps its header (the
 * SIGINT stop happened mid-block) and ends the output; post-interrupt
 * `cancelled` endpoints render nothing. */
export function renderSearchHuman(result: SearchResult): string {
  const lines: string[] = [];
  for (const endpoint of result.endpoints) {
    if (endpoint.status === "skipped") continue;
    if (endpoint.status === "cancelled") break;
    if (lines.length > 0) lines.push("");
    lines.push(`== ${endpoint.name} ==`);
    if (endpoint.traversal) lines.push(...renderTraversalProvenance(endpoint.traversal));
    if (endpoint.status === "interrupted") break;
    if (endpoint.providerOutput) {
      lines.push(
        endpoint.folder
          ? (renderResultUnits(endpoint.providerOutput, endpoint.name, endpoint.folder)
            ?? renderFallbackProviderBlock(endpoint.providerOutput, endpoint.name))
          : endpoint.remoteUris !== undefined
            ? (renderResultUnits(endpoint.providerOutput, endpoint.name, "", endpoint.remoteUris)
              ?? renderFallbackProviderBlock(endpoint.providerOutput, endpoint.name))
            : renderFallbackProviderBlock(endpoint.providerOutput, endpoint.name),
      );
    } else if (endpoint.providerExitStatus === 0) {
      lines.push("(no matches)");
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
