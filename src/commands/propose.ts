import {
  runPropose,
  renderProposeHuman,
  renderProposeJson,
  ProposeProviderError,
  ProposeUsageError,
  type ProposeContext,
  type ProposeErrorClass,
  type ProposeRequest,
} from "../capabilities/propose.ts";
import { ScopeError } from "../scope.ts";
import { ManifestError } from "../config/manifest.ts";
import { KitUsageError, parseKitArgs, renderKitHelp, renderKitUsageError, type UkpCommandSpec } from "./kit.ts";
import { HelpRequestError, isHelpRequest } from "./flags.ts";

/** CLI-owned command result shape (ADR 0021). */
export interface ProposeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Error-class → exit-code mapping (ADR 0021). */
const PROPOSE_EXIT_BY_ERROR_CLASS: Record<ProposeErrorClass, number> = {
  "no-endpoint": 1,
  "endpoint-name-mismatch": 1,
  "capability-undeclared": 1,
  "submission-file-unreadable": 1,
};

/** CLI composition of the structured outcome (ADR 0021); kept as the test
 * entry so suites exercise the exact adapter path the bin takes. */
export function executePropose(request: ProposeRequest, context: ProposeContext): ProposeCommandResult {
  const outcome = runPropose(request, context);
  if (!outcome.ok) {
    return {
      exitCode: PROPOSE_EXIT_BY_ERROR_CLASS[outcome.failure.errorClass],
      stdout: "",
      stderr: `ukp propose: ${outcome.failure.message}\n`,
    };
  }
  return {
    exitCode: 0,
    stdout: request.json
      ? renderProposeJson(request.endpoint, outcome.result)
      : renderProposeHuman(outcome.result),
    stderr: "",
  };
}

/** Single-source command spec (ADR 0024): summary feeds the root help via
 * cli.ts; usage feeds the help header and the usage-error line; the
 * single-endpoint family (-c singleton, -g teaching flag, required
 * --endpoint) and help-intent triage live in kit.ts. */
export const PROPOSE_SPEC: UkpCommandSpec = {
  name: "propose",
  summary: "submit an idempotent change proposal",
  group: "endpoint",
  description: "Submit an idempotent change proposal to one Service endpoint.",
  usage: "--endpoint <name> [--id <slug>] --file <path>",
  options: [
    {
      flags: "--id <slug>",
      help: "revision key: resubmitting the same id updates the same proposal (revision +1); defaults to the --file basename (1-63 lowercase ASCII slug), which then becomes the proposal's persistent id — renaming the file creates a new proposal",
    },
    { flags: "--file <path>", help: "read the proposal content from a file (required)" },
    { flags: "--json", help: "emit the structured response envelope" },
  ],
  singleEndpoint: {
    endpointHelp: "select the endpoint that receives the proposal",
    unsupportedHelp: "not supported by propose; use --endpoint <name>",
  },
};

interface ProposeCommandOptions extends Record<string, unknown> {
  endpoint?: string;
  id?: string;
  file?: string;
  json?: boolean;
  g?: boolean;
}

export function parseProposeArgs(args: readonly string[]): ProposeRequest {
  const parsed = parseKitArgs<ProposeCommandOptions>(PROPOSE_SPEC, args);
  const [unexpected] = parsed.positionals;
  if (unexpected !== undefined) {
    throw new KitUsageError(
      `unexpected argument '${unexpected}'; propose reads content from --file <path>, not from an inline argument`,
    );
  }

  return {
    endpoint: parsed.scope.explicitEndpoints![0],
    ...(parsed.options.id === undefined ? {} : { id: parsed.options.id }),
    ...(parsed.options.file === undefined ? {} : { file: parsed.options.file }),
    json: parsed.options.json === true,
  };
}

export function executeProposeCommand(args: readonly string[], context: ProposeContext): ProposeCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderProposeHelp(), stderr: "" };
  }

  try {
    return executePropose(parseProposeArgs(args), context);
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderProposeHelp(), stderr: "" };
    }
    if (error instanceof KitUsageError || error instanceof ProposeUsageError) {
      // ProposeUsageError: capability-side validation (slug form, missing
      // --file) classifies as usage too — same rendering, exit 2.
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
  return renderKitHelp(PROPOSE_SPEC);
}

export function renderProposeUsageError(message: string): string {
  return renderKitUsageError(PROPOSE_SPEC, message);
}
