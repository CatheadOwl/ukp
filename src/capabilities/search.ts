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
import { loadManifest, ManifestError } from "../config/manifest.ts";
import { readRegistry } from "../registry.ts";
import { resolveScope } from "../scope.ts";
import { defaultQmdCommand, isDocidBody, stripDocidHash } from "./qmd.ts";

export interface SearchRequest {
  query: string;
  limit: number;
}

export interface SearchOptions {
  explicitEndpoints?: string[];
  global: boolean;
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

  for (const binding of scope.bindings) {
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
      plan.push({ name: binding.name, provider: null, status: "skipped", warning });
      continue;
    }
    if (service.effectiveName !== binding.name) {
      throw new SearchPlanningError(
        `endpoint '${binding.name}' no longer matches Service effective name '${service.effectiveName}'`,
      );
    }
    const capability = service.manifest.capabilities.search;
    if (!capability) {
      const warning = `endpoint '${binding.name}' does not provide search`;
      warnings.push(warning);
      plan.push({ name: binding.name, provider: null, status: "skipped", warning });
      continue;
    }
    if (capability.provider !== "qmd") {
      const warning = `endpoint '${binding.name}' uses unsupported search provider '${capability.provider}'`;
      warnings.push(warning);
      plan.push({
        name: binding.name,
        provider: capability.provider,
        status: "skipped",
        warning,
      });
      continue;
    }
    if (!qmdCommand) {
      const warning = `endpoint '${binding.name}' search unavailable: qmd executable is not available`;
      warnings.push(warning);
      plan.push({ name: binding.name, provider: "qmd", status: "skipped", warning });
      continue;
    }
    plan.push({
      name: binding.name,
      provider: "qmd",
      status: "executable",
      folder: service.folder,
      command: qmdCommand,
    });
  }

  if (!plan.some((endpoint) => endpoint.status === "executable")) {
    warnings.push(registry.length === 0
      ? "no executable search endpoints: the Host Registry is empty; run 'ukp register' from a Service folder, then retry"
      : "no executable search endpoints: run 'ukp list' to inspect registrations and 'ukp diagnose' from the selected Service folder(s)");
  }
  return { plan, warnings };
}

function commandFor(endpoint: PlannedEndpoint, parsed: ParsedSearch, json: boolean): string[] {
  const command = [
    ...endpoint.command!,
    "search",
    parsed.request.query,
    "-n",
    String(parsed.request.limit),
  ];
  if (json) command.push("--format", "json");
  return command;
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
    output.push(`== ${endpoint.name} (search/qmd) ==`);
    const command = commandFor(endpoint, parsed, false);
    const result = spawnSync(command[0]!, command.slice(1), {
      cwd: endpoint.folder!,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    const providerOutput = (result.stdout ?? "").trimEnd();
    if (providerOutput) output.push(renderHumanProviderOutput(providerOutput, endpoint));
    else if (result.status === 0) output.push("(no matches)");
    if (result.signal === "SIGINT") {
      warnings.push(`endpoint '${endpoint.name}' provider cancelled`);
      return {
        exitCode: 130,
        stdout: `${output.join("\n")}\n`,
        stderr: `${warnings.join("\n")}\n`,
      };
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

function extractQmdDocidsFromText(output: string): Array<{ docid: string; line?: number }> {
  const found: Array<{ docid: string; line?: number }> = [];
  for (const line of output.split(/\r?\n/)) {
    // A docid only appears on the QMD location header line (`qmd://...:line #docid`);
    // body lines may contain a 6-hex `#xxxxxx` (e.g. a color code) that is not a docid.
    if (!line.startsWith("qmd://")) continue;
    const docid = /#([a-f0-9]{6})/.exec(line);
    if (!docid) continue;
    const lineHit = /:(\d+)\s+#[a-f0-9]{6}/.exec(line);
    found.push({
      docid: docid[1],
      line: lineHit ? Number(lineHit[1]) : undefined,
    });
  }
  return found;
}

function renderHumanProviderOutput(providerOutput: string, endpoint: PlannedEndpoint): string {
  const lines = [providerOutput];
  const seen = new Set<string>();
  for (const { docid, line } of extractQmdDocidsFromText(providerOutput)) {
    if (seen.has(docid)) continue;
    seen.add(docid);
    const lineHint = line ? ` --lines ${line}` : "";
    lines.push(`UKP reference: ukp get --endpoint ${endpoint.name} ${docid}${lineHint}`);
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
      });
      continue;
    }
    if (cancelled) {
      endpoints.push({ name: endpoint.name, provider: endpoint.provider, status: "cancelled" });
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
      const result = spawnSync(command[0]!, command.slice(1), {
        cwd: endpoint.folder!,
        stdio: ["ignore", stdoutFd, stderrFd],
        windowsHide: true,
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
