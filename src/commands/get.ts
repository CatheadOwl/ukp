import { Command, CommanderError } from "commander";
import {
  executeGet,
  GetUsageError,
  type GetContext,
  type GetRequest,
  type GetResult,
  type LineRange,
} from "../capabilities/get.ts";
import { ScopeError } from "../scope.ts";
import { countFlagOccurrences, isHelpRequest } from "./flags.ts";

function createGetCommand(): Command {
  return new Command("ukp get")
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(true)
    .helpOption("-h, --help", "show this help")
    .usage("--endpoint <name> <reference> [--lines <start[:count]>] | ukp://<endpoint>/<rel-path>[#L<line>]")
    .description(
      "Read an endpoint-scoped resource reference from one Service endpoint (endpoint names come from 'ukp list'). "
        + "A ukp:// URI is addressed exactly (no fuzzy resolution); #L<line> maps to the line window start. "
        + "On success stdout carries only the resource body; all diagnostics go to stderr.",
    )
    .argument("[reference]", "endpoint-local path, ukp:// URI, docid[:line] handoff key, or qmd:// provider reference")
    .option("-c, --endpoint <name>", "select the endpoint that owns the resource")
    .option("-g", "not supported; get is explicitly endpoint-scoped (current scope: 'ukp inspect'; endpoints: 'ukp list')")
    .option("--lines <start[:count]>", "read a 1-based text line window");
}

function parseLineRange(value: string): LineRange {
  const match = /^([0-9]+)(?::([0-9]+))?$/.exec(value);
  if (!match) throw new GetUsageError("--lines must use <start[:count]> with decimal integers");
  const start = Number(match[1]);
  const count = match[2] === undefined ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(start) || start < 1) {
    throw new GetUsageError("--lines start must be a positive integer");
  }
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 1)) {
    throw new GetUsageError("--lines count must be a positive integer");
  }
  return count === undefined ? { start } : { start, count };
}

function parseGetCommand(args: readonly string[]): {
  positionals: string[];
  endpoint?: string;
  global?: boolean;
  lines?: string;
} {
  const command = createGetCommand()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new GetUsageError(error.message.replace(/^error: /, ""));
    }
    throw error;
  }

  const options = command.opts<{
    endpoint?: string;
    g?: boolean;
    lines?: string;
  }>();
  return {
    positionals: command.args,
    endpoint: options.endpoint,
    global: options.g,
    lines: options.lines,
  };
}

/** ASCII-only case-insensitive `ukp://` scheme match (RFC 3986: scheme is
 * case-insensitive; restricting the classes to ASCII avoids Unicode
 * case-folding surprises like the Kelvin sign). */
const UKP_URI_PREFIX_RE = /^[uU][kK][pP]:\/\//;

/**
 * Percent-decode a `%XX`-escaped string into its UTF-8 form (G3 pin, D-059).
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
 * into a GetRequest with exact slot addressing.
 *
 * Encoding stance (G3 pin, D-059): UTF-8/IRI semantics — raw UTF-8 is legal
 * as-is; `%XX` triplets are percent-decoded per component (see
 * percentDecodeUtf8). Case stance: exact compare, no case folding and no
 * canonicalization (RFC 8089 precedent) — platform case-sensitivity
 * differences are declared behavior, not normalized. `#L<line>` maps to the
 * line-window start; any other fragment is an opaque navigation hint and is
 * ignored for reading.
 */
