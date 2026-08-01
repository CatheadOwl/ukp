import { loadManifest, type LoadedManifest } from "../config/manifest.ts";
import { readRegistry, type RegistryBinding } from "../registry.ts";
import { resolveScope } from "../scope.ts";
import { Command, CommanderError } from "commander";
import { countFlagOccurrences, isHelpRequest } from "./flags.ts";

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
  if (capability === "refresh") {
    if (provider !== "qmd") {
      return { supported: false, reason: `provider '${provider}' is not supported for capability 'refresh' by this UKP build` };
    }
    const executable = Bun.which("qmd") ?? Bun.which("qmd.ps1") ?? Bun.which("qmd.cmd");
    return executable
      ? { supported: true }
      : { supported: false, reason: "qmd executable is not available" };
  }
  if (capability !== "search") {
    return { supported: false, reason: `capability '${capability}' is not implemented by this UKP build` };
  }
  if (provider !== "qmd") {
    return { supported: false, reason: `provider '${provider}' is not supported by this UKP build` };
  }
  const executable = Bun.which("qmd") ?? Bun.which("qmd.ps1") ?? Bun.which("qmd.cmd");
  return executable
    ? { supported: true }
    : { supported: false, reason: "qmd executable is not available" };
}

export function evaluateServiceCapabilities(
  service: LoadedManifest,
  resolveProvider: ProviderResolver = defaultProviderResolver,
): DiagnoseReport["capabilities"] {
  return Object.entries(service.manifest.capabilities).map(([name, declaration]) => {
    const check = resolveProvider(declaration.provider, name);
    return {
      name,
      provider: declaration.provider,
      status: check.supported ? "ok" as const : "warning" as const,
      ...(check.reason ? { reason: check.reason } : {}),
    };
  });
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
        return {
          exitCode: 0,
          stdout: renderDiagnose(diagnoseService(context.currentDirectory, context.resolveProvider)),
          stderr: parsed.warnings.length > 0 ? `${parsed.warnings.join("\n")}\n` : "",
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
        output.push(renderDiagnose(result.report).trimEnd());
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

export function renderDiagnose(report: DiagnoseReport): string {
  const lines = [
    `endpoint: ${report.service.effectiveName} (source: ${report.service.nameSource})`,
  ];
  if (report.service.manifest.description) {
    lines.push(`description: ${report.service.manifest.description}`);
  }
  lines.push(`location: ${report.service.folder}`);
  for (const capability of report.capabilities) {
    lines.push(`capability: ${capability.name}`);
    lines.push(`provider: ${capability.provider}`);
    lines.push(`status: ${capability.status}`);
    if (capability.reason) lines.push(`warning: ${capability.reason}`);
  }
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
