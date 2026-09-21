import { loadManifest, type LoadedManifest, type ManifestCapability } from "../config/manifest.ts";
import { FILE_NATIVE_CAPABILITIES, isFileNativeCapability } from "../config/file-native.ts";
import { EXTERNAL_TOOL_CAPABILITIES, EXTERNAL_PROVIDER, isExternalToolCapability } from "../config/external-tool.ts";
import { isRemoteBinding, localPathOf, readRegistry, type RegistryBinding } from "../registry.ts";
import { resolveScope } from "../scope.ts";
import { KitUsageError, parseKitArgs, renderKitHelp, renderKitUsageError, type UkpCommandSpec } from "./kit.ts";
import { HelpRequestError, isHelpRequest } from "./flags.ts";
import { defaultQmdCommand } from "../capabilities/qmd.ts";
import { resolveProposeFolder } from "../capabilities/propose.ts";
import { rgExecutableAvailable } from "../capabilities/rg.ts";

export interface ProviderCheck {
  supported: boolean;
  reason?: string;
}

export type ProviderResolver = (provider: string, capability?: string) => ProviderCheck;

export interface DiagnoseReport {
  service: LoadedManifest;
  capabilities: Array<{
    name: string;
    provider: string;
    source: "manifest" | "derived-local" | "base-tier";
    status: "ok" | "warning";
    reason?: string;
  }>;
}

export interface DiagnoseCommandContext {
  currentDirectory: string;
  registryPath: string;
  resolveProvider?: ProviderResolver;
}

export interface DiagnoseCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RenderDiagnoseOptions {
  includeSearchabilityHint?: boolean;
}

const SEARCHABILITY_HINT = "hint: diagnose checks wiring, not indexed content; content is searchable after provider setup (see 'ukp guide service qmd').";

/** Single-source command spec (ADR 0024): summary feeds the root help via
 * cli.ts; usage feeds the help header and the usage-error line; the scope
 * family, singleton detection, and help-intent triage live in kit.ts. */
export const DIAGNOSE_SPEC: UkpCommandSpec = {
  name: "diagnose",
  summary: "check a Service or endpoints for wiring problems (manifest, provider setup)",
  group: "operations",
  description: "Validate a Service folder or selected registered Service endpoints.",
  usage: "[--endpoint <name> ... | -g]",
  scope: {
    endpointHelp: "validate one registered endpoint; repeat to validate multiple endpoints",
    globalHelp: "validate every endpoint in the Host Registry; takes no value",
  },
  helpSuffix: [
    "",
    "Scope:",
    "  With no --endpoint or -g, diagnose validates the current folder as a",
    "  Service (Manifest and provider wiring). -g validates every registered",
    "  endpoint; -g cannot be combined with --endpoint.",
    "",
  ].join("\n"),
};

// Provider registration point for this UKP build: every provider that can
// back a capability must have its availability check here. Adding a provider
// means (1) a branch in this resolver and (2) a capability adapter under
// capabilities/ that the command layer dispatches to.
export function defaultProviderResolver(provider: string, capability = "search"): ProviderCheck {
  if (isFileNativeCapability(capability)) {
    // Only the UKP-native file provider exists for the file-native set;
    // Manifest load already defaults bare declarations to "file".
    return provider === "file"
      ? { supported: true }
      : {
          supported: false,
          reason: `provider '${provider}' is not supported for capability '${capability}' by this UKP build`,
        };
  }
  if (isExternalToolCapability(capability)) {
    // External-tool base tier (ADR-RG-003): the provider marker is fixed;
    // availability is the base tool itself, degrading to a warning row.
    if (provider !== EXTERNAL_PROVIDER) {
      return { supported: false, reason: `provider '${provider}' is not supported for capability '${capability}' by this UKP build` };
    }
    return rgExecutableAvailable()
      ? { supported: true }
      : { supported: false, reason: "rg executable is not available" };
  }
  if (capability === "update") {
    if (provider !== "qmd") {
      return { supported: false, reason: `provider '${provider}' is not supported for capability 'update' by this UKP build` };
    }
    return defaultQmdCommand()
      ? { supported: true }
      : { supported: false, reason: "qmd executable is not available" };
  }
  if (capability !== "search") {
    return { supported: false, reason: `capability '${capability}' is not implemented by this UKP build` };
  }
  if (provider !== "qmd") {
    return { supported: false, reason: `provider '${provider}' is not supported by this UKP build` };
  }
  return defaultQmdCommand()
    ? { supported: true }
    : { supported: false, reason: "qmd executable is not available" };
}

