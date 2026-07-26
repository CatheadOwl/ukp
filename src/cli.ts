import { homedir } from "node:os";
import { join } from "node:path";
import { executeHumanSearch, parseSearchArgs, SearchUsageError } from "./capabilities/search.ts";
import { diagnoseService, renderDiagnose, type ProviderResolver } from "./commands/diagnose.ts";
import { ENDPOINT_NAME } from "./config/manifest.ts";
import { readRegistry, registerAt, unregisterAt } from "./registry.ts";

export const COMMANDS = [
  ["diagnose", "validate a Service folder"],
  ["register", "register a Service endpoint"],
  ["unregister", "remove a registered endpoint"],
  ["list", "list registered endpoint bindings"],
  ["search", "run atomic lexical search"],
] as const;

export interface CliContext {
  currentDirectory?: string;
  registryPath?: string;
  resolveProvider?: ProviderResolver;
  qmdCommand?: readonly string[];
  artifactRoot?: string;
  artifactRunId?: string;
  now?: Date;
}

export function renderHelp(): string {
  const lines = [
    "Usage: ukp <command> [options]",
    "",
    "Commands:",
    ...COMMANDS.map(([name, description]) => `  ${name.padEnd(10)} ${description}`),
    "",
    "Options:",
    "  -h, --help  show this help",
  ];
  return `${lines.join("\n")}\n`;
}

export function runCli(
  args: readonly string[],
  stdout = console.log,
  stderr = console.error,
  context: CliContext = {},
): number {
  const [command] = args;
  const currentDirectory = context.currentDirectory ?? process.cwd();
  const registryPath = context.registryPath ?? join(homedir(), ".ukp", "registry.toml");

  if (!command || command === "-h" || command === "--help") {
    stdout(renderHelp().trimEnd());
    return 0;
  }

  if (command === "diagnose") {
    if (args.length !== 1) {
      stderr("Usage: ukp diagnose");
      return 2;
    }
    try {
      stdout(renderDiagnose(diagnoseService(currentDirectory, context.resolveProvider)).trimEnd());
      return 0;
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (command === "register") {
    if (args.length !== 1) {
      stderr("Usage: ukp register");
      return 2;
    }
    try {
      const report = diagnoseService(currentDirectory, context.resolveProvider);
      registerAt(registryPath, report.service.effectiveName, report.service.folder);
      stdout(`registered: ${report.service.effectiveName}\nlocation: ${report.service.folder}`);
      return 0;
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (command === "unregister") {
    const name = args[1];
    if (args.length !== 2 || !name || !ENDPOINT_NAME.test(name)) {
      stderr("Usage: ukp unregister <name>");
      return 2;
    }
    try {
      const previous = readRegistry(registryPath).find((binding) => binding.name === name);
      unregisterAt(registryPath, name);
      stdout(`unregistered: ${name}\nlocation: ${previous?.path ?? "unknown"}`);
      return 0;
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (command === "list") {
    if (args.length !== 1) {
      stderr("Usage: ukp list");
      return 2;
    }
    try {
      const endpoints = readRegistry(registryPath);
      stdout(endpoints.length === 0
        ? "No endpoints registered."
        : endpoints.map((endpoint) => `${endpoint.name}\t${endpoint.path}`).join("\n"));
      return 0;
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (command === "search") {
    try {
      const result = executeHumanSearch(parseSearchArgs(args.slice(1)), {
        currentDirectory,
        registryPath,
        qmdCommand: context.qmdCommand,
        artifactRoot: context.artifactRoot,
        artifactRunId: context.artifactRunId,
        now: context.now,
      });
      if (result.stdout) stdout(result.stdout.trimEnd());
      if (result.stderr) stderr(result.stderr.trimEnd());
      return result.exitCode;
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return error instanceof SearchUsageError ? 2 : 1;
    }
  }

  if (COMMANDS.some(([name]) => name === command)) {
    stderr(`ukp ${command}: command implementation is not initialized yet`);
    return 3;
  }

  stderr(`ukp: unknown command '${command}'`);
  stderr("Run 'ukp --help' for usage.");
  return 2;
}

if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2));
}
