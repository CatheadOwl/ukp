import { realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_FILES,
  builtinDescriptionProvider,
  scanStructure,
  type NavNode,
  type ResolvedScanOptions,
  type ScanDiagnostic,
} from "@any-nav/scan";
import { loadManifest, type ManifestCapability } from "../config/manifest.ts";
import { resolveFileNativeCapability, unsupportedFileNativeProviderMessage } from "../config/file-native.ts";
import { localPathOf, readRegistry } from "../registry.ts";
import { resolveScope } from "../scope.ts";
import { isInsideRealRoot, splitEndpointRelativeSegments } from "../path-safety.ts";

// Nav capability: file provider whose scan engine is delegated to
// `@any-nav/scan` (W2 / N3 re-ruling, 2026-10-22). The design stance is
// provider-owned visibility: the exclusion rules below are the file
// provider's own visibility contract — the caller can never override them
// from the command surface (path/depth/format only). The engine owns the
// walk (gitignore inheritance, dot/exclusion floors, .md-only pruning,
// budget counting); UKP owns addressing, the route-root/depth projection,
// the entry window and the ukp.nav.v1 envelope.

/** Safety cap on listed route entries (owner R6 问1 = A1, 2026-10-22): the
 * structure walk sees everything, then this UKP projection window cuts —
 * loud via `max-entries-reached`, same diagnostic shape as the native
 * implementation, agent contract unchanged. */
export const NAV_MAX_ENTRIES = 2000;

/** Terminal scan budget for the structure walk (owner R6 问2 = B1,
 * 2026-10-22): `ResolvedScanOptions.maxFiles` is a required number with no
 * "unlimited" sentinel (≤0 caps instantly), so a high terminal value is the
 * practical-unbounded form — counts stay exact on every realistic corpus.
 * If it ever binds, the engine's consumer diagnostics disclose the floor
 * counts (never a silent cut). */
export const NAV_SCAN_MAX_FILES = 1_000_000;

/** Provider-side scan options resolved from the capability declaration:
 * engine terminal values (whole-set replacement — R4/R5), dot entries and
 * gitignore always on, budget per NAV_SCAN_MAX_FILES. */
export function resolveNavScanOptions(capability: ManifestCapability): ResolvedScanOptions {
  const config = capability.config ?? {};
  if (Object.hasOwn(config, "max_description_files")) {
    throw new NavProviderError(
      "nav config 'max_description_files' is retired (owner R6 问3 = C1, 2026-10-22): "
        + "the description budget collapsed into the entry window — remove the key",
    );
  }
  return {
    excludeDirs: parseStringList(config, "exclude_dirs") ?? DEFAULT_EXCLUDE_DIRS,
    excludeFiles: parseStringList(config, "exclude_files") ?? DEFAULT_EXCLUDE_FILES,
    excludeDotEntries: true,
    respectGitignore: true,
    maxFiles: NAV_SCAN_MAX_FILES,
  };
}

function parseStringList(config: Record<string, unknown>, key: string): string[] | undefined {
  const raw = config[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new NavProviderError(`nav config '${key}' must be an array of non-empty strings`);
  }
  return raw as string[];
}

export interface NavEntry {
  /** Endpoint-relative route path, forward slashes. Files keep their `.md`
   * suffix so the path is directly consumable by `ukp read`. */
  path: string;
  kind: "file" | "folder";
  description: string | null;
  /** Depth-boundary folders only: `true` with `omittedMarkdownCount`. */
  truncated?: boolean;
  /** Recursive `.md` total under a truncated folder (exclusions applied). */
  omittedMarkdownCount?: number;
  /** Truncated folder entries only: the representative README child's
   * endpoint-relative POSIX path, mapped verbatim from the engine's
   * `NavNode.markdown` — present iff that README is in the tree (W2 问 4
   * restoration, 2026-10-31; zero derivation at the projection layer). */
  markdown?: string;
}

export interface NavDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface NavResult {
  endpoint: string;
  /** Route root the depth window was computed from ("." = endpoint root). */
  root: string;
  depth: number;
  entries: NavEntry[];
  routeCount: number;
  diagnostics: NavDiagnostic[];
  /** Maintainer-audience findings (owner R6 问5 = E1, 2026-10-22): engine
   * audience triage — these never enter the ukp.nav.v1 envelope; the human
   * face renders them to stderr, the JSON face stays silent. */
  maintainerDiagnostics: NavDiagnostic[];
}