function proposeFolderError(serviceFolder: string, declaration: ManifestCapability): string | undefined {
  try {
    resolveProposeFolder(serviceFolder, declaration);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function evaluateServiceCapabilities(
  service: LoadedManifest,
  resolveProvider: ProviderResolver = defaultProviderResolver,
): DiagnoseReport["capabilities"] {
  const manifestCapabilities = Object.entries(service.manifest.capabilities).map(([name, declaration]) => {
    // Provider is guaranteed post-load for valid Manifests (file-native bare
    // declarations default to "file"; others fail at load). The "(none)"
    // arm is defensive depth for direct API callers.
    const provider = declaration.provider ?? "(none)";
    const check = resolveProvider(provider, name);
    // Front-load propose folder validation so config typos surface in the
    // Service-side self-check instead of the first `ukp propose` run.
    const folderError = name === "propose"
      ? proposeFolderError(service.folder, declaration)
      : undefined;
    const supported = check.supported && folderError === undefined;
    const reason = !check.supported ? check.reason : folderError;
    return {
      name,
      provider,
      source: "manifest" as const,
      status: supported ? "ok" as const : "warning" as const,
      ...(reason ? { reason } : {}),
    };
  });

  // Derived file-native defaults (ADR 0016 rule 2): every read-side
  // file-native capability not declared by the Manifest is still effectively
  // present. The table is the single source — no per-capability rows here.
  const derived = Object.entries(FILE_NATIVE_CAPABILITIES)
    .filter(([name, spec]) => spec.derived && !Object.hasOwn(service.manifest.capabilities, name))
    .map(([name]) => {
      const check = resolveProvider("file", name);
      return {
        name,
        provider: "file",
        source: "derived-local" as const,
        status: check.supported ? "ok" as const : "warning" as const,
        ...(check.reason ? { reason: check.reason } : {}),
      };
    });

  // External-tool base tier (ADR-RG-003): base-tier members are effectively
  // present on every registered local Service without declaration; a missing
  // base tool degrades the row to a warning, never hides it.
  const baseTier = Object.entries(EXTERNAL_TOOL_CAPABILITIES)
    .filter(([name, spec]) => spec.baseTier && !Object.hasOwn(service.manifest.capabilities, name))
    .map(([name]) => {
      const check = resolveProvider(EXTERNAL_PROVIDER, name);
      return {
        name,
        provider: EXTERNAL_PROVIDER,
        source: "base-tier" as const,
        status: check.supported ? "ok" as const : "warning" as const,
        ...(check.reason ? { reason: check.reason } : {}),
      };
    });
  return [...manifestCapabilities, ...derived, ...baseTier];
}

export function diagnoseService(
  serviceFolder: string,
  resolveProvider: ProviderResolver = defaultProviderResolver,
): DiagnoseReport {
  const service = loadManifest(serviceFolder);
  const capabilities = evaluateServiceCapabilities(service, resolveProvider);

  if (!capabilities.some((capability) => capability.status === "ok")) {
    throw new Error("NO_SUPPORTED_CAPABILITY");
  }
  return { service, capabilities };
}

export function renderDependencyRegistryWarnings(
  service: LoadedManifest,
  registry: readonly RegistryBinding[],
): string[] {
  if (!service.manifest.dependencies || service.manifest.dependencies.length === 0) return [];
  const registeredEndpoints = new Set(registry.map((binding) => binding.name));
  return service.manifest.dependencies
    .filter((dependency) => !registeredEndpoints.has(dependency.endpoint))
    .map((dependency) =>
      `dependency target '${dependency.endpoint}' is not registered (declared by ${service.effectiveName})`
    );
}

function parseDiagnoseArgs(args: readonly string[]): {
  explicitEndpoints?: string[];
  global: boolean;
  warnings: string[];
} {
  const parsed = parseKitArgs(DIAGNOSE_SPEC, args);
  return {
    explicitEndpoints: parsed.scope.explicitEndpoints,
    global: parsed.scope.global,
    warnings: parsed.scope.warnings,
  };
}

function diagnoseBinding(
  binding: RegistryBinding,
  resolveProvider: ProviderResolver | undefined,
): { status: "ok"; report: DiagnoseReport } | { status: "failed"; message: string } {
  if (isRemoteBinding(binding)) {
    return {
      status: "failed",
      message: `remote endpoint '${binding.name}' (${binding.url}): diagnose is local-only for remote endpoints; reachability shows in 'ukp list'`,
    };
  }
  try {
    const report = diagnoseService(localPathOf(binding), resolveProvider);
    if (report.service.effectiveName !== binding.name) {
      return {
        status: "failed",
        message: `endpoint '${binding.name}' no longer matches Service effective name '${report.service.effectiveName}'`,
      };
    }
    return { status: "ok", report };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

export function executeDiagnoseCommand(
  args: readonly string[],
  context: DiagnoseCommandContext,
): DiagnoseCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderDiagnoseHelp(), stderr: "" };
  }

  try {
    const parsed = parseDiagnoseArgs(args);
    if (!parsed.explicitEndpoints && !parsed.global) {
      try {
        const report = diagnoseService(context.currentDirectory, context.resolveProvider);
        let dependencyWarnings: string[] = [];
        try {
          dependencyWarnings = renderDependencyRegistryWarnings(report.service, readRegistry(context.registryPath));
        } catch (error) {
          if (report.service.manifest.dependencies && report.service.manifest.dependencies.length > 0) {
            dependencyWarnings = [
              `dependency registry check skipped: ${error instanceof Error ? error.message : String(error)}`,
            ];
          }
        }
        const warnings = [...parsed.warnings, ...dependencyWarnings];
        return {
          exitCode: 0,
          stdout: renderDiagnose(report, {
            includeSearchabilityHint: true,
          }),
          stderr: warnings.length > 0 ? `${warnings.join("\n")}\n` : "",
        };
      } catch (error) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: renderLocalDiagnoseError(error instanceof Error ? error.message : String(error)),
        };
      }
    }

    const registry = readRegistry(context.registryPath);
    const scope = resolveScope({
      currentDirectory: context.currentDirectory,
      registry,
      explicitEndpoints: parsed.explicitEndpoints,
      global: parsed.global,
    });
    const warnings = [...parsed.warnings, ...scope.warnings];
    const output: string[] = [];
    let failed = false;

    for (const binding of scope.bindings) {
      output.push(`== ${binding.name} ==`);
      const result = diagnoseBinding(binding, context.resolveProvider);
      if (result.status === "ok") {
        output.push(renderDiagnose(result.report, { includeSearchabilityHint: true }).trimEnd());
        warnings.push(...renderDependencyRegistryWarnings(result.report.service, registry));
      } else {
        failed = true;
        output.push("status: failed");
        output.push(`error: ${result.message}`);
      }
    }

    if (scope.bindings.length === 0) {
      failed = true;
      warnings.push("no endpoints selected: the Host Registry is empty; run 'ukp register' from a Service folder, then retry");
    }

    return {
      exitCode: failed ? 1 : 0,
      stdout: output.length > 0 ? `${output.join("\n")}\n` : "",
      stderr: warnings.length > 0 ? `${warnings.join("\n")}\n` : "",
    };
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderDiagnoseHelp(), stderr: "" };
    }
    if (error instanceof KitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderDiagnoseUsageError(error.message) };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp diagnose: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

