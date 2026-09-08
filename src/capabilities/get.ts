import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";
import { loadManifest } from "../config/manifest.ts";
import { readRegistry } from "../registry.ts";
import { resolveScope } from "../scope.ts";
import { buildQmdInvocation, defaultQmdCommand, isBareDocidReference, stripDocidHash, stripQmdHeader, toQmdGetArgument } from "./qmd.ts";

export interface GetRequest {
  /** Undefined only for an absolute filesystem reference, which the
   * capability maps against the Registry before any read (ADR-URI-001
   * tolerant tier); every other tier requires it. */
  endpoint?: string;
  path: string;
  lines?: LineRange;
  /** "uri" = exact slot addressing (ukp:// input, ADR 0014): the path must
   * resolve exactly; no fuzzy fallback and no provider delegation on miss. */
  addressing?: "uri";
  /** Document-relative context (ADR-URI-001 tolerant tier): the
   * endpoint-relative route of the source document the reference was copied
   * from. `path` is then resolved against that document's directory. */
  fromRef?: string;
}

export interface LineRange {
  start: number;
  count?: number;
}

export interface GetContext {
  currentDirectory: string;
  registryPath: string;
  qmdCommand?: readonly string[];
}

export interface GetResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class GetUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GetUsageError";
  }
}

/** provider-unavailable classification for "no qmd executable at all" — the
 * read channel is absent, which is the same recovery class as a spawn
 * failure (install/verify qmd), never resource-missing. */
function providerUnavailableNoExecutable(endpointName: string): GetResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr:
      `ukp read: provider-unavailable: the QMD read channel for endpoint '${endpointName}' has no usable qmd executable.\n`
      + `Browse the endpoint with 'ukp nav --endpoint ${endpointName}' or install qmd, then retry.\n`,
  };
}

function validateEndpointRelativePath(reference: string): string[] {
  if (reference.length === 0) throw new GetUsageError("reference must be a non-empty endpoint-scoped reference");
  if (
    isAbsolute(reference)
    || win32.isAbsolute(reference)
    || /^[A-Za-z]:/.test(reference)
    || reference.startsWith("//")
    || reference.startsWith("\\\\")
  ) {
    throw new GetUsageError("reference must be endpoint-scoped, not absolute");
  }

  const segments = reference.split(/[\\/]/);
  if (segments.some((segment) => segment.length === 0)) {
    throw new GetUsageError("reference must not contain empty path segments");
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new GetUsageError("reference must not contain '.' or '..' path segments");
  }
  return segments;
}

function isInsideService(serviceReal: string, targetReal: string): boolean {
  const rel = relative(serviceReal, targetReal);
  // rel === "" means target is the service folder itself (not a file inside it)
  // Check ".." segment boundary: rel.startsWith("..") but not "..literal"
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function resolveEndpointPath(serviceFolder: string, reference: string): string {
  const segments = validateEndpointRelativePath(reference);
  const targetPath = resolve(join(serviceFolder, ...segments));
  // Single containment check via realpath: catches both lexical and symlink escapes
  const serviceReal = realpathSync(serviceFolder);
  const targetReal = realpathSync(targetPath);
  if (!isInsideService(serviceReal, targetReal)) {
    throw new GetUsageError("reference must stay inside the selected Service folder when resolved as a file");
  }
  return targetReal;
}

/** Tolerant-tier absolute-shape detection (ADR-URI-001): an input that is an
 * absolute filesystem path (any of the shapes the plain tier rejects) is
 * mapped against the Registry instead of being a usage error. */
export function isAbsoluteFilesystemReference(reference: string): boolean {
  // `C:foo` (no separator) is drive-relative, not absolute — it stays on the
  // plain tier, where validateEndpointRelativePath rejects the `X:` shape.
  return (
    isAbsolute(reference)
    || win32.isAbsolute(reference)
    || /^[A-Za-z]:[\\/]/.test(reference)
    || reference.startsWith("//")
    || reference.startsWith("\\\\")
  );
}

/**
 * Resolve a document-relative reference (ADR-URI-001 tolerant tier): the
 * reference as it appears inside a source document (`../x.md`, `./x.md`,
 * bare `x.md`), resolved against `fromRef`'s directory with `.`/`..`
 * segment normalization. Pure string work — no filesystem access, no fuzzy
 * search; escaping the endpoint root is a usage error, not a containment
 * miss (the caller learns the boundary before any file is touched).
 */
function resolveDocRelativeReference(fromRef: string, reference: string): string {
  const base = validateEndpointRelativePath(fromRef).slice(0, -1);
  const segments = [...base];
  for (const segment of reference.split(/[\\/]/)) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new GetUsageError(
          `'${reference}' (from '${fromRef}') resolves outside the endpoint`,
        );
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new GetUsageError(
      `'${reference}' (from '${fromRef}') resolves to the endpoint root, not a resource`,
    );
  }
  return segments.join("/");
}