export interface NavRequest {
  endpoint: string;
  path?: string;
  depth?: number;
  json: boolean;
}

export interface NavContext {
  currentDirectory: string;
  registryPath: string;
}

/** Structured failure (ADR 0021): factual data only — the `ukp nav:` prefix,
 * exit code, and recovery wording are adapter renderings, not capability
 * data. `errorClass` is the stable classification the exit-code mapping
 * consumes. */
export type NavErrorClass =
  | "no-endpoint"
  | "endpoint-name-mismatch"
  | "provider-unsupported"
  | "route-root-not-found"
  | "route-root-not-directory";

export interface NavFailure {
  errorClass: NavErrorClass;
  /** Factual message without any surface prefix or hint phrasing. */
  message: string;
}

/** ADR 0021 capability outcome: structured success (`NavResult` is the
 * `ukp.nav.v1` envelope body) or a classified failure. Never rendered text,
 * never exit codes. Async since the engine delegation (the scan package
 * reads bounded heads through an in-flight window, 2026-10-22). */
export type NavOutcome =
  | { ok: true; result: NavResult }
  | { ok: false; failure: NavFailure };

export class NavUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NavUsageError";
  }
}

export class NavProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NavProviderError";
  }
}

export const NAV_MAX_DEPTH = 10;
export const NAV_DEFAULT_DEPTH = 0;

function toNavDiagnostic(diagnostic: ScanDiagnostic): NavDiagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
  };
}

function childByName(node: NavNode, name: string): NavNode | undefined {
  return (node.children ?? []).find((child) => child.name === name);
}

/** Descends the scanned tree to the route root. The walk covers the whole
 * Service folder (gitignore inheritance from the Service root down is part
 * of the engine's semantics), so the route root is a subtree selection. */
function navigateTo(tree: NavNode, segments: readonly string[]): NavNode {
  let current = tree;
  for (const segment of segments) {
    const next = childByName(current, segment);
    if (next === undefined || next.kind !== "dir") {
      throw new NavProviderError(`route root segment '${segment}' vanished from the scan tree`);
    }
    current = next;
  }
  return current;
}

/** Recursive `.md` total under a node — the depth-boundary truncation count.
 * The structure walk already applied every exclusion, so this is exact. */
function countMarkdown(node: NavNode): number {
  let total = 0;
  for (const child of node.children ?? []) {
    if (child.kind === "file") total += 1;
    else total += countMarkdown(child);
  }
  return total;
}

/** The folder's own README path (engine file-node names are stems), for the
 * description hydration set: engine folder descriptions fold from the
 * sidecar ?? own-README chain once the README hydrates. */
function readmePathOf(node: NavNode): string | undefined {
  for (const child of node.children ?? []) {
    if (child.kind === "file" && child.name.toLowerCase() === "readme") return child.path;
  }
  return undefined;
}

interface FlatEntry {
  path: string;
  kind: "file" | "folder";
  node: NavNode;
  /** Folder entries only. */
  omittedMarkdownCount?: number;
}

function flattenToDepth(node: NavNode, remaining: number, out: FlatEntry[]): void {
  for (const child of node.children ?? []) {
    if (child.kind === "file") {
      out.push({ path: child.path, kind: "file", node: child });
    } else if (remaining > 0) {
      flattenToDepth(child, remaining - 1, out);
    } else {
      const count = countMarkdown(child);
      if (count > 0) {
        out.push({ path: child.path, kind: "folder", node: child, omittedMarkdownCount: count });
      }
    }
  }
}

