import {
  runNav,
  projectNavEnvelope,
  renderNavHuman,
  renderNavJson,
  NAV_MAX_DEPTH,
  NavProviderError,
  NavUsageError,
  validateNavRoutePath,
  type NavContext,
  type NavErrorClass,
  type NavRequest,
} from "../capabilities/nav.ts";
import { ScopeError } from "../scope.ts";
import { ManifestError } from "../config/manifest.ts";
import { KitUsageError, parseKitArgs, renderKitHelp, renderKitUsageError, type UkpCommandSpec } from "./kit.ts";
import { HelpRequestError, isHelpRequest } from "./flags.ts";

/** CLI-owned command result shape (ADR 0021: exit codes and channel text
 * belong to the surface adapter, not the capability). */
export interface NavCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Error-class → exit-code mapping (ADR 0021: owned by the CLI adapter per
 * the Capability Contract; every nav failure class is a hard stop today). */
const NAV_EXIT_BY_ERROR_CLASS: Record<NavErrorClass, number> = {
  "no-endpoint": 1,
  "endpoint-name-mismatch": 1,
  "provider-unsupported": 1,
  "route-root-not-found": 1,
  "route-root-not-directory": 1,
};

/** Single-source command spec (ADR 0024): summary feeds the root help via
 * cli.ts; usage feeds the help header and the usage-error line; the
 * single-endpoint family (-c singleton, -g teaching flag, required
 * --endpoint) and help-intent triage live in kit.ts. */
export const NAV_SPEC: UkpCommandSpec = {
  name: "nav",
  summary: "navigate the Markdown structure of an endpoint",
  group: "endpoint",
  description: "Navigate the Markdown structure of one Service endpoint (endpoint names come from 'ukp list').",
  usage: "--endpoint <name> [path] [--depth <n>] [--json]",
  arguments: [
    { name: "path", help: "endpoint-relative route to expand (default: the endpoint root)" },
  ],
  options: [
    {
      flags: "--depth <n>",
      help: "how many directory levels to expand from the route root (0-10, default 0; deeper folders appear as [truncated: N], where N is that folder's total recursive .md count)",
    },
    { flags: "--json", help: "emit the structured response envelope" },
  ],
  singleEndpoint: {
    endpointHelp: "select the endpoint to navigate",
    unsupportedHelp: "not supported by nav; use --endpoint <name>",
  },
};

interface NavCommandOptions extends Record<string, unknown> {
  endpoint?: string;
  depth?: string;
  json?: boolean;
  g?: boolean;
}

export function parseNavArgs(args: readonly string[]): NavRequest {
  const parsed = parseKitArgs<NavCommandOptions>(NAV_SPEC, args);

  // Command-side semantics, pre-kit order: excess positionals, then depth
  // form and range, then route-path lexical validation.
  if (parsed.positionals.length > 1) {
    throw new KitUsageError(
      `unexpected argument '${parsed.positionals[1]}'; nav takes at most one [path] argument`,
    );
  }
  let depth: number | undefined;
  if (parsed.options.depth !== undefined) {
    // Strict decimal form only: Number() would accept "1e1"/"0x2" variants
    // that are almost certainly typos on a 0-10 flag.
    if (!/^\d+$/.test(parsed.options.depth.trim())) {
      throw new KitUsageError("--depth must be a non-negative integer");
    }
    const candidate = Number(parsed.options.depth.trim());
    if (candidate < 0 || candidate > NAV_MAX_DEPTH) {
      throw new KitUsageError(`--depth must be an integer between 0 and ${NAV_MAX_DEPTH}`);
    }
    depth = candidate;
  }
  if (parsed.positionals[0] !== undefined) {
    validateNavRoutePath(parsed.positionals[0]);
  }

  return {
    endpoint: parsed.scope.explicitEndpoints![0],
    ...(parsed.positionals[0] === undefined ? {} : { path: parsed.positionals[0] }),
    ...(depth === undefined ? {} : { depth }),
    json: parsed.options.json === true,
  };
}

export function executeNavCommand(args: readonly string[], context: NavContext): NavCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderNavHelp(), stderr: "" };
  }

  let request: NavRequest;
  try {
    request = parseNavArgs(args);
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderNavHelp(), stderr: "" };
    }
    if (error instanceof KitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderNavUsageError(error.message) };
    }
    throw error;
  }

  try {
    const outcome = runNav(request, context);
    if (!outcome.ok) {
      // Single render source for failures too: the factual message is
      // capability data; only the prefix, exit code, and hint wording are
      // CLI renderings.
      return {
        exitCode: NAV_EXIT_BY_ERROR_CLASS[outcome.failure.errorClass],
        stdout: "",
        stderr: `ukp nav: ${outcome.failure.message}\n`,
      };
    }

    const envelope = projectNavEnvelope(outcome.result);
    // Diagnostics go to stderr in BOTH render modes (read's channel
    // discipline: stdout is the payload, stderr is the operational
    // channel). Without this, a Human-mode budget hit would be silent —
    // violating ADR 0018's loud contract. JSON keeps the diagnostics in
    // the envelope too.
    const diagnosticLines = envelope.diagnostics
      .map((diagnostic) => `ukp nav: ${diagnostic.code}: ${diagnostic.message}`)
      .join("\n");
    return {
      exitCode: 0,
      stdout: request.json ? renderNavJson(envelope) : renderNavHuman(envelope),
      stderr: diagnosticLines.length > 0 ? `${diagnosticLines}\n` : "",
    };
  } catch (error) {
    if (error instanceof NavUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderNavUsageError(error.message) };
    }
    if (error instanceof ScopeError) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `ukp nav: ${error.message}\nRun 'ukp list' to inspect registrations and 'ukp register' from a Service folder, then retry.\n`,
      };
    }
    if (error instanceof ManifestError) {
      return { exitCode: 1, stdout: "", stderr: `ukp nav: ${error.message}\n` };
    }
    if (error instanceof NavProviderError) {
      return { exitCode: 1, stdout: "", stderr: `ukp nav: ${error.message}\n` };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp nav: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

export function renderNavHelp(): string {
  return renderKitHelp(NAV_SPEC);
}

export function renderNavUsageError(message: string): string {
  return renderKitUsageError(NAV_SPEC, message);
}
