import { homedir } from "node:os";
import { join } from "node:path";
import {
  executeDiagnoseCommand,
  type ProviderResolver,
} from "./commands/diagnose.ts";
import { executeGuideCommand } from "./commands/guide.ts";
import { executeListCommand, executeRegisterCommand, executeUnregisterCommand } from "./commands/inventory.ts";
import { executeSearchCommand } from "./commands/search.ts";

export { renderSearchHelp } from "./commands/search.ts";
export { renderDiagnoseHelp } from "./commands/diagnose.ts";
export { renderGuideHelp, renderServiceGuide } from "./commands/guide.ts";

export const COMMANDS = [
  ["diagnose", "validate a Service folder or endpoint scope"],
  ["guide", "show short operational guides"],
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

interface CliCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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

function writeCommandResult(
  result: CliCommandResult,
  stdout: (message?: unknown) => void,
  stderr: (message?: unknown) => void,
): number {
  if (result.stdout) stdout(result.stdout.trimEnd());
  if (result.stderr) stderr(result.stderr.trimEnd());
  return result.exitCode;
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
    return writeCommandResult(executeDiagnoseCommand(args.slice(1), {
      currentDirectory,
      registryPath,
      resolveProvider: context.resolveProvider,
    }), stdout, stderr);
  }

  if (command === "guide") {
    return writeCommandResult(executeGuideCommand(args.slice(1)), stdout, stderr);
  }

  if (command === "register") {
    return writeCommandResult(executeRegisterCommand(args.slice(1), {
      currentDirectory,
      registryPath,
      resolveProvider: context.resolveProvider,
    }), stdout, stderr);
  }

  if (command === "unregister") {
    return writeCommandResult(executeUnregisterCommand(args.slice(1), {
      currentDirectory,
      registryPath,
    }), stdout, stderr);
  }

  if (command === "list") {
    return writeCommandResult(executeListCommand(args.slice(1), {
      currentDirectory,
      registryPath,
    }), stdout, stderr);
  }

  if (command === "search") {
    return writeCommandResult(executeSearchCommand(args.slice(1), {
      currentDirectory,
      registryPath,
      qmdCommand: context.qmdCommand,
      artifactRoot: context.artifactRoot,
      artifactRunId: context.artifactRunId,
      now: context.now,
    }), stdout, stderr);
  }

  stderr(`ukp: unknown command '${command}'`);
  stderr("Run 'ukp --help' for usage.");
  return 2;
}

if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2));
}
