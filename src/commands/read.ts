import { Command, CommanderError } from "commander";
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
import { isValidPin } from "../capabilities/rename-recovery.ts";
import { ScopeError } from "../scope.ts";
import { countFlagOccurrences, isHelpRequest } from "./flags.ts";

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

function createReadCommand(): Command {
  return new Command("ukp read")
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(true)
    .helpOption("-h, --help", "show this help")
    .usage("--endpoint <name> <reference> [--lines <start[:count]>] | ukp://<endpoint>/<rel-path>[#L<line>]")
    .description(
      "Read an endpoint-scoped resource reference from one Service endpoint (endpoint names come from 'ukp list'). "
        + "A ukp:// URI is addressed exactly (no fuzzy resolution); #L<line> maps to the line window start. "
        + "A document-relative reference resolves against --from <route>; an absolute filesystem path maps to the endpoint whose Service folder contains it (mapping echoed on stderr). "
        + "On a slot miss the layered rename recovery runs (git history, then search re-anchor); a recovered read echoes the move on stderr. "
        + "On success stdout carries only the resource body; all diagnostics go to stderr.",
    )
    .argument("[reference]", "endpoint-local path, ukp:// URI, docid[:line] handoff key, or qmd:// provider reference")
    .option("-c, --endpoint <name>", "select the endpoint that owns the resource")
    .option("-g", "not supported; read is explicitly endpoint-scoped (current scope: 'ukp inspect'; endpoints: 'ukp list')")
    .option("--lines <start[:count]>", "read a 1-based text line window")
    .option("--from <route>", "resolve a document-relative reference (../x.md, bare filename) against this source document's endpoint-relative route")
    .option("--pin <sha256-hex>", "verify rename recovery against this ukp-pin content hash (sha256-<64 hex>)")
    .option("--format <mode>", "output mode: json emits a structured failure envelope (body still goes to stdout)");
}

function parseLineRange(value: string): LineRange {
  const match = /^([0-9]+)(?::([0-9]+))?$/.exec(value);
  if (!match) throw new ReadUsageError("--lines must use <start[:count]> with decimal integers");
  const start = Number(match[1]);
  const count = match[2] === undefined ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(start) || start < 1) {
    throw new ReadUsageError("--lines start must be a positive integer");
  }
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 1)) {
    throw new ReadUsageError("--lines count must be a positive integer");
  }
  return count === undefined ? { start } : { start, count };
}

