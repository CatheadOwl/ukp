import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";
import { loadManifest } from "../config/manifest.ts";
import { isRemoteBinding, localPathOf, readRegistry, type RegistryBinding } from "../registry.ts";
import { resolveScope } from "../scope.ts";
import { buildQmdInvocation, defaultQmdCommand, isBareDocidReference, providerTimeoutMs, stripDocidHash, stripQmdHeader, toQmdGetArgument } from "./qmd.ts";
import { isValidPin, pinFromSourceDocument, recoverRenamedResource, type RecoveryCandidate } from "./rename-recovery.ts";
import { isInsideRealRoot, splitEndpointRelativeSegments } from "../path-safety.ts";

export interface ReadRequest {
  /** Undefined only for an absolute filesystem reference, which the
   * capability maps against the Registry before any read (ADR-URI-001
   * tolerant tier); every other tier requires it. */
  endpoint?: string;
  path: string;
  lines?: LineRange;
  /** "uri" = exact slot addressing (ukp:// input, ADR 0014): the path must
   * resolve exactly; no fuzzy fallback and no provider delegation on miss.
   * "absolute" = Registry-mapped absolute path (ADR-URI-001): same exact
   * intent — a miss fails fast with resource-missing and never enters the
   * filesystem candidate scan (which on large endpoints is pathologically
   * slow; BB-006 Run 2 evidence: 118s no-output on a miss). */
  addressing?: "uri" | "absolute";
  /** Document-relative context (ADR-URI-001 tolerant tier): the
   * endpoint-relative route of the source document the reference was copied
   * from. `path` is then resolved against that document's directory. */
  fromRef?: string;
  /** Consumer-pinned content hash (`sha256-<64 hex>`, ADR 0020 / spec
   * read-rename-recovery): the ukp-pin verification key for the miss-path
   * recovery descent. Absent = stale-unknown verification. */
  pin?: string;
  /** The reference exactly as the caller wrote it before tolerant-tier
   * rewriting — used to locate the same-line ukp-pin annotation in the
   * --from source document (Q1 spelling). */
  sourceReference?: string;
}

export interface LineRange {
  start: number;
  count?: number;
}

export interface ReadContext {
  currentDirectory: string;
  registryPath: string;
  qmdCommand?: readonly string[];
}

/** Tolerant-addressing resolution provenance (ADR-URI-001): the factual echo
 * of the request rewrite. Structured so a non-CLI surface can hand the
 * consumer back the canonical endpoint+route instead of parsing stderr. */
export interface ReadResolution {
  kind: "absolute-mapped" | "doc-relative";
  /** Factual echo body without the `ukp read:` prefix. */
  note: string;
}

/** Rename-recovery metadata (ADR 0020 / spec read-rename-recovery). `from`
 * carries the original route so the success echo is renderable from data. */
export interface ReadRecoveryMeta {
  from: string;
  attempted: string[];
  outcome: "recovered" | "exhausted";
  recoveredTo?: string;
  layer?: string;
  verification?: string;
  candidates?: RecoveryCandidate[];
}

/** ADR 0021 error classification — lifted from the word-level taxonomy that
 * already lived in the stderr wording (`provider-unavailable:`,
 * `resource-missing:`, `provider-timeout`, ...). Exit codes are adapter
 * renderings of these classes. */
export type ReadErrorClass =
  | "no-endpoint"
  | "endpoint-name-mismatch"
  | "provider-unavailable"
  | "provider-timeout"
  | "provider-cancelled"
  | "provider-incompatible"
  | "provider-no-content"
  | "resource-missing"
  | "qmd-route-unavailable"
  | "resource-disappeared"
  | "resource-is-directory"
  | "start-beyond-eof"
  | "ambiguous-match"
  | "no-exact-match"
  | "resource-not-found"
  /** Inline tier-validation failures (containment escape, lexical path
   * violations re-checked at execution): exit 2 with a bare message, unlike
   * parse-layer usage errors which render the usage block. */
  | "usage-error";