/**
 * Map an absolute filesystem reference to { endpoint, route } by matching it
 * against every registered endpoint's Service folder (ADR-URI-001 tolerant
 * tier; the agent-facing equivalent of `gh pr view` accepting a pasted URL).
 * Containment uses the same resolved-realpath stance as reads; a target that
 * does not exist yet falls back to a lexical check against the real Service
 * root. Ambiguity (zero or multiple endpoints) is a usage error, never a
 * silent first-match: the mapping must be reproducible.
 */
function resolveAbsoluteReference(
  reference: string,
  registry: readonly { name: string; path: string }[],
): { endpoint: string; route: string } {
  const matches: { endpoint: string; route: string }[] = [];
  for (const binding of registry) {
    let service: ReturnType<typeof loadManifest>;
    try {
      service = loadManifest(binding.path);
    } catch {
      continue;
    }
    if (service.effectiveName !== binding.name) continue;
    let serviceReal: string;
    try {
      serviceReal = realpathSync(service.folder);
    } catch {
      continue;
    }
    let target: string;
    try {
      target = realpathSync(reference);
    } catch {
      target = resolve(reference);
    }
    if (!isInsideService(serviceReal, target)) continue;
    matches.push({
      endpoint: binding.name,
      route: relative(serviceReal, target).replace(/\\/g, "/"),
    });
  }
  if (matches.length === 0) {
    const names = registry.map((binding) => binding.name).join(", ");
    throw new GetUsageError(
      `absolute reference '${reference}' matches no registered endpoint`
        + (names.length > 0 ? ` (registered: ${names})` : " (no endpoints registered)"),
    );
  }
  if (matches.length > 1) {
    const list = matches.map((match) => `${match.endpoint} (${match.route})`).join(", ");
    throw new GetUsageError(
      `absolute reference '${reference}' matches multiple endpoints: ${list}; use 'ukp read --endpoint <name> <route>' instead`,
    );
  }
  return matches[0];
}

function normalizeFilename(name: string): string {
  // Strip extension (only if there's a leading character before the dot) and normalize hyphens/underscores
  // Dotfiles like .env keep their name (dotIndex === 0 means no leading char)
  const dotIndex = name.lastIndexOf(".");
  const withoutExt = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  return withoutExt.toLowerCase().replace(/[-_]/g, "");
}

