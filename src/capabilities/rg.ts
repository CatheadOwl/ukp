import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadManifest } from "../config/manifest.ts";
import { resolveExternalToolCapability, EXTERNAL_PROVIDER } from "../config/external-tool.ts";
import { readRegistry } from "../registry.ts";
import { resolveScope } from "../scope.ts";
import { isInsideRealRoot } from "../path-safety.ts";

// rg capability (ADR-RG-001..004, workunits/ukp_rg): an independent atomic
// capability parallel to `search` — base lexical search over the endpoint's
// own files via ripgrep. Thin shaping only (vision principle 6): UKP owns
// name→cwd resolution, scope boundaries, and output shaping into
// read/file-ready `ukp://` references; rg's own semantics pass through.
// Structured outcome per ADR 0021 — never rendered text, never exit codes.

export interface RgRequest {
  query: string;
  limit: number;
}

export interface RgOptions {
  explicitEndpoints?: string[];
  global: boolean;
  glob?: string;
  type?: string;
  ignoreCase?: boolean;
  count?: boolean;
  /** Validated passthrough args (allowlist + scope protection, ADR-RG-002). */
  passthrough: readonly string[];
  /** Surface concern (propose precedent): the capability never consumes it —
   * the adapter picks the render mode; the outcome is always structured. */
  json?: boolean;
}

export interface ParsedRg {
  request: RgRequest;
  options: RgOptions;
  warnings: string[];
}

export interface RgContext {
  currentDirectory: string;
  registryPath: string;
  rgCommand?: readonly string[];
}

/** ADR 0021 aggregate classification — the adapter maps it onto exit codes;
 * D-036 semantics (skip never changes the success state; a tool failure
 * fails the run; an interrupt is 130). */
export type RgAggregateStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "no-success";

/** One match in the contract zone: endpoint-relative path, optional line,
 * matched-line excerpt, and the durable slot key. `ukp_uri` is emitted only
 * when the path safely resolves inside the Service folder (ADR 0019 stance);
 * rg results are endpoint-local scans so this is the common case. */
export interface RgMatch {
  path: string;
  line?: number;
  text?: string;
  ukp_uri?: string;
}

export interface RgCountEntry {
  path: string;
  count: number;
}

export interface RgEndpointOutcome {
  name: string;
  provider: typeof EXTERNAL_PROVIDER;
  status?:
    | "succeeded"
    | "no_matches"
    | "skipped"
    | "failed"
    /** human mode only: this endpoint's SIGINT stopped the run — its header
     * was already rendered, its block never is. */
    | "interrupted"
    /** not reached because an earlier endpoint was interrupted. */
    | "cancelled";
  /** Factual skip/failure message (no surface prefix). */
  message?: string;
  /** Match mode results (client-side capped at the request limit). */
  matches?: RgMatch[];
  /** Count mode results (`--count`). */
  counts?: RgCountEntry[];
  /** True when matches were truncated at the request limit. */
  truncated?: boolean;
}

export interface RgResult {
  query: string;
  limit: number;
  endpoints: RgEndpointOutcome[];
  warnings: string[];
  aggregate: RgAggregateStatus;
}

export class RgUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RgUsageError";
  }
}

export class RgPlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RgPlanningError";
  }
}

export const RG_DEFAULT_LIMIT = 50;
export const RG_MAX_LIMIT = 1000;

export function defaultRgCommand(): readonly string[] {
  return ["rg"];
}

/** Base-tool availability probe (diagnose / provider resolver): true when a
 * ripgrep executable starts. */
