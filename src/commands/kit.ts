import { Command, CommanderError } from "commander";
import { countFlagOccurrences, HelpRequestError, isCommanderHelpIntent, isHelpRequest } from "./flags.ts";
import { ScopeError } from "../scope.ts";

/** CLI-owned command result shape (ADR 0021; same fields every command
 * result already carries). */
export interface KitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Usage error surfaced by kit parsing (commander translation, generated
 * singleton detection, scope family rules). Exit 2 at the adapter. */
export class KitUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KitUsageError";
  }
}

/** Option declaration. Non-multi options get generated singleton duplicate
 * detection (replaces per-command countFlagOccurrences if-chains). */
export interface KitOptionSpec {
  flags: string;
  help: string;
  /** repeat-to-collect (append semantics); default singleton */
  multi?: boolean;
}

/** Command spec — the single source for everything the family rules render
 * (ADR 0024). `usage` omits the leading "ukp <name> ": the help header and
 * the usage-error line both prepend it, from this one string. */
export interface UkpCommandSpec {
  name: string;
  /** root-help one-liner; feeds COMMAND_DESCRIPTIONS once cli.ts is wired */
  summary: string;
  group: "endpoint" | "registry" | "operations" | "help";
  description: string;
  usage: string;
  arguments?: Array<{ name: string; help: string; required?: boolean }>;
  options?: KitOptionSpec[];
  /** -c/--endpoint (repeat-multi) + -g family: mutual exclusion, duplicate
   * endpoint warnings, generated -g singleton detection. Commands with
   * `scope` and no `arguments` reject positionals with the family message. */
  scope?: {
    endpointHelp: string;
    globalHelp: string;
  };
  /** pre-wrapped extra section appended verbatim to --help */
  helpSuffix?: string;
}

function collectValues(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function flagSpellings(flags: string): { long?: string; short?: string } {
  let long: string | undefined;
  let short: string | undefined;
  for (const token of flags.split(",").map((part) => part.trim())) {
    if (token.startsWith("--")) long = token.split(/\s+/)[0];
    else if (token.startsWith("-")) short = token.split(/\s+/)[0];
  }
  return { long, short };
}

/** Generated singleton detection: every declared non-multi option (plus the
 * scope family's -g) may appear exactly once, counting short/long spellings
 * and bundled short forms together. The error names the canonical spelling
 * (long preferred), matching the pre-kit messages. */
function assertSingletonFlags(spec: UkpCommandSpec, args: readonly string[]): void {
  const declarations: string[] = [
    ...(spec.options ?? []).filter((option) => !option.multi).map((option) => option.flags),
    ...(spec.scope ? ["-g"] : []),
  ];
  for (const flags of declarations) {
    const { long, short } = flagSpellings(flags);
    const occurrences = (long === undefined ? 0 : countFlagOccurrences(args, long))
      + (short === undefined ? 0 : countFlagOccurrences(args, short));
    if (occurrences > 1) {
      throw new KitUsageError(`${long ?? short} may only be specified once`);
    }
  }
}

export function createKitCommand(spec: UkpCommandSpec): Command {
  const command = new Command(`ukp ${spec.name}`)
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(true)
    .helpOption("-h, --help", "show this help")
    .usage(spec.usage)
    .description(spec.description);
  for (const option of spec.options ?? []) {
    if (option.multi) command.option(option.flags, option.help, collectValues);
    else command.option(option.flags, option.help);
  }
  if (spec.scope) {
    command.option("-c, --endpoint <name>", spec.scope.endpointHelp, collectValues);
    command.option("-g", spec.scope.globalHelp);
  }
  return command;
}

export interface KitScopeSelection {
  explicitEndpoints?: string[];
  global: boolean;
  warnings: string[];
}

export interface KitParsed<Options extends Record<string, unknown> = Record<string, unknown>> {
  positionals: string[];
  options: Options;
  scope: KitScopeSelection;
}

/** Family parse pipeline, order-matched to the pre-kit commands: commander
 * errors first (unknown option…), then generated singleton detection, then
 * positional rejection, then duplicate-endpoint warnings, then the
 * `--endpoint`/`-g` conflict. Help/version intent surfaces as
 * HelpRequestError for the execute layer to re-render. */
export function parseKitArgs<Options extends Record<string, unknown> = Record<string, unknown>>(
  spec: UkpCommandSpec,
  args: readonly string[],
): KitParsed<Options> {
  const command = createKitCommand(spec)
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (isCommanderHelpIntent(error)) throw new HelpRequestError();
      throw new KitUsageError(error.message.replace(/^error: /, ""));
    }
    throw error;
  }

  assertSingletonFlags(spec, args);

  const options = command.opts<Options>();
  const positionals = command.args;
  if (!spec.scope) {
    return { positionals, options, scope: { global: false, warnings: [] } };
  }

  if (spec.arguments === undefined && positionals.length > 0) {
    throw new KitUsageError(
      `unexpected argument '${positionals[0]}'. Use '--endpoint <name>' to select an endpoint; '-g' takes no value.`,
    );
  }

  const explicit: string[] = [];
  const warnings: string[] = [];
  for (const endpoint of (options as { endpoint?: string[] }).endpoint ?? []) {
    if (explicit.includes(endpoint)) warnings.push(`duplicate endpoint '${endpoint}' ignored`);
    else explicit.push(endpoint);
  }
  const global = (options as { g?: boolean }).g === true;
  if (global && explicit.length > 0) {
    throw new KitUsageError("--endpoint and -g cannot be used together");
  }

  return {
    positionals,
    options,
    scope: {
      explicitEndpoints: explicit.length > 0 ? explicit : undefined,
      global,
      warnings,
    },
  };
}

export function renderKitHelp(spec: UkpCommandSpec): string {
  const base = createKitCommand(spec).helpInformation();
  return spec.helpSuffix === undefined ? base : base + spec.helpSuffix;
}

export function renderKitUsageError(spec: UkpCommandSpec, message: string): string {
  return [
    `ukp ${spec.name}: ${message}`,
    `Usage: ukp ${spec.name} ${spec.usage}`,
    `Run 'ukp ${spec.name} --help' for details.`,
  ].join("\n");
}

/** Family execute pipeline: sole-arg help, HelpRequestError re-render,
 * KitUsageError → exit 2 with the single-source usage line, ScopeError →
 * exit 1 with the command's recovery hint, fallback → exit 1. */
export function executeKitCommand(
  spec: UkpCommandSpec,
  args: readonly string[],
  run: (parsed: KitParsed) => KitCommandResult,
  recovery: { scopeErrorHint?: string } = {},
): KitCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderKitHelp(spec), stderr: "" };
  }

  try {
    return run(parseKitArgs(spec, args));
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderKitHelp(spec), stderr: "" };
    }
    if (error instanceof KitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderKitUsageError(spec, error.message) };
    }
    if (error instanceof ScopeError) {
      const hint = recovery.scopeErrorHint === undefined ? "" : `\n${recovery.scopeErrorHint}`;
      return { exitCode: 1, stdout: "", stderr: `ukp ${spec.name}: ${error.message}${hint}\n` };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp ${spec.name}: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}
