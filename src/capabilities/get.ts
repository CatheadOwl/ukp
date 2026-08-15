import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";
import { loadManifest } from "../config/manifest.ts";
import { readRegistry } from "../registry.ts";
import { resolveScope } from "../scope.ts";
import { defaultQmdCommand, isBareDocidReference, stripDocidHash, stripQmdHeader, toQmdGetArgument } from "./qmd.ts";

export interface GetRequest {
  endpoint: string;
  path: string;
  lines?: LineRange;
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
 * Read an unresolved reference through the QMD-backed get adapter.
 *
 * UKP delegates resolution and read to QMD in one provider-owned operation.
 * The adapter re-adds the `#` to a bare docid handoff key (ADR 0011) so QMD
 * resolves it by content fingerprint, strips the provider header so stdout
 * starts at the body, and keeps UKP's exit/error discipline without leaking
 * QMD internals as traces.
 */
function readViaQmd(
  qmdCommand: readonly string[],
  serviceFolder: string,
  request: GetRequest,
  endpointName: string,
): GetResult {
  const command = [
    ...qmdCommand,
    "get",
    toQmdGetArgument(request.path, request.lines),
    "--no-line-numbers",
  ];
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd: serviceFolder,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    return { exitCode: 1, stdout: "", stderr: "ukp get: failed to run qmd\n" };
  }
  if (result.signal === "SIGINT" || result.status === 130) {
    return { exitCode: 130, stdout: "", stderr: "ukp get: provider cancelled\n" };
  }
  if (result.status !== 0) {
    const providerError = (result.stderr ?? "").trim();
    if (
      providerError.includes("no-line-numbers")
      || providerError.includes("unknown option")
      || providerError.includes("unknown flag")
    ) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "ukp get: qmd build does not support '--no-line-numbers'; provider incompatible\n",
      };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: providerError
        ? `ukp get: ${providerError}\n`
        : `ukp get: resource '${request.path}' could not be resolved in endpoint '${endpointName}'\n`,
    };
  }

  const body = stripQmdHeader(result.stdout ?? "");
  if (body.length === 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp get: provider returned no content for '${request.path}' in endpoint '${endpointName}'\n`,
    };
  }
  return { exitCode: 0, stdout: body, stderr: "" };
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

  const registry = readRegistry(context.registryPath);
  const scope = resolveScope({
    currentDirectory: context.currentDirectory,
    registry,
    explicitEndpoints: [request.endpoint],
    global: false,
  });
  const [binding] = scope.bindings;
  if (!binding) {
    return { exitCode: 1, stdout: "", stderr: "ukp get: no endpoint selected\n" };
  }

  const service = loadManifest(binding.path);
  if (service.effectiveName !== binding.name) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp get: endpoint '${binding.name}' no longer matches Service effective name '${service.effectiveName}'\n`,
    };
  }

  // QMD-backed route is derived from the declared search provider; there is no
  // explicit get capability in the current Manifest. QMD visibility governs only
  // this unresolved-reference delegation, never the explicit file baseline.
  const qmdBacked = service.manifest.capabilities.search?.provider === "qmd";
  const qmdCommand = qmdBacked
    ? context.qmdCommand ?? defaultQmdCommand()
    : undefined;

  // qmd:// provider reference: route before endpoint-local path validation, so
  // the `://` empty segment is never misread as a file-path usage error.
  if (request.path.startsWith("qmd://")) {
    if (!qmdBacked) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `ukp get: qmd:// references require a QMD-backed endpoint; endpoint '${binding.name}' has no QMD get route\n`,
      };
    }
    if (!qmdCommand) {
      return { exitCode: 1, stdout: "", stderr: "ukp get: qmd executable is not available\n" };
    }
    return readViaQmd(qmdCommand, service.folder, request, binding.name);
  }

  let targetPath: string;
  try {
    targetPath = resolveEndpointPath(service.folder, request.path);
  } catch (error) {
    if (error instanceof GetUsageError) {
      return { exitCode: 2, stdout: "", stderr: `ukp get: ${error.message}\n` };
    }
    // realpathSync throws ENOENT if path doesn't exist
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // QMD-backed: delegate resolution to the provider; do not fuzzy-scan the
      // Service folder (that would bypass QMD's collection/ignore visibility).
      if (qmdBacked) {
        if (!qmdCommand) {
          return { exitCode: 1, stdout: "", stderr: "ukp get: qmd executable is not available\n" };
        }
        return readViaQmd(qmdCommand, service.folder, request, binding.name);
      }
      // Pure file-backed: filesystem fuzzy fallback (visibility root is the
      // Service folder itself).
      const { serviceReal, suffixMatches, nameFuzzyMatches } = findFilesBySuffix(service.folder, request.path);

      // Suffix match (filename exact): single match → return directly, multiple → list candidates
      if (suffixMatches.length === 1) {
        targetPath = suffixMatches[0];
      } else if (suffixMatches.length > 1) {
        const matchList = suffixMatches
          .map((m) => `  - ${relative(serviceReal, m)}`)
          .join("\n");
        return {
          exitCode: 1,
          stdout: "",
          stderr: `ukp get: multiple resources match '${request.path}' in endpoint '${binding.name}':\n${matchList}\nUse a more specific path.\n`,
        };
      } else if (nameFuzzyMatches.length > 0) {
        // Name fuzzy match (filename fuzzy): always show candidates
        const matchList = nameFuzzyMatches
          .map((m) => `  - ${relative(serviceReal, m)}`)
          .join("\n");
        return {
          exitCode: 1,
          stdout: "",
          stderr: `ukp get: no exact match for '${request.path}' in endpoint '${binding.name}'.\nDid you mean:\n${matchList}\n`,
        };
      } else {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `ukp get: resource '${request.path}' was not found in endpoint '${binding.name}'\n`,
        };
      }
    } else {
      throw error;
    }
  }

  let content: string;
  try {
    content = readFileSync(targetPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { exitCode: 1, stdout: "", stderr: `ukp get: resource disappeared during lookup\n` };
    }
    throw error;
  }
  const rangeResult = applyLineRange(content, request.lines);
  if (rangeResult.kind === "start-beyond-eof") {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `ukp get: --lines start ${rangeResult.start} is beyond the end of '${request.path}' (${rangeResult.lineCount} lines)\n`,
    };
  }
  return { exitCode: 0, stdout: rangeResult.content, stderr: "" };
}
