import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { ENDPOINT_NAME, loadManifest, type ManifestCapability } from "../config/manifest.ts";
import { resolveFileNativeCapability, unsupportedFileNativeProviderMessage } from "../config/file-native.ts";
import { localPathOf, readRegistry } from "../registry.ts";
import { resolveScope } from "../scope.ts";
import { acquireLock, LockBusyError, releaseLock } from "../fslock.ts";

// The slug profile (1–63 chars, strict lowercase ASCII slug) shares the
// endpoint-name grammar, so the Manifest pattern is reused deliberately.
export const PROPOSE_SLUG = ENDPOINT_NAME;

export const DEFAULT_PROPOSE_FOLDER = "inbox";

// Service-maintained frontmatter keys: always owned by the Service side of
// the upsert; never accepted from submitted content (injected values are
// stripped — see spec/file-provider.md, W1 decision).
const SERVICE_KEYS = new Set(["id", "status", "revision", "created", "updated"]);

export type ProposeStatus = "created" | "unchanged" | "updated";

export interface ProposeResult {
  id: string;
  status: ProposeStatus;
  revision: number;
}

export class ProposeProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProposeProviderError";
  }
}

export class ProposeBusyError extends ProposeProviderError {
  constructor(id: string) {
    // No provider location on any client-facing surface (probe 20260906).
    super(`proposal '${id}' is locked by another submission; retry shortly`);
    this.name = "ProposeBusyError";
  }
}

export function assertProposeSlug(id: string): void {
  if (!PROPOSE_SLUG.test(id)) {
    throw new ProposeProviderError(
      `invalid proposal id '${id}': expected 1-63 lowercase ASCII slug characters ([a-z0-9-])`,
    );
  }
}

// Resolves the file-provider folder for a propose capability declaration.
// The folder is Service-owned config, relative to the Service folder.
export function resolveProposeFolder(serviceFolder: string, capability: ManifestCapability): string {
  if (capability.provider !== "file") {
    throw new ProposeProviderError(unsupportedFileNativeProviderMessage("propose", capability.provider));
  }
  const rawFolder = capability.config?.folder;
  let folder = DEFAULT_PROPOSE_FOLDER;
  if (rawFolder !== undefined) {
    if (typeof rawFolder !== "string" || rawFolder.length === 0) {
      throw new ProposeProviderError("propose config 'folder' must be a non-empty string");
    }
    if (isAbsolute(rawFolder) || rawFolder.includes("\\") || rawFolder.includes(":")) {
      throw new ProposeProviderError(
        `propose config 'folder' must be a relative path inside the Service folder: ${rawFolder}`,
      );
    }
    const segments = rawFolder.split("/");
    // Segment charset = POSIX Portable Filename Character Set
    // (A-Z a-z 0-9 . _ -) — one cited standard, deliberately no extra
    // structural guards: a closed accepted set converges in one rename
    // (the error message carries the full standard), and keeps the
    // diagnose prompt one line. The folder is Service-owned config
    // (trust domain); this check is lexical, not an identity profile.
    if (
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
      || !segments.every((segment) => /^[A-Za-z0-9._-]+$/.test(segment))
    ) {
      throw new ProposeProviderError(
        `propose config 'folder' has unsafe path segments (each segment must use POSIX portable filename characters A-Z a-z 0-9 . _ -): ${rawFolder}`,
      );
    }
    folder = segments.join(sep);
  }
  return join(serviceFolder, folder);
}

interface ParsedDocument {
  submitterLines: string[];
  body: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
    || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Parses a proposal document. Submitted content may carry a frontmatter
// block; service-maintained keys are stripped (the submission never owns
// them), submitter-owned display keys pass through verbatim.
function parseDocument(content: string): ParsedDocument {
  const lines = content.split("\n");
  if (lines[0] === undefined || lines[0].trim() !== "---") {
    return { submitterLines: [], body: content };
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) {
    return { submitterLines: [], body: content };
  }
  const submitterLines: string[] = [];
  for (const line of lines.slice(1, closing)) {
    const key = line.split(":", 1)[0]?.trim() ?? "";
    if (key !== "" && SERVICE_KEYS.has(key)) continue;
    submitterLines.push(line);
  }
  const body = lines.slice(closing + 1).join("\n");
  return { submitterLines, body };
}

function parseStoredDocument(content: string): { revision: number; created: string; document: ParsedDocument } {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new ProposeProviderError("stored proposal is missing its frontmatter block");
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) {
    throw new ProposeProviderError("stored proposal has an unterminated frontmatter block");
  }
  let revision: number | undefined;
  let created: string | undefined;
  const submitterLines: string[] = [];
  for (const line of lines.slice(1, closing)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1));
    if (key === "revision") {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new ProposeProviderError(`stored proposal has an invalid revision: ${value}`);
      }
      revision = parsed;
    } else if (key === "created") {
      created = value;
    } else if (key !== "" && !SERVICE_KEYS.has(key)) {
      submitterLines.push(line);
    }
  }
  if (revision === undefined || created === undefined) {
    throw new ProposeProviderError("stored proposal is missing service-maintained frontmatter fields");
  }
  return { revision, created, document: { submitterLines, body: lines.slice(closing + 1).join("\n") } };
}

