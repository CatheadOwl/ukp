import { CommanderError } from "commander";

export function countFlagOccurrences(args: readonly string[], flag: string): number {
  if (flag.startsWith("--")) {
    return args.filter((argument) => argument === flag || argument.startsWith(`${flag}=`)).length;
  }

  if (!flag.startsWith("-") || flag.length !== 2) {
    return args.filter((argument) => argument === flag).length;
  }

  const shortFlag = flag[1];
  return args.reduce((count, argument) => {
    if (argument === flag) return count + 1;
    if (!argument.startsWith("-") || argument.length <= 2) return count;

    const bundle = argument.slice(1);
    if (!/^[A-Za-z]+$/.test(bundle)) return count;
    if (!bundle.split("").every((character) => character === shortFlag)) return count;
    return count + bundle.length;
  }, 0);
}

export function isHelpRequest(args: readonly string[]): boolean {
  return args.length === 1 && (args[0] === "-h" || args[0] === "--help");
}

/** commander reports help/version intent through exitOverride's
 * CommanderError (codes `commander.help` / `commander.helpDisplayed` /
 * `commander.version`); the `(outputHelp)` message is an internal sentinel,
 * not user-facing text. Options are order-independent, so `--help` must win
 * wherever it appears, and the parse layer must not translate these into
 * usage errors. Call inside an `instanceof CommanderError` guard — a type
 * predicate here would narrow the sibling branch to `never`. */
export function isCommanderHelpIntent(error: CommanderError): boolean {
  return error.code === "commander.help"
    || error.code === "commander.helpDisplayed"
    || error.code === "commander.version";
}

/** Flows from the parse layer (whose configureOutput silencing swallowed
 * commander's own help rendering) to the execute layer, which re-renders
 * help and returns exit 0. */
export class HelpRequestError extends Error {
  constructor() {
    super("help requested");
    this.name = "HelpRequestError";
  }
}
