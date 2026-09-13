import { spawnSync } from "node:child_process";
import { loadClientConfig, findNearestClientConfig } from "../config/client.ts";
import { loadManifest } from "../config/manifest.ts";
import { isRemoteBinding, localPathOf, readRegistry, type RegistryBinding } from "../registry.ts";
import { ScopeError } from "../scope.ts";
import { buildQmdInvocation, defaultQmdCommand, updateTimeoutMs } from "./qmd.ts";

export interface UpdateOptions {
  explicitEndpoints?: string[];
  global: boolean;
}

export interface ParsedUpdate {
  options: UpdateOptions;
  warnings: string[];
}

export interface UpdateContext {
  currentDirectory: string;
  registryPath: string;
  qmdCommand?: readonly string[];
}

/** ADR 0021 aggregate classification — the adapter maps it onto exit codes;
 * the capability never decides them. */
export type UpdateAggregateStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "no-success";

/** One endpoint's structured update outcome. `message` keeps today's
 * wording (including Hint lines — same documented debt class as search
 * warnings); `providerOutput` is the provider-native zone, passed through
 * unmodeled. */
export interface UpdateEndpointOutcome {
  name: string;
  provider: string | null;
  /** Transiently undefined while the provider run classifies the entry;
   * every path assigns a final status before the outcome escapes. */
  status?:
    | "updated"
    | "skipped"
    /** plan-stage failure (name mismatch, manifest error) — renders with an
     * `error:` line, unlike a provider failure. */
    | "plan-failed"
    | "provider-failed"
    | "timeout"
    /** this endpoint's SIGINT stopped the run — its header block was already
     * rendered through `status: cancelled`, later endpoints render nothing. */
    | "interrupted"
    /** not reached because an earlier endpoint was interrupted. */
    | "cancelled";
  message?: string;
  providerOutput?: string;
}

/** ADR 0021 structured outcome. */
export interface UpdateOutcome {
  endpoints: UpdateEndpointOutcome[];
  warnings: string[];
  aggregate: UpdateAggregateStatus;
}

export class UpdateUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateUsageError";
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

