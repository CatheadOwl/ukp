import { Command, CommanderError } from "commander";
import { loadManifest } from "../config/manifest.ts";
import { readRegistry, type RegistryBinding } from "../registry.ts";
import { resolveScope, ScopeError, type ResolvedScope } from "../scope.ts";
import {
  defaultProviderResolver,
  evaluateServiceCapabilities,
  renderDependencyRegistryWarnings,
  renderDiagnose,
  type DiagnoseReport,
  type ProviderResolver,
} from "./diagnose.ts";
import { countFlagOccurrences, HelpRequestError, isCommanderHelpIntent, isHelpRequest } from "./flags.ts";

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

export class InspectUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InspectUsageError";
  }
}

function collectValues(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function createInspectCommand(): Command {
  return new Command("ukp inspect")
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(true)
    .helpOption("-h, --help", "show this help")
    .usage("[--endpoint <name> ... | -g]")
    .description("Explain the current UKP scope, Registry bindings, and Service capabilities.")
    .option(
      "-c, --endpoint <name>",
      "inspect one registered endpoint; repeat to inspect multiple endpoints",
      collectValues,
    )
    .option("-g", "inspect every endpoint in the Host Registry; takes no value");
}

function parseInspectCommand(args: readonly string[]): {
  positionals: string[];
  endpoints: string[];
  global?: boolean;
} {
  const command = createInspectCommand()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (isCommanderHelpIntent(error)) throw new HelpRequestError();
      throw new InspectUsageError(error.message.replace(/^error: /, ""));
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

function parseInspectArgs(args: readonly string[]): {
  explicitEndpoints?: string[];
  global: boolean;
  warnings: string[];
} {
  const parsed = parseInspectCommand(args);
  const explicit: string[] = [];
  const warnings: string[] = [];

  if (countFlagOccurrences(args, "-g") > 1) throw new InspectUsageError("-g may only be specified once");
  const [unexpected] = parsed.positionals;
  if (unexpected !== undefined) {
    throw new InspectUsageError(
      `unexpected argument '${unexpected}'. Use '--endpoint <name>' to select an endpoint; '-g' takes no value.`,
    );
  }

  for (const endpoint of parsed.endpoints) {
    if (explicit.includes(endpoint)) warnings.push(`duplicate endpoint '${endpoint}' ignored`);
    else explicit.push(endpoint);
  }

  if (parsed.global && explicit.length > 0) {
    throw new InspectUsageError("--endpoint and -g cannot be used together");
  }

  return {
    explicitEndpoints: explicit.length > 0 ? explicit : undefined,
    global: parsed.global ?? false,
    warnings,
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
  try {
    const service = loadManifest(binding.path);
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
    if (error instanceof InspectUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderInspectUsageError(error.message) };
    }
    if (error instanceof ScopeError) {
      return { exitCode: 1, stdout: "", stderr: `ukp inspect: ${error.message}\n` };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `error: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

export function renderInspectHelp(): string {
  return createInspectCommand().helpInformation();
}

export function renderInspectUsageError(message: string): string {
  return [
    `ukp inspect: ${message}`,
    "Usage: ukp inspect [--endpoint <name> ... | -g]",
    "Run 'ukp inspect --help' for details.",
  ].join("\n");
}