function parseUkpUri(uri: string, flags: { endpoint?: string; lines?: string }): GetRequest {
  // Precondition: the caller (parseGetArgs) has already matched
  // UKP_URI_PREFIX_RE against this input; the non-null assertion below relies
  // on that guard. New callers must test the prefix before calling.
  if (flags.endpoint !== undefined) {
    throw new GetUsageError("a ukp:// URI carries its own endpoint; do not also pass --endpoint");
  }
  const rest = uri.slice(uri.match(UKP_URI_PREFIX_RE)![0].length);
  const hashIndex = rest.indexOf("#");
  const fragment = hashIndex === -1 ? undefined : percentDecodeUtf8(rest.slice(hashIndex + 1));
  const pathPart = hashIndex === -1 ? rest : rest.slice(0, hashIndex);
  const slashIndex = pathPart.indexOf("/");
  if (slashIndex === -1 && pathPart.includes("\\")) {
    throw new GetUsageError("ukp:// URI uses '/' as the path separator: ukp://<endpoint>/<rel-path>");
  }
  // No slash: the whole remainder is the endpoint with an empty rel-path.
  // Percent-decoding is applied per component after the split (D-059): `/`
  // and `#` are always literal delimiters at split time; a decoded `%2F`
  // becomes a separator character downstream, which is unambiguous because
  // no filesystem allows `/` inside a name.
  const endpoint = slashIndex === -1 ? percentDecodeUtf8(pathPart) : percentDecodeUtf8(pathPart.slice(0, slashIndex));
  const relPath = percentDecodeUtf8(slashIndex === -1 ? "" : pathPart.slice(slashIndex + 1));
  if (endpoint.length === 0) {
    throw new GetUsageError("ukp:// URI must name an endpoint: ukp://<endpoint>/<rel-path>");
  }
  if (relPath.length === 0) {
    throw new GetUsageError("ukp:// URI must carry a non-empty endpoint-relative path");
  }

  let lines: LineRange | undefined;
  const lineMatch = fragment === undefined ? undefined : /^L([0-9]+)$/.exec(fragment);
  if (lineMatch) {
    if (flags.lines !== undefined) {
      throw new GetUsageError("a ukp:// #L<line> fragment already carries a line; do not also pass --lines");
    }
    const start = Number(lineMatch[1]);
    // Same integer discipline as --lines: an unrepresentably large number is a
    // usage error here, not a deferred start-beyond-eof read failure.
    if (!Number.isSafeInteger(start) || start < 1) {
      throw new GetUsageError("ukp:// #L fragment must be a positive line number");
    }
    lines = { start };
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

export function parseGetArgs(args: readonly string[]): GetRequest {
  const parsed = parseGetCommand(args);
  const [path, unexpected] = parsed.positionals;

  if (countFlagOccurrences(args, "--endpoint") + countFlagOccurrences(args, "-c") > 1) {
    throw new GetUsageError("--endpoint may only be specified once");
  }
  if (countFlagOccurrences(args, "--lines") > 1) throw new GetUsageError("--lines may only be specified once");
  if (parsed.global) throw new GetUsageError("get requires --endpoint <name> and does not support -g");
  // Unexpected positionals are rejected before the missing-flag checks so the
  // error names the real problem (extra argument), not a missing --endpoint.
  if (unexpected !== undefined) {
    throw new GetUsageError(
      `unexpected argument '${unexpected}'; get accepts exactly one reference. Use '--endpoint <name>' to select an endpoint.`,
    );
  }
  if (path !== undefined && UKP_URI_PREFIX_RE.test(path)) {
    return parseUkpUri(path, { endpoint: parsed.endpoint, lines: parsed.lines });
  }
  if (parsed.endpoint === undefined || parsed.endpoint.length === 0) {
    throw new GetUsageError("get requires --endpoint <name>");
  }
  if (path === undefined || path.length === 0) {
    throw new GetUsageError("get reference must be a non-empty endpoint-scoped reference");
  }

  return {
    endpoint: parsed.endpoint,
    path,
    ...(parsed.lines === undefined ? {} : { lines: parseLineRange(parsed.lines) }),
  };
}

export function executeGetCommand(args: readonly string[], context: GetContext): GetResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderGetHelp(), stderr: "" };
  }

  try {
    return executeGet(parseGetArgs(args), context);
  } catch (error) {
    if (error instanceof GetUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderGetUsageError(error.message) };
    }
    if (error instanceof ScopeError) {
      return { exitCode: 1, stdout: "", stderr: `ukp get: ${error.message}\n` };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp get: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

export function renderGetHelp(): string {
  return createGetCommand().helpInformation();
}

export function renderGetUsageError(message: string): string {
  return [
    `ukp get: ${message}`,
    "Usage: ukp get --endpoint <name> <reference> [--lines <start[:count]>]",
    "       ukp get ukp://<endpoint>/<rel-path>[#L<line>]",
    "Run 'ukp get --help' for details.",
  ].join("\n");
}
