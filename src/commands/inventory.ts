import { Command, CommanderError } from "commander";
import { ENDPOINT_NAME } from "../config/manifest.ts";
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

export function executeRegisterCommand(
  args: readonly string[],
  context: InventoryCommandContext,
): InventoryCommandResult {
  const command = createCommand("register", "Register the current Service folder.");
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: command.helpInformation(), stderr: "" };
  }
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

export function executeListCommand(args: readonly string[], context: InventoryCommandContext): InventoryCommandResult {
  const command = createCommand("list", "List registered endpoint bindings.");
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: command.helpInformation(), stderr: "" };
  }
  try {
    parseCommand(command, args);
    if (args.length !== 0) {
      throw new InventoryUsageError("list takes no arguments");
    }
    const endpoints = readRegistry(context.registryPath);
    return {
      exitCode: 0,
      stdout: endpoints.length === 0
        ? "No endpoints registered."
        : endpoints.map((endpoint) => `${endpoint.name}\t${endpoint.path}`).join("\n"),
      stderr: "",
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