function findFilesBySuffix(serviceFolder: string, suffix: string): {
  serviceReal: string;
  suffixMatches: string[];
  nameFuzzyMatches: string[];
} {
  const serviceReal = realpathSync(serviceFolder);
  const suffixMatches = new Set<string>();
  const nameFuzzyMatches = new Set<string>();
  const visitedDirs = new Set<string>();
  const normalizedSuffix = suffix.replace(/\\/g, "/");
  const suffixSegments = normalizedSuffix.split("/");
  const targetFileName = suffixSegments[suffixSegments.length - 1];
  const normalizedTargetName = normalizeFilename(targetFileName);
  // For fuzzy matching, also normalize the path prefix (all segments except the last)
  const pathPrefix = suffixSegments.slice(0, -1).join("/");
  const normalizedPathPrefix = pathPrefix.replace(/\\/g, "/").toLowerCase().replace(/[-_]/g, "");

  function scan(currentPath: string): void {
    let entries;
    try {
      entries = readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);
      let canonicalPath: string;
      let isSymlink = false;

      if (entry.isSymbolicLink()) {
        isSymlink = true;
        try {
          canonicalPath = realpathSync(fullPath);
          if (!isInsideService(serviceReal, canonicalPath)) {
            continue;
          }
        } catch {
          continue; // Broken symlink
        }
      } else {
        canonicalPath = fullPath;
      }

      // Determine actual type (symlinks need statSync since Dirent methods return false for symlinks)
      let isDir: boolean;
      let isFile: boolean;
      if (isSymlink) {
        try {
          const stat = statSync(canonicalPath);
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      } else {
        isDir = entry.isDirectory();
        isFile = entry.isFile();
      }

      if (isDir) {
        const dirReal = isSymlink ? canonicalPath : realpathSync(canonicalPath);
        if (visitedDirs.has(dirReal)) continue;
        visitedDirs.add(dirReal);
        scan(canonicalPath);
      } else if (isFile) {
        const fileReal = isSymlink ? canonicalPath : realpathSync(canonicalPath);
        const relPath = relative(serviceReal, fileReal).replace(/\\/g, "/");

        // Check 1: Exact suffix match (filename exact, path fuzzy)
        if (entry.name === targetFileName) {
          if (relPath === normalizedSuffix || relPath.endsWith("/" + normalizedSuffix)) {
            if (isInsideService(serviceReal, fileReal)) {
              suffixMatches.add(fileReal);
              continue;
            }
          }
        }

        // Check 2: Name fuzzy match (filename fuzzy with -/_ normalization, ignoring extension)
        // Also check path prefix if the user specified one
        const normalizedName = normalizeFilename(entry.name);
        if (normalizedName === normalizedTargetName) {
          // If user specified a path prefix (e.g., "subdir/file.md"), verify it matches
          if (normalizedPathPrefix) {
            const fileDir = relative(serviceReal, isSymlink ? canonicalPath : realpathSync(join(canonicalPath, "..")))
              .replace(/\\/g, "/")
              .toLowerCase()
              .replace(/[-_]/g, "");
            // Check if the file's directory path ends with the normalized prefix
            if (fileDir !== normalizedPathPrefix && !fileDir.endsWith("/" + normalizedPathPrefix)) {
              continue; // Path prefix doesn't match, skip
            }
          }
          if (isInsideService(serviceReal, fileReal)) {
            nameFuzzyMatches.add(fileReal);
          }
        }
      }
    }
  }

  visitedDirs.add(serviceReal);
  scan(serviceReal);
  return {
    serviceReal,
    suffixMatches: Array.from(suffixMatches),
    nameFuzzyMatches: Array.from(nameFuzzyMatches),
  };
}

type LineRangeResult =
  | { kind: "ok"; content: string }
  | { kind: "start-beyond-eof"; start: number; lineCount: number };

/**
 * Slice `content` to the requested 1-based `--lines` window.
 *
 * Two out-of-range shapes are distinguished so the caller can enforce the
 * get/file exit contract, which must match get/qmd (where an empty provider
 * body already fails with exit 1):
 * - `start` past the last line → `start-beyond-eof`; the caller errors (exit 1)
 *   and never surfaces a silently-empty success read.
 * - `start` valid but the window runs past the end → content is truncated to
 *   the available lines and remains `ok` (exit 0). `--lines` is a best-effort
 *   reading hint and never selects another resource.
 */
function applyLineRange(content: string, range: LineRange | undefined): LineRangeResult {
  if (!range) return { kind: "ok", content };
  // An empty file has zero lines, so any start is beyond the end.
  if (content.length === 0) return { kind: "start-beyond-eof", start: range.start, lineCount: 0 };
  const lines = content.split(/\r?\n/);
  if (content.endsWith("\n") || content.endsWith("\r\n")) lines.pop();
  const lineCount = lines.length;
  const startIndex = range.start - 1;
  if (startIndex >= lineCount) {
    return { kind: "start-beyond-eof", start: range.start, lineCount };
  }
  const selected = lines.slice(startIndex, range.count === undefined ? undefined : startIndex + range.count);
  return { kind: "ok", content: `${selected.join("\n")}\n` };
}

/**
 * Read an explicit provider-tier reference (bare docid handoff key, ADR 0011,
 * or a `qmd://` provider reference, ADR 0008) through the QMD-backed get
 * adapter. Never entered from a plain-path miss (ADR 0017: shape-based
 * dispatch). The adapter re-adds the `#` to a bare docid so QMD resolves it
 * by content fingerprint, strips the provider header so stdout starts at the
 * body, and keeps UKP's exit/error discipline — failures classify as
 * provider-unavailable (spawn) or resource-missing (provider ran, no
 * resolution) without leaking QMD internals as traces.
 */
