import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, unlinkSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { stringify } from "smol-toml";
import { Command, CommanderError } from "commander";
import { ENDPOINT_NAME, loadManifest } from "../config/manifest.ts";
import { isHelpRequest } from "./flags.ts";

export interface InitCommandContext {
  currentDirectory: string;
}

export interface InitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class InitUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitUsageError";
  }
}

function createInitCommand(): Command {
  return new Command("ukp init")
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(false)
    .helpOption("-h, --help", "show this help")
    .usage("<target>")
    .description("Initialize UKP-owned files.")
    .argument("<target>", "init target: service");
}

function createInitServiceCommand(): Command {
  return new Command("ukp init service")
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(false)
    .helpOption("-h, --help", "show this help")
    .description("Create a Service Manifest in the current folder.")
    .option("--name <name>", "explicit Service endpoint name")
    .option("--description <text>", "human-readable Service description");
}

function parseCommand(command: Command, args: readonly string[]): void {
  try {
    command.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    command.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new InitUsageError(error.message.replace(/^error: /, ""));
    }
    throw error;
  }
}

function renderUsageError(message: string): string {
  return [
    `ukp init: ${message}`,
    "Usage: ukp init <target>",
    "Run 'ukp init --help' for details.",
  ].join("\n");
}

function renderServiceUsageError(message: string): string {
  return [
    `ukp init service: ${message}`,
    "Usage: ukp init service [--name <name>] [--description <text>]",
    "Run 'ukp init service --help' for details.",
  ].join("\n");
}

function resolveServiceFolder(currentDirectory: string): string {
  try {
    const folder = realpathSync(currentDirectory);
    if (!statSync(folder).isDirectory()) throw new Error("not a directory");
    return folder;
  } catch (error) {
    throw new Error(`Service folder is not accessible: ${currentDirectory}`, { cause: error });
  }
}

function resolveServiceName(folder: string, explicitName?: string): { name: string; source: "option" | "folder-name" } {
  const name = explicitName ?? basename(folder);
  const source = explicitName === undefined ? "folder-name" : "option";
  if (!ENDPOINT_NAME.test(name)) {
    const hint = source === "folder-name"
      ? "Pass '--name <name>' with a lowercase endpoint slug."
      : "Name must be a lowercase endpoint slug.";
    throw new InitUsageError(`invalid Service name '${name}'. ${hint}`);
  }
  return { name, source };
}

function validateInitServiceOptions(
  folder: string,
  options: { name?: string; description?: string },
): { name: string; nameSource: "option" | "folder-name" } {
  const { name, source } = resolveServiceName(folder, options.name);
  if (options.description === "") {
    throw new InitUsageError("description must be a non-empty string");
  }
  return { name, nameSource: source };
}

function renderServiceManifest(options: { name?: string; description?: string }): string {
  const encoded = stringify({
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.description === undefined ? {} : { description: options.description }),
    capabilities: {
      search: {
        provider: "qmd",
      },
    },
  });
  return encoded.endsWith("\n") ? encoded : `${encoded}\n`;
}

function createServiceManifest(
  currentDirectory: string,
  options: { name?: string; description?: string },
): { folder: string; manifestPath: string; name: string; nameSource: "option" | "folder-name" } {
  const folder = resolveServiceFolder(currentDirectory);
  const { name, nameSource } = validateInitServiceOptions(folder, options);

  const ukpDirectory = join(folder, ".ukp");
  const manifestPath = join(ukpDirectory, "service.toml");
  if (existsSync(manifestPath)) {
    throw new Error(`Service Manifest already exists: ${manifestPath}`);
  }

  mkdirSync(ukpDirectory, { recursive: true });
  const descriptor = openSync(manifestPath, "wx", 0o600);
  let committed = false;
  try {
    writeFileSync(descriptor, renderServiceManifest(options), "utf8");
    committed = true;
  } finally {
    closeSync(descriptor);
    if (!committed && existsSync(manifestPath)) unlinkSync(manifestPath);
  }

  try {
    loadManifest(folder);
  } catch (error) {
    if (existsSync(manifestPath)) unlinkSync(manifestPath);
    throw error;
  }

  return { folder, manifestPath, name, nameSource };
}

function executeInitServiceCommand(args: readonly string[], context: InitCommandContext): InitCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderInitServiceHelp(), stderr: "" };
  }

  try {
    const command = createInitServiceCommand();
    parseCommand(command, args);
    const options = command.opts<{ name?: string; description?: string }>();
    const result = createServiceManifest(context.currentDirectory, options);
    return {
      exitCode: 0,
      stdout: [
        `initialized Service: ${result.name}`,
        `name_source: ${result.nameSource}`,
        `manifest: ${result.manifestPath}`,
        `location: ${result.folder}`,
        "capability: search",
        "provider: qmd",
        "next: ukp diagnose",
        "next: ukp register",
      ].join("\n"),
      stderr: "",
    };
  } catch (error) {
    if (error instanceof InitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderServiceUsageError(error.message) };
    }
    return { exitCode: 1, stdout: "", stderr: `error: ${error instanceof Error ? error.message : String(error)}\n` };
  }
}

export function executeInitCommand(args: readonly string[], context: InitCommandContext): InitCommandResult {
  if (args[0] === "service") {
    return executeInitServiceCommand(args.slice(1), context);
  }
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderInitHelp(), stderr: "" };
  }

  try {
    const command = createInitCommand();
    parseCommand(command, args);
    const [target] = command.args;
    if (target !== "service") {
      throw new InitUsageError(`unknown init target '${target}'. Available target: service`);
    }
    return executeInitServiceCommand([], context);
  } catch (error) {
    if (error instanceof InitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderUsageError(error.message) };
    }
    return { exitCode: 1, stdout: "", stderr: `error: ${error instanceof Error ? error.message : String(error)}\n` };
  }
}

export function renderInitHelp(): string {
  return createInitCommand().helpInformation();
}

export function renderInitServiceHelp(): string {
  return createInitServiceCommand().helpInformation() + [
    "Creates .ukp/service.toml with the current minimal search provider:",
    "  [capabilities.search]",
    "  provider = \"qmd\"",
    "",
    "Next:",
    "  ukp guide service",
    "  qmd init",
    "  ukp diagnose",
    "  ukp register",
    "",
  ].join("\n");
}