export interface ReadFailure {
  errorClass: ReadErrorClass;
  /** Factual message body — no `ukp read:` prefix (the adapter adds it once,
   * on the first line). May be multi-line; embedded recovery-hint wording is
   * known debt of the same class as search warnings (envelope/byte
   * compatibility first). */
  message: string;
  recovery?: ReadRecoveryMeta;
  resolution?: ReadResolution;
}

/** ADR 0021 payload-type success: the resource body IS the contract (stdout
 * purity); echoes, recovery metadata, and warnings are sideband fields. */
export interface ReadSuccess {
  content: string;
  recovery?: ReadRecoveryMeta;
  /** Recovery-descent warnings (factual lines; adapter prefixes each). */
  recoveryWarnings: string[];
  resolution?: ReadResolution;
}

export type ReadOutcome =
  | { ok: true; result: ReadSuccess }
  | { ok: false; failure: ReadFailure };

export class ReadUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadUsageError";
  }
}

function readFailure(
  errorClass: ReadErrorClass,
  message: string,
  recovery?: ReadRecoveryMeta,
): ReadOutcome {
  return { ok: false, failure: recovery ? { errorClass, message, recovery } : { errorClass, message } };
}

/** provider-unavailable classification for "no qmd executable at all" — the
 * read channel is absent, which is the same recovery class as a spawn
 * failure (install/verify qmd), never resource-missing. */
function providerUnavailableNoExecutable(endpointName: string): ReadOutcome {
  return readFailure(
    "provider-unavailable",
    `provider-unavailable: the QMD read channel for endpoint '${endpointName}' has no usable qmd executable.\n`
      + `Browse the endpoint with 'ukp nav --endpoint ${endpointName}' or install qmd, then retry.`,
  );
}

function validateEndpointRelativePath(reference: string): string[] {
  if (reference.length === 0) throw new ReadUsageError("reference must be a non-empty endpoint-scoped reference");
  // Path-safety primitive (ADR 0023): verdicts shared, error wording local.
  const result = splitEndpointRelativeSegments(reference);
  if (!result.ok) {
    if (result.reason === "absolute") {
      throw new ReadUsageError("reference must be endpoint-scoped, not absolute");
    }
    if (result.reason === "empty-segment") {
      throw new ReadUsageError("reference must not contain empty path segments");
    }
    throw new ReadUsageError("reference must not contain '.' or '..' path segments");
  }
  return result.segments;
}

