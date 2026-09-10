import { spawnSync } from "node:child_process";
import { loadClientConfig, findNearestClientConfig } from "../config/client.ts";
import { loadManifest } from "../config/manifest.ts";
import { readRegistry, type RegistryBinding } from "../registry.ts";
import { ScopeError } from "../scope.ts";
import { buildQmdInvocation, defaultQmdCommand, refreshTimeoutMs } from "./qmd.ts";

export interface RefreshOptions {
  explicitEndpoints?: string[];
  global: boolean;
}

export interface ParsedRefresh {
  options: RefreshOptions;
  warnings: string[];
}

export interface RefreshContext {
  currentDirectory: string;
  registryPath: string;
  qmdCommand?: readonly string[];
}

export interface RefreshResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class RefreshUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefreshUsageError";
  }
}

type PlannedEndpoint =
  | {
    name: string;
    provider: "qmd";
    status: "executable";
    folder: string;
    command: readonly string[];
  }
  | {
    name: string;
    provider: string | null;
    status: "skipped";
    message: string;
  }
  | {
    name: string;
    provider: string | null;
    status: "failed";
    message: string;
  };

function resolveRefreshBindings(
  parsed: ParsedRefresh,
  registry: readonly RegistryBinding[],
  context: RefreshContext,
): { bindings: RegistryBinding[]; warnings: string[] } {
  if (parsed.options.global && parsed.options.explicitEndpoints !== undefined) {
    throw new ScopeError("explicit endpoint scope and global scope cannot be used together");
  }

  const warnings = [...parsed.warnings];
  const byName = new Map(registry.map((binding) => [binding.name, binding]));

  if (parsed.options.explicitEndpoints !== undefined) {
    return {
      bindings: parsed.options.explicitEndpoints.map((name) => {
        const binding = byName.get(name);
        if (!binding) throw new ScopeError(`unknown endpoint '${name}'`);
        return binding;
      }),
      warnings,
    };
  }

  if (parsed.options.global) return { bindings: [...registry], warnings };

  const configPath = findNearestClientConfig(context.currentDirectory);
  if (!configPath) {
    throw new ScopeError("refresh requires an explicit scope; use '--endpoint <name>' or '-g'");
  }

  const config = loadClientConfig(configPath);
  const bindings: RegistryBinding[] = [];
  for (const name of config.default_endpoints) {
    const binding = byName.get(name);
    if (binding) bindings.push(binding);
    else warnings.push(`'${name}' is not registered (from ${configPath})`);
  }
  if (bindings.length === 0) {
    throw new ScopeError("Client Config does not resolve to any registered endpoint");
  }
  return { bindings, warnings };
}

function planRefresh(parsed: ParsedRefresh, context: RefreshContext): {
  plan: PlannedEndpoint[];
  warnings: string[];
} {
  const registry = readRegistry(context.registryPath);
  const { bindings, warnings } = resolveRefreshBindings(parsed, registry, context);
  const qmdCommand = context.qmdCommand ?? defaultQmdCommand();
  const plan: PlannedEndpoint[] = [];

  if (bindings.length === 0) {
    warnings.push("no endpoints selected: the Host Registry is empty; run 'ukp register' from a Service folder, then retry");
  }

  for (const binding of bindings) {
    try {
      const service = loadManifest(binding.path);
      if (service.effectiveName !== binding.name) {
        plan.push({
          name: binding.name,
          provider: null,
          status: "failed",
          message: [
            `endpoint '${binding.name}' no longer matches Service effective name '${service.effectiveName}'`,
            `Hint: run 'ukp inspect --endpoint ${binding.name}' and re-register the Service if the binding is stale.`,
          ].join("\n"),
        });
        continue;
      }

      const capability = service.manifest.capabilities.refresh;
      if (!capability) {
        plan.push({
          name: binding.name,
          provider: null,
          status: "skipped",
          message: [
            `endpoint '${binding.name}' does not provide refresh`,
            `Hint: run 'ukp inspect --endpoint ${binding.name}' to review Service capabilities.`,
          ].join("\n"),
        });
        continue;
      }

      if (capability.provider !== "qmd") {
        const provider = capability.provider ?? "(none)";
        plan.push({
          name: binding.name,
          provider,
          status: "skipped",
          message: `endpoint '${binding.name}' uses unsupported refresh provider '${provider}'`,
        });
        continue;
      }

      if (!qmdCommand || qmdCommand.length === 0) {
        plan.push({
          name: binding.name,
          provider: "qmd",
          status: "skipped",
          message: [
            `endpoint '${binding.name}' refresh unavailable: qmd executable is not available`,
            "Hint: install QMD or pass a valid qmd command in the execution context.",
          ].join("\n"),
        });
        continue;
      }

      plan.push({
        name: binding.name,
        provider: "qmd",
        status: "executable",
        folder: service.folder,
        command: qmdCommand,
      });
    } catch (error) {
      plan.push({
        name: binding.name,
        provider: null,
        status: "failed",
        message: [
          error instanceof Error ? error.message : String(error),
          `Hint: run 'ukp inspect --endpoint ${binding.name}' or 'ukp diagnose --endpoint ${binding.name}'.`,
        ].join("\n"),
      });
    }
  }

  if (!plan.some((endpoint) => endpoint.status === "executable")) {
    warnings.push("no executable refresh endpoints: run 'ukp inspect' to review selected endpoint capabilities");
  }

  return { plan, warnings };
}

