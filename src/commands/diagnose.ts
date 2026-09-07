import { loadManifest, type LoadedManifest, type ManifestCapability } from "../config/manifest.ts";
import { readRegistry, type RegistryBinding } from "../registry.ts";
import { resolveScope } from "../scope.ts";
import { Command, CommanderError } from "commander";
import { countFlagOccurrences, isHelpRequest } from "./flags.ts";
import { defaultQmdCommand } from "../capabilities/qmd.ts";
import { resolveProposeFolder } from "../capabilities/propose.ts";

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
    source: "manifest" | "derived-local";
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

const SEARCHABILITY_HINT = "hint: diagnose checks wiring, not indexed content; for QMD run qmd init / collection add / update.";

export class DiagnoseUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnoseUsageError";
  }
}

export function defaultProviderResolver(provider: string, capability = "search"): ProviderCheck {
  if (capability === "get") {
    return provider === "file"
      ? { supported: true }
      : { supported: false, reason: `provider '${provider}' is not supported for capability 'get' by this UKP build` };
  }
  if (capability === "propose") {
    return provider === "file"
      ? { supported: true }
      : { supported: false, reason: `provider '${provider}' is not supported for capability 'propose' by this UKP build` };
  }
  if (capability === "nav") {
    // Manifest load already defaults a bare file-native declaration
    // (nav / propose) to "file".
    return provider === "file"
      ? { supported: true }
      : { supported: false, reason: `provider '${provider}' is not supported for capability 'nav' by this UKP build` };
  }
  if (capability === "refresh") {
    if (provider !== "qmd") {
      return { supported: false, reason: `provider '${provider}' is not supported for capability 'refresh' by this UKP build` };
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
    // nav is normalized to its "file" default at Manifest load; a missing
    // provider on any other capability is surfaced as "(none)".
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

  const getCheck = resolveProvider("file", "get");
  const derived = [
    {
      name: "get",
      provider: "file",
      source: "derived-local" as const,
      status: getCheck.supported ? "ok" as const : "warning" as const,
      ...(getCheck.reason ? { reason: getCheck.reason } : {}),
    },
  ];
  // Nav is a derived default like get/file (O-013 precedent): report it as
  // derived-local only when the Manifest does not declare it itself.
  if (!Object.hasOwn(service.manifest.capabilities, "nav")) {
    const navCheck = resolveProvider("file", "nav");
    derived.push({
      name: "nav",
      provider: "file",
      source: "derived-local" as const,
      status: navCheck.supported ? "ok" as const : "warning" as const,
      ...(navCheck.reason ? { reason: navCheck.reason } : {}),
    });
  }
  return [...manifestCapabilities, ...derived];
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

function collectValues(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function createDiagnoseCommand(): Command {
  return new Command("ukp diagnose")
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(true)
    .helpOption("-h, --help", "show this help")
    .usage("[--endpoint <name> ... | -g]")
    .description("Validate a Service folder or selected registered Service endpoints.")
    .option(
      "-c, --endpoint <name>",
      "validate one registered endpoint; repeat to validate multiple endpoints",
      collectValues,
    )
    .option("-g", "validate every endpoint in the Host Registry; takes no value");
}

function parseDiagnoseCommand(args: readonly string[]): {
  positionals: string[];
  endpoints: string[];
  global?: boolean;
} {
  const command = createDiagnoseCommand()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new DiagnoseUsageError(error.message.replace(/^error: /, ""));
    }
    throw error;
  }

  const options = command.opts<{
    endpoint?: string[];
    g?: boolean;
  }>();
  return {
    positionals: command.args,
    endpoints: options.endpoint ?? [],
    global: options.g,
  };
}

function parseDiagnoseArgs(args: readonly string[]): {
  explicitEndpoints?: string[];
  global: boolean;
  warnings: string[];
} {
  const parsed = parseDiagnoseCommand(args);
  const explicit: string[] = [];
  const warnings: string[] = [];

  if (countFlagOccurrences(args, "-g") > 1) throw new DiagnoseUsageError("-g may only be specified once");
  const [unexpected] = parsed.positionals;
  if (unexpected !== undefined) {
    throw new DiagnoseUsageError(
      `unexpected argument '${unexpected}'. Use '--endpoint <name>' to select an endpoint; '-g' takes no value.`,
    );
  }

  for (const endpoint of parsed.endpoints) {
    if (explicit.includes(endpoint)) warnings.push(`duplicate endpoint '${endpoint}' ignored`);
    else explicit.push(endpoint);
  }

  if (parsed.global && explicit.length > 0) {
    throw new DiagnoseUsageError("--endpoint and -g cannot be used together");
  }

  return {
    explicitEndpoints: explicit.length > 0 ? explicit : undefined,
    global: parsed.global ?? false,
    warnings,
  };
}

function diagnoseBinding(
  binding: RegistryBinding,
  resolveProvider: ProviderResolver | undefined,
): { status: "ok"; report: DiagnoseReport } | { status: "failed"; message: string } {
  try {
    const report = diagnoseService(binding.path, resolveProvider);
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
    if (error instanceof DiagnoseUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderDiagnoseUsageError(error.message) };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `error: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

export function renderLocalDiagnoseError(message: string): string {
  return [
    `error: ${message}`,
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
      : `capability: ${capability.name}`);
    lines.push(`provider: ${capability.provider}`);
    lines.push(`status: ${capability.status}`);
    if (capability.reason) lines.push(`warning: ${capability.reason}`);
  }
  if (showSearchabilityHint) lines.push(SEARCHABILITY_HINT);
  return `${lines.join("\n")}\n`;
}

export function renderDiagnoseHelp(): string {
  return createDiagnoseCommand().helpInformation();
}

export function renderDiagnoseUsageError(message: string): string {
  return [
    `ukp diagnose: ${message}`,
    "Usage: ukp diagnose [--endpoint <name> ... | -g]",
    "Run 'ukp diagnose --help' for details.",
  ].join("\n");
}