function readViaQmd(
  qmdCommand: readonly string[],
  serviceFolder: string,
  request: GetRequest,
  endpointName: string,
): GetResult {
  const providerArgs = [
    "get",
    toQmdGetArgument(request.path, request.lines),
    "--no-line-numbers",
  ];
  const invocation = buildQmdInvocation(qmdCommand, providerArgs);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: serviceFolder,
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: invocation.verbatim,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    // provider-unavailable, not resource-missing: the read channel itself
    // could not start (spawn failure — qmd missing, or an unstartable shim
    // form). The two classes drive completely different recovery actions, so
    // the wording must classify and point at recovery paths.
    const detail = result.error instanceof Error ? result.error.message : String(result.error);
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `ukp read: provider-unavailable: the QMD read channel for endpoint '${endpointName}' could not start (${detail}).\n`
        + `Browse the endpoint with 'ukp nav --endpoint ${endpointName}' or verify the qmd installation, then retry.\n`,
    };
  }
  if (result.signal === "SIGINT" || result.status === 130) {
    return { exitCode: 130, stdout: "", stderr: "ukp read: provider cancelled\n" };
  }
  if (result.status !== 0) {
    // Provider stderr detail keeps at most the first non-empty line — a
    // multi-line crash dump must not flood the surface (a provider
    // malfunction still lands in this branch; the classification stays
    // resource-missing-shaped, which is a declared limitation of a one-line
    // provider detail).
    const rawProviderError = (result.stderr ?? "").trim();
    if (
      rawProviderError.includes("no-line-numbers")
      || rawProviderError.includes("unknown option")
      || rawProviderError.includes("unknown flag")
    ) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "ukp read: qmd build does not support '--no-line-numbers'; provider incompatible\n",
      };
    }
    const providerError = rawProviderError
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `ukp read: resource-missing: '${request.path}' could not be resolved by the provider in endpoint '${endpointName}'\n`
        + (providerError ? `(provider: ${providerError})\n` : ""),
    };
  }

  const body = stripQmdHeader(result.stdout ?? "");
  if (body.length === 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp read: provider returned no content for '${request.path}' in endpoint '${endpointName}'\n`,
    };
  }
  return { exitCode: 0, stdout: body, stderr: "" };
}

function readTargetWithLines(targetPath: string, request: GetRequest): GetResult {
  let content: string;
  try {
    content = readFileSync(targetPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { exitCode: 1, stdout: "", stderr: `ukp read: resource disappeared during lookup\n` };
    }
    // A directory tail resolves as a path but is not a readable resource; the
    // failure must state that in product terms instead of leaking the Node
    // errno (`EISDIR: illegal operation on a directory, read`) as the surface.
    if (error instanceof Error && "code" in error && error.code === "EISDIR") {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `ukp read: '${request.path}' is a directory, not a readable resource\n`,
      };
    }
    throw error;
  }
  const rangeResult = applyLineRange(content, request.lines);
  if (rangeResult.kind === "start-beyond-eof") {
    // Word by input origin: a URI #L<line> fragment never mentions --lines.
    const origin = request.addressing === "uri" ? "line window start" : "--lines start";
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `ukp read: ${origin} ${rangeResult.start} is beyond the end of '${request.path}' (${rangeResult.lineCount} lines)\n`,
    };
  }
  return { exitCode: 0, stdout: rangeResult.content, stderr: "" };
}

export function executeGet(request: GetRequest, context: GetContext): GetResult {
  // A docid[:line] handoff key already carries an embedded line; a separate
  // --lines range would double-specify (ADR 0011 / get-qmd-adapter). Strip any
  // leading `#` first so a hash-prefixed `#docid:line` is caught too, even
  // though `#` never appears on the UKP surface.
  const barePath = stripDocidHash(request.path);
  if (request.lines && isBareDocidReference(barePath) && barePath.includes(":")) {
    throw new GetUsageError(
      "a docid[:line] reference already carries a line; do not also pass --lines",
    );
  }

  // Tolerant-addressing pre-pass (ADR-URI-001): the caller's address encoding
  // is the product's job, never a shape the agent must pre-normalize. Two
  // explicit tiers — an absolute filesystem path mapped against the Registry
  // (endpoint inferred), and a document-relative reference resolved against
  // --from. Both rewrite the request to the canonical endpoint+route and echo
  // the mapping on stderr (stdout stays body-only); both fail loud as usage
  // errors, never silently delegating (the weak-reference lesson, ADR 0017).
  const registry = readRegistry(context.registryPath);
  let resolutionNote: string | undefined;
  if (request.addressing !== "uri" && isAbsoluteFilesystemReference(request.path)) {
    if (request.fromRef !== undefined) {
      throw new GetUsageError("an absolute filesystem path cannot be combined with --from");
    }
    if (request.endpoint !== undefined) {
      throw new GetUsageError(
        "an absolute filesystem path carries its own endpoint (matched against registered endpoints); do not also pass --endpoint",
      );
    }
    const mapped = resolveAbsoluteReference(request.path, registry);
    request = { ...request, endpoint: mapped.endpoint, path: mapped.route };
    resolutionNote = `ukp read: absolute path matched endpoint '${mapped.endpoint}', route '${mapped.route}'`;
  } else if (request.fromRef !== undefined) {
    if (request.endpoint === undefined) {
      throw new GetUsageError("--from requires --endpoint <name>");
    }
    if (request.path.startsWith("qmd://") || isBareDocidReference(barePath)) {
      throw new GetUsageError("--from applies to document-relative path references, not provider references");
    }
    const resolved = resolveDocRelativeReference(request.fromRef, request.path);
    resolutionNote = `ukp read: resolved '${request.path}' from '${request.fromRef}' -> '${resolved}'`;
    request = { ...request, path: resolved };
  }

  const result = executeResolvedRead(request, context, registry);
  return resolutionNote === undefined
    ? result
    : { ...result, stderr: `${resolutionNote}\n${result.stderr}` };
}