export function renderLocalDiagnoseError(message: string): string {
  return [
    `ukp diagnose: ${message}`,
    "Hint: 'ukp diagnose' checks the current folder as a Service.",
    "Run 'ukp guide service' for the short onboarding guide.",
    "Use 'ukp diagnose -g' to validate every registered endpoint, or 'ukp diagnose --endpoint <name>' for one endpoint.",
  ].join("\n") + "\n";
}

export function renderDiagnose(report: DiagnoseReport, options: RenderDiagnoseOptions = {}): string {
  const lines = [
    `endpoint: ${report.service.effectiveName} (source: ${report.service.nameSource})`,
  ];
  if (report.service.manifest.description) {
    lines.push(`description: ${report.service.manifest.description}`);
  }
  if (report.service.manifest.dependencies && report.service.manifest.dependencies.length > 0) {
    for (const dependency of report.service.manifest.dependencies) {
      lines.push(`dependency: depends_on -> ${dependency.endpoint} (kind: ${dependency.kind})`);
      if (dependency.reason) {
        lines.push(`dependency_reason: ${dependency.reason}`);
      }
    }
  }
  lines.push(`location: ${report.service.folder}`);
  const showSearchabilityHint = options.includeSearchabilityHint
    && report.capabilities.some((capability) => capability.name === "search" && capability.status === "ok");
  for (const capability of report.capabilities) {
    lines.push(capability.source === "derived-local"
      ? `capability: ${capability.name} (derived local baseline)`
      : capability.source === "base-tier"
        ? `capability: ${capability.name} (external-tool base tier)`
        : `capability: ${capability.name}`);
    lines.push(`provider: ${capability.provider}`);
    lines.push(`status: ${capability.status}`);
    if (capability.reason) lines.push(`warning: ${capability.reason}`);
  }
  if (showSearchabilityHint) lines.push(SEARCHABILITY_HINT);
  return `${lines.join("\n")}\n`;
}

export function renderDiagnoseHelp(): string {
  return renderKitHelp(DIAGNOSE_SPEC);
}

export function renderDiagnoseUsageError(message: string): string {
  return renderKitUsageError(DIAGNOSE_SPEC, message);
}
