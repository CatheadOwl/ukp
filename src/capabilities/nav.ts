import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";
import { loadManifest, type ManifestCapability } from "../config/manifest.ts";
import { resolveFileNativeCapability, unsupportedFileNativeProviderMessage } from "../config/file-native.ts";
import { readRegistry } from "../registry.ts";
import { resolveScope } from "../scope.ts";

// Nav capability: UKP-native file provider that
// enumerates the Markdown structure of one endpoint. The design stance is
// provider-owned visibility: the exclusion rules
// below are the file provider's own visibility contract — the caller can
// never override them from the command surface (path/depth/format only).

/** Default directory exclusions (case-insensitive), aligned with the
 * reference scanner (any_nav): build-tool output trees carry no knowledge
 * routes. Services replace the whole set via
 * `[capabilities.nav.config] exclude_dirs = [...]`. */
export const NAV_DEFAULT_EXCLUDE_DIRS: readonly string[] = [
  "node_modules",
  "dist",
  "build",
  "lib",
  "out",
  "coverage",
];

/** Default file-name exclusions (case-insensitive). Agent-instruction files
 * (AGENTS.md / CLAUDE.md) are context the agent harness already injects —
 * they are not discoverable knowledge for nav's goal, so they never appear
 * in route views nor truncated counts. Replaceable via
 * `[capabilities.nav.config] exclude_files = [...]`. */
export const NAV_DEFAULT_EXCLUDE_FILES: readonly string[] = ["AGENTS.md", "CLAUDE.md"];

/** The provider-side visibility set resolved from the capability declaration:
 * defaults unless the Service overrides a whole list in its own config. */
export interface NavVisibility {
  excludeDirs: readonly string[];
  excludeFiles: readonly string[];
}

function parseStringList(config: Record<string, unknown>, key: string): string[] | undefined {
  const raw = config[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new NavProviderError(`nav config '${key}' must be an array of non-empty strings`);
  }
  return (raw as string[]).map((item) => item.toLowerCase());
}

export function resolveNavVisibility(capability: ManifestCapability): NavVisibility {
  const config = capability.config ?? {};
  return {
    excludeDirs: parseStringList(config, "exclude_dirs") ?? NAV_DEFAULT_EXCLUDE_DIRS.map((d) => d.toLowerCase()),
    excludeFiles: parseStringList(config, "exclude_files") ?? NAV_DEFAULT_EXCLUDE_FILES.map((f) => f.toLowerCase()),
  };
}

/** Safety cap on collected route entries; the recursive truncation count
 * still walks everything so `[truncated: N]` totals stay exact. */
export const NAV_MAX_ENTRIES = 2000;

/** Budget on per-entry description reads (ADR 0018): the expensive
 * cost class gets a configurable cap. Configurable by precedent (VS Code
 * maxResults, TS/VS Code "let the user decide what to skip"); loud by
 * contract when hit (never a silent drop). Counts stay exact and unbounded —
 * budgets are for expensive-and-droppable work, never cheap-and-load-bearing
 * work. Default equals the entry cap, so the budget only binds when a
 * Service deliberately lowers it. */
export const NAV_DEFAULT_MAX_DESCRIPTION_FILES = NAV_MAX_ENTRIES;

function resolveNavDescriptionBudget(capability: ManifestCapability): number {
  const raw = (capability.config ?? {})["max_description_files"];
  if (raw === undefined) return NAV_DEFAULT_MAX_DESCRIPTION_FILES;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
    throw new NavProviderError("nav config 'max_description_files' must be a positive integer");
  }
  return raw;
}

// ---------------------------------------------------------------------------
// .gitignore support (visibility follows the endpoint's own ignore files —
// zero UKP-side configuration). Semantics are the git subset: comments,
// blank lines, `!` negation, trailing-`/` dir-only patterns, leading-`/` or
// internal-`/` anchoring, `**` / `*` / `?` wildcards, per-file last-match
// wins, and deeper .gitignore files override shallower ones.
// ---------------------------------------------------------------------------

interface IgnoreRule {
  negated: boolean;
  dirOnly: boolean;
  /** Tests a path relative to the directory holding the .gitignore. */
  regex: RegExp;
}

function globSegmentToRegexSource(segment: string): string {
  return segment
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
}