function executeResolvedRead(
  request: GetRequest,
  context: GetContext,
  registry: ReturnType<typeof readRegistry>,
): GetResult {
  if (request.endpoint === undefined) {
    return { exitCode: 1, stdout: "", stderr: "ukp read: no endpoint selected\n" };
  }
  const scope = resolveScope({
    currentDirectory: context.currentDirectory,
    registry,
    explicitEndpoints: [request.endpoint],
    global: false,
  });
  const [binding] = scope.bindings;
  if (!binding) {
    return { exitCode: 1, stdout: "", stderr: "ukp read: no endpoint selected\n" };
  }

  const service = loadManifest(binding.path);
  if (service.effectiveName !== binding.name) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp read: endpoint '${binding.name}' no longer matches Service effective name '${service.effectiveName}'\n`,
    };
  }

  // QMD-backed route is derived from the declared search provider; there is no
  // explicit get capability in the current Manifest. ADR 0017: QMD visibility
  // governs only the explicit provider tiers (bare docid, qmd://), never the
  // file-native plain-path tier.
  const qmdBacked = service.manifest.capabilities.search?.provider === "qmd";
  const qmdCommand = qmdBacked
    ? context.qmdCommand ?? defaultQmdCommand()
    : undefined;

  // ukp:// URI input (ADR 0014): exact slot addressing. The rel-path must
  // resolve exactly — no filesystem fuzzy fallback and no QMD weak-reference
  // delegation on a miss, and this tier routes BEFORE the qmd:// provider
  // reference check: a rel-path that happens to start with `qmd://` (e.g.
  // `ukp://ep/qmd://abc`) is a literal URI path segment sequence, never a
  // provider-owned reference — the URI's determinism promise outranks
  // provider delegation everywhere. Failures classify per the three-valued
  // taxonomy (dangling-endpoint is raised earlier by scope resolution; here:
  // resource-missing). Containment is the same resolved-realpath check as
  // the explicit file baseline (G5: resolved containment stance).
  if (request.addressing === "uri") {
    let targetPath: string;
    try {
      targetPath = resolveEndpointPath(service.folder, request.path);
    } catch (error) {
      if (error instanceof GetUsageError) {
        return { exitCode: 2, stdout: "", stderr: `ukp read: ${error.message}\n` };
      }
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            `ukp read: resource-missing '${request.path}' in endpoint '${binding.name}' (ukp:// addresses a slot exactly; no fuzzy resolution)\n`,
        };
      }
      throw error;
    }
    return readTargetWithLines(targetPath, request);
  }

  // ukp:// provider reference (non-URI input only; the URI tier above already
  // returned): route before endpoint-local path validation, so the `://`
  // empty segment is never misread as a file-path usage error.
  if (request.path.startsWith("qmd://")) {
    if (!qmdBacked) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `ukp read: qmd:// references require a QMD-backed endpoint; endpoint '${binding.name}' has no QMD get route\n`,
      };
    }
    if (!qmdCommand) {
      return providerUnavailableNoExecutable(binding.name);
    }
    return readViaQmd(qmdCommand, service.folder, request, binding.name);
  }

  // Bare docid[:line] handoff key (ADR 0011) — an explicit provider shape
  // (ADR 0017: shape-based dispatch). It routes to the provider before any
  // filesystem resolution: the fingerprint carries search-handoff intent, and
  // a Service-folder file that happens to be named like a docid must not
  // shadow it. (Recomputed here: the tolerant pre-pass may have rewritten
  // request.path, but a rewritten path is always a plain route, never a docid.)
  const barePath = stripDocidHash(request.path);
  if (isBareDocidReference(barePath)) {
    if (!qmdBacked) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `ukp read: a docid[:line] reference requires a QMD-backed endpoint; endpoint '${binding.name}' has no QMD get route\n`,
      };
    }
    if (!qmdCommand) {
      return providerUnavailableNoExecutable(binding.name);
    }
    return readViaQmd(qmdCommand, service.folder, request, binding.name);
  }

  let targetPath: string;
  try {
    targetPath = resolveEndpointPath(service.folder, request.path);
  } catch (error) {
    if (error instanceof GetUsageError) {
      return { exitCode: 2, stdout: "", stderr: `ukp read: ${error.message}\n` };
    }
    // realpathSync throws ENOENT if path doesn't exist
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // ADR 0017: read is file-native — a plain-path miss is resource-missing
      // on every endpoint; the provider is never entered from a miss. On a
      // QMD-backed endpoint the filesystem scan is advisory only (candidate
      // list for human shorthand recovery); it never resolves the read, so
      // provider collection/ignore visibility is never bypassed by a silent
      // hit (ISSUE-007). Pure file-backed endpoints keep the file layer's
      // own suffix/fuzzy resolution, whose visibility root is the Service
      // folder itself.
      if (qmdBacked) {
        const { serviceReal, suffixMatches, nameFuzzyMatches } = findFilesBySuffix(service.folder, request.path);
        const candidates = [...suffixMatches, ...nameFuzzyMatches]
          .map((m) => `  - ${relative(serviceReal, m).replace(/\\/g, "/")}`);
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            `ukp read: resource-missing '${request.path}' in endpoint '${binding.name}' (plain paths address files exactly; provider reads use a bare docid handoff key or qmd://)`
            + (candidates.length > 0
              ? `\nDid you mean:\n${candidates.join("\n")}\n`
              : "\n"),
        };
      }
      // Pure file-backed: filesystem fuzzy fallback (visibility root is the
      // Service folder itself).
      const { serviceReal, suffixMatches, nameFuzzyMatches } = findFilesBySuffix(service.folder, request.path);

      // Suffix match (filename exact): single match → return directly, multiple → list candidates
      if (suffixMatches.length === 1) {
        targetPath = suffixMatches[0];
      } else if (suffixMatches.length > 1) {
        const matchList = suffixMatches
          .map((m) => `  - ${relative(serviceReal, m).replace(/\\/g, "/")}`)
          .join("\n");
        return {
          exitCode: 1,
          stdout: "",
          stderr: `ukp read: multiple resources match '${request.path}' in endpoint '${binding.name}':\n${matchList}\nUse a more specific path.\n`,
        };
      } else if (nameFuzzyMatches.length > 0) {
        // Name fuzzy match (filename fuzzy): always show candidates
        const matchList = nameFuzzyMatches
          .map((m) => `  - ${relative(serviceReal, m).replace(/\\/g, "/")}`)
          .join("\n");
        return {
          exitCode: 1,
          stdout: "",
          stderr: `ukp read: no exact match for '${request.path}' in endpoint '${binding.name}'.\nDid you mean:\n${matchList}\n`,
        };
      } else {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `ukp read: resource '${request.path}' was not found in endpoint '${binding.name}'\n`,
        };
      }
    } else {
      throw error;
    }
  }

  return readTargetWithLines(targetPath, request);
}