function resolveUpdateBindings(
  parsed: ParsedUpdate,
  registry: readonly RegistryBinding[],
  context: UpdateContext,
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
    throw new ScopeError("update requires an explicit scope; use '--endpoint <name>' or '-g'");
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

function planUpdate(parsed: ParsedUpdate, context: UpdateContext): {
  plan: PlannedEndpoint[];
  warnings: string[];
} {
  const registry = readRegistry(context.registryPath);
  const { bindings, warnings } = resolveUpdateBindings(parsed, registry, context);
  const qmdCommand = context.qmdCommand ?? defaultQmdCommand();
  const plan: PlannedEndpoint[] = [];

  if (bindings.length === 0) {
    warnings.push("no endpoints selected: the Host Registry is empty; run 'ukp register' from a Service folder, then retry");
  }

  for (const binding of bindings) {
    if (isRemoteBinding(binding)) {
      plan.push({
        name: binding.name,
        provider: null,
        status: "skipped",
        message: `endpoint '${binding.name}' is remote (${binding.url}); update is not yet remote-enabled (ukp_remote W3)`,
      });
      continue;
    }
    try {
      const service = loadManifest(localPathOf(binding));
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

      const capability = service.manifest.capabilities.update;
      if (!capability) {
        plan.push({
          name: binding.name,
          provider: null,
          status: "skipped",
          message: [
            `endpoint '${binding.name}' does not provide update`,
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
          message: `endpoint '${binding.name}' uses unsupported update provider '${provider}'`,
        });
        continue;
      }

      if (!qmdCommand || qmdCommand.length === 0) {
        plan.push({
          name: binding.name,
          provider: "qmd",
          status: "skipped",
          message: [
            `endpoint '${binding.name}' update unavailable: qmd executable is not available`,
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
    warnings.push("no executable update endpoints: run 'ukp inspect' to review selected endpoint capabilities");
  }

  return { plan, warnings };
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

/** ADR 0021 core entry: runs the update capability and returns the
 * structured outcome. Scope failures throw typed errors (`ScopeError`,
 * `UpdateUsageError`) for the surface adapter to map. */
export function runUpdate(parsed: ParsedUpdate, context: UpdateContext): UpdateOutcome {
  const { plan, warnings } = planUpdate(parsed, context);
  const endpoints: UpdateEndpointOutcome[] = [];
  let failed = plan.some((endpoint) => endpoint.status === "failed");
  let succeeded = false;
  let interrupted = false;

  for (const endpoint of plan) {
    if (endpoint.status === "skipped" || endpoint.status === "failed") {
      endpoints.push({
        name: endpoint.name,
        provider: endpoint.provider,
        status: endpoint.status === "failed" ? "plan-failed" : "skipped",
        message: endpoint.message,
      });
      continue;
    }
    if (interrupted) {
      endpoints.push({ name: endpoint.name, provider: endpoint.provider, status: "cancelled" });
      continue;
    }

    const outcome: UpdateEndpointOutcome = {
      name: endpoint.name,
      provider: "qmd",
    };
    endpoints.push(outcome);
    const command = commandFor(endpoint);
    const result = spawnSync(command.file, command.args, {
      cwd: endpoint.folder,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: command.verbatim,
      maxBuffer: 64 * 1024 * 1024,
      timeout: updateTimeoutMs(),
    });

    const providerOutput = (result.stdout ?? "").trimEnd();
    const providerError = (result.stderr ?? "").trimEnd() || result.error?.message;

    if (result.signal === "SIGTERM") {
      // Zero-output hang guard: `qmd update` on a large corpus is slow but
      // bounded; beyond the ceiling it is a classified failure, not silence.
      failed = true;
      outcome.status = "timeout";
      warnings.push(
        `endpoint '${endpoint.name}' provider timed out after ${updateTimeoutMs() / 1000}s (set UKP_UPDATE_TIMEOUT_MS to adjust)`,
      );
      continue;
    }

    if (result.signal === "SIGINT" || result.status === 130) {
      warnings.push(`endpoint '${endpoint.name}' provider cancelled`);
      outcome.status = "interrupted";
      interrupted = true;
      continue;
    }

    if (result.status !== 0 || result.error) {
      failed = true;
      outcome.status = "provider-failed";
      warnings.push(`endpoint '${endpoint.name}' provider failed${providerError ? `: ${providerError}` : ""}`);
      continue;
    }

    succeeded = true;
    outcome.status = "updated";
    if (providerOutput) outcome.providerOutput = providerOutput;
  }

  return {
    endpoints,
    warnings,
    aggregate: interrupted
      ? "cancelled"
      : failed
        ? "failed"
        : succeeded
          ? "succeeded"
          : "no-success",
  };
}

// ---------------------------------------------------------------------------
// Presentation (ADR 0021 two-stage form, surface-neutral view): `body` /
// `diagnostics` — the adapter assigns channels.
// ---------------------------------------------------------------------------

export interface UpdateHumanView {
  body: string;
  diagnostics: string;
}

export function renderUpdateHuman(result: UpdateOutcome): UpdateHumanView {
  const lines: string[] = [];
  for (const endpoint of result.endpoints) {
    if (endpoint.status === "cancelled") break;
    lines.push(`== ${endpoint.name} ==`);
    lines.push("capability: update");
    lines.push(`provider: ${endpoint.provider ?? "(none)"}`);
    if (endpoint.status === "skipped" || endpoint.status === "plan-failed") {
      lines.push(`status: ${endpoint.status === "plan-failed" ? "failed" : "skipped"}`);
      lines.push(`${endpoint.status === "plan-failed" ? "error" : "message"}: ${endpoint.message}`);
      continue;
    }
    lines.push(`maintenance_scope: ${QMD_MAINTENANCE_SCOPE}`);
    if (endpoint.status === "interrupted") {
      lines.push("status: cancelled");
      break;
    }
    if (endpoint.status === "timeout") {
      lines.push("status: failed");
      lines.push(`error: provider timed out after ${updateTimeoutMs() / 1000}s`);
      continue;
    }
    if (endpoint.status === "provider-failed") {
      lines.push("status: failed");
      continue;
    }
    lines.push("status: updated");
    if (endpoint.providerOutput) {
      lines.push("");
      lines.push("== provider output ==");
      lines.push(endpoint.providerOutput);
    }
  }
  return {
    body: lines.length > 0 ? `${lines.join("\n")}\n` : "",
    diagnostics: result.warnings.length > 0 ? `${result.warnings.join("\n")}\n` : "",
  };
}
