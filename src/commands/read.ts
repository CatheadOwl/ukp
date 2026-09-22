import {
  runRead,
  renderReadHuman,
  projectReadEnvelope,
  ReadUsageError,
  isAbsoluteFilesystemReference,
  type ReadContext,
  type ReadErrorClass,
  type ReadOutcome,
  type ReadRecoveryMeta,
  type ReadRequest,
  type LineRange,
} from "../capabilities/read.ts";
import { isValidPin, pinHashOf } from "../capabilities/rename-recovery.ts";
import { isBareDocidReference, stripDocidHash } from "../capabilities/qmd.ts";
import {
  fetchDiscoveryDocument,
  openRemoteTransport,
  remoteRead,
  remoteTokenFor,
  resolveRemoteToken,
  type RemoteTransportHandle,
} from "../capabilities/remote-client.ts";
import { isRemoteBinding, readRegistry, type RegistryBinding } from "../registry.ts";
import { ScopeError } from "../scope.ts";
import { KitUsageError, parseKitArgs, renderKitHelp, renderKitUsageError, type UkpCommandSpec } from "./kit.ts";
import { HelpRequestError, isHelpRequest } from "./flags.ts";

/** CLI-owned command result shape (ADR 0021). `recovery` exposes the
 * structured rename-recovery metadata alongside the channels so programmatic
 * consumers of the adapter need not re-parse stderr. */
export interface ReadCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  recovery?: ReadRecoveryMeta;
}

/** Error-class → exit-code mapping (ADR 0021): the capability classifies,
 * the adapter decides process semantics. Inline tier-validation usage
 * failures keep the bare exit-2 rendering; parse-layer usage errors render
 * the usage block via the catch path. */
const READ_EXIT_BY_ERROR_CLASS: Record<ReadErrorClass, number> = {
  "no-endpoint": 1,
  "endpoint-name-mismatch": 1,
  "provider-unavailable": 1,
  "provider-timeout": 1,
  "provider-cancelled": 130,
  "provider-incompatible": 1,
  "provider-no-content": 1,
  "resource-missing": 1,
  "qmd-route-unavailable": 1,
  "resource-disappeared": 1,
  "resource-is-directory": 1,
  "start-beyond-eof": 1,
  "ambiguous-match": 1,
  "no-exact-match": 1,
  "resource-not-found": 1,
  "usage-error": 2,
};

/** Single-source command spec (ADR 0024). Options-only form (like search/
 * rg): `--endpoint` is required only for the endpoint-scoped tier — the
 * URI and absolute-filesystem tiers carry their own endpoint — so the
 * singleEndpoint family's unconditional requirement does not apply; tier
 * dispatch and its precedence stay command-side. */
export const READ_SPEC: UkpCommandSpec = {
  name: "read",
  summary: "read an endpoint-scoped resource (exact path, ukp:// URI, or a docid from search results)",
  group: "endpoint",
  description:
    "Read an endpoint-scoped resource reference from one Service endpoint (endpoint names come from 'ukp list'). "
    + "A ukp:// URI is addressed exactly (no fuzzy resolution); #L<line> maps to the line window start. "
    + "A document-relative reference resolves against --from <route>; an absolute filesystem path maps to the endpoint whose Service folder contains it (mapping echoed on stderr). "
    + "On a slot miss the layered rename recovery runs (git history, then search re-anchor); a recovered read echoes the move on stderr. "
    + "On success stdout carries only the resource body; all diagnostics go to stderr.",
  usage: "--endpoint <name> <reference> [--lines <start[:count]>] | ukp://<endpoint>/<rel-path>[#L<line>]",
  arguments: [
    { name: "reference", help: "endpoint-local path, ukp:// URI, docid[:line] handoff key, or qmd:// provider reference" },
  ],
  options: [
    { flags: "-c, --endpoint <name>", help: "select the endpoint that owns the resource" },
    {
      flags: "-g",
      help: "not supported; read is explicitly endpoint-scoped (current scope: 'ukp inspect'; endpoints: 'ukp list')",
      teachingFlag: true,
    },
    { flags: "--lines <start[:count]>", help: "read a 1-based text line window (count omitted: to end of file)" },
    {
      flags: "--from <route>",
      help: "resolve a document-relative reference (../x.md, bare filename) against this source document's endpoint-relative route",
    },
    {
      flags: "--pin <sha256-hex>",
      help: "verify rename recovery against this ukp-pin content hash (sha256-<64 hex>; emit the current pin with --show-pin)",
    },
    {
      flags: "--show-pin",
      help: "emit the ukp-pin for the read resource on stderr (<!-- ukp-pin: sha256-... -->, whole-file LF-normalized sha256; embed next to a ukp:// reference to power rename recovery). Local reads allow a line window - the pin still covers the whole file; remote reads need the whole file, so drop the window there",
    },
    { flags: "--format <mode>", help: "output mode: 'json' emits a structured failure envelope (body still goes to stdout); default is human output" },
  ],
  helpSuffix: [
    "",
    "Reference forms:",
    "  endpoint-local path - requires --endpoint <name>",
    "  ukp://<endpoint>/<rel-path>[#L<line>] - carries its own endpoint",
    "  docid[:line] / qmd://<reference> - provider-owned references;",
    "  require --endpoint <name> and are resolved by the Service's provider",
    "  absolute filesystem path - the owning endpoint is matched from the",
    "  Host Registry (mapping echoed on stderr)",
    "",
  ].join("\n"),
};