export function rgExecutableAvailable(): boolean {
  const result = spawnSync("rg", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
  return !result.error;
}

export function rgTimeoutMs(): number {
  const raw = process.env.UKP_RG_TIMEOUT_MS;
  if (raw === undefined || raw.length === 0) return 60_000;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 60_000;
}

// ---------------------------------------------------------------------------
// Passthrough validation (ADR-RG-002): allowlist + scope protection.
// ---------------------------------------------------------------------------

/** Value flags consume the next token (or an attached value: `-C2`). */
const PASSTHROUGH_VALUE_FLAGS = new Set(["-A", "-B", "-C", "-m", "--max-count", "-g", "--glob", "-t", "--type", "--max-filesize"]);
const PASSTHROUGH_BOOL_FLAGS = new Set(["-i", "--ignore-case", "-S", "--smart-case", "-s", "--case-sensitive", "-w", "--word-regexp", "-F", "--fixed-strings", "-v", "--invert-match", "-U", "--multiline", "--no-ignore", "--hidden", "--no-messages", "--column", "--no-heading"]);

/** Validates passthrough args: allowlist membership + scope protection.
 * Throws `RgUsageError` naming the rejected token and the reason; returns
 * the validated args unchanged. Exported so the parse layer can fail as
 * exit 2 before any endpoint work starts; the capability re-validates. */
export function validateRgPassthrough(args: readonly string[]): readonly string[] {
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!token.startsWith("-")) {
      throw new RgUsageError(
        `passthrough argument '${token}' is not allowed: rg targets the Service folder — no path operands (use the endpoint selector for scope)`,
      );
    }
    if (PASSTHROUGH_BOOL_FLAGS.has(token)) continue;
    if (PASSTHROUGH_VALUE_FLAGS.has(token)) {
      if (index + 1 >= args.length) {
        throw new RgUsageError(`passthrough flag '${token}' requires a value`);
      }
      index += 1; // consume the value token
      continue;
    }
    if (/^-[ABCm]=/.test(token)) continue; // long-form value on a short flag
    if (/^-[ABCm].+$/.test(token)) continue; // attached value (-C2)
    if (/^--[\w-]+=/.test(token)) {
      const longFlag = token.slice(0, token.indexOf("="));
      if (PASSTHROUGH_VALUE_FLAGS.has(longFlag) || PASSTHROUGH_BOOL_FLAGS.has(longFlag)) continue;
    }
    throw new RgUsageError(
      `passthrough flag '${token}' is not on the rg allowlist (rejected: path operands, output-changing flags such as --json/-r, config/pre filters; the frozen flag set covers the common surface)`,
    );
  }
  return args;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface PlannedEndpoint {
  name: string;
  folder: string;
}

function planRg(parsed: ParsedRg, context: RgContext): { plan: PlannedEndpoint[]; warnings: string[] } {
  const registry = readRegistry(context.registryPath);
  const scope = resolveScope({
    currentDirectory: context.currentDirectory,
    registry,
    explicitEndpoints: parsed.options.explicitEndpoints,
    global: parsed.options.global,
  });
  const warnings = [...parsed.warnings, ...scope.warnings];
  const plan: PlannedEndpoint[] = [];
  for (const binding of scope.bindings) {
    const service = loadManifest(binding.path);
    if (service.effectiveName !== binding.name) {
      throw new RgPlanningError(
        `endpoint '${binding.name}' no longer matches Service effective name '${service.effectiveName}'`,
      );
    }
    // External-tool base tier (ADR-RG-003): rg is effectively present on
    // every registered local Service; the declaration only overrides config.
    resolveExternalToolCapability(service.manifest, "rg");
    plan.push({ name: binding.name, folder: service.folder });
  }
  return { plan, warnings };
}