function renderSkipped(endpoint: Exclude<PlannedEndpoint, { status: "executable" }>): string {
  return [
    `== ${endpoint.name} ==`,
    "capability: refresh",
    `provider: ${endpoint.provider ?? "(none)"}`,
    `status: ${endpoint.status}`,
    `${endpoint.status === "failed" ? "error" : "message"}: ${endpoint.message}`,
  ].join("\n");
}

function commandFor(endpoint: Extract<PlannedEndpoint, { status: "executable" }>): {
  file: string;
  args: string[];
  verbatim: boolean;
} {
  // Uniform provider plumbing: a cmd.exe shim wrapper must get
  // the whole call as one cmd-escaped /c payload.
  return buildQmdInvocation(endpoint.command, ["update"]);
}

const QMD_MAINTENANCE_SCOPE =
  "provider-owned (qmd update in the Service folder; QMD decides which configured collections are maintained)";

export function executeRefresh(parsed: ParsedRefresh, context: RefreshContext): RefreshResult {
  const { plan, warnings } = planRefresh(parsed, context);
  const output: string[] = [];
  let failed = plan.some((endpoint) => endpoint.status === "failed");
  let succeeded = false;

  for (const endpoint of plan) {
    if (endpoint.status !== "executable") {
      output.push(renderSkipped(endpoint));
      continue;
    }

    output.push(`== ${endpoint.name} ==`);
    output.push("capability: refresh");
    output.push("provider: qmd");
    output.push(`maintenance_scope: ${QMD_MAINTENANCE_SCOPE}`);
    const command = commandFor(endpoint);
    const result = spawnSync(command.file, command.args, {
      cwd: endpoint.folder,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: command.verbatim,
      maxBuffer: 64 * 1024 * 1024,
      timeout: refreshTimeoutMs(),
    });

    const providerOutput = (result.stdout ?? "").trimEnd();
    const providerError = (result.stderr ?? "").trimEnd() || result.error?.message;

    if (result.signal === "SIGTERM") {
      // Zero-output hang guard: `qmd update` on a large corpus is slow but
      // bounded; beyond the ceiling it is a classified failure, not silence.
      failed = true;
      output.push("status: failed");
      warnings.push(
        `endpoint '${endpoint.name}' provider timed out after ${refreshTimeoutMs() / 1000}s (set UKP_REFRESH_TIMEOUT_MS to adjust)`,
      );
      output.push(`error: provider timed out after ${refreshTimeoutMs() / 1000}s`);
      continue;
    }

    if (result.signal === "SIGINT" || result.status === 130) {
      warnings.push(`endpoint '${endpoint.name}' provider cancelled`);
      output.push("status: cancelled");
      return {
        exitCode: 130,
        stdout: `${output.join("\n")}\n`,
        stderr: `${warnings.join("\n")}\n`,
      };
    }

    if (result.status !== 0 || result.error) {
      failed = true;
      output.push("status: failed");
      warnings.push(`endpoint '${endpoint.name}' provider failed${providerError ? `: ${providerError}` : ""}`);
      continue;
    }

    succeeded = true;
    output.push("status: refreshed");
    if (providerOutput) {
      output.push("");
      output.push("== provider output ==");
      output.push(providerOutput);
    }
  }

  return {
    exitCode: failed || !succeeded ? 1 : 0,
    stdout: output.length > 0 ? `${output.join("\n")}\n` : "",
    stderr: warnings.length > 0 ? `${warnings.join("\n")}\n` : "",
  };
}