interface ReadCommandOptions extends Record<string, unknown> {
  endpoint?: string;
  g?: boolean;
  lines?: string;
  from?: string;
  pin?: string;
  showPin?: boolean;
  format?: string;
}

function parseLineRange(value: string): LineRange {
  const match = /^([0-9]+)(?::([0-9]+))?$/.exec(value);
  if (!match) throw new KitUsageError("--lines must use <start[:count]> with decimal integers");
  const start = Number(match[1]);
  const count = match[2] === undefined ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(start) || start < 1) {
    throw new KitUsageError("--lines start must be a positive integer");
  }
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 1)) {
    throw new KitUsageError("--lines count must be a positive integer");
  }
  return count === undefined ? { start } : { start, count };
}

/** ASCII-only case-insensitive `ukp://` scheme match (RFC 3986: scheme is
 * case-insensitive; restricting the classes to ASCII avoids Unicode
 * case-folding surprises like the Kelvin sign). */
const UKP_URI_PREFIX_RE = /^[uU][kK][pP]:\/\//;

/**
 * Percent-decode a `%XX`-escaped string into its UTF-8 form.
 *
 * WHATWG-URL-style lenient decoding applied per component (endpoint /
 * rel-path / fragment): every valid `%XX` triplet contributes one byte to a
 * UTF-8 decode; invalid `%` sequences are kept literally; invalid UTF-8
 * bytes decode as U+FFFD. Decoding happens after the authority/path/fragment
 * split, so `/` and `#` are always literal delimiters; a decoded `%2F`
 * becomes a separator character — unambiguous because no supported
 * filesystem allows `/` inside a name. Raw (unescaped) UTF-8 passes through
 * verbatim (IRI semantics: URI/IRI distinction is deliberately not enforced).
 */
function percentDecodeUtf8(component: string): string {
  if (!component.includes("%")) return component;
  const decoder = new TextDecoder("utf-8");
  let result = "";
  let bytes: number[] = [];
  let i = 0;
  const flush = () => {
    if (bytes.length > 0) {
      result += decoder.decode(new Uint8Array(bytes));
      bytes = [];
    }
  };
  while (i < component.length) {
    const hex = /^%[0-9a-fA-F]{2}$/.exec(component.slice(i, i + 3));
    if (hex) {
      bytes.push(Number.parseInt(component.slice(i + 1, i + 3), 16));
      i += 3;
      continue;
    }
    flush();
    result += component[i];
    i += 1;
  }
  flush();
  return result;
}

/**
 * Parse a `ukp://<endpoint>/<rel-path>[#fragment]` URI (ADR 0014 target form)
 * into a ReadRequest with exact slot addressing.
 *
 * Encoding stance: UTF-8/IRI semantics — raw UTF-8 is legal
 * as-is; `%XX` triplets are percent-decoded per component (see
 * percentDecodeUtf8). Case stance: exact compare, no case folding and no
 * canonicalization (RFC 8089 precedent) — platform case-sensitivity
 * differences are declared behavior, not normalized. `#L<line>` maps to the
 * line-window start; any other fragment is an opaque navigation hint and is
 * ignored for reading.
 */
