import { readFileSync, realpathSync } from "node:fs";
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

function resolveEndpointPath(serviceFolder: string, reference: string): string {
  const segments = validateEndpointRelativePath(reference);
  const targetPath = resolve(join(serviceFolder, ...segments));
  // Single containment check via realpath: catches both lexical and symlink escapes
  const serviceReal = realpathSync(serviceFolder);
  const targetReal = realpathSync(targetPath);
  const rel = relative(serviceReal, targetReal);
  if (rel === "" || (rel.startsWith("..") || isAbsolute(rel))) {
    throw new GetUsageError("path must stay inside the selected Service folder");
  }
  return targetReal;
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

  const capability = service.manifest.capabilities.get;
  if (!capability) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp get: endpoint '${binding.name}' does not provide get\nHint: add [capabilities.get] provider = "file" to the Service Manifest when this endpoint should expose endpoint-relative reads.\n`,
    };
  }
  if (capability.provider !== "file") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp get: endpoint '${binding.name}' uses unsupported get provider '${capability.provider}'\n`,
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
      return {
        exitCode: 1,
        stdout: "",
        stderr: `ukp get: resource '${request.path}' was not found in endpoint '${binding.name}'\n`,
      };
    }
    throw error;
  }

  const content = readFileSync(targetPath, "utf8");
  return { exitCode: 0, stdout: applyLineRange(content, request.lines), stderr: "" };
}
