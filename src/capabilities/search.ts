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
import { isAbsolute, join, relative, resolve, win32 } from "node:path";
import { createArtifactRun } from "../artifacts.ts";
import { loadManifest, ManifestError } from "../config/manifest.ts";
import { readRegistry } from "../registry.ts";
import { resolveScope } from "../scope.ts";
import { defaultQmdCommand, normalizeQmdReferenceForGet } from "./qmd.ts";

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
  get_adapter?: "file" | "qmd";
  reason?: string;
}

interface QmdReferenceSidecar {
  schema: "ukp.search.references.v1";
  endpoint: string;
  source_artifact: string;
  results: Array<QmdReferenceMapping & { index: number }>;
}

function splitQmdLocation(location: string): { target: string; line?: number } {
  const match = /:(\d+)$/.exec(location);
  if (!match) return { target: location };
  return {
    target: location.slice(0, -match[0].length),
    line: Number(match[1]),
  };
}

function normalizeReferencePath(path: string): string | undefined {
  const segments = path.split(/[\\/]/);
  if (
    segments.length === 0
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return segments.join("/");
}

function maybeLine(line: number | undefined): { line?: number } {
  return line ? { line } : {};
}

function mapExistingEndpointRelativePath(
  endpointName: string,
  serviceFolder: string,
  providerLocation: string,
  reference: string,
  line?: number,
  qmdFallbackReference?: string,
): QmdReferenceMapping {
  const normalized = normalizeReferencePath(reference);
  if (!normalized) {
    return {
      provider_location: providerLocation,
      endpoint: endpointName,
      status: "provider_only",
      reason: "provider location is not a valid endpoint-relative path",
    };
  }
  try {
    const serviceReal = realpathSync(serviceFolder);
    const targetReal = realpathSync(resolve(join(serviceFolder, ...normalized.split("/"))));
    const rel = relative(serviceReal, targetReal);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return {
        provider_location: providerLocation,
        endpoint: endpointName,
        status: "provider_only",
        reason: "provider location resolves outside the endpoint folder",
      };
    }
    return {
      provider_location: providerLocation,
      endpoint: endpointName,
      reference: rel.split(/[\\/]/).join("/"),
      ...maybeLine(line),
      status: "get_ready",
      get_adapter: "file",
    };
  } catch {
    if (qmdFallbackReference) {
      return {
        provider_location: providerLocation,
        endpoint: endpointName,
        reference: normalizeQmdReferenceForGet(qmdFallbackReference),
        ...maybeLine(line),
        status: "get_ready",
        get_adapter: "qmd",
      };
    }
    return {
      provider_location: providerLocation,
      endpoint: endpointName,
      status: "provider_only",
      reason: "provider location cannot be resolved inside the endpoint folder",
    };
  }
}

function mapQmdUri(
  endpointName: string,
  serviceFolder: string,
  uri: string,
  explicitLine?: number,
): QmdReferenceMapping {
  if (!uri.startsWith("qmd://")) {
    return {
      provider_location: uri,
      endpoint: endpointName,
      status: "provider_only",
      reason: "provider location is not a qmd URI",
    };
  }

  const { target, line } = splitQmdLocation(uri.slice("qmd://".length));
  const resultLine = line ?? explicitLine;
  const providerReference = `qmd://${target}`;
  if (target.length === 0) {
    return {
      provider_location: uri,
      endpoint: endpointName,
      status: "provider_only",
      reason: "provider qmd URI is empty",
    };
  }
  if (win32.isAbsolute(target) || isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target)) {
    try {
      const serviceReal = realpathSync(serviceFolder);
      const targetReal = realpathSync(target);
      const rel = relative(serviceReal, targetReal);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        return {
          provider_location: uri,
          endpoint: endpointName,
          reference: normalizeQmdReferenceForGet(providerReference),
          ...maybeLine(resultLine),
          status: "get_ready",
          get_adapter: "qmd",
        };
      }
      return {
        provider_location: uri,
        endpoint: endpointName,
        reference: rel.split(/[\\/]/).join("/"),
        ...maybeLine(resultLine),
        status: "get_ready",
        get_adapter: "file",
      };
    } catch {
      return {
        provider_location: uri,
        endpoint: endpointName,
        reference: normalizeQmdReferenceForGet(providerReference),
        ...maybeLine(resultLine),
        status: "get_ready",
        get_adapter: "qmd",
      };
    }
  }

  const [authority, ...referenceParts] = target.split(/[\\/]/);
  if (authority !== endpointName) {
    return {
      provider_location: uri,
      endpoint: endpointName,
      reference: normalizeQmdReferenceForGet(providerReference),
      ...maybeLine(resultLine),
      status: "get_ready",
      get_adapter: "qmd",
    };
  }
  return mapExistingEndpointRelativePath(
    endpointName,
    serviceFolder,
    uri,
    referenceParts.join("/"),
    resultLine,
    providerReference,
  );
}

function extractQmdUrisFromText(output: string): string[] {
  return (output.match(/qmd:\/\/\S+/g) ?? []).map((uri) => uri.replace(/[),.;!?]+$/, ""));
}

function renderHumanProviderOutput(providerOutput: string, endpoint: PlannedEndpoint): string {
  const lines = [providerOutput];
  const seen = new Set<string>();
  for (const uri of extractQmdUrisFromText(providerOutput)) {
    if (seen.has(uri)) continue;
    seen.add(uri);
    const mapping = mapQmdUri(endpoint.name, endpoint.folder!, uri);
    if (mapping.status === "get_ready") {
      const lineHint = mapping.line ? ` --lines ${mapping.line}` : "";
      lines.push(`UKP reference: ukp get --endpoint ${endpoint.name} ${mapping.reference}${lineHint}`);
    } else {
      lines.push(`Provider-only location: ${uri}`);
    }
  }
  return lines.join("\n");
}

function buildQmdReferenceSidecar(
  endpointName: string,
  serviceFolder: string,
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
    results: nativeResults
      .map((result, index) => {
        const uri = result && typeof result === "object" && "uri" in result ? result.uri : undefined;
        const file = result && typeof result === "object" && "file" in result ? result.file : undefined;
        const line = result && typeof result === "object" && "line" in result ? result.line : undefined;
        const providerLocation = typeof uri === "string" ? uri : typeof file === "string" ? file : undefined;
        const explicitLine = Number.isSafeInteger(line) && line > 0 ? line : undefined;
        const mapping = typeof providerLocation === "string"
          ? mapQmdUri(endpointName, serviceFolder, providerLocation, explicitLine)
          : {
            provider_location: "",
            endpoint: endpointName,
            status: "provider_only" as const,
            reason: "qmd result does not contain a string uri or file",
          };
        return { index, ...mapping };
      }),
  };
}

function writeQmdReferenceSidecar(
  endpointName: string,
  serviceFolder: string,
  sourceArtifact: string,
  sidecarPath: string,
): void {
  const sidecar = buildQmdReferenceSidecar(endpointName, serviceFolder, sourceArtifact);
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
        writeQmdReferenceSidecar(endpoint.name, endpoint.folder!, artifact, referencesArtifact);
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
