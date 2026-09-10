import { Command, CommanderError } from "commander";
import { ENDPOINT_NAME, loadManifest } from "../config/manifest.ts";
import { FILE_NATIVE_CAPABILITIES, isFileNativeCapability } from "../config/file-native.ts";
import { diagnoseService, type ProviderResolver } from "./diagnose.ts";
import { readRegistry, registerAt, unregisterAt } from "../registry.ts";
import { countFlagOccurrences, isHelpRequest } from "./flags.ts";

export interface InventoryCommandContext {
  currentDirectory: string;
  registryPath: string;
  resolveProvider?: ProviderResolver;
}

export interface InventoryCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class InventoryUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryUsageError";
  }
}

function createCommand(name: string, description: string): Command {
  return new Command(`ukp ${name}`)
    .exitOverride()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined })
    .allowUnknownOption(false)
    .allowExcessArguments(false)
    .helpOption("-h, --help", "show this help")
    .description(description);
}

function parseCommand(command: Command, args: readonly string[]): void {
  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new InventoryUsageError(error.message.replace(/^error: /, ""));
    }
    throw error;
  }
}

function renderUsageError(name: string, message: string, usage: string): string {
  return [
    `ukp ${name}: ${message}`,
    `Usage: ${usage}`,
    `Run 'ukp ${name} --help' for details.`,
  ].join("\n");
}

export function renderRegisterHelp(): string {
  return createCommand("register", "Register the current Service folder.").helpInformation() + [
    "",
    "Recovery:",
    "  Registering a name already bound to a different location is rejected.",
    "  Unregister the old binding first, then register from the new Service folder:",
    "  ukp unregister --endpoint <name>",
    "",
  ].join("\n");
}

export function executeRegisterCommand(
  args: readonly string[],
  context: InventoryCommandContext,
): InventoryCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderRegisterHelp(), stderr: "" };
  }
  const command = createCommand("register", "Register the current Service folder.");
  try {
    parseCommand(command, args);
    if (args.length !== 0) {
      throw new InventoryUsageError("register takes no arguments");
    }
    const report = diagnoseService(context.currentDirectory, context.resolveProvider);
    registerAt(context.registryPath, report.service.effectiveName, report.service.folder);
    const lines = [
      `registered: ${report.service.effectiveName}`,
      ...(report.service.manifest.description ? [`description: ${report.service.manifest.description}`] : []),
      `location: ${report.service.folder}`,
    ];
    return {
      exitCode: 0,
      stdout: lines.join("\n"),
      stderr: "",
    };
  } catch (error) {
    if (error instanceof InventoryUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderUsageError("register", error.message, "ukp register") };
    }
    return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

// Derived file-native capabilities (read/nav today) exist on every registered
// endpoint without a declaration (ADR 0016 rule 2); they are stated once in
// the header instead of being repeated on every row. Everything else a
// Service declares (search, refresh, propose, ...) is per-endpoint news and
// gets its own column.
const DEFAULT_CAPABILITIES = (Object.keys(FILE_NATIVE_CAPABILITIES) as Array<keyof typeof FILE_NATIVE_CAPABILITIES>)
  .filter((name) => FILE_NATIVE_CAPABILITIES[name].derived)
  .sort();

function renderListRow(endpoint: { name: string; path: string }): { line: string; warning?: string } {
  let service;
  try {
    service = loadManifest(endpoint.path);
  } catch (error) {
    // One-line headline only: an inventory warning must stay scannable even
    // when the underlying ManifestError carries a full zod schema dump.
    const headline = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    return {
      line: `${endpoint.name}\t${endpoint.path}\t(unavailable)`,
      warning: `endpoint '${endpoint.name}' capabilities unavailable: ${headline}`,
    };
  }
  const extras = Object.keys(service.manifest.capabilities)
    .filter((name) => !(isFileNativeCapability(name) && FILE_NATIVE_CAPABILITIES[name].derived))
    .sort();
  return { line: `${endpoint.name}\t${endpoint.path}\t${extras.length > 0 ? extras.join(",") : "-"}` };
}

export function executeListCommand(args: readonly string[], context: InventoryCommandContext): InventoryCommandResult {
  const command = createCommand("list", "List registered endpoint bindings and capabilities.");
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: command.helpInformation(), stderr: "" };
  }
  try {
    parseCommand(command, args);
    if (args.length !== 0) {
      throw new InventoryUsageError("list takes no arguments");
    }
    const endpoints = readRegistry(context.registryPath);
    if (endpoints.length === 0) {
      return { exitCode: 0, stdout: "No endpoints registered.", stderr: "" };
    }
    const warnings: string[] = [];
    const rows = endpoints.map((endpoint) => {
      const rendered = renderListRow(endpoint);
      if (rendered.warning) warnings.push(rendered.warning);
      return rendered.line;
    });
    const stdout = [
      `capabilities on every endpoint: ${DEFAULT_CAPABILITIES.join(", ")} (derived file-native); additional declared capabilities per endpoint:`,
      ...rows,
    ].join("\n");
    return {
      exitCode: 0,
      stdout,
      stderr: warnings.length > 0 ? `${warnings.join("\n")}\n` : "",
    };
  } catch (error) {
    if (error instanceof InventoryUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderUsageError("list", error.message, "ukp list") };
    }
    return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

export function executeUnregisterCommand(
  args: readonly string[],
  context: InventoryCommandContext,
): InventoryCommandResult {
  const command = createCommand("unregister", "Remove a registered endpoint.")
    .usage("--endpoint <name>")
    .argument("[name]", "legacy registered endpoint name")
    .option("-c, --endpoint <name>", "select the endpoint binding to remove");
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: command.helpInformation(), stderr: "" };
  }
  try {
    parseCommand(command, args);
    const options = command.opts<{ endpoint?: string }>();
    const positional = command.args[0];
    if (countFlagOccurrences(args, "--endpoint") + countFlagOccurrences(args, "-c") > 1) {
      throw new InventoryUsageError("--endpoint may only be specified once");
    }
    if (options.endpoint && positional) {
      throw new InventoryUsageError("unregister accepts either --endpoint <name> or legacy positional <name>, not both");
    }
    const name = options.endpoint ?? positional;
    if (!name || !ENDPOINT_NAME.test(name)) {
      throw new InventoryUsageError("unregister requires a valid endpoint name via --endpoint <name>");
    }
    const previous = readRegistry(context.registryPath).find((binding) => binding.name === name);
    unregisterAt(context.registryPath, name);
    return {
      exitCode: 0,
      stdout: `unregistered: ${name}\nlocation: ${previous?.path ?? "unknown"}`,
      stderr: "",
    };
  } catch (error) {
    if (error instanceof InventoryUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderUsageError("unregister", error.message, "ukp unregister --endpoint <name>") };
    }
    return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}