function resolveEndpointPath(serviceFolder: string, reference: string): string {
  const segments = validateEndpointRelativePath(reference);
  const targetPath = resolve(join(serviceFolder, ...segments));
  // Single containment check via realpath: catches both lexical and symlink escapes
  const serviceReal = realpathSync(serviceFolder);
  const targetReal = realpathSync(targetPath);
  if (!isInsideRealRoot(serviceReal, targetReal)) {
    throw new ReadUsageError("reference must stay inside the selected Service folder when resolved as a file");
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
        throw new ReadUsageError(
          `'${reference}' (from '${fromRef}') resolves outside the endpoint`,
        );
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new ReadUsageError(
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
  registry: readonly RegistryBinding[],
): { endpoint: string; route: string } {
  const matches: { endpoint: string; route: string }[] = [];
  for (const binding of registry) {
    if (isRemoteBinding(binding) || binding.path === undefined) continue;
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
    if (!isInsideRealRoot(serviceReal, target)) continue;
    matches.push({
      endpoint: binding.name,
      route: relative(serviceReal, target).replace(/\\/g, "/"),
    });
  }
  if (matches.length === 0) {
    const names = registry.map((binding) => binding.name).join(", ");
    throw new ReadUsageError(
      `absolute reference '${reference}' matches no registered endpoint`
        + (names.length > 0 ? ` (registered: ${names})` : " (no endpoints registered)"),
    );
  }
  if (matches.length > 1) {
    const list = matches.map((match) => `${match.endpoint} (${match.route})`).join(", ");
    throw new ReadUsageError(
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

/** Budget for the human-shorthand candidate scan. The scan is advisory only
 * (Did-you-mean), so it is bounded: beyond this many files scanned it stops
 * with whatever it has collected. The walk itself is cheap — the per-file
 * name filter below rejects non-matching entries before ANY filesystem
 * syscall (realpathSync per file on a large endpoint was the BB-006 Run 2
 * pathology: 118s on a miss), so this budget is a safety net, not the fix.
 * `UKP_CANDIDATE_SCAN_FILE_BUDGET` overrides (min 1) so the trigger branch
 * is testable without materializing 20k files. */
function candidateScanFileBudget(): number {
  const raw = process.env.UKP_CANDIDATE_SCAN_FILE_BUDGET;
  if (raw !== undefined && /^\d+$/.test(raw) && Number(raw) >= 1) return Number(raw);
  return 20_000;
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
  let filesScanned = 0;

  function scan(currentPath: string): void {
    if (filesScanned > candidateScanFileBudget()) return;
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
          if (!isInsideRealRoot(serviceReal, canonicalPath)) {
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
        filesScanned += 1;
        // Cheap name filter BEFORE any per-file syscall: both match checks
        // below are gated on the entry name (exact or normalized), so a
        // non-matching name can skip realpathSync/relative entirely. On a
        // large endpoint this is the difference between a cheap readdir walk
        // and a per-file realpath storm (BB-006 Run 2: 118s miss).
        const nameExact = entry.name === targetFileName;
        if (!nameExact && normalizeFilename(entry.name) !== normalizedTargetName) {
          continue;
        }
        const fileReal = isSymlink ? canonicalPath : realpathSync(canonicalPath);
        const relPath = relative(serviceReal, fileReal).replace(/\\/g, "/");

        // Check 1: Exact suffix match (filename exact, path fuzzy)
        if (nameExact) {
          if (relPath === normalizedSuffix || relPath.endsWith("/" + normalizedSuffix)) {
            if (isInsideRealRoot(serviceReal, fileReal)) {
              suffixMatches.add(fileReal);
              continue;
            }
          }
        }

        // Check 2: Name fuzzy match (filename fuzzy with -/_ normalization, ignoring extension)
        // Also check path prefix if the user specified one
        if (normalizeFilename(entry.name) === normalizedTargetName) {
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
          if (isInsideRealRoot(serviceReal, fileReal)) {
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
 * read/file exit contract, which must match read/qmd (where an empty provider
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
  request: ReadRequest,
  endpointName: string,
): ReadOutcome {
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
    timeout: providerTimeoutMs(),
  });

  if (result.signal === "SIGTERM") {
    // Zero-output hang audit: a provider that never responds must land in a
    // classified failure, not silence. spawnSync kills with SIGTERM on timeout.
    return readFailure(
      "provider-timeout",
      `provider-timeout: the QMD read channel for endpoint '${endpointName}' did not respond within ${providerTimeoutMs() / 1000}s.\n`
        + `Verify the qmd installation or set UKP_PROVIDER_TIMEOUT_MS, then retry.`,
    );
  }

  if (result.error) {
    // provider-unavailable, not resource-missing: the read channel itself
    // could not start (spawn failure — qmd missing, or an unstartable shim
    // form). The two classes drive completely different recovery actions, so
    // the wording must classify and point at recovery paths.
    const detail = result.error instanceof Error ? result.error.message : String(result.error);
    return readFailure(
      "provider-unavailable",
      `provider-unavailable: the QMD read channel for endpoint '${endpointName}' could not start (${detail}).\n`
        + `Browse the endpoint with 'ukp nav --endpoint ${endpointName}' or verify the qmd installation, then retry.`,
    );
  }
  if (result.signal === "SIGINT" || result.status === 130) {
    return readFailure("provider-cancelled", "provider cancelled");
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
      return readFailure(
        "provider-incompatible",
        "qmd build does not support '--no-line-numbers'; provider incompatible",
      );
    }
    const providerError = rawProviderError
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return readFailure(
      "resource-missing",
      `resource-missing: '${request.path}' could not be resolved by the provider in endpoint '${endpointName}'`
        + (providerError ? `\n(provider: ${providerError})` : ""),
    );
  }

  const body = stripQmdHeader(result.stdout ?? "");
  if (body.length === 0) {
    return readFailure(
      "provider-no-content",
      `provider returned no content for '${request.path}' in endpoint '${endpointName}'`,
    );
  }
  return { ok: true, result: { content: body, recoveryWarnings: [] } };
}

/**
 * Miss-path rename recovery (ADR 0020 / spec read-rename-recovery): run the
 * layered descent for a slot miss and, on recovery, read the proposed route
 * with the same line-window contract. Returns either the recovered read
 * (echo + warnings prepended on stderr, `recovery` metadata attached) or a
 * marker the miss site merges into its existing resource-missing wording
 * (plus advisory candidates). Provider shapes never enter here (spec:
 * recovery is a file-slot concern); the L2 search layer runs only when the
 * endpoint declares a qmd search capability, and its absence is silent.
 */
function attemptRenameRecovery(
  request: ReadRequest,
  endpointName: string,
  serviceFolder: string,
  qmdCommand: readonly string[] | undefined,
  pin: string | undefined,
): { kind: "recovered"; outcome: ReadOutcome } | { kind: "exhausted"; recovery: ReadRecoveryMeta } {
  const outcome = recoverRenamedResource({
    route: request.path,
    endpointName,
    serviceFolder,
    ...(pin !== undefined ? { pin } : {}),
    ...(qmdCommand !== undefined ? { qmdCommand } : {}),
  });
  const recovery: ReadRecoveryMeta = {
    from: request.path,
    attempted: outcome.attempted,
    outcome: outcome.status,
    ...(outcome.recoveredRoute !== undefined ? { recoveredTo: outcome.recoveredRoute } : {}),
    ...(outcome.layer !== undefined ? { layer: outcome.layer } : {}),
    ...(outcome.verification !== undefined ? { verification: outcome.verification } : {}),
    ...(outcome.candidates.length > 0 ? { candidates: outcome.candidates } : {}),
  };
  if (outcome.status === "recovered" && outcome.recoveredRoute !== undefined) {
    try {
      const targetPath = resolveEndpointPath(serviceFolder, outcome.recoveredRoute);
      const read = readTargetWithLines(targetPath, { ...request, path: outcome.recoveredRoute });
      if (read.ok) {
        // Success sideband: echo + warnings render from structured fields.
        return {
          kind: "recovered",
          outcome: { ok: true, result: { ...read.result, recovery, recoveryWarnings: outcome.warnings } },
        };
      }
      // The proposed route failed its own read (e.g. start-beyond-eof): the
      // recovery found the resource but the read contract still governs —
      // surface that failure rather than hiding behind resource-missing.
      return { kind: "recovered", outcome: { ...read, failure: { ...read.failure, recovery } } };
    } catch {
      // Proposed route vanished or escaped containment mid-recovery: fall
      // through to exhaustion (recorded below with the attempted layers).
    }
  }
  return { kind: "exhausted", recovery };
}

/** Advisory recovery candidates appended to a resource-missing miss (spec
 * read-rename-recovery): pin-rejected and search-recalled routes the consumer
 * may confirm manually. Empty input renders nothing. */
function formatRecoveryCandidates(candidates: readonly RecoveryCandidate[] | undefined): string {
  if (!candidates || candidates.length === 0) return "";
  const lines = candidates.map((candidate) => `  - ${candidate.path} (recovery candidate, ${candidate.verified})`);
  return `Rename recovery candidates:\n${lines.join("\n")}\n`;
}

function readTargetWithLines(targetPath: string, request: ReadRequest): ReadOutcome {
  let content: string;
  try {
    content = readFileSync(targetPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return readFailure("resource-disappeared", "resource disappeared during lookup");
    }
    // A directory tail resolves as a path but is not a readable resource; the
    // failure must state that in operator-facing terms instead of leaking the Node
    // errno (`EISDIR: illegal operation on a directory, read`) as the surface.
    if (error instanceof Error && "code" in error && error.code === "EISDIR") {
      return readFailure(
        "resource-is-directory",
        `'${request.path}' is a directory, not a readable resource`,
      );
    }
    throw error;
  }
  const rangeResult = applyLineRange(content, request.lines);
  if (rangeResult.kind === "start-beyond-eof") {
    // Word by input origin: a URI #L<line> fragment never mentions --lines.
    const origin = request.addressing === "uri" ? "line window start" : "--lines start";
    return readFailure(
      "start-beyond-eof",
      `${origin} ${rangeResult.start} is beyond the end of '${request.path}' (${rangeResult.lineCount} lines)`,
    );
  }
  return { ok: true, result: { content: rangeResult.content, recoveryWarnings: [] } };
}

/** ADR 0021 core entry: runs the read capability and returns the structured
 * outcome. Parse-layer usage errors and scope/manifest failures still throw
 * typed errors for the surface adapter to map; execution-tier usage
 * violations classify as `usage-error` failures (exit-2 class). */
export function runRead(request: ReadRequest, context: ReadContext): ReadOutcome {
  // A docid[:line] handoff key already carries an embedded line; a separate
  // --lines range would double-specify (ADR 0011 / read-qmd-adapter). Strip any
  // leading `#` first so a hash-prefixed `#docid:line` is caught too, even
  // though `#` never appears on the UKP surface.
  const barePath = stripDocidHash(request.path);
  if (request.lines && isBareDocidReference(barePath) && barePath.includes(":")) {
    throw new ReadUsageError(
      "a docid[:line] reference already carries a line; do not also pass --lines",
    );
  }

  // Tolerant-addressing pre-pass (ADR-URI-001): the caller's address encoding
  // is UKP's job, never a shape the agent must pre-normalize. Two
  // explicit tiers — an absolute filesystem path mapped against the Registry
  // (endpoint inferred), and a document-relative reference resolved against
  // --from. Both rewrite the request to the canonical endpoint+route and
  // record the mapping as structured resolution provenance (echoed on stderr
  // by the adapter; stdout stays body-only); both fail loud as usage
  // errors, never silently delegating (the weak-reference lesson, ADR 0017).
  const registry = readRegistry(context.registryPath);
  let resolution: ReadResolution | undefined;
  if (request.addressing !== "uri" && isAbsoluteFilesystemReference(request.path)) {
    if (request.fromRef !== undefined) {
      throw new ReadUsageError("an absolute filesystem path cannot be combined with --from");
    }
    if (request.endpoint !== undefined) {
      throw new ReadUsageError(
        "an absolute filesystem path carries its own endpoint (matched against registered endpoints); do not also pass --endpoint",
      );
    }
    const mapped = resolveAbsoluteReference(request.path, registry);
    request = { ...request, endpoint: mapped.endpoint, path: mapped.route, addressing: "absolute" };
    resolution = {
      kind: "absolute-mapped",
      note: `absolute path matched endpoint '${mapped.endpoint}', route '${mapped.route}'`,
    };
  } else if (request.fromRef !== undefined) {
    if (request.endpoint === undefined) {
      throw new ReadUsageError("--from requires --endpoint <name>");
    }
    if (request.path.startsWith("qmd://") || isBareDocidReference(barePath)) {
      throw new ReadUsageError("--from applies to document-relative path references, not provider references");
    }
    const resolved = resolveDocRelativeReference(request.fromRef, request.path);
    resolution = {
      kind: "doc-relative",
      note: `resolved '${request.path}' from '${request.fromRef}' -> '${resolved}'`,
    };
    // Keep the verbatim reference for same-line ukp-pin extraction (Q1).
    request = { ...request, path: resolved, sourceReference: request.path };
  }

  const outcome = executeResolvedRead(request, context, registry);
  if (resolution === undefined) return outcome;
  return outcome.ok
    ? { ok: true, result: { ...outcome.result, resolution } }
    : { ok: false, failure: { ...outcome.failure, resolution } };
}

function executeResolvedRead(
  request: ReadRequest,
  context: ReadContext,
  registry: ReturnType<typeof readRegistry>,
): ReadOutcome {
  if (request.endpoint === undefined) {
    return readFailure("no-endpoint", "no endpoint selected");
  }
  const scope = resolveScope({
    currentDirectory: context.currentDirectory,
    registry,
    explicitEndpoints: [request.endpoint],
    global: false,
  });
  const [binding] = scope.bindings;
  if (!binding) {
    return readFailure("no-endpoint", "no endpoint selected");
  }
  if (isRemoteBinding(binding)) {
    // Defensive: the read adapter routes remote endpoints through the
    // remote transport before runRead is reached.
    return readFailure(
      "provider-incompatible",
      `endpoint '${binding.name}' is remote (${binding.url}); remote reads route through the remote transport`,
    );
  }

  const service = loadManifest(localPathOf(binding));
  if (service.effectiveName !== binding.name) {
    return readFailure(
      "endpoint-name-mismatch",
      `endpoint '${binding.name}' no longer matches Service effective name '${service.effectiveName}'`,
    );
  }

  // ukp-pin from the --from source document (Q1 same-line spelling): the
  // consumer's verification key travels with the reference, not the command.
  let pin = request.pin;
  if (pin === undefined && request.fromRef !== undefined && request.sourceReference !== undefined) {
    pin = pinFromSourceDocument(request.fromRef, request.sourceReference, service.folder);
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
      if (error instanceof ReadUsageError) {
        return readFailure("usage-error", error.message);
      }
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        // ADR 0020 miss-path recovery: the URI slot missed, so descend the
        // layered stack (git-derived -> search re-anchor) before classifying.
        const recovered = attemptRenameRecovery(request, binding.name, service.folder, qmdCommand, pin);
        if (recovered.kind === "recovered") return recovered.outcome;
        return readFailure(
          "resource-missing",
          `resource-missing '${request.path}' in endpoint '${binding.name}' (ukp:// addresses a slot exactly; no fuzzy resolution)\n`
            + formatRecoveryCandidates(recovered.recovery.candidates).trimEnd(),
          recovered.recovery,
        );
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
      return readFailure(
        "qmd-route-unavailable",
        `qmd:// references require a QMD-backed endpoint; endpoint '${binding.name}' has no QMD get route`,
      );
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
      return readFailure(
        "qmd-route-unavailable",
        `a docid[:line] reference requires a QMD-backed endpoint; endpoint '${binding.name}' has no QMD get route`,
      );
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
    if (error instanceof ReadUsageError) {
      return readFailure("usage-error", error.message);
    }
    // realpathSync throws ENOENT if path doesn't exist
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // Absolute-tier miss (ADR-URI-001): the input carried exact intent (a
      // Registry-mapped absolute path), so there is no human-shorthand to
      // recover from — fail fast with resource-missing and never enter the
      // candidate scan (BB-006 Run 2 evidence: scanning a large external
      // endpoint on such a miss took 118s with zero output).
      if (request.addressing === "absolute") {
        const recovered = attemptRenameRecovery(request, binding.name, service.folder, qmdCommand, pin);
        if (recovered.kind === "recovered") return recovered.outcome;
        return readFailure(
          "resource-missing",
          `resource-missing '${request.path}' in endpoint '${binding.name}'`
            + ` (absolute paths address files exactly; the mapped route does not exist — the target may live one level deeper, e.g. under src/)\n`
            + formatRecoveryCandidates(recovered.recovery.candidates).trimEnd(),
          recovered.recovery,
        );
      }
      // ADR 0017: read is file-native — a plain-path miss is resource-missing
      // on every endpoint; the provider is never entered from a miss. On a
      // QMD-backed endpoint the filesystem scan is advisory only (candidate
      // list for human shorthand recovery); it never resolves the read, so
      // provider collection/ignore visibility is never bypassed by a silent
      // hit. Pure file-backed endpoints keep the file layer's
      // own suffix/fuzzy resolution, whose visibility root is the Service
      // folder itself.
      if (qmdBacked) {
        const recovered = attemptRenameRecovery(request, binding.name, service.folder, qmdCommand, pin);
        if (recovered.kind === "recovered") return recovered.outcome;
        const { serviceReal, suffixMatches, nameFuzzyMatches } = findFilesBySuffix(service.folder, request.path);
        const candidates = [...suffixMatches, ...nameFuzzyMatches]
          .map((m) => `  - ${relative(serviceReal, m).replace(/\\/g, "/")}`);
        // Shape-tailored miss wording (BB-006 evidence): never mention docid/
        // qmd:// here — a file-surface consumer misread that parenthetical as
        // a hint and detoured into a docid miss. Discovery pointers only.
        const shapeHint = request.path.includes("/")
          ? `Browse the endpoint with 'ukp nav --endpoint ${binding.name}'`
          : `For a document-relative reference use '--from <route>', or browse with 'ukp nav --endpoint ${binding.name}'`;
        return readFailure(
          "resource-missing",
          `resource-missing '${request.path}' in endpoint '${binding.name}' (plain paths and ukp:// URIs address files exactly; no fuzzy resolution)\n`
            + `${shapeHint}.`
            + (candidates.length > 0
              ? `\nDid you mean:\n${candidates.join("\n")}`
              : "")
            + (recovered.recovery.candidates && recovered.recovery.candidates.length > 0
              ? `\n${formatRecoveryCandidates(recovered.recovery.candidates).trimEnd()}`
              : ""),
          recovered.recovery,
        );
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
        return readFailure(
          "ambiguous-match",
          `multiple resources match '${request.path}' in endpoint '${binding.name}':\n${matchList}\nUse a more specific path.`,
        );
      } else if (nameFuzzyMatches.length > 0) {
        // Name fuzzy match (filename fuzzy): always show candidates
        const matchList = nameFuzzyMatches
          .map((m) => `  - ${relative(serviceReal, m).replace(/\\/g, "/")}`)
          .join("\n");
        return readFailure(
          "no-exact-match",
          `no exact match for '${request.path}' in endpoint '${binding.name}'.\nDid you mean:\n${matchList}`,
        );
      } else {
        const recovered = attemptRenameRecovery(request, binding.name, service.folder, undefined, pin);
        if (recovered.kind === "recovered") return recovered.outcome;
        return readFailure(
          "resource-not-found",
          `resource '${request.path}' was not found in endpoint '${binding.name}'`
            + (recovered.recovery.candidates && recovered.recovery.candidates.length > 0
              ? `\n${formatRecoveryCandidates(recovered.recovery.candidates).trimEnd()}`
              : ""),
          recovered.recovery,
        );
      }
    } else {
      throw error;
    }
  }

  return readTargetWithLines(targetPath, request);
}

// ---------------------------------------------------------------------------
// Presentation (ADR 0021 two-stage form). read is a payload-type capability:
// stdout is the resource body itself; every echo/warning/diagnostic is a
// sideband rendered onto stderr by the shared render below. Adapters must
// consume these — never re-parse rendered text (the old --format json path
// regex-extracted the error class out of stderr; the class is data now).
// ---------------------------------------------------------------------------

/** Success sideband lines: resolution echo, recovery echo, then recovery
 * warnings — composed from structured fields, `ukp read:` prefixes added
 * here (CLI wording, not capability data). */
function renderReadSideband(result: ReadSuccess): string {
  const parts: string[] = [];
  if (result.resolution !== undefined) {
    parts.push(`ukp read: ${result.resolution.note}`);
  }
  if (result.recovery?.outcome === "recovered" && result.recovery.recoveredTo !== undefined) {
    const layerLabel = result.recovery.layer === "search-reanchor" ? "search re-anchor" : "git history";
    parts.push(`ukp read: recovered: '${result.recovery.from}' moved to '${result.recovery.recoveredTo}' (${layerLabel})`);
  }
  for (const warning of result.recoveryWarnings) {
    parts.push(`ukp read: warning: ${warning}`);
  }
  return parts.map((part) => `${part}\n`).join("");
}

/** Human rendering of an outcome, in surface-neutral terms: `body` is the
 * payload (the CLI prints it on stdout), `diagnostics` is the sideband
 * (echoes/warnings/failure message — the CLI prints it on stderr). Channel
 * assignment belongs to adapters, so the presentation view stays
 * surface-neutral. */
export interface ReadHumanView {
  body: string;
  diagnostics: string;
}

export function renderReadHuman(outcome: ReadOutcome): ReadHumanView {
  if (outcome.ok) {
    return { body: outcome.result.content, diagnostics: renderReadSideband(outcome.result) };
  }
  const failure = outcome.failure;
  const prefix = failure.resolution !== undefined ? `ukp read: ${failure.resolution.note}\n` : "";
  const message = failure.message.endsWith("\n") ? failure.message : `${failure.message}\n`;
  return { body: "", diagnostics: `${prefix}ukp read: ${message}` };
}

/** `--format json` envelope (spec read-rename-recovery). Failure class is
 * data (`failure.errorClass`); only the three word-level classes that the
 * published envelope vocabulary defines surface as-is, `usage-error` keeps
 * its name, everything else maps to `error` — identical to the envelope the
 * text-regex extraction produced. */
export interface ReadEnvelope {
  ok: boolean;
  endpoint?: string;
  reference: string;
  recovered_to?: string;
  error?: {
    class: string;
    message: string;
    recovery?: {
      attempted: string[];
      outcome: string;
      recovered_to?: string;
      candidates?: RecoveryCandidate[];
    };
  };
}

export function projectReadEnvelope(request: ReadRequest, outcome: ReadOutcome): ReadEnvelope {
  if (outcome.ok) {
    return {
      ok: true,
      ...(request.endpoint !== undefined ? { endpoint: request.endpoint } : {}),
      reference: request.path,
      ...(outcome.result.recovery?.recoveredTo !== undefined
        ? { recovered_to: outcome.result.recovery.recoveredTo }
        : {}),
    };
  }
  const failure = outcome.failure;
  const wordLevel = failure.errorClass === "resource-missing"
    || failure.errorClass === "provider-unavailable"
    || failure.errorClass === "provider-timeout";
  const errorClass = failure.errorClass === "usage-error"
    ? "usage-error"
    : wordLevel
      ? failure.errorClass
      : "error";
  const firstLine = failure.message.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  return {
    ok: false,
    ...(request.endpoint !== undefined ? { endpoint: request.endpoint } : {}),
    reference: request.path,
    error: {
      class: errorClass,
      message: firstLine,
      ...(failure.recovery !== undefined
        ? {
          recovery: {
            attempted: failure.recovery.attempted,
            outcome: failure.recovery.outcome,
            ...(failure.recovery.recoveredTo !== undefined ? { recovered_to: failure.recovery.recoveredTo } : {}),
            ...(failure.recovery.candidates !== undefined ? { candidates: failure.recovery.candidates } : {}),
          },
        }
        : {}),
    },
  };
}
