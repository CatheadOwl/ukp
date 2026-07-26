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
import { loadManifest } from "../config/manifest.ts";
import { readRegistry } from "../registry.ts";
import { resolveScope } from "../scope.ts";

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

export function parseSearchArgs(args: readonly string[]): ParsedSearch {
  let query: string | undefined;
  let limit = 20;
  let limitSeen = false;
  let global = false;
  let json = false;
  const explicit: string[] = [];
  const warnings: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--limit") {
      if (limitSeen) throw new SearchUsageError("--limit may only be specified once");
      const value = args[++index];
      if (!value || !/^[0-9]+$/.test(value)) throw new SearchUsageError("--limit must be a decimal integer");
      limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw new SearchUsageError("--limit must be between 1 and 1000");
      }
      limitSeen = true;
      continue;
    }
    if (argument === "-c") {
      const value = args[++index];
      if (!value) throw new SearchUsageError("-c requires an endpoint name");
      if (explicit.includes(value)) warnings.push(`duplicate endpoint '${value}' ignored`);
      else explicit.push(value);
      continue;
    }
    if (argument === "-g") {
      if (global) throw new SearchUsageError("-g may only be specified once");
      global = true;
      continue;
    }
    if (argument === "--json") {
      if (json) throw new SearchUsageError("--json may only be specified once");
      json = true;
      continue;
    }
    if (argument.startsWith("-")) throw new SearchUsageError(`unknown search option '${argument}'`);
    if (query !== undefined) throw new SearchUsageError("search accepts exactly one query argument");
    query = argument;
  }

  if (query === undefined || query.length === 0) throw new SearchUsageError("search query must be non-empty");
  if (global && explicit.length > 0) throw new SearchUsageError("-c and -g cannot be used together");
  return {
    request: { query, limit },
    options: { explicitEndpoints: explicit.length > 0 ? explicit : undefined, global, json },
    warnings,
  };
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

function defaultQmdCommand(): string[] | undefined {
  const executable = Bun.which("qmd") ?? Bun.which("qmd.ps1") ?? Bun.which("qmd.cmd");
  if (!executable) return undefined;
  return executable.toLowerCase().endsWith(".ps1")
    ? [Bun.which("powershell.exe") ?? "powershell.exe", "-NoProfile", "-File", executable]
    : [executable];
}

interface PlannedEndpoint {
  name: string;
  provider: string | null;
  status: "executable" | "skipped";
  folder?: string;
  command?: readonly string[];
  warning?: string;
}

export interface SearchEndpointEnvelope {
  name: string;
  provider: string | null;
  status: "succeeded" | "no_matches" | "skipped" | "failed" | "cancelled";
  artifact?: string;
  format?: string;
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
    const service = loadManifest(binding.path);
    if (service.effectiveName !== binding.name) {
      throw new Error(`endpoint '${binding.name}' no longer matches Service effective name '${service.effectiveName}'`);
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
    warnings.push("no executable search endpoints");
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
    if (providerOutput) output.push(providerOutput);
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
      const hasProviderStderr = statSync(errorArtifact).size > 0;
      if (!hasProviderStderr) unlinkSync(errorArtifact);
      endpoints.push({
        name: endpoint.name,
        provider: endpoint.provider,
        status,
        artifact,
        format: "qmd-json",
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
