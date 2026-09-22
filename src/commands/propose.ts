import {
  runPropose,
  renderProposeHuman,
  renderProposeJson,
  proposalIdOf,
  readSubmissionFile,
  ProposeProviderError,
  ProposeUsageError,
  type ProposeContext,
  type ProposeErrorClass,
  type ProposeFailure,
  type ProposeRequest,
} from "../capabilities/propose.ts";
import {
  fetchDiscoveryDocument,
  openRemoteTransport,
  remotePropose,
  resolveRemoteToken,
  type RemoteTransportHandle,
} from "../capabilities/remote-client.ts";
import { isRemoteBinding, readRegistry, type RegistryBinding } from "../registry.ts";
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
  "provider-unsupported": 1,
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
  summary: "submit an idempotent change proposal (the write path into a Service)",
  group: "endpoint",
  description: "Submit an idempotent change proposal to one Service endpoint (endpoint names come from 'ukp list').",
  usage: "--endpoint <name> [--id <slug>] --file <path>",
  options: [
    {
      flags: "--id <slug>",
      help: "revision key: resubmitting the same id updates the same proposal (revision +1); 1-63 lowercase ASCII slug (enforced for explicit ids and the default alike); defaults to the --file basename, which then becomes the proposal's persistent id - renaming the file creates a new proposal",
    },
    { flags: "--file <path>", help: "read the proposal content from a file (required)" },
    { flags: "--json", help: "emit the structured response envelope" },
  ],
  singleEndpoint: {
    endpointHelp: "select the endpoint that receives the proposal",
    unsupportedHelp: "not supported by propose; use --endpoint <name>",
  },
  helpSuffix: [
    "",
    "Lifecycle:",
    "  Submitted proposals land in the Service's proposal folder (default",
    "  'inbox') for the Service owner to adjudicate; there is no",
    "  accept/reject command yet. Resubmitting the same id revises the same",
    "  proposal ('ukp guide propose' covers the model).",
    "",
  ].join("\n"),
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

export function executeProposeCommand(
  args: readonly string[],
  context: ProposeContext,
): ProposeCommandResult | Promise<ProposeCommandResult> {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderProposeHelp(), stderr: "" };
  }

  try {
    const request = parseProposeArgs(args);
    // Remote branch (ukp_remote W8): a remote binding routes through the
    // remote transport; the sync local contract is unchanged
    // (conditional-async seam, same as nav). The id resolves here so usage
    // violations classify identically to the local path.
    const id = proposalIdOf(request);
    const binding = readRegistry(context.registryPath).find((entry) => entry.name === request.endpoint);
    if (binding !== undefined && isRemoteBinding(binding)) {
      return executeRemotePropose(request, id, binding, context);
    }
    return executePropose(request, context);
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

function remoteTokenHint(endpointName: string): string {
  return `endpoint '${endpointName}' requires a bearer token; set UKP_ENDPOINT_${endpointName.toUpperCase().replace(/-/g, "_")}_TOKEN`;
}

/** Failure rendering identical to the sync path's outcome branch, with the
 * remote-phase warnings appended to stderr. */
function proposeFailureResult(failure: ProposeFailure, warnings: readonly string[]): ProposeCommandResult {
  const stderr = [`ukp propose: ${failure.message}`, ...warnings];
  return { exitCode: PROPOSE_EXIT_BY_ERROR_CLASS[failure.errorClass], stdout: "", stderr: `${stderr.join("\n")}\n` };
}

/** Wire error class → ProposeErrorClass. capability-undeclared is the same
 * vocabulary on both sides and passes through; everything transport-shaped
 * (auth 401, identity, route miss on an older serve, unreachable, wire
 * guards) folds into provider-unsupported with the specifics preserved in
 * the message (W8 mapping, mirroring nav's W6). */
function mapRemoteProposeErrorClass(errorClass: string | undefined): ProposeErrorClass {
  if (errorClass === "capability-undeclared") return "capability-undeclared";
  return "provider-unsupported";
}

/** PUT /v1/propose/{id} over the wire (ADR-REM-005); the wire envelope IS
 * the local envelope, so the shared renderers finish the job with zero
 * output divergence. */
async function executeRemotePropose(
  request: ProposeRequest,
  id: string,
  binding: RegistryBinding,
  context: ProposeContext,
): Promise<ProposeCommandResult> {
  const submission = readSubmissionFile(request.file!, context.currentDirectory);
  if ("failure" in submission) {
    return proposeFailureResult(submission.failure, []);
  }

  const token = resolveRemoteToken(binding);
  const warnings: string[] = [];
  let transport: RemoteTransportHandle | undefined;
  try {
    transport = await openRemoteTransport(binding, { registryPath: context.registryPath });
    const discovery = await fetchDiscoveryDocument(binding, transport, token);
    warnings.push(...discovery.warnings);
    if (discovery.bearerRequired && token === undefined) warnings.push(remoteTokenHint(binding.name));
  } catch (error) {
    transport?.close();
    return proposeFailureResult(
      { errorClass: "provider-unsupported", message: error instanceof Error ? error.message : String(error) },
      warnings,
    );
  }

  let result;
  try {
    result = await remotePropose(transport, token, id, submission.content);
  } catch (error) {
    return proposeFailureResult(
      { errorClass: "provider-unsupported", message: error instanceof Error ? error.message : String(error) },
      warnings,
    );
  } finally {
    transport.close();
  }
  if (result.ok && result.result !== undefined) {
    return {
      exitCode: 0,
      stdout: request.json
        ? renderProposeJson(request.endpoint, result.result)
        : renderProposeHuman(result.result),
      stderr: warnings.length > 0 ? `${warnings.join("\n")}\n` : "",
    };
  }
  return proposeFailureResult(
    {
      errorClass: mapRemoteProposeErrorClass(result.errorClass),
      message: result.errorMessage ?? `remote propose failed (status ${result.status})`,
    },
    warnings,
  );
}

export function renderProposeHelp(): string {
  return renderKitHelp(PROPOSE_SPEC);
}

export function renderProposeUsageError(message: string): string {
  return renderKitUsageError(PROPOSE_SPEC, message);
}