async function buildNavResult(
  serviceFolder: string,
  routeRootFolder: string,
  root: string,
  depth: number,
  endpoint: string,
  options: ResolvedScanOptions,
): Promise<NavResult> {
  // B1 (owner R6 问2, 2026-10-22): structure walk with zero content reads,
  // then hydrate descriptions only for the window survivors.
  const structure = await scanStructure(serviceFolder, builtinDescriptionProvider, options);
  const routeRelative = relative(serviceFolder, routeRootFolder).replace(/\\/g, "/");
  const segments = routeRelative.length === 0 || routeRelative === "." ? [] : routeRelative.split("/");
  const routeNode = navigateTo(structure.tree, segments);

  const flat: FlatEntry[] = [];
  flattenToDepth(routeNode, depth, flat);

  // A1 window: full walk, then the projection window cuts (loud, same shape).
  const diagnostics: NavDiagnostic[] = [];
  let survivors = flat;
  if (flat.length > NAV_MAX_ENTRIES) {
    survivors = flat.slice(0, NAV_MAX_ENTRIES);
    diagnostics.push({
      code: "max-entries-reached",
      message: `route view truncated at ${NAV_MAX_ENTRIES} entries`,
    });
  }

  // Hydration set = window file entries + surviving truncated folders' own
  // READMEs (file hydration by window; folder descriptions fold full-tree
  // inside the engine on every describe — coordinator verification ③).
  const hydration = new Set<string>();
  for (const entry of survivors) {
    if (entry.kind === "file") {
      hydration.add(entry.path);
    } else {
      const readme = readmePathOf(entry.node);
      if (readme !== undefined) hydration.add(readme);
    }
  }

  // E1 audience triage: engine consumer findings ride the envelope;
  // maintainer findings ride the stderr-only channel.
  const maintainerDiagnostics: NavDiagnostic[] = [];
  for (const diagnostic of structure.diagnostics) {
    if (diagnostic.audience === "consumer") diagnostics.push(toNavDiagnostic(diagnostic));
    else maintainerDiagnostics.push(toNavDiagnostic(diagnostic));
  }
  const describeDiagnostics = await structure.describe(hydration);
  // Engine items carry placeholder text where the description chain found
  // nothing ("Undocumented — …"); the ukp.nav.v1 contract keeps null. The
  // per-file maintainer diagnostics name exactly those paths.
  const nullDescriptionPaths = new Set<string>();
  for (const diagnostic of describeDiagnostics) {
    if (diagnostic.audience !== "maintainer") continue;
    maintainerDiagnostics.push(toNavDiagnostic(diagnostic));
    if (
      diagnostic.path !== undefined
      && (diagnostic.code === "no-description" || diagnostic.code === "unreadable-file")
    ) {
      nullDescriptionPaths.add(diagnostic.path);
    }
  }

  const entries: NavEntry[] = survivors.map((entry) => {
    if (entry.kind === "folder") {
      return {
        path: entry.path,
        kind: "folder",
        description: entry.node.description ?? null,
        truncated: true,
        omittedMarkdownCount: entry.omittedMarkdownCount,
        ...(entry.node.markdown === undefined ? {} : { markdown: entry.node.markdown }),
      };
    }
    const description = nullDescriptionPaths.has(entry.path)
      ? null
      : entry.node.item?.description ?? null;
    return { path: entry.path, kind: "file", description };
  });

  entries.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: "base" }));
  return {
    endpoint,
    root,
    depth,
    entries,
    routeCount: entries.length,
    diagnostics,
    maintainerDiagnostics,
  };
}

/** Lexical route-path validation (usage-error tier, shared by the command
 * parser and the capability): endpoint-relative, no empty / `.` / `..`
 * segments. Existence and containment are checked later at execution. */
export function validateNavRoutePath(routePath: string): string[] {
  // Path-safety primitive (ADR 0023): verdicts shared, error wording local.
  const result = splitEndpointRelativeSegments(routePath);
  if (!result.ok) {
    if (result.reason === "absolute") {
      throw new NavUsageError("path must be endpoint-relative, not absolute");
    }
    if (result.reason === "empty-segment") {
      throw new NavUsageError("path must not contain empty path segments");
    }
    throw new NavUsageError("path must not contain '.' or '..' path segments");
  }
  return result.segments;
}

/** Presentation projection (ADR 0021 two-stage form): the structured,
 * serializable view. First-class citizen — adapters (CLI today, MCP /
 * programmatic later) consume this view, never the raw scan result.
 * Maintainer diagnostics stay out (E1): the envelope is the agent face. */
export interface NavEnvelope {
  schema: "ukp.nav.v1";
  command: "nav";
  capability: "nav";
  endpoint: string;
  root: string;
  depth: number;
  routeCount: number;
  entries: NavEntry[];
  diagnostics: NavDiagnostic[];
}

export function projectNavEnvelope(result: NavResult): NavEnvelope {
  return {
    schema: "ukp.nav.v1",
    command: "nav",
    capability: "nav",
    endpoint: result.endpoint,
    root: result.root,
    depth: result.depth,
    routeCount: result.routeCount,
    entries: result.entries,
    diagnostics: result.diagnostics,
  };
}