function parseUkpUri(uri: string, flags: { endpoint?: string; lines?: string }): ReadRequest {
  // Precondition: the caller (parseReadArgs) has already matched
  // UKP_URI_PREFIX_RE against this input; the non-null assertion below relies
  // on that guard. New callers must test the prefix before calling.
  if (flags.endpoint !== undefined) {
    throw new KitUsageError("a ukp:// URI carries its own endpoint; do not also pass --endpoint");
  }
  const rest = uri.slice(uri.match(UKP_URI_PREFIX_RE)![0].length);
  const hashIndex = rest.indexOf("#");
  const fragment = hashIndex === -1 ? undefined : percentDecodeUtf8(rest.slice(hashIndex + 1));
  const pathPart = hashIndex === -1 ? rest : rest.slice(0, hashIndex);
  const slashIndex = pathPart.indexOf("/");
  if (slashIndex === -1 && pathPart.includes("\\")) {
    throw new KitUsageError("ukp:// URI uses '/' as the path separator: ukp://<endpoint>/<rel-path>");
  }
  // No slash: the whole remainder is the endpoint with an empty rel-path.
  // Percent-decoding is applied per component after the split: `/`
  // and `#` are always literal delimiters at split time; a decoded `%2F`
  // becomes a separator character downstream, which is unambiguous because
  // no filesystem allows `/` inside a name.
  const endpoint = slashIndex === -1 ? percentDecodeUtf8(pathPart) : percentDecodeUtf8(pathPart.slice(0, slashIndex));
  const relPath = percentDecodeUtf8(slashIndex === -1 ? "" : pathPart.slice(slashIndex + 1));
  if (endpoint.length === 0) {
    throw new KitUsageError("ukp:// URI must name an endpoint: ukp://<endpoint>/<rel-path>");
  }
  if (relPath.length === 0) {
    throw new KitUsageError("ukp:// URI must carry a non-empty endpoint-relative path");
  }

  let lines: LineRange | undefined;
  const lineMatch = fragment === undefined ? undefined : /^L([0-9]+)$/.exec(fragment);
  if (lineMatch) {
    if (flags.lines !== undefined) {
      throw new KitUsageError("a ukp:// #L<line> fragment already carries a line; do not also pass --lines");
    }
    const start = Number(lineMatch[1]);
    // Same integer discipline as --lines: an unrepresentably large number is a
    // usage error here, not a deferred start-beyond-eof read failure.
    if (!Number.isSafeInteger(start) || start < 1) {
      throw new KitUsageError("ukp:// #L fragment must be a positive line number");
    }
    lines = { start };
  } else if (fragment !== undefined && /^L\d/.test(fragment)) {
    // G4 pin (fail-loud): a digit right after `L` commits to line-window intent,
    // so a malformed window (`#L67:5`, `#L12x`) is a usage error — silently
    // reading the whole document would hide the typo. Heading-style fragments
    // (`#Lifecycle`, `#L-pipeline`) keep opaque semantics: `L` + non-digit was
    // never a line window.
    throw new KitUsageError(
      `ukp:// #L fragment looks like a malformed line window: '${fragment}' (use #L<line> or a plain heading anchor)`,
    );
  }
  // Non-`#L` fragments are opaque navigation hints (ADR 0014 rule 5): ignored
  // for reading; a broken path invalidates the fragment, never the reverse.

  return {
    endpoint,
    path: relPath,
    addressing: "uri",
    ...(lines !== undefined
      ? { lines }
      : flags.lines !== undefined
        ? { lines: parseLineRange(flags.lines) }
        : {}),
  };
}

export function parseReadArgs(args: readonly string[]): ReadRequest {
  return parseReadWithFormat(args).request;
}