function parseReadCommand(args: readonly string[]): {
  positionals: string[];
  endpoint?: string;
  global?: boolean;
  lines?: string;
  from?: string;
  pin?: string;
  format?: string;
} {
  const command = createReadCommand()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new ReadUsageError(error.message.replace(/^error: /, ""));
    }
    throw error;
  }

  const options = command.opts<{
    endpoint?: string;
    g?: boolean;
    lines?: string;
    from?: string;
    pin?: string;
    format?: string;
  }>();
  return {
    positionals: command.args,
    endpoint: options.endpoint,
    global: options.g,
    lines: options.lines,
    from: options.from,
    pin: options.pin,
    format: options.format,
  };
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
    throw new ReadUsageError("a ukp:// URI carries its own endpoint; do not also pass --endpoint");
  }
  const rest = uri.slice(uri.match(UKP_URI_PREFIX_RE)![0].length);
  const hashIndex = rest.indexOf("#");
  const fragment = hashIndex === -1 ? undefined : percentDecodeUtf8(rest.slice(hashIndex + 1));
  const pathPart = hashIndex === -1 ? rest : rest.slice(0, hashIndex);
  const slashIndex = pathPart.indexOf("/");
  if (slashIndex === -1 && pathPart.includes("\\")) {
    throw new ReadUsageError("ukp:// URI uses '/' as the path separator: ukp://<endpoint>/<rel-path>");
  }
  // No slash: the whole remainder is the endpoint with an empty rel-path.
  // Percent-decoding is applied per component after the split: `/`
  // and `#` are always literal delimiters at split time; a decoded `%2F`
  // becomes a separator character downstream, which is unambiguous because
  // no filesystem allows `/` inside a name.
  const endpoint = slashIndex === -1 ? percentDecodeUtf8(pathPart) : percentDecodeUtf8(pathPart.slice(0, slashIndex));
  const relPath = percentDecodeUtf8(slashIndex === -1 ? "" : pathPart.slice(slashIndex + 1));
  if (endpoint.length === 0) {
    throw new ReadUsageError("ukp:// URI must name an endpoint: ukp://<endpoint>/<rel-path>");
  }
  if (relPath.length === 0) {
    throw new ReadUsageError("ukp:// URI must carry a non-empty endpoint-relative path");
  }

  let lines: LineRange | undefined;
  const lineMatch = fragment === undefined ? undefined : /^L([0-9]+)$/.exec(fragment);
  if (lineMatch) {
    if (flags.lines !== undefined) {
      throw new ReadUsageError("a ukp:// #L<line> fragment already carries a line; do not also pass --lines");
    }
    const start = Number(lineMatch[1]);
    // Same integer discipline as --lines: an unrepresentably large number is a
    // usage error here, not a deferred start-beyond-eof read failure.
    if (!Number.isSafeInteger(start) || start < 1) {
      throw new ReadUsageError("ukp:// #L fragment must be a positive line number");
    }
    lines = { start };
  } else if (fragment !== undefined && /^L\d/.test(fragment)) {
    // G4 pin (fail-loud): a digit right after `L` commits to line-window intent,
    // so a malformed window (`#L67:5`, `#L12x`) is a usage error — silently
    // reading the whole document would hide the typo. Heading-style fragments
    // (`#Lifecycle`, `#L-pipeline`) keep opaque semantics: `L` + non-digit was
    // never a line window.
    throw new ReadUsageError(
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
  const parsed = parseReadCommand(args);
  const [path, unexpected] = parsed.positionals;

  if (countFlagOccurrences(args, "--endpoint") + countFlagOccurrences(args, "-c") > 1) {
    throw new ReadUsageError("--endpoint may only be specified once");
  }
  if (countFlagOccurrences(args, "--lines") > 1) throw new ReadUsageError("--lines may only be specified once");
  if (countFlagOccurrences(args, "--from") > 1) throw new ReadUsageError("--from may only be specified once");
  if (parsed.pin !== undefined && !isValidPin(parsed.pin)) {
    // Q7-narrowed SRI form only: no multi-algorithm negotiation, no upper-case
    // hex tolerance — the pin is machine-written, not hand-typed.
    throw new ReadUsageError("--pin must use sha256-<64 lowercase hex> (the ukp-pin form emitted next to ukp:// references)");
  }
  if (parsed.format !== undefined && parsed.format !== "json") {
    throw new ReadUsageError("--format only supports 'json'");
  }
  const pin = parsed.pin;
  if (parsed.global) throw new ReadUsageError("read requires --endpoint <name> and does not support -g");
  // Unexpected positionals are rejected before the missing-flag checks so the
  // error names the real problem (extra argument), not a missing --endpoint.
  if (unexpected !== undefined) {
    throw new ReadUsageError(
      `unexpected argument '${unexpected}'; read accepts exactly one reference. Use '--endpoint <name>' to select an endpoint.`,
    );
  }
  const withPin = <T extends object>(request: T): T & { pin?: string } =>
    parsed.pin === undefined ? request : { ...request, pin: parsed.pin };
  const format = parsed.format === "json" ? ("json" as const) : undefined;

  if (path !== undefined && UKP_URI_PREFIX_RE.test(path)) {
    if (parsed.from !== undefined) {
      throw new ReadUsageError("a ukp:// URI carries its own endpoint; --from is for document-relative references");
    }
    return { request: withPin(parseUkpUri(path, { endpoint: parsed.endpoint, lines: parsed.lines })), ...(format ? { format } : {}) };
  }
  // Tolerant tier (ADR-URI-001): an absolute filesystem path carries its own
  // endpoint (Registry-matched), so --endpoint is neither required nor
  // allowed; --from is for document-relative references only.
  if (path !== undefined && isAbsoluteFilesystemReference(path)) {
    if (parsed.from !== undefined) {
      throw new ReadUsageError("an absolute filesystem path cannot be combined with --from");
    }
    if (parsed.endpoint !== undefined) {
      throw new ReadUsageError(
        "an absolute filesystem path carries its own endpoint (matched against registered endpoints); do not also pass --endpoint",
      );
    }
    return {
      request: withPin({
        path,
        ...(parsed.lines === undefined ? {} : { lines: parseLineRange(parsed.lines) }),
      }),
      ...(format ? { format } : {}),
    };
  }
  if (parsed.endpoint === undefined || parsed.endpoint.length === 0) {
    throw new ReadUsageError("read requires --endpoint <name>");
  }
  if (path === undefined || path.length === 0) {
    throw new ReadUsageError("read reference must be a non-empty endpoint-scoped reference");
  }
  if (parsed.from !== undefined && parsed.from.length === 0) {
    throw new ReadUsageError("--from must be a non-empty endpoint-relative route");
  }

  return {
    request: withPin({
      endpoint: parsed.endpoint,
      path,
      ...(parsed.from === undefined ? {} : { fromRef: parsed.from }),
      ...(parsed.lines === undefined ? {} : { lines: parseLineRange(parsed.lines) }),
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

export function executeReadCommand(args: readonly string[], context: ReadContext): ReadCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderReadHelp(), stderr: "" };
  }

  try {
    const { request, format } = parseReadWithFormat(args);
    const outcome = runRead(request, context);
    if (format === "json") return renderJsonOutput(request, outcome);
    const human = renderReadHuman(outcome);
    const recovery = outcome.ok ? outcome.result.recovery : outcome.failure.recovery;
    return {
      exitCode: outcome.ok ? 0 : READ_EXIT_BY_ERROR_CLASS[outcome.failure.errorClass],
      stdout: human.body,
      stderr: human.diagnostics,
      ...(recovery !== undefined ? { recovery } : {}),
    };
  } catch (error) {
    if (error instanceof ReadUsageError) {
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

export function renderReadHelp(): string {
  return createReadCommand().helpInformation();
}

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