function renderDocument(
  id: string,
  submitterLines: readonly string[],
  revision: number,
  created: string,
  updated: string,
  body: string,
): string {
  const frontmatter = [
    "---",
    `id: ${id}`,
    ...submitterLines,
    "status: proposed",
    `revision: ${revision}`,
    `created: ${created}`,
    `updated: ${updated}`,
    "---",
  ];
  return `${frontmatter.join("\n")}\n${body}`;
}

function sameSubmission(left: ParsedDocument, right: ParsedDocument): boolean {
  return left.body === right.body && left.submitterLines.join("\n") === right.submitterLines.join("\n");
}

function writeAtomic(targetPath: string, content: string): void {
  const tempPath = `${targetPath}.tmp.${randomUUID()}`;
  try {
    const descriptor = openSync(tempPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, content, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(tempPath, targetPath);
  } catch (error) {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw error;
  }
}

export interface ProposeUpsertContext {
  now?: () => Date;
}

// The file-provider upsert: sibling lock, in-lock re-read, three-state
// classification, temp-file + atomic replace discipline.
export function proposeUpsert(
  serviceFolder: string,
  capability: ManifestCapability,
  id: string,
  content: string,
  context: ProposeUpsertContext = {},
): ProposeResult {
  assertProposeSlug(id);
  const folder = resolveProposeFolder(serviceFolder, capability);
  mkdirSync(folder, { recursive: true });
  const targetPath = join(folder, `${id}.md`);
  const lockPath = `${targetPath}.lock`;

  let lockDescriptor: number;
  try {
    lockDescriptor = acquireLock(lockPath);
  } catch (error) {
    if (error instanceof LockBusyError) throw new ProposeBusyError(id);
    throw new ProposeProviderError(`cannot acquire proposal lock: ${lockPath}`, { cause: error });
  }

  try {
    const submission = parseDocument(content);
    const timestamp = (context.now ?? (() => new Date()))().toISOString();

    if (!existsSync(targetPath)) {
      const document = renderDocument(id, submission.submitterLines, 1, timestamp, timestamp, submission.body);
      writeAtomic(targetPath, document);
      return { id, status: "created", revision: 1 };
    }

    const stored = parseStoredDocument(readFileSync(targetPath, "utf8"));
    if (sameSubmission(submission, stored.document)) {
      return { id, status: "unchanged", revision: stored.revision };
    }

    const document = renderDocument(
      id,
      submission.submitterLines,
      stored.revision + 1,
      stored.created,
      timestamp,
      submission.body,
    );
    writeAtomic(targetPath, document);
    return { id, status: "updated", revision: stored.revision + 1 };
  } finally {
    releaseLock(lockPath, lockDescriptor);
  }
}

export interface ProposeRequest {
  endpoint: string;
  id?: string;
  file?: string;
  json: boolean;
}

export interface ProposeContext {
  currentDirectory: string;
  registryPath: string;
  now?: () => Date;
}

/** ADR 0021 error classification — factual messages; the `ukp propose:`
 * prefix and exit codes are adapter renderings. */
export type ProposeErrorClass =
  | "no-endpoint"
  | "endpoint-name-mismatch"
  | "capability-undeclared"
  | "submission-file-unreadable"
  | "provider-unsupported";

export interface ProposeFailure {
  errorClass: ProposeErrorClass;
  message: string;
}

/** ADR 0021 structured outcome. The upsert core (`ProposeResult`) was
 * already structured; this wraps the endpoint/capability/file prelude. */
export type ProposeOutcome =
  | { ok: true; result: ProposeResult }
  | { ok: false; failure: ProposeFailure };

export class ProposeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposeUsageError";
  }
}

