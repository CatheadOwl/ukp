import {
  executeKitCommand,
  parseKitArgs,
  renderKitHelp,
  type KitCommandResult,
  type KitParsed,
  type UkpCommandSpec,
} from "./kit.ts";
import {
  runRefresh,
  renderRefreshHuman,
  type ParsedRefresh,
  type RefreshAggregateStatus,
  type RefreshContext,
} from "../capabilities/refresh.ts";

export type { RefreshContext } from "../capabilities/refresh.ts";

/** CLI-owned command result shape (ADR 0021). */
export interface RefreshCommandResult extends KitCommandResult {}

/** Aggregate classification → exit code (ADR 0021). */
const REFRESH_EXIT_BY_AGGREGATE: Record<RefreshAggregateStatus, number> = {
  "succeeded": 0,
  "failed": 1,
  "no-success": 1,
  "cancelled": 130,
};

/** Single-source command spec (ADR 0024 pilot command): `summary` feeds the
 * root help via cli.ts; `usage` feeds both the help header and the
 * usage-error line; the scope family, singleton detection, help-intent
 * triage, and catch chain live in kit.ts. */
export const REFRESH_SPEC: UkpCommandSpec = {
  name: "refresh",
  summary: "trigger provider-owned Service maintenance",
  group: "operations",
  description: "Trigger provider-owned maintenance for selected Service endpoints.",
  usage: "[--endpoint <name> ... | -g]",
  scope: {
    endpointHelp: "refresh one endpoint; repeat to refresh multiple endpoints",
    globalHelp: "refresh every endpoint in the Host Registry; takes no value",
  },
  helpSuffix: [
    "",
    "Scope:",
    "  With no --endpoint or -g, the workspace default scope applies: the",
    "  Client Config's default endpoints ('ukp inspect' shows the resolved",
    "  scope); with no Client Config, every registered endpoint. Maintenance",
    "  itself is provider-owned: the endpoint selector never maps to a",
    "  provider collection.",
    "",
  ].join("\n"),
};

function toParsedRefresh(parsed: KitParsed): ParsedRefresh {
  return {
    options: {
      explicitEndpoints: parsed.scope.explicitEndpoints,
      global: parsed.scope.global,
    },
    warnings: parsed.scope.warnings,
  };
}

export function parseRefreshArgs(args: readonly string[]): ParsedRefresh {
  return toParsedRefresh(parseKitArgs(REFRESH_SPEC, args));
}

/** CLI composition of the structured outcome (ADR 0021); kept as the test
 * entry so suites exercise the exact adapter path the bin takes. */
export function executeRefresh(parsed: ParsedRefresh, context: RefreshContext): RefreshCommandResult {
  const result = runRefresh(parsed, context);
  const view = renderRefreshHuman(result);
  return {
    exitCode: REFRESH_EXIT_BY_AGGREGATE[result.aggregate],
    stdout: view.body,
    stderr: view.diagnostics,
  };
}

export function executeRefreshCommand(args: readonly string[], context: RefreshContext): RefreshCommandResult {
  return executeKitCommand(
    REFRESH_SPEC,
    args,
    (parsed) => executeRefresh(toParsedRefresh(parsed), context),
    {
      scopeErrorHint:
        "Hint: run 'ukp list' to inspect registrations, 'ukp register' from a Service folder to add one, or pass '-g' to explicitly refresh every registered endpoint.",
    },
  );
}

export function renderRefreshHelp(): string {
  return renderKitHelp(REFRESH_SPEC);
}