function patternToRegex(pattern: string, anchored: boolean): RegExp | null {
  const segments = pattern.split("/");
  let source = "^";
  if (!anchored) source += "(?:[^/]+/)*";
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const last = index === segments.length - 1;
    if (segment === "**") {
      // Non-trailing `**` means "any depth below here (including zero)";
      // trailing `**` means "everything below the prefix". The separator
      // handling falls out naturally: the non-last branch already ends with
      // `/` inside the group, and the next loop iteration handles the real
      // segment after `**`.
      source += last ? ".*" : "(?:[^/]+/)*";
      continue;
    }
    source += globSegmentToRegexSource(segment);
    if (!last) source += "/";
  }
  try {
    // Case-insensitive everywhere: UKP targets Windows hosts where git
    // defaults to core.ignorecase=true, and a nav/build divergence on the
    // same .gitignore would be a visibility split, not a nicety.
    return new RegExp(`${source}$`, "i");
  } catch {
    return null;
  }
}

export function parseGitignoreRules(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.length === 0 || line.startsWith("#")) continue;
    let pattern = line;
    let negated = false;
    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }
    if (pattern.length === 0) continue;
    let dirOnly = false;
    if (pattern.endsWith("/")) {
      dirOnly = true;
      pattern = pattern.slice(0, -1);
    }
    let anchored = false;
    if (pattern.startsWith("/")) {
      anchored = true;
      pattern = pattern.slice(1);
    } else if (pattern.includes("/")) {
      anchored = true;
    }
    if (pattern.length === 0 || pattern.split("/").some((segment) => segment.length === 0)) continue;
    const regex = patternToRegex(pattern, anchored);
    if (regex) rules.push({ negated, dirOnly, regex });
  }
  return rules;
}

function readGitignoreRules(dir: string): IgnoreRule[] {
  try {
    return parseGitignoreRules(readFileSync(join(dir, ".gitignore"), "utf8"));
  } catch {
    return [];
  }
}

/** One .gitignore file's rules, anchored at the directory holding it. */
interface IgnoreLayer {
  base: string;
  rules: IgnoreRule[];
}

function appendLayer(layers: readonly IgnoreLayer[], dir: string): IgnoreLayer[] {
  const rules = readGitignoreRules(dir);
  return rules.length === 0 ? [...layers] : [...layers, { base: dir, rules }];
}

/** Builds the inherited chain from the Service folder down to a route root. */
function buildInheritedLayers(from: string, to: string): IgnoreLayer[] {
  const rel = relative(from, to).replace(/\\/g, "/");
  let layers: IgnoreLayer[] = appendLayer([], from);
  if (rel.length === 0 || rel === ".") return layers;
  let acc = from;
  for (const segment of rel.split("/")) {
    acc = join(acc, segment);
    layers = appendLayer(layers, acc);
  }
  return layers;
}

/** Last matching rule wins; deeper .gitignore files' rules come later. */
function isIgnored(absolutePath: string, isDirectory: boolean, layers: readonly IgnoreLayer[]): boolean {
  let ignored = false;
  for (const layer of layers) {
    const rel = relative(layer.base, absolutePath).replace(/\\/g, "/");
    if (rel.length === 0 || rel === ".." || rel.startsWith("../")) continue;
    for (const rule of layer.rules) {
      if (ruleMatches(rule, rel, isDirectory)) ignored = !rule.negated;
    }
  }
  return ignored;
}

function ruleMatches(rule: IgnoreRule, path: string, isDirectory: boolean): boolean {
  if (!rule.dirOnly) return rule.regex.test(path);
  // A dir-only pattern ignores the directory and everything under it: test
  // the path itself (when it is a directory) plus every ancestor.
  if (isDirectory && rule.regex.test(path)) return true;
  let ancestor = "";
  for (const segment of path.split("/")) {
    ancestor = ancestor.length === 0 ? segment : `${ancestor}/${segment}`;
    if (rule.regex.test(ancestor)) return true;
  }
  return false;
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
  /** Budget-hit entries only (ADR 0018): the entry IS listed (path came from
   * the cheap scan), but its description read was skipped beyond the
   * configurable description-read budget. Loud by contract — the entry
   * marker plus the `description-budget-reached` diagnostic always appear
   * together, never a silent drop. */
  descriptionOmitted?: "budget";
}

export interface NavDiagnostic {
  code:
    | "unreadable-directory"
    | "unreadable-file"
    | "max-entries-reached"
    | "description-budget-reached";
  message: string;
}

