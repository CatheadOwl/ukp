import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createArtifactRun } from "../artifacts.ts";
import {
  loadManifest,
  ManifestError,
  type LoadedManifest,
  type ManifestDependency,
} from "../config/manifest.ts";
import { readRegistry, type RegistryBinding } from "../registry.ts";
import { resolveScope } from "../scope.ts";
import { buildQmdInvocation, defaultQmdCommand, isDocidBody, stripDocidHash } from "./qmd.ts";

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

export class SearchUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchUsageError";
  }
}

export class SearchPlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchPlanningError";
  }
}

export interface HumanSearchContext {
  currentDirectory: string;
  registryPath: string;
  qmdCommand?: readonly string[];
  artifactRoot?: string;
  artifactRunId?: string;
  now?: Date;
}

export interface HumanSearchResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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

function planSearch(parsed: ParsedSearch, context: HumanSearchContext): {
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
    let service;
    try {
      service = loadManifest(binding.path);
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
  // cmd.exe shim wrapper (ISSUE-011) never lets cmd re-parse it.
  return buildQmdInvocation(endpoint.command!, providerArgs);
}

function renderTraversalProvenance(endpoint: PlannedEndpoint): string[] {
  const traversal = endpoint.traversal;
  if (!traversal) return [];
  const via = traversal.via ? ` via=${traversal.via.kind}` : "";
  const lines = [
    `traversal: depth=${traversal.depth} path=${traversal.path.join(" -> ")}${via}`,
  ];
  if (traversal.via?.reason) lines.push(`traversal_reason: ${traversal.via.reason}`);
  return lines;
}

function executeHumanMode(
  parsed: ParsedSearch,
  plan: readonly PlannedEndpoint[],
  warnings: string[],
): HumanSearchResult {
  const executable = plan.filter((endpoint) => endpoint.status === "executable");
  if (executable.length === 0) {
    return { exitCode: 1, stdout: "", stderr: `${warnings.join("\n")}\n` };
  }

  const output: string[] = [];
  let failed = false;
  for (const endpoint of executable) {
    if (output.length > 0) output.push("");
    output.push(`== ${endpoint.name} ==`);
    output.push(...renderTraversalProvenance(endpoint));
    const command = commandFor(endpoint, parsed, true);
    const result = spawnSync(command.file, command.args, {
      cwd: endpoint.folder!,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: command.verbatim,
      maxBuffer: 64 * 1024 * 1024,
    });
    const providerOutput = (result.stdout ?? "").trimEnd();
    if (result.signal === "SIGINT") {
      warnings.push(`endpoint '${endpoint.name}' provider cancelled`);
      return {
        exitCode: 130,
        stdout: `${output.join("\n")}\n`,
        stderr: `${warnings.join("\n")}\n`,
      };
    }
    if (providerOutput) {
      output.push(renderResultUnits(providerOutput, endpoint.name)
        ?? renderFallbackProviderBlock(providerOutput, endpoint));
    } else if (result.status === 0) {
      output.push("(no matches)");
    }
    if (result.status !== 0 || result.error) {
      failed = true;
      const providerError = (result.stderr ?? "").trimEnd() || result.error?.message;
      warnings.push(`endpoint '${endpoint.name}' provider failed${providerError ? `: ${providerError}` : ""}`);
    }
  }
  return {
    exitCode: failed ? 1 : 0,
    stdout: `${output.join("\n")}\n`,
    stderr: warnings.length > 0 ? `${warnings.join("\n")}\n` : "",
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
  status: "get_ready" | "provider_only";
  get_adapter?: "qmd";
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

function providerLocationOf(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const record = result as { uri?: unknown; file?: unknown };
  if (typeof record.uri === "string") return record.uri;
  if (typeof record.file === "string") return record.file;
  return "";
}

/**
 * Map one QMD search result to a UKP get-ready reference (ADR 0011).
 *
 * QMD-indexed results carry a stable `docid` content fingerprint. `search`
 * emits it as a bare handoff key (`#` stripped), not the weak `qmd://`/path
 * name; `get` re-adds the `#` and resolves by fingerprint exactly. Name, title,
 * and path become display-only provenance (`provider_location`). A result with
 * no usable docid has no UKP get route and is `provider_only`.
 */
function mapQmdResultToReference(endpointName: string, result: unknown): QmdReferenceMapping {
  const providerLocation = providerLocationOf(result);
  const docid = docidOf(result);
  if (!docid) {
    return {
      provider_location: providerLocation,
      endpoint: endpointName,
      status: "provider_only",
      reason: "qmd result has no usable docid",
    };
  }
  return {
    provider_location: providerLocation,
    endpoint: endpointName,
    reference: docid,
    ...maybeLine(lineOf(result)),
    status: "get_ready",
    get_adapter: "qmd",
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
 * why it matches (excerpt), and how to read it (a copyable `get` line addressing
 * the ADR 0011 handoff key `docid[:line]`). Provider vocabulary never reaches the
 * default Human surface: the docid appears only inside the `get` command, and
 * location provenance is reduced to a human-readable basename (the raw `qmd://`
 * stays in the `--json` reference sidecar). A result with no usable docid has no
 * get route and says so in plain words.
 */
function renderResultUnit(unitIndex: number, endpointName: string, result: unknown): string {
  const providerLocation = providerLocationOf(result);
  const docid = docidOf(result);
  const line = lineOf(result);
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
  if (docid) {
    const key = line ? `${docid}:${line}` : docid;
    lines.push(`   read: ukp read --endpoint ${endpointName} ${key}`);
  } else {
    lines.push(`   (no direct read — provider-managed result)`);
  }
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
function renderResultUnits(providerOutput: string, endpointName: string): string | null {
  let nativeResults: unknown;
  try {
    nativeResults = JSON.parse(providerOutput);
  } catch {
    return null;
  }
  if (!Array.isArray(nativeResults)) return null;
  if (nativeResults.length === 0) return "(no matches)";
  return nativeResults
    .map((result, index) => renderResultUnit(index + 1, endpointName, result))
    .join("\n\n");
}

/**
 * Fallback (spec "Fallback"): a provider that did not return a parseable JSON
 * array renders as its raw output block plus a trailing `UKP reference:` list
 * (docid form). Docids are read from the provider's QMD location header lines
 * (`qmd://...:line #docid`); body lines with a 6-hex token (e.g. a color code)
 * are never treated as docids.
 */
function renderFallbackProviderBlock(providerOutput: string, endpoint: PlannedEndpoint): string {
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
    lines.push(`UKP reference: ukp read --endpoint ${endpoint.name} ${bare}${lineHint}`);
  }
  return lines.join("\n");
}

function buildQmdReferenceSidecar(endpointName: string, sourceArtifact: string): QmdReferenceSidecar {
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
      ...mapQmdResultToReference(endpointName, result),
    })),
  };
}

function writeQmdReferenceSidecar(
  endpointName: string,
  sourceArtifact: string,
  sidecarPath: string,
): void {
  const sidecar = buildQmdReferenceSidecar(endpointName, sourceArtifact);
  writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function executeJsonMode(
  parsed: ParsedSearch,
  context: HumanSearchContext,
  plan: readonly PlannedEndpoint[],
  warnings: string[],
): HumanSearchResult {
  const run = createArtifactRun({
    root: context.artifactRoot,
    runId: context.artifactRunId,
    now: context.now,
  });
  const endpoints: SearchEndpointEnvelope[] = [];
  let failed = false;
  let succeeded = false;
  let cancelled = false;

  for (const endpoint of plan) {
    if (endpoint.status === "skipped") {
      endpoints.push({
        name: endpoint.name,
        provider: endpoint.provider,
        status: "skipped",
        message: endpoint.warning,
        ...(endpoint.traversal ?? {}),
      });
      continue;
    }
    if (cancelled) {
      endpoints.push({
        name: endpoint.name,
        provider: endpoint.provider,
        status: "cancelled",
        ...(endpoint.traversal ?? {}),
      });
      continue;
    }

    const artifact = resolve(join(run.directory, `${endpoint.name}.json`));
    const referencesArtifact = resolve(join(run.directory, `${endpoint.name}.references.json`));
    const errorArtifact = resolve(join(run.directory, `${endpoint.name}.stderr.txt`));
    let stdoutFd: number | undefined;
    let stderrFd: number | undefined;
    try {
      stdoutFd = openSync(artifact, "w", 0o600);
      stderrFd = openSync(errorArtifact, "w", 0o600);
      const command = commandFor(endpoint, parsed, true);
      const result = spawnSync(command.file, command.args, {
        cwd: endpoint.folder!,
        stdio: ["ignore", stdoutFd, stderrFd],
        windowsHide: true,
        windowsVerbatimArguments: command.verbatim,
      });
      closeSync(stdoutFd);
      stdoutFd = undefined;
      closeSync(stderrFd);
      stderrFd = undefined;

      if (result.signal === "SIGINT") {
        cancelled = true;
        appendErrorArtifact(errorArtifact, "provider cancelled by SIGINT");
        endpoints.push({
          name: endpoint.name,
          provider: endpoint.provider,
          status: "cancelled",
          artifact,
          format: "qmd-json",
          error_artifact: errorArtifact,
          message: "provider cancelled by SIGINT",
          ...(endpoint.traversal ?? {}),
        });
        warnings.push(`endpoint '${endpoint.name}' provider cancelled`);
        continue;
      }

      if (result.status !== 0 || result.error) {
        failed = true;
        if (result.error) appendErrorArtifact(errorArtifact, result.error.message);
        const message = `endpoint '${endpoint.name}' provider failed`;
        warnings.push(message);
        endpoints.push({
          name: endpoint.name,
          provider: endpoint.provider,
          status: "failed",
          artifact,
          format: "qmd-json",
          error_artifact: errorArtifact,
          message,
          ...(endpoint.traversal ?? {}),
        });
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
        endpoints.push({
          name: endpoint.name,
          provider: endpoint.provider,
          status: "failed",
          artifact,
          format: "qmd-json",
          error_artifact: errorArtifact,
          message,
          ...(endpoint.traversal ?? {}),
        });
        continue;
      }

      succeeded = true;
      let hasReferenceSidecar = false;
      try {
        writeQmdReferenceSidecar(endpoint.name, artifact, referencesArtifact);
        hasReferenceSidecar = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        appendErrorArtifact(errorArtifact, `invalid qmd-json reference mapping: ${detail}`);
        warnings.push(`endpoint '${endpoint.name}' reference sidecar unavailable: ${detail}`);
      }
      const hasProviderStderr = statSync(errorArtifact).size > 0;
      if (!hasProviderStderr) unlinkSync(errorArtifact);
      endpoints.push({
        name: endpoint.name,
        provider: endpoint.provider,
        status,
        artifact,
        format: "qmd-json",
        ...(hasReferenceSidecar
          ? {
            references_artifact: referencesArtifact,
            references_format: "ukp-search-references-v1" as const,
          }
          : {}),
        ...(hasProviderStderr ? { error_artifact: errorArtifact } : {}),
        ...(endpoint.traversal ?? {}),
      });
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
      endpoints.push({
        name: endpoint.name,
        provider: endpoint.provider,
        status: "failed",
        ...(existsSync(artifact) ? { artifact, format: "qmd-json" } : {}),
        ...(existsSync(errorArtifact) ? { error_artifact: errorArtifact } : {}),
        message,
        ...(endpoint.traversal ?? {}),
      });
    }
  }

  const envelope: SearchEnvelope = {
    schema: "ukp.search.v1",
    run_id: run.runId,
    command: "search",
    capability: "search",
    query: parsed.request.query,
    limit: parsed.request.limit,
    endpoints,
    warnings,
  };
  return {
    exitCode: cancelled ? 130 : failed || !succeeded ? 1 : 0,
    stdout: `${JSON.stringify(envelope, null, 2)}\n`,
    stderr: "",
  };
}

export function executeHumanSearch(parsed: ParsedSearch, context: HumanSearchContext): HumanSearchResult {
  const { plan, warnings } = planSearch(parsed, context);
  return parsed.options.json
    ? executeJsonMode(parsed, context, plan, warnings)
    : executeHumanMode(parsed, plan, warnings);
}