// Derives the default proposal id from a --file basename (extension
// stripped). The derived value still has to satisfy the slug profile.
export function deriveIdFromFileName(filePath: string): string {
  const name = basename(filePath);
  const dotIndex = name.lastIndexOf(".");
  const id = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  if (!PROPOSE_SLUG.test(id)) {
    throw new ProposeUsageError(
      `proposal id derived from '${name}' is not a valid slug (1-63 lowercase ASCII [a-z0-9-]); pass --id explicitly`,
    );
  }
  return id;
}

export function renderProposeHuman(result: ProposeResult): string {
  // Probe 20260906-promoted shape: no provider location on the human
  // surface; the --json envelope carries the endpoint name instead.
  return `proposal ${result.id} ${result.status} (revision ${result.revision})\n`;
}

/** The `ukp.propose.v1` envelope object — single source for the CLI
 * `--json` rendering and the serve `PUT /v1/propose/{id}` response (W8):
 * the wire response IS the local envelope. */
export function proposeEnvelope(endpoint: string, result: ProposeResult): {
  schema: string;
  command: string;
  capability: string;
  endpoint: string;
  id: string;
  status: ProposeStatus;
  revision: number;
} {
  return {
    schema: "ukp.propose.v1",
    command: "propose",
    capability: "propose",
    endpoint,
    id: result.id,
    status: result.status,
    revision: result.revision,
  };
}

export function renderProposeJson(endpoint: string, result: ProposeResult): string {
  return `${JSON.stringify(proposeEnvelope(endpoint, result), null, 2)}\n`;
}

/** Resolves the proposal id for a request (explicit `--id` or derived from
 * the --file basename) — shared by the local run and the remote branch
 * (W8). Usage violations throw `ProposeUsageError`. */
export function proposalIdOf(request: Pick<ProposeRequest, "id" | "file">): string {
  // Single stable channel (decision 2026-09-06): --file is the only content
  // source. A stdin channel would need unreliable isTTY-based selection
  // (agent harnesses spawn with piped stdin), and the canonical propose
  // loop is read → edit local file → resubmit anyway.
  if (request.file === undefined) {
    throw new ProposeUsageError("propose requires --file <path> (the proposal content source)");
  }
  const id = request.id ?? deriveIdFromFileName(request.file);
  if (!PROPOSE_SLUG.test(id)) {
    throw new ProposeUsageError(
      `invalid proposal id '${id}': expected 1-63 lowercase ASCII slug characters ([a-z0-9-])`,
    );
  }
  return id;
}

/** Reads the --file submission content relative to the caller's working
 * directory — shared by the local run and the remote branch (W8); an
 * unreadable file classifies as submission-file-unreadable. */
export function readSubmissionFile(
  file: string,
  currentDirectory: string,
): { content: string } | { failure: ProposeFailure } {
  const filePath = resolve(currentDirectory, file);
  try {
    return { content: readFileSync(filePath, "utf8") };
  } catch (error) {
    const detail = error instanceof Error && "code" in error && error.code === "ENOENT"
      ? "file not found"
      : error instanceof Error ? error.message : String(error);
    return {
      failure: {
        errorClass: "submission-file-unreadable",
        message: `cannot read --file '${file}': ${detail}`,
      },
    };
  }
}

/** ADR 0021 core entry: validates the prelude (id slug, scope, capability
 * declaration, submission file) and runs the idempotent upsert. Usage
 * violations throw `ProposeUsageError`; provider/config violations throw
 * `ProposeProviderError`; scope/manifest failures throw their typed errors —
 * all mapped by the surface adapter. The `json` request flag is a surface
 * concern: the outcome is always structured. */
export function runPropose(request: ProposeRequest, context: ProposeContext): ProposeOutcome {
  const id = proposalIdOf(request);

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
  // Remote bindings never reach this local path in the CLI composition (the
  // command adapter routes them to the remote branch, W8); localPathOf
  // throwing for a remote binding is the backstop (W6 nav/rg precedent).

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

  // Propose is file-native but write-side (ADR 0016): an explicit
  // declaration is mandatory; resolution goes through the shared table.
  const resolved = resolveFileNativeCapability(service.manifest, "propose");
  if (!resolved) {
    return {
      ok: false,
      failure: {
        errorClass: "capability-undeclared",
        message: `endpoint '${binding.name}' does not declare the propose capability`
          + ` - declare [capabilities.propose] in the Service Manifest (.ukp/service.toml); 'ukp guide propose' walks through it`,
      },
    };
  }

  const submission = readSubmissionFile(request.file!, context.currentDirectory);
  if ("failure" in submission) {
    return { ok: false, failure: submission.failure };
  }

  const result = proposeUpsert(service.folder, resolved.capability, id, submission.content, { now: context.now });
  return { ok: true, result };
}