export interface NavResult {
  endpoint: string;
  /** Route root the depth window was computed from ("." = endpoint root). */
  root: string;
  depth: number;
  entries: NavEntry[];
  routeCount: number;
  diagnostics: NavDiagnostic[];
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
 * never exit codes. */
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

function isExcludedDir(name: string, visibility: NavVisibility): boolean {
  // Case-insensitive to match the gitignore "i" stance (Windows hosts,
  // core.ignorecase=true): `.gitignore` writing `Node_Modules/` must not
  // resurrect a node_modules tree.
  const lower = name.toLowerCase();
  return visibility.excludeDirs.includes(lower);
}

function isExcludedFile(name: string, visibility: NavVisibility): boolean {
  return visibility.excludeFiles.includes(name.toLowerCase());
}

function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

function isReadme(name: string): boolean {
  return name.toLowerCase() === "readme.md";
}

function toRoutePath(serviceFolder: string, target: string): string {
  const rel = relative(serviceFolder, target).replace(/\\/g, "/");
  return rel.length === 0 ? "." : rel;
}

// Frontmatter `description:` extraction (single shallow read; a missing or
// malformed block simply yields null — nav never fails because a document
// lacks a description).
function extractDescription(content: string): string | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) return null;
  for (const line of lines.slice(1, closing)) {
    if (/^\s/.test(line)) continue; // nested keys never own the description
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    if (line.slice(0, separator).trim() !== "description") continue;
    const value = line.slice(separator + 1).trim();
    if (value.length === 0) return null;
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      return value.slice(1, -1);
    }
    return value;
  }
  return null;
}

interface TruncatedFolder {
  folder: string;
  markdownCount: number;
  description: string | null;
}

/** Recursive `.md` count under a depth-boundary folder, plus a shallow read
 * of its first-level README for the description. The count is the total that
 * would appear on expansion — independent of the observing route root.
 * Ignore layers are inherited so a truncated folder's count already excludes
 * gitignored content. */
function describeTruncatedFolder(
  serviceFolder: string,
  folder: string,
  diagnostics: NavDiagnostic[],
  layers: readonly IgnoreLayer[],
  visibility: NavVisibility,
): TruncatedFolder {
  let markdownCount = 0;
  let description: string | null = null;
  const walk = (dir: string, isRoot: boolean, currentLayers: readonly IgnoreLayer[]): void => {
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      if (isRoot) {
        diagnostics.push({
          code: "unreadable-directory",
          message: `unable to read directory ${toRoutePath(serviceFolder, dir)}`,
        });
      }
      return;
    }
    const withLayers = appendLayer(currentLayers, dir);
    for (const child of children) {
      if (child.name.startsWith(".")) continue;
      const childPath = join(dir, child.name);
      if (child.isDirectory()) {
        if (isExcludedDir(child.name, visibility)) continue;
        if (isIgnored(childPath, true, withLayers)) continue;
        walk(childPath, false, withLayers);
      } else if (child.isFile() && isMarkdown(child.name)) {
        if (isExcludedFile(child.name, visibility)) continue;
        if (isIgnored(childPath, false, withLayers)) continue;
        markdownCount++;
        if (isRoot && isReadme(child.name) && description === null) {
          try {
            description = extractDescription(readFileSync(childPath, "utf8"));
          } catch {
            description = null;
          }
        }
      }
    }
  };
  walk(folder, true, layers);
  return { folder, markdownCount, description };
}

interface ScanState {
  files: string[];
  truncated: TruncatedFolder[];
  diagnostics: NavDiagnostic[];
}

function scanDirectory(
  serviceFolder: string,
  dir: string,
  depth: number,
  maxDepth: number,
  state: ScanState,
  layers: readonly IgnoreLayer[],
  visibility: NavVisibility,
): void {
  let children;
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch {
    state.diagnostics.push({
      code: "unreadable-directory",
      message: `unable to read directory ${toRoutePath(serviceFolder, dir)}`,
    });
    return;
  }
  const withLayers = appendLayer(layers, dir);
  children.sort((left, right) => left.name.localeCompare(right.name));

  for (const child of children) {
    if (child.name.startsWith(".")) continue;
    const childPath = join(dir, child.name);

    if (child.isDirectory()) {
      if (isExcludedDir(child.name, visibility)) continue;
      if (isIgnored(childPath, true, withLayers)) continue;
      if (depth >= maxDepth) {
        const truncated = describeTruncatedFolder(serviceFolder, childPath, state.diagnostics, withLayers, visibility);
        if (truncated.markdownCount > 0) {
          if (state.files.length + state.truncated.length >= NAV_MAX_ENTRIES) {
            state.diagnostics.push({
              code: "max-entries-reached",
              message: `route view truncated at ${NAV_MAX_ENTRIES} entries`,
            });
            return;
          }
          state.truncated.push(truncated);
        }
        continue;
      }
      scanDirectory(serviceFolder, childPath, depth + 1, maxDepth, state, withLayers, visibility);
      continue;
    }

    if (child.isFile() && isMarkdown(child.name)) {
      if (isExcludedFile(child.name, visibility)) continue;
      if (isIgnored(childPath, false, withLayers)) continue;
      if (state.files.length + state.truncated.length >= NAV_MAX_ENTRIES) {
        state.diagnostics.push({
          code: "max-entries-reached",
          message: `route view truncated at ${NAV_MAX_ENTRIES} entries`,
        });
        return;
      }
      state.files.push(childPath);
    }
  }
}