function parseReadWithFormat(args: readonly string[]): { request: ReadRequest; format?: "json" } {
  // Kit parse: commander translation + help-intent triage + generated
  // singleton detection (--endpoint/--lines/--from/--pin/--format; the -g
  // teaching flag is excluded). Command-side checks follow in the pre-kit
  // order: pin form, format value, -g rejection, excess positionals, tiers.
  const parsed = parseKitArgs<ReadCommandOptions>(READ_SPEC, args);
  const [path, unexpected] = parsed.positionals;

  if (parsed.options.pin !== undefined && !isValidPin(parsed.options.pin)) {
    // Q7-narrowed SRI form only: no multi-algorithm negotiation, no upper-case
    // hex tolerance — the pin is machine-written, not hand-typed.
    throw new KitUsageError("--pin must use sha256-<64 lowercase hex> (the ukp-pin form embedded next to ukp:// references; emit one with --show-pin)");
  }
  if (parsed.options.format !== undefined && parsed.options.format !== "json") {
    throw new KitUsageError("--format only supports 'json'");
  }
  // The ukp-pin is a file-slot concept (same boundary as pin verification in
  // the recovery descent): provider-tier references never expose whole-file
  // content, so emission is refused by input shape at parse time.
  if (parsed.options.showPin === true && path !== undefined) {
    const barePath = stripDocidHash(path);
    if (path.startsWith("qmd://") || isBareDocidReference(barePath)) {
      throw new KitUsageError(
        "--show-pin is file-slot-only: the ukp-pin covers whole-file content, and provider references (docid, qmd://) do not expose it",
      );
    }
  }
  const pin = parsed.options.pin;
  if (parsed.options.g) throw new KitUsageError("read requires --endpoint <name> and does not support -g");
  // Unexpected positionals are rejected before the missing-flag checks so the
  // error names the real problem (extra argument), not a missing --endpoint.
  if (unexpected !== undefined) {
    throw new KitUsageError(
      `unexpected argument '${unexpected}'; read accepts exactly one reference. Use '--endpoint <name>' to select an endpoint.`,
    );
  }
  const withPinOptions = <T extends object>(request: T): T & { pin?: string; emitPin?: boolean } => {
    let out: T & { pin?: string; emitPin?: boolean } = request;
    if (parsed.options.pin !== undefined) out = { ...out, pin: parsed.options.pin };
    if (parsed.options.showPin === true) out = { ...out, emitPin: true };
    return out;
  };
  const format = parsed.options.format === "json" ? ("json" as const) : undefined;

  if (path !== undefined && UKP_URI_PREFIX_RE.test(path)) {
    if (parsed.options.from !== undefined) {
      throw new KitUsageError("a ukp:// URI carries its own endpoint; --from is for document-relative references");
    }
    return { request: withPinOptions(parseUkpUri(path, { endpoint: parsed.options.endpoint, lines: parsed.options.lines })), ...(format ? { format } : {}) };
  }
  // Tolerant tier (ADR-URI-001): an absolute filesystem path carries its own
  // endpoint (Registry-matched), so --endpoint is neither required nor
  // allowed; --from is for document-relative references only.
  if (path !== undefined && isAbsoluteFilesystemReference(path)) {
    if (parsed.options.from !== undefined) {
      throw new KitUsageError("an absolute filesystem path cannot be combined with --from");
    }
    if (parsed.options.endpoint !== undefined) {
      throw new KitUsageError(
        "an absolute filesystem path carries its own endpoint (matched against registered endpoints); do not also pass --endpoint",
      );
    }
    return {
      request: withPinOptions({
        path,
        ...(parsed.options.lines === undefined ? {} : { lines: parseLineRange(parsed.options.lines) }),
      }),
      ...(format ? { format } : {}),
    };
  }
  if (parsed.options.endpoint === undefined || parsed.options.endpoint.length === 0) {
    throw new KitUsageError("read requires --endpoint <name>");
  }
  if (path === undefined || path.length === 0) {
    throw new KitUsageError("read reference must be a non-empty endpoint-scoped reference");
  }
  if (parsed.options.from !== undefined && parsed.options.from.length === 0) {
    throw new KitUsageError("--from must be a non-empty endpoint-relative route");
  }

  return {
    request: withPinOptions({
      endpoint: parsed.options.endpoint,
      path,
      ...(parsed.options.from === undefined ? {} : { fromRef: parsed.options.from }),
      ...(parsed.options.lines === undefined ? {} : { lines: parseLineRange(parsed.options.lines) }),
    }),
    ...(format ? { format } : {}),
  };
}

