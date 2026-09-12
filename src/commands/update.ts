import {
  executeKitCommand,
  parseKitArgs,
  renderKitHelp,
  type KitCommandResult,
  type KitParsed,
  type UkpCommandSpec,
} from "./kit.ts";
import {
  runUpdate,
  renderUpdateHuman,
  type ParsedUpdate,
  type UpdateAggregateStatus,
  type UpdateContext,
} from "../capabilities/update.ts";

export type { UpdateContext } from "../capabilities/update.ts";

/** CLI-owned command result shape (ADR 0021). */
export interface UpdateCommandResult extends KitCommandResult {}

/** Aggregate classification → exit code (ADR 0021). */
const UPDATE_EXIT_BY_AGGREGATE: Record<UpdateAggregateStatus, number> = {
  "succeeded": 0,
  "failed": 1,
  "no-success": 1,
  "cancelled": 130,
};

/** Single-source command spec (ADR 0024 pilot command): `summary` feeds the
 * root help via cli.ts; `usage` feeds both the help header and the
 * usage-error line; the scope family, singleton detection, help-intent
 * triage, and catch chain live in kit.ts. */
export const UPDATE_SPEC: UkpCommandSpec = {
  name: "update",
  summary: "trigger provider-owned Service maintenance",
  group: "operations",
  description: "Trigger provider-owned maintenance for selected Service endpoints.",
  usage: "[--endpoint <name> ... | -g]",
  scope: {
    endpointHelp: "update one endpoint; repeat to update multiple endpoints",
    globalHelp: "update every endpoint in the Host Registry; takes no value",
  },
  helpSuffix: [
    "",
    "Scope:",
    "  With no --endpoint or -g, the workspace default scope applies: the",
    "  Client Config's default endpoints ('ukp inspect' shows the resolved",
    "  scope). Without a Client Config, update needs an explicit scope:",
    "  pass --endpoint <name> or -g. -g selects every endpoint in the Host",
    "  Registry and cannot be combined with --endpoint. Maintenance runs",
    "  the provider's own update step (QMD: 'qmd update'), updating what",
    "  its index covers; the endpoint selector never maps to a provider",
    "  collection.",
    "",
  ].join("\n"),
};

function toParsedUpdate(parsed: KitParsed): ParsedUpdate {
  return {
    options: {
      explicitEndpoints: parsed.scope.explicitEndpoints,
      global: parsed.scope.global,
    },
    warnings: parsed.scope.warnings,
  };
}

export function parseUpdateArgs(args: readonly string[]): ParsedUpdate {
  return toParsedUpdate(parseKitArgs(UPDATE_SPEC, args));
}

/** CLI composition of the structured outcome (ADR 0021); kept as the test
 * entry so suites exercise the exact adapter path the bin takes. */
export function executeUpdate(parsed: ParsedUpdate, context: UpdateContext): UpdateCommandResult {
  const result = runUpdate(parsed, context);
  const view = renderUpdateHuman(result);
  return {
    exitCode: UPDATE_EXIT_BY_AGGREGATE[result.aggregate],
    stdout: view.body,
    stderr: view.diagnostics,
  };
}

export function executeUpdateCommand(args: readonly string[], context: UpdateContext): UpdateCommandResult {
  return executeKitCommand(
    UPDATE_SPEC,
    args,
    (parsed) => executeUpdate(toParsedUpdate(parsed), context),
    {
      scopeErrorHint:
        "Hint: run 'ukp list' to inspect registrations, 'ukp register' from a Service folder to add one, or pass '-g' to explicitly update every registered endpoint.",
    },
  );
}

export function renderUpdateHelp(): string {
  return renderKitHelp(UPDATE_SPEC);
}