function buildNavResult(
  serviceFolder: string,
  routeRootFolder: string,
  root: string,
  depth: number,
  endpoint: string,
  visibility: NavVisibility,
  descriptionBudget: number,
): NavResult {
  const state: ScanState = { files: [], truncated: [], diagnostics: [] };
  // Ignore layers are inherited from the Service folder down to the route
  // root, then continue accumulating during the scan.
  const layers = buildInheritedLayers(serviceFolder, routeRootFolder);
  scanDirectory(serviceFolder, routeRootFolder, 0, depth, state, layers, visibility);

  // Description extraction is the expensive cost class (ADR 0018): a full
  // file read per entry. Beyond the configurable budget the entry stays
  // listed (the path came from the cheap scan) but its description is
  // omitted, flagged per-entry, and announced once by diagnostic — loud,
  // never silent.
  let descriptionsRead = 0;
  let descriptionsOmitted = 0;
  const entries: NavEntry[] = state.files.map((file) => {
    if (descriptionsRead >= descriptionBudget) {
      descriptionsOmitted += 1;
      return {
        path: toRoutePath(serviceFolder, file),
        kind: "file" as const,
        description: null,
        descriptionOmitted: "budget" as const,
      };
    }
    descriptionsRead += 1;
    let description: string | null = null;
    try {
      description = extractDescription(readFileSync(file, "utf8"));
    } catch {
      state.diagnostics.push({
        code: "unreadable-file",
        message: `unable to read markdown file ${toRoutePath(serviceFolder, file)}`,
      });
    }
    return { path: toRoutePath(serviceFolder, file), kind: "file" as const, description };
  });
  if (descriptionsOmitted > 0) {
    state.diagnostics.push({
      code: "description-budget-reached",
      message:
        `descriptions omitted for ${descriptionsOmitted} entries beyond the description-read budget `
        + `${descriptionBudget} (nav config 'max_description_files'; entries stay listed, counts stay exact)`,
    });
  }

  for (const truncated of state.truncated) {
    entries.push({
      path: toRoutePath(serviceFolder, truncated.folder),
      kind: "folder",
      description: truncated.description,
      truncated: true,
      omittedMarkdownCount: truncated.markdownCount,
    });
  }

  entries.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: "base" }));
  return {
    endpoint,
    root,
    depth,
    entries,
    routeCount: entries.length,
    diagnostics: state.diagnostics,
  };
}

/** Lexical route-path validation (usage-error tier, shared by the command
 * parser and the capability): endpoint-relative, no empty / `.` / `..`
 * segments. Existence and containment are checked later at execution. */
export function validateNavRoutePath(routePath: string): string[] {
  if (
    isAbsolute(routePath)
    || win32.isAbsolute(routePath)
    || /^[A-Za-z]:/.test(routePath)
    || routePath.startsWith("//")
    || routePath.startsWith("\\\\")
  ) {
    throw new NavUsageError("path must be endpoint-relative, not absolute");
  }
  const segments = routePath.split(/[\\/]/);
  if (segments.some((segment) => segment.length === 0)) {
    throw new NavUsageError("path must not contain empty path segments");
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new NavUsageError("path must not contain '.' or '..' path segments");
  }
  return segments;
}

/** Presentation projection (ADR 0021 two-stage form): the structured,
 * serializable view. First-class citizen — adapters (CLI today, MCP /
 * programmatic later) consume this view, never the raw scan result. */
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
      const line = `[truncated: ${entry.omittedMarkdownCount}] ${entry.path}`;
      lines.push(entry.description ? `${line} | ${entry.description}` : line);
    } else if (entry.descriptionOmitted === "budget") {
      lines.push(`${entry.path} | (description omitted: budget reached)`);
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
 * outcome. Scope/manifest/provider failures that cannot be classified as a
 * nav failure still throw their typed errors (`ScopeError`,
 * `ManifestError`, `NavUsageError`, `NavProviderError`) for the surface
 * adapter to map. */
export function runNav(request: NavRequest, context: NavContext): NavOutcome {
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

  const service = loadManifest(binding.path);
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
    if (rel.startsWith("..") || isAbsolute(rel)) {
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

  const result = buildNavResult(
    service.folder,
    routeRootFolder,
    root,
    depth,
    binding.name,
    resolveNavVisibility(resolved.capability),
    resolveNavDescriptionBudget(resolved.capability),
  );
  return { ok: true, result };
}