function encodeUkpUriSegment(segment: string): string {
  return segment.replace(/[%#? ]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** rg reports paths relative to its cwd (the Service folder); normalize
 * separators and shape the durable slot key. */
function toUkpUri(endpointName: string, path: string): string {
  const rel = path.replace(/\\/g, "/");
  return `ukp://${endpointName}/${rel.split("/").map(encodeUkpUriSegment).join("/")}`;
}

/** ADR 0019 emission rule (ADR 0023 / D-073, spec §3): the URI is a slot
 * promise, so it is emitted only when the match path safely resolves inside
 * the Service folder — resolved containment, same stance as search's
 * provider-location mapping. A miss silently drops the `ukp_uri` field
 * (the match and its `path` stay): rg output is tool output, not user
 * error. Output-side filtering is the second line of defense; the
 * passthrough allowlist (no path operands) is the first. */
function ukpUriIfInside(endpointFolder: string, endpointName: string, path: string): string | undefined {
  const absolute = resolve(endpointFolder, ...path.replace(/\\/g, "/").split("/"));
  let folderReal: string;
  let targetReal: string;
  try {
    folderReal = realpathSync(endpointFolder);
    targetReal = realpathSync(absolute);
  } catch {
    return undefined;
  }
  if (!isInsideRealRoot(folderReal, targetReal)) return undefined;
  return toUkpUri(endpointName, path);
}

interface RgJsonEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
}

function rgToolArgs(parsed: ParsedRg): string[] {
  const args: string[] = ["--no-heading", "--no-messages"];
  if (parsed.options.count) {
    args.push("--count");
  } else {
    args.push("--json");
  }
  if (parsed.options.ignoreCase) args.push("-i");
  if (parsed.options.glob !== undefined) args.push("--glob", parsed.options.glob);
  if (parsed.options.type !== undefined) args.push("--type", parsed.options.type);
  args.push(...parsed.options.passthrough);
  args.push("-e", parsed.request.query);
  return args;
}

/** Runs the rg capability and returns the structured outcome. Scope and
 * planning failures throw typed errors (`RgUsageError`, `RgPlanningError`,
 * `ScopeError`, `ManifestError`) for the surface adapter to map. */
export function runRg(parsed: ParsedRg, context: RgContext): RgResult {
  validateRgPassthrough(parsed.options.passthrough);
  const { plan, warnings } = planRg(parsed, context);
  const command = context.rgCommand ?? defaultRgCommand();
  const endpoints: RgEndpointOutcome[] = [];
  let succeeded = false;
  let failed = false;
  let interrupted = false;

  for (const endpoint of plan) {
    const outcome: RgEndpointOutcome = { name: endpoint.name, provider: EXTERNAL_PROVIDER };
    endpoints.push(outcome);
    if (interrupted) {
      outcome.status = "cancelled";
      continue;
    }

    const result = spawnSync(command[0]!, [...command.slice(1), ...rgToolArgs(parsed)], {
      cwd: endpoint.folder,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: rgTimeoutMs(),
    });

    if (result.error) {
      // ADR-RG-003/R-7: a missing base tool is a degradation, not a fault —
      // skipped + warning, the run continues with other endpoints.
      warnings.push(`endpoint '${endpoint.name}' rg unavailable: rg executable is not available`);
      outcome.status = "skipped";
      outcome.message = "rg executable is not available";
      continue;
    }
    if (result.signal === "SIGTERM") {
      failed = true;
      const message = `endpoint '${endpoint.name}' rg timed out after ${rgTimeoutMs() / 1000}s (set UKP_RG_TIMEOUT_MS to adjust)`;
      warnings.push(message);
      outcome.status = "failed";
      outcome.message = `rg timed out after ${rgTimeoutMs() / 1000}s`;
      continue;
    }
    if (result.signal === "SIGINT" || result.status === 130) {
      warnings.push(`endpoint '${endpoint.name}' rg cancelled`);
      outcome.status = "interrupted";
      interrupted = true;
      continue;
    }
    if (result.status !== 0 && result.status !== 1) {
      // rg exits 1 for "no matches" (a result, not a failure); anything else
      // is a tool failure.
      failed = true;
      const detail = (result.stderr ?? "").trim().split(/\r?\n/).find((line) => line.length > 0);
      warnings.push(`endpoint '${endpoint.name}' rg failed${detail ? `: ${detail}` : ""}`);
      outcome.status = "failed";
      outcome.message = detail ?? `rg exited with status ${result.status}`;
      continue;
    }

    if (parsed.options.count) {
      const counts: RgCountEntry[] = [];
      for (const line of (result.stdout ?? "").split(/\r?\n/)) {
        if (line.length === 0) continue;
        const separator = line.lastIndexOf(":");
        if (separator <= 0) continue;
        const count = Number(line.slice(separator + 1));
        if (!Number.isSafeInteger(count)) continue;
        counts.push({ path: line.slice(0, separator).replace(/\\/g, "/"), count });
      }
      if (counts.length === 0) {
        succeeded = true; // no matches is a successful result (D-036 stance)
        outcome.status = "no_matches";
      } else {
        succeeded = true;
        outcome.status = "succeeded";
        outcome.counts = counts;
      }
      continue;
    }

    const matches: RgMatch[] = [];
    let truncated = false;
    for (const line of (result.stdout ?? "").split(/\r?\n/)) {
      if (line.length === 0) continue;
      let event: RgJsonEvent;
      try {
        event = JSON.parse(line) as RgJsonEvent;
      } catch {
        continue;
      }
      if (event.type !== "match") continue;
      if (matches.length >= parsed.request.limit) {
        truncated = true;
        break;
      }
      const path = event.data?.path?.text;
      if (typeof path !== "string" || path.length === 0) continue;
      const entry: RgMatch = { path: path.replace(/\\/g, "/") };
      const lineNumber = event.data?.line_number;
      if (Number.isSafeInteger(lineNumber) && (lineNumber as number) > 0) entry.line = lineNumber;
      const text = event.data?.lines?.text;
      if (typeof text === "string") {
        const firstLine = text.split(/\r?\n/)[0] ?? "";
        if (firstLine.length > 0) entry.text = firstLine.length > 240 ? `${firstLine.slice(0, 240)}...` : firstLine;
      }
      const uri = ukpUriIfInside(endpoint.folder, endpoint.name, entry.path);
      if (uri !== undefined) entry.ukp_uri = uri;
      matches.push(entry);
    }
    if (matches.length === 0 && !truncated) {
      // No matches is a successful result (search precedent D-036: a
      // no-match endpoint never fails the run).
      succeeded = true;
      outcome.status = "no_matches";
    } else {
      succeeded = true;
      outcome.status = "succeeded";
      outcome.matches = matches;
      if (truncated) outcome.truncated = true;
    }
  }

  return {
    query: parsed.request.query,
    limit: parsed.request.limit,
    endpoints,
    warnings,
    aggregate: interrupted
      ? "cancelled"
      : failed
        ? "failed"
        : succeeded
          ? "succeeded"
          : "no-success",
  };
}

// ---------------------------------------------------------------------------
// Presentation (ADR 0021 two-stage form, surface-neutral view).
// ---------------------------------------------------------------------------

export interface RgEnvelope {
  schema: "ukp.rg.v1";
  command: "rg";
  capability: "rg";
  query: string;
  limit: number;
  count_mode: boolean;
  endpoints: Array<{
    name: string;
    provider: string;
    status: string;
    match_count?: number;
    truncated?: boolean;
    message?: string;
    matches?: RgMatch[];
    counts?: RgCountEntry[];
  }>;
  warnings: string[];
}

export function projectRgEnvelope(result: RgResult, countMode: boolean): RgEnvelope {
  return {
    schema: "ukp.rg.v1",
    command: "rg",
    capability: "rg",
    query: result.query,
    limit: result.limit,
    count_mode: countMode,
    endpoints: result.endpoints.map((endpoint) => ({
      name: endpoint.name,
      provider: endpoint.provider,
      status: endpoint.status ?? "failed",
      ...(endpoint.matches !== undefined ? { match_count: endpoint.matches.length, matches: endpoint.matches } : {}),
      ...(endpoint.counts !== undefined ? { counts: endpoint.counts } : {}),
      ...(endpoint.truncated !== undefined ? { truncated: endpoint.truncated } : {}),
      ...(endpoint.message !== undefined ? { message: endpoint.message } : {}),
    })),
    warnings: result.warnings,
  };
}

export interface RgHumanView {
  body: string;
  diagnostics: string;
}

export function renderRgHuman(result: RgResult): RgHumanView {
  const lines: string[] = [];
  for (const endpoint of result.endpoints) {
    if (endpoint.status === "skipped" || endpoint.status === "cancelled") continue;
    if (lines.length > 0) lines.push("");
    lines.push(`== ${endpoint.name} ==`);
    if (endpoint.status === "interrupted") break;
    if (endpoint.status === "failed") {
      lines.push(`status: failed${endpoint.message ? `: ${endpoint.message}` : ""}`);
      continue;
    }
    if (endpoint.status === "no_matches") {
      lines.push("(no matches)");
      continue;
    }
    if (endpoint.counts !== undefined) {
      for (const entry of endpoint.counts) lines.push(`${entry.path}: ${entry.count}`);
      if (endpoint.truncated) lines.push("(truncated at the result limit)");
      continue;
    }
    let unitIndex = 1;
    for (const match of endpoint.matches ?? []) {
      if (unitIndex > 1) lines.push("");
      const identity = match.line !== undefined ? `${match.path}:${match.line}` : match.path;
      lines.push(`${unitIndex}. ${identity}`);
      if (match.text !== undefined) lines.push(`   ${match.text.replace(/\n/g, "\n   ")}`);
      if (match.ukp_uri !== undefined) {
        const fragment = match.line !== undefined ? `#L${match.line}` : "";
        lines.push(`   uri: ${match.ukp_uri}${fragment}`);
      }
      unitIndex += 1;
    }
    if (endpoint.truncated) lines.push(`(truncated at the result limit ${result.limit}; raise --limit)`);
  }
  return {
    body: lines.length > 0 ? `${lines.join("\n")}\n` : "",
    diagnostics: result.warnings.length > 0 ? `${result.warnings.join("\n")}\n` : "",
  };
}