export function renderNavHuman(envelope: NavEnvelope): string {
  const lines = [`endpoint: ${envelope.endpoint} (root: ${envelope.root}, depth: ${envelope.depth})`];
  if (envelope.entries.length === 0) {
    lines.push("no markdown routes under this root");
  }
  for (const entry of envelope.entries) {
    if (entry.kind === "folder") {
      // Self-explanatory unexpanded form: an unexpanded folder plus the exact
      // recursive .md count inside (never "truncated" — nothing was cut).
      const line = `${entry.path}/ (+${entry.omittedMarkdownCount} .md)`;
      lines.push(entry.description ? `${line} | ${entry.description}` : line);
    } else {
      lines.push(entry.description ? `${entry.path} | ${entry.description}` : entry.path);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderNavJson(envelope: NavEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/** ADR 0021 core entry: runs the nav capability and returns a structured
 * outcome. Async since the scan-engine delegation (2026-10-22) — the local
 * and remote branches now share one async contract.
 * Scope/manifest/provider failures that cannot be classified as a nav
 * failure still throw their typed errors (`ScopeError`, `ManifestError`,
 * `NavUsageError`, `NavProviderError`) for the surface adapter to map. */
export async function runNav(request: NavRequest, context: NavContext): Promise<NavOutcome> {
  let depth = NAV_DEFAULT_DEPTH;
  if (request.depth !== undefined) {
    if (!Number.isSafeInteger(request.depth) || request.depth < 0 || request.depth > NAV_MAX_DEPTH) {
      throw new NavUsageError(`--depth must be an integer between 0 and ${NAV_MAX_DEPTH}`);
    }
    depth = request.depth;
  }

  const registry = readRegistry(context.registryPath);
  const scope = resolveScope({
    currentDirectory: context.currentDirectory,
    registry,
    explicitEndpoints: [request.endpoint],
    global: false,
  });
  const [binding] = scope.bindings;
  if (!binding) {
    return { ok: false, failure: { errorClass: "no-endpoint", message: "no endpoint selected" } };
  }
  // Remote bindings are routed to the remote transport by the surface
  // adapter before this point (ukp_remote W6); reaching here with one means
  // a programmatic caller — localPathOf gives it the classified refusal.

  const service = loadManifest(localPathOf(binding));
  if (service.effectiveName !== binding.name) {
    return {
      ok: false,
      failure: {
        errorClass: "endpoint-name-mismatch",
        message: `endpoint '${binding.name}' no longer matches Service effective name '${service.effectiveName}'`,
      },
    };
  }

  // Nav is a file-native derived default (ADR 0016): every registered local
  // Service has nav/file unless it declares otherwise. Resolution goes
  // through the shared file-native table — no command-local fallback.
  const resolved = resolveFileNativeCapability(service.manifest, "nav");
  if (!resolved || resolved.capability.provider !== "file") {
    return {
      ok: false,
      failure: {
        errorClass: "provider-unsupported",
        message: unsupportedFileNativeProviderMessage("nav", resolved?.capability.provider),
      },
    };
  }

  // Route root: the optional path must resolve to a directory inside the
  // Service folder. Exact addressing only — no fuzzy candidates: a miss
  // fails precisely instead of guessing.
  let routeRootFolder = service.folder;
  let root = ".";
  if (request.path !== undefined) {
    const segments = validateNavRoutePath(request.path);
    const targetPath = resolve(join(service.folder, ...segments));
    const serviceReal = realpathSync(service.folder);
    let targetReal: string;
    try {
      targetReal = realpathSync(targetPath);
    } catch {
      return {
        ok: false,
        failure: {
          errorClass: "route-root-not-found",
          message: `path '${request.path}' was not found in endpoint '${binding.name}'`,
        },
      };
    }
    const rel = relative(serviceReal, targetReal);
    if (!isInsideRealRoot(serviceReal, targetReal, { allowRoot: true })) {
      throw new NavUsageError("path must stay inside the selected Service folder");
    }
    if (!statSync(targetReal).isDirectory()) {
      return {
        ok: false,
        failure: {
          errorClass: "route-root-not-directory",
          message: `path '${request.path}' is not a directory in endpoint '${binding.name}'`,
        },
      };
    }
    routeRootFolder = targetReal;
    root = rel.length === 0 ? "." : rel.replace(/\\/g, "/");
  }

  const result = await buildNavResult(
    service.folder,
    routeRootFolder,
    root,
    depth,
    binding.name,
    resolveNavScanOptions(resolved.capability),
  );
  return { ok: true, result };
}
