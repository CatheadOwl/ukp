import { Command, CommanderError } from "commander";
import {
  executeGet,
  GetUsageError,
  type GetContext,
  type GetRequest,
  type GetResult,
  type LineRange,
} from "../capabilities/get.ts";
import { ScopeError } from "../scope.ts";
import { countFlagOccurrences, isHelpRequest } from "./flags.ts";

function createGetCommand(): Command {
  return new Command("ukp get")
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(true)
    .helpOption("-h, --help", "show this help")
    .usage("--endpoint <name> <path> [--lines <start[:count]>]")
    .description("Read an endpoint-relative resource from one Service endpoint.")
    .argument("[path]", "endpoint-relative resource path")
    .option("-c, --endpoint <name>", "select the endpoint that owns the resource")
    .option("-g", "not supported by get; use --endpoint <name>")
    .option("--lines <start[:count]>", "read a 1-based text line window");
}

function parseLineRange(value: string): LineRange {
  const match = /^([0-9]+)(?::([0-9]+))?$/.exec(value);
  if (!match) throw new GetUsageError("--lines must use <start[:count]> with decimal integers");
  const start = Number(match[1]);
  const count = match[2] === undefined ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(start) || start < 1) {
    throw new GetUsageError("--lines start must be a positive integer");
  }
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 1)) {
    throw new GetUsageError("--lines count must be a positive integer");
  }
  return count === undefined ? { start } : { start, count };
}

function parseGetCommand(args: readonly string[]): {
  positionals: string[];
  endpoint?: string;
  global?: boolean;
  lines?: string;
} {
  const command = createGetCommand()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new GetUsageError(error.message.replace(/^error: /, ""));
    }
    throw error;
  }

  const options = command.opts<{
    endpoint?: string;
    g?: boolean;
    lines?: string;
  }>();
  return {
    positionals: command.args,
    endpoint: options.endpoint,
    global: options.g,
    lines: options.lines,
  };
}

export function parseGetArgs(args: readonly string[]): GetRequest {
  const parsed = parseGetCommand(args);
  const [path, unexpected] = parsed.positionals;

  if (countFlagOccurrences(args, "--endpoint") + countFlagOccurrences(args, "-c") > 1) {
    throw new GetUsageError("--endpoint may only be specified once");
  }
  if (countFlagOccurrences(args, "--lines") > 1) throw new GetUsageError("--lines may only be specified once");
  if (parsed.global) throw new GetUsageError("get requires --endpoint <name> and does not support -g");
  if (parsed.endpoint === undefined || parsed.endpoint.length === 0) {
    throw new GetUsageError("get requires --endpoint <name>");
  }
  if (path === undefined || path.length === 0) {
    throw new GetUsageError("get path must be a non-empty endpoint-relative path");
  }
  if (unexpected !== undefined) {
    throw new GetUsageError(
      `unexpected argument '${unexpected}'; get accepts exactly one path. Use '--endpoint <name>' to select an endpoint.`,
    );
  }

  return {
    endpoint: parsed.endpoint,
    path,
    ...(parsed.lines === undefined ? {} : { lines: parseLineRange(parsed.lines) }),
  };
}

export function executeGetCommand(args: readonly string[], context: GetContext): GetResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderGetHelp(), stderr: "" };
  }

  try {
    return executeGet(parseGetArgs(args), context);
  } catch (error) {
    if (error instanceof GetUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderGetUsageError(error.message) };
    }
    if (error instanceof ScopeError) {
      return { exitCode: 1, stdout: "", stderr: `ukp get: ${error.message}\n` };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp get: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

export function renderGetHelp(): string {
  return createGetCommand().helpInformation();
}

export function renderGetUsageError(message: string): string {
  return [
    `ukp get: ${message}`,
    "Usage: ukp get --endpoint <name> <path> [--lines <start[:count]>]",
    "Run 'ukp get --help' for details.",
  ].join("\n");
}
