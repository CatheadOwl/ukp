import { Command, CommanderError } from "commander";
import {
  executePropose,
  ProposeProviderError,
  ProposeUsageError,
  type ProposeContext,
  type ProposeRequest,
  type ProposeCommandResult,
} from "../capabilities/propose.ts";
import { ScopeError } from "../scope.ts";
import { ManifestError } from "../config/manifest.ts";
import { countFlagOccurrences, isHelpRequest } from "./flags.ts";

function createProposeCommand(): Command {
  return new Command("ukp propose")
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(true)
    .helpOption("-h, --help", "show this help")
    .usage("--endpoint <name> [--id <slug>] --file <path>")
    .description("Submit an idempotent change proposal to one Service endpoint.")
    .option("-c, --endpoint <name>", "select the endpoint that receives the proposal")
    .option("--id <slug>", "proposal identity (1-63 lowercase ASCII slug; defaults to the --file basename)")
    .option("--file <path>", "read the proposal content from a file (required)")
    .option("--json", "emit the structured response envelope")
    .option("-g", "not supported by propose; use --endpoint <name>");
}

function parseProposeCommand(args: readonly string[]): {
  positionals: string[];
  endpoint?: string;
  id?: string;
  file?: string;
  json: boolean;
  global?: boolean;
} {
  const command = createProposeCommand()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new ProposeUsageError(error.message.replace(/^error: /, ""));
    }
    throw error;
  }

  const options = command.opts<{
    endpoint?: string;
    id?: string;
    file?: string;
    json?: boolean;
    g?: boolean;
  }>();
  return {
    positionals: command.args,
    endpoint: options.endpoint,
    id: options.id,
    file: options.file,
    json: options.json === true,
    global: options.g,
  };
}

export function parseProposeArgs(args: readonly string[]): ProposeRequest {
  const parsed = parseProposeCommand(args);
  const [unexpected] = parsed.positionals;

  if (countFlagOccurrences(args, "--endpoint") + countFlagOccurrences(args, "-c") > 1) {
    throw new ProposeUsageError("--endpoint may only be specified once");
  }
  if (countFlagOccurrences(args, "--id") > 1) throw new ProposeUsageError("--id may only be specified once");
  if (countFlagOccurrences(args, "--file") > 1) throw new ProposeUsageError("--file may only be specified once");
  if (parsed.global) throw new ProposeUsageError("propose requires --endpoint <name> and does not support -g");
  if (parsed.endpoint === undefined || parsed.endpoint.length === 0) {
    throw new ProposeUsageError("propose requires --endpoint <name>");
  }
  if (unexpected !== undefined) {
    throw new ProposeUsageError(
      `unexpected argument '${unexpected}'; propose reads content from --file <path>, not from an inline argument`,
    );
  }

  return {
    endpoint: parsed.endpoint,
    ...(parsed.id === undefined ? {} : { id: parsed.id }),
    ...(parsed.file === undefined ? {} : { file: parsed.file }),
    json: parsed.json,
  };
}

export function executeProposeCommand(args: readonly string[], context: ProposeContext): ProposeCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderProposeHelp(), stderr: "" };
  }

  try {
    return executePropose(parseProposeArgs(args), context);
  } catch (error) {
    if (error instanceof ProposeUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderProposeUsageError(error.message) };
    }
    if (error instanceof ScopeError) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `ukp propose: ${error.message}\nRun 'ukp list' to inspect registrations and 'ukp register' from a Service folder, then retry.\n`,
      };
    }
    if (error instanceof ManifestError) {
      return { exitCode: 1, stdout: "", stderr: `ukp propose: ${error.message}\n` };
    }
    if (error instanceof ProposeProviderError) {
      return { exitCode: 1, stdout: "", stderr: `ukp propose: ${error.message}\n` };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp propose: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

export function renderProposeHelp(): string {
  return createProposeCommand().helpInformation();
}

export function renderProposeUsageError(message: string): string {
  return [
    `ukp propose: ${message}`,
    "Usage: ukp propose --endpoint <name> [--id <slug>] --file <path>",
    "Run 'ukp propose --help' for details.",
  ].join("\n");
}
