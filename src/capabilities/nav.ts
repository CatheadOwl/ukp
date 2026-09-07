import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";
import { loadManifest, type ManifestCapability } from "../config/manifest.ts";
import { readRegistry } from "../registry.ts";
import { resolveScope } from "../scope.ts";

// Nav capability (W1, workunits/ukp_nav): UKP-native file provider that
// enumerates the Markdown structure of one endpoint. The design stance is
// provider-owned visibility (D-047 / ADR-0009 spirit): the exclusion rules
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
   * suffix so the path is directly consumable by `ukp get`. */
  path: string;
  kind: "file" | "folder";
  description: string | null;
  /** Depth-boundary folders only: `true` with `omittedMarkdownCount`. */
  truncated?: boolean;
  /** Recursive `.md` total under a truncated folder (exclusions applied). */
  omittedMarkdownCount?: number;
}

export interface NavDiagnostic {
  code: "unreadable-directory" | "unreadable-file" | "max-entries-reached";
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

export interface NavCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

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
): NavResult {
  const state: ScanState = { files: [], truncated: [], diagnostics: [] };
  // Ignore layers are inherited from the Service folder down to the route
  // root, then continue accumulating during the scan.
  const layers = buildInheritedLayers(serviceFolder, routeRootFolder);
  scanDirectory(serviceFolder, routeRootFolder, 0, depth, state, layers, visibility);

  const entries: NavEntry[] = state.files.map((file) => {
    let description: string | null = null;
    try {
      description = extractDescription(readFileSync(file, "utf8"));
    } catch {
      state.diagnostics.push({
        code: "unreadable-file",
        message: `unable to read markdown file ${toRoutePath(serviceFolder, file)}`,
      });
    }
    return { path: toRoutePath(serviceFolder, file), kind: "file", description };
  });

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

/** Resolves the file-provider nav capability declaration. Only the UKP-native
 * `file` provider exists; QMD-native enumeration is evidence-triggered (N2). */
export function assertNavProvider(capability: ManifestCapability): void {
  if (capability.provider !== "file") {
    throw new NavProviderError(
      `unsupported nav provider '${capability.provider}' (supported: file)`,
    );
  }
}

export function renderNavHuman(result: NavResult): string {
  const lines = [`endpoint: ${result.endpoint} (root: ${result.root}, depth: ${result.depth})`];
  if (result.entries.length === 0) {
    lines.push("no markdown routes under this root");
  }
  for (const entry of result.entries) {
    if (entry.kind === "folder") {
      const line = `[truncated: ${entry.omittedMarkdownCount}] ${entry.path}`;
      lines.push(entry.description ? `${line} | ${entry.description}` : line);
    } else {
      lines.push(entry.description ? `${entry.path} | ${entry.description}` : entry.path);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderNavJson(result: NavResult): string {
  const envelope = {
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
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function executeNav(request: NavRequest, context: NavContext): NavCommandResult {
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
    return { exitCode: 1, stdout: "", stderr: "ukp nav: no endpoint selected\n" };
  }

  const service = loadManifest(binding.path);
  if (service.effectiveName !== binding.name) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp nav: endpoint '${binding.name}' no longer matches Service effective name '${service.effectiveName}'\n`,
    };
  }

  // Nav is a derived default capability (precedent: get/file baseline,
  // O-013/D-044): every registered local Service has nav/file unless it
  // declares otherwise. `[capabilities.nav]` in the Manifest exists only to
  // override the provider or the visibility defaults.
  const capability = service.manifest.capabilities.nav ?? { provider: "file" };
  assertNavProvider(capability);

  // Route root: the optional path must resolve to a directory inside the
  // Service folder. Exact addressing only — no fuzzy candidates (D-047
  // spirit): a miss fails precisely instead of guessing.
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
        exitCode: 1,
        stdout: "",
        stderr: `ukp nav: path '${request.path}' was not found in endpoint '${binding.name}'\n`,
      };
    }
    const rel = relative(serviceReal, targetReal);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new NavUsageError("path must stay inside the selected Service folder");
    }
    if (!statSync(targetReal).isDirectory()) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `ukp nav: path '${request.path}' is not a directory in endpoint '${binding.name}'\n`,
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
    resolveNavVisibility(capability),
  );
  return {
    exitCode: 0,
    stdout: request.json ? renderNavJson(result) : renderNavHuman(result),
    stderr: "",
  };
}