/** `--format json` (spec read-rename-recovery): failures emit a structured
 * envelope on stdout (class + message + recovery metadata); success keeps the
 * body on stdout and puts a small envelope on stderr. Human mode is the
 * default and unchanged. The envelope is projected from the structured
 * outcome — the class is data, never regex-extracted from rendered text. */
function renderJsonOutput(request: ReadRequest, outcome: ReadOutcome): ReadCommandResult {
  const human = renderReadHuman(outcome);
  const envelope = projectReadEnvelope(request, outcome);
  const exitCode = outcome.ok
    ? 0
    : READ_EXIT_BY_ERROR_CLASS[outcome.failure.errorClass];
  const recovery = outcome.ok ? outcome.result.recovery : outcome.failure.recovery;
  if (outcome.ok) {
    return {
      exitCode,
      stdout: human.body,
      stderr: `${JSON.stringify(envelope)}\n${human.diagnostics}`,
      ...(recovery !== undefined ? { recovery } : {}),
    };
  }
  // Failure envelope replaces the human stdout (which is empty on failure);
  // stderr keeps its diagnostics verbatim.
  return {
    exitCode,
    stdout: `${JSON.stringify(envelope, null, 2)}\n`,
    stderr: human.diagnostics,
    ...(recovery !== undefined ? { recovery } : {}),
  };
}

