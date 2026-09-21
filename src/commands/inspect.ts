import { loadManifest } from "../config/manifest.ts";
import { isRemoteBinding, localPathOf, readRegistry, type RegistryBinding } from "../registry.ts";
import { resolveScope, ScopeError, type ResolvedScope } from "../scope.ts";
import {
  defaultProviderResolver,
  evaluateServiceCapabilities,
  renderDependencyRegistryWarnings,
  renderDiagnose,
  type DiagnoseReport,
  type ProviderResolver,
} from "./diagnose.ts";
import { KitUsageError, parseKitArgs, renderKitHelp, renderKitUsageError, type UkpCommandSpec } from "./kit.ts";
import { HelpRequestError, isHelpRequest } from "./flags.ts";

export interface InspectCommandContext {
  currentDirectory: string;
  registryPath: string;
  resolveProvider?: ProviderResolver;
}

export interface InspectCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Single-source command spec (ADR 0024): summary feeds the root help via
 * cli.ts; usage feeds the help header and the usage-error line; the scope
 * family, singleton detection, and help-intent triage live in kit.ts. */
export const INSPECT_SPEC: UkpCommandSpec = {
  name: "inspect",
  summary: "show which endpoints the current scope selects and their capabilities",
  group: "operations",
  description: "Explain the current UKP scope, Registry bindings, and Service capabilities.",
  usage: "[--endpoint <name> ... | -g]",
  scope: {
    endpointHelp: "inspect one registered endpoint; repeat to inspect multiple endpoints",
    globalHelp: "inspect every endpoint in the Host Registry; takes no value",
  },
};

function parseInspectArgs(args: readonly string[]): {
  explicitEndpoints?: string[];
  global: boolean;
  warnings: string[];
} {
  const parsed = parseKitArgs(INSPECT_SPEC, args);
  return {
    explicitEndpoints: parsed.scope.explicitEndpoints,
    global: parsed.scope.global,
    warnings: parsed.scope.warnings,
  };
}

function describeScopeSource(scope: ResolvedScope, context: InspectCommandContext): string {
  if (scope.source === "explicit") return "explicit endpoint selector";
  if (scope.source === "global") return "Host Registry (-g)";
  if (scope.source === "registry-fallback") return "Host Registry fallback (no Client Config)";
  return scope.configPath ? `Client Config (${scope.configPath})` : "Client Config";
}

function inspectBinding(
  binding: RegistryBinding,
  resolveProvider: ProviderResolver | undefined,
): { status: "ok" | "unavailable"; report: DiagnoseReport } | { status: "failed"; message: string } {
  if (isRemoteBinding(binding)) {
    return {
      status: "failed",
      message: `remote endpoint '${binding.name}' (${binding.url}): inspect deep-dive is local-only for remote endpoints; capabilities show in 'ukp list'`,
    };
  }
  try {
    const service = loadManifest(localPathOf(binding));
    const report = {
      service,
      capabilities: evaluateServiceCapabilities(service, resolveProvider ?? defaultProviderResolver),
    };
    if (report.service.effectiveName !== binding.name) {
      return {
        status: "failed",
        message: `endpoint '${binding.name}' no longer matches Service effective name '${report.service.effectiveName}'`,
      };
    }
    return {
      status: report.capabilities.some((capability) => capability.status === "ok") ? "ok" : "unavailable",
      report,
    };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

function renderEndpointInspection(binding: RegistryBinding, result: ReturnType<typeof inspectBinding>): string {
  const lines = [
    `== ${binding.name} ==`,
    `binding: ${binding.name} -> ${binding.path}`,
  ];
  if (result.status === "failed") {
    lines.push("status: failed");
    lines.push(`error: ${result.message}`);
    return lines.join("\n");
  }

  lines.push(`manifest: ${result.report.service.manifestPath}`);
  if (result.status === "unavailable") {
    lines.push("service_status: unavailable");
  }
  lines.push(renderDiagnose(result.report).trimEnd());
  return lines.join("\n");
}

export function executeInspectCommand(
  args: readonly string[],
  context: InspectCommandContext,
): InspectCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderInspectHelp(), stderr: "" };
  }

  try {
    const parsed = parseInspectArgs(args);
    const registry = readRegistry(context.registryPath);
    const scope = resolveScope({
      currentDirectory: context.currentDirectory,
      registry,
      explicitEndpoints: parsed.explicitEndpoints,
      global: parsed.global,
    });
    const warnings = [...parsed.warnings, ...scope.warnings];
    const output = [
      `scope: ${scope.source}`,
      `source: ${describeScopeSource(scope, context)}`,
      `registry: ${context.registryPath}`,
      `selected_endpoints: ${scope.bindings.length}`,
    ];

    let failed = false;
    if (scope.bindings.length === 0) {
      failed = true;
      warnings.push("no endpoints selected: the Host Registry is empty; run 'ukp register' from a Service folder, then retry");
    }

    for (const binding of scope.bindings) {
      const result = inspectBinding(binding, context.resolveProvider);
      if (result.status === "failed" || result.status === "unavailable") failed = true;
      if (result.status !== "failed") {
        warnings.push(...renderDependencyRegistryWarnings(result.report.service, registry));
      }
      output.push("");
      output.push(renderEndpointInspection(binding, result));
    }

    return {
      exitCode: failed ? 1 : 0,
      stdout: `${output.join("\n")}\n`,
      stderr: warnings.length > 0 ? `${warnings.join("\n")}\n` : "",
    };
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderInspectHelp(), stderr: "" };
    }
    if (error instanceof KitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderInspectUsageError(error.message) };
    }
    if (error instanceof ScopeError) {
      return { exitCode: 1, stdout: "", stderr: `ukp inspect: ${error.message}\n` };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp inspect: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

export function renderInspectHelp(): string {
  return renderKitHelp(INSPECT_SPEC);
}

export function renderInspectUsageError(message: string): string {
  return renderKitUsageError(INSPECT_SPEC, message);
}
