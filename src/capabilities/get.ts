import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";
import { loadManifest } from "../config/manifest.ts";
import { readRegistry } from "../registry.ts";
import { resolveScope } from "../scope.ts";

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
  if (reference.length === 0) throw new GetUsageError("path must be a non-empty endpoint-relative path");
  if (
    isAbsolute(reference)
    || win32.isAbsolute(reference)
    || /^[A-Za-z]:/.test(reference)
    || reference.startsWith("//")
    || reference.startsWith("\\\\")
  ) {
    throw new GetUsageError("path must be endpoint-relative, not absolute");
  }

  const segments = reference.split(/[\\/]/);
  if (segments.some((segment) => segment.length === 0)) {
    throw new GetUsageError("path must not contain empty segments");
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new GetUsageError("path must not contain '.' or '..' segments");
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
    throw new GetUsageError("path must stay inside the selected Service folder");
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

function applyLineRange(content: string, range: LineRange | undefined): string {
  if (!range) return content;
  const lines = content.split(/\r?\n/);
  if (content.endsWith("\n") || content.endsWith("\r\n")) lines.pop();
  const startIndex = range.start - 1;
  const selected = lines.slice(startIndex, range.count === undefined ? undefined : startIndex + range.count);
  return selected.length > 0 ? `${selected.join("\n")}\n` : "";
}

export function executeGet(request: GetRequest, context: GetContext): GetResult {
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

  let targetPath: string;
  try {
    targetPath = resolveEndpointPath(service.folder, request.path);
  } catch (error) {
    if (error instanceof GetUsageError) {
      return { exitCode: 2, stdout: "", stderr: `ukp get: ${error.message}\n` };
    }
    // realpathSync throws ENOENT if path doesn't exist
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // Try fuzzy matching
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
  return { exitCode: 0, stdout: applyLineRange(content, request.lines), stderr: "" };
}