export function executeReadCommand(
  args: readonly string[],
  context: ReadContext,
): ReadCommandResult | Promise<ReadCommandResult> {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderReadHelp(), stderr: "" };
  }

  try {
    const { request, format } = parseReadWithFormat(args);
    // Remote branch (ukp_remote W2): endpoint-scoped and ukp:// reads on a
    // remote binding route through the remote transport; the absolute-path
    // tier never carries a remote endpoint. The sync contract for local
    // reads is unchanged (conditional-async seam, same as search).
    if (request.endpoint !== undefined) {
      const binding = readRegistry(context.registryPath).find((entry) => entry.name === request.endpoint);
      if (binding !== undefined && isRemoteBinding(binding)) {
        return executeRemoteRead(request, format, binding, context.registryPath);
      }
    }
    const outcome = runRead(request, context);
    return renderReadOutcome(request, outcome, format, []);
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderReadHelp(), stderr: "" };
    }
    if (error instanceof KitUsageError || error instanceof ReadUsageError) {
      // ReadUsageError: capability-side tier validation classifies as usage
      // too — same rendering, exit 2.
      return { exitCode: 2, stdout: "", stderr: renderReadUsageError(error.message) };
    }
    if (error instanceof ScopeError) {
      return { exitCode: 1, stdout: "", stderr: `ukp read: ${error.message}\n` };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp read: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

/** Shared render tail for the sync and remote read paths (byte-identical to
 * the pre-remote adapter when `warnings` is empty). */
function renderReadOutcome(
  request: ReadRequest,
  outcome: ReadOutcome,
  format: "json" | undefined,
  warnings: string[],
): ReadCommandResult {
  if (format === "json") {
    const base = renderJsonOutput(request, outcome);
    if (warnings.length === 0) return base;
    return { ...base, stderr: `${base.stderr}${warnings.join("\n")}\n` };
  }
  const human = renderReadHuman(outcome);
  const recovery = outcome.ok ? outcome.result.recovery : outcome.failure.recovery;
  const diagnostics = warnings.length > 0
    ? `${human.diagnostics}${human.diagnostics === "" || human.diagnostics.endsWith("\n") ? "" : "\n"}${warnings.join("\n")}\n`
    : human.diagnostics;
  return {
    exitCode: outcome.ok ? 0 : READ_EXIT_BY_ERROR_CLASS[outcome.failure.errorClass],
    stdout: human.body,
    stderr: diagnostics,
    ...(recovery !== undefined ? { recovery } : {}),
  };
}

function remoteTokenHint(endpointName: string): string {
  return `endpoint '${endpointName}' requires a bearer token; set UKP_ENDPOINT_${endpointName.toUpperCase().replace(/-/g, "_")}_TOKEN`;
}

/** Wire error class → ReadErrorClass. Word-level classes pass through;
 * transport-only verdicts (auth-failure, identity-mismatch, route misses)
 * fold into provider-unavailable with the specifics preserved in the
 * message (ukp_remote W2 mapping decision, workline-recorded). */
function mapRemoteReadErrorClass(errorClass: string | undefined): ReadErrorClass {
  if (errorClass === "resource-missing") return "resource-missing";
  if (errorClass === "provider-timeout") return "provider-timeout";
  if (errorClass === "usage-error") return "usage-error";
  return "provider-unavailable";
}

async function executeRemoteRead(
  request: ReadRequest,
  format: "json" | undefined,
  binding: RegistryBinding,
  registryPath?: string,
): Promise<ReadCommandResult> {
  // Remote emission needs whole-file content, and a line window would arrive
  // windowed from the server — refuse before opening any transport.
  if (request.emitPin === true && request.lines !== undefined) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: renderReadUsageError(
        "--show-pin needs whole-file content; drop the line window (--lines / #L) - the pin always covers the whole file",
      ),
    };
  }
  const token = resolveRemoteToken(binding);
  const warnings: string[] = [];
  let transport: RemoteTransportHandle | undefined;
  try {
    transport = await openRemoteTransport(binding, registryPath === undefined ? {} : { registryPath });
    const discovery = await fetchDiscoveryDocument(binding, transport, token);
    warnings.push(...discovery.warnings);
    if (discovery.bearerRequired && token === undefined) warnings.push(remoteTokenHint(binding.name));
  } catch (error) {
    transport?.close();
    return renderReadOutcome(
      request,
      {
        ok: false,
        failure: {
          errorClass: "provider-unavailable",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      format,
      warnings,
    );
  }

  if (request.fromRef !== undefined) {
    return renderReadOutcome(
      request,
      {
        ok: false,
        failure: {
          errorClass: "provider-incompatible",
          message: "--from document-relative references are local-only; remote reads take an endpoint-relative ref or a ukp:// URI (ukp_remote W2)",
        },
      },
      format,
      warnings,
    );
  }

  const params = {
    ref: request.path,
    ...(request.lines !== undefined
      ? { lines: `${request.lines.start}${request.lines.count !== undefined ? `:${request.lines.count}` : ""}` }
      : {}),
    ...(request.pin !== undefined ? { pin: request.pin } : {}),
  };
  let result;
  try {
    result = await remoteRead(transport, token, params);
  } catch (error) {
    return renderReadOutcome(
      request,
      {
        ok: false,
        failure: {
          errorClass: "provider-unavailable",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      format,
      warnings,
    );
  } finally {
    transport.close();
  }
  if (result.ok) {
    // No line window can be present here (rejected above), so the server
    // returned the whole file — the client-side hash is the same contract as
    // the local capability's pre-window computation.
    const pin = request.emitPin === true ? `sha256-${pinHashOf(result.content)}` : undefined;
    return renderReadOutcome(
      request,
      { ok: true, result: { content: result.content, ...(pin !== undefined ? { pin } : {}), recoveryWarnings: [] } },
      format,
      warnings,
    );
  }
  return renderReadOutcome(
    request,
    {
      ok: false,
      failure: {
        errorClass: mapRemoteReadErrorClass(result.errorClass),
        message: result.errorMessage ?? `remote read failed (status ${result.status})`,
      },
    },
    format,
    warnings,
  );
}

export function renderReadHelp(): string {
  return renderKitHelp(READ_SPEC);
}

/** Escape hatch (ADR 0024 non-goal #5): read's usage error keeps its
 * hand-written four-form block instead of the kit's single usage line —
 * the tier dispatch (endpoint-scoped / --from / absolute path / ukp://) has
 * four legitimate invocations and the multi-form recovery text is the
 * load-bearing part. */
export function renderReadUsageError(message: string): string {
  return [
    `ukp read: ${message}`,
    "Usage: ukp read --endpoint <name> <reference> [--lines <start[:count]>]",
    "       ukp read --endpoint <name> --from <route> <document-relative reference>",
    "       ukp read <absolute filesystem path>",
    "       ukp read ukp://<endpoint>/<rel-path>[#L<line>]",
    "Run 'ukp read --help' for details.",
  ].join("\n");
}
