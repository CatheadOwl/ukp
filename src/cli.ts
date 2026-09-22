#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  executeDiagnoseCommand,
  DIAGNOSE_SPEC,
  type ProviderResolver,
} from "./commands/diagnose.ts";
import { executeReadCommand, READ_SPEC } from "./commands/read.ts";
import { executeRgCommand, RG_SPEC } from "./commands/rg.ts";
import { executeGuideCommand, GUIDE_SPEC, GUIDE_TOPICS } from "./commands/guide.ts";
import { executeInitCommand, INIT_SPEC } from "./commands/init.ts";
import { executeInspectCommand, INSPECT_SPEC } from "./commands/inspect.ts";
import { executeListCommand, executeRegisterCommand, executeUnregisterCommand, LIST_SPEC, REGISTER_SPEC, UNREGISTER_SPEC } from "./commands/inventory.ts";
import { executeNavCommand, NAV_SPEC } from "./commands/nav.ts";
import { executeProposeCommand, PROPOSE_SPEC } from "./commands/propose.ts";
import { executeUpdateCommand, UPDATE_SPEC } from "./commands/update.ts";
import { executeServeCommand, SERVE_SPEC } from "./commands/serve.ts";
import { executeSearchCommand, SEARCH_SPEC } from "./commands/search.ts";

export { renderSearchHelp } from "./commands/search.ts";
export { renderDiagnoseHelp } from "./commands/diagnose.ts";
export { renderReadHelp } from "./commands/read.ts";
export { renderGuideHelp, renderServiceGuide, renderServiceQmdGuide, renderClientGuide, renderRgGuide, renderRemoteGuide, renderProposeGuide } from "./commands/guide.ts";
export { renderInitHelp, renderInitServiceHelp } from "./commands/init.ts";
export { renderInspectHelp } from "./commands/inspect.ts";
export { renderUpdateHelp } from "./commands/update.ts";
export { renderProposeHelp } from "./commands/propose.ts";
export { renderNavHelp } from "./commands/nav.ts";
export { renderRgHelp } from "./commands/rg.ts";

// `get` was renamed to `read`; with no external users the old
// spelling was removed outright instead of kept as an alias.
//
// Command descriptions are the single source; COMMAND_GROUPS only assigns
// each command a help-display heading (ADR 0022). Grouping is a rendering
// concern: the invocation surface stays flat — `ukp <verb>` — and dispatch
// in runCli is unchanged.
const COMMAND_DESCRIPTIONS: Record<string, string> = {
  // ADR 0024: migrated commands feed their root-help summary from the
  // command spec; `version` stays hand-written (meta command, deliberate
  // exception — no usage string, custom help handling).
  diagnose: DIAGNOSE_SPEC.summary,
  read: READ_SPEC.summary,
  rg: RG_SPEC.summary,
  guide: GUIDE_SPEC.summary,
  init: INIT_SPEC.summary,
  inspect: INSPECT_SPEC.summary,
  serve: SERVE_SPEC.summary,
  update: UPDATE_SPEC.summary,
  register: REGISTER_SPEC.summary,
  unregister: UNREGISTER_SPEC.summary,
  list: LIST_SPEC.summary,
  nav: NAV_SPEC.summary,
  propose: PROPOSE_SPEC.summary,
  search: SEARCH_SPEC.summary,
  version: "show version information",
};

export const COMMANDS = Object.entries(COMMAND_DESCRIPTIONS).map(
  ([name, description]) => [name, description] as const,
);

// Help-display groups (ADR 0022): purpose-noun headings over a flat verb
// surface. Every command must appear in exactly one group; a guard test
// locks group membership against COMMANDS.
export const COMMAND_GROUPS = [
  {
    heading: "Endpoint commands",
    commands: ["search", "read", "nav", "rg", "propose"],
  },
  {
    heading: "Registry commands",
    commands: ["init", "register", "unregister", "list"],
  },
  {
    heading: "Operations commands",
    commands: ["diagnose", "inspect", "update", "serve"],
  },
  {
    heading: "Help commands",
    commands: ["guide", "version"],
  },
] as const;

export interface CliContext {
  currentDirectory?: string;
  registryPath?: string;
  resolveProvider?: ProviderResolver;
  qmdCommand?: readonly string[];
  rgCommand?: readonly string[];
  artifactRoot?: string;
  artifactRunId?: string;
  now?: Date;
}

interface CliCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PackageMetadata {
  version?: unknown;
}

const PACKAGE_JSON_URL = new URL("../package.json", import.meta.url);
const SOURCE_ROOT_URL = new URL("./", import.meta.url);
const PACKAGE_JSON_PATH = fileURLToPath(PACKAGE_JSON_URL);
const SOURCE_ROOT_PATH = dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(PACKAGE_JSON_URL, "utf8"),
  ) as PackageMetadata;

  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("version metadata must contain a non-empty version string");
  }

  return packageJson.version;
}

function findLatestMtimeMs(root: URL): number {
  const stat = statSync(root);
  if (!stat.isDirectory()) return stat.mtimeMs;

  return readdirSync(root, { withFileTypes: true }).reduce((latest, entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, root);
    return Math.max(latest, findLatestMtimeMs(child));
  }, stat.mtimeMs);
}

function formatMtime(ms: number): string {
  return new Date(ms).toISOString();
}

function formatLocalMtime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

export function renderVersion(options: { verbose?: boolean } = {}): string {
  const version = readPackageVersion();
  if (!options.verbose) return `ukp ${version}\n`;

  const packageMtimeMs = statSync(PACKAGE_JSON_URL).mtimeMs;
  const sourceMtimeMs = findLatestMtimeMs(SOURCE_ROOT_URL);
  const lines = [
    `ukp ${version}`,
    `source_updated_local: ${formatLocalMtime(sourceMtimeMs)}`,
    `source_updated_utc: ${formatMtime(sourceMtimeMs)}`,
    `package_updated_local: ${formatLocalMtime(packageMtimeMs)}`,
    `package_updated_utc: ${formatMtime(packageMtimeMs)}`,
    `runtime: bun ${Bun.version}`,
    `source: ${SOURCE_ROOT_PATH}`,
    `package: ${PACKAGE_JSON_PATH}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function renderVersionHelp(): string {
  const lines = [
    "Usage: ukp version [options]",
    "",
    "Show version information.",
    "",
    "Options:",
    "  -v, --verbose  show debug version details",
    "  -h, --help     show this help",
  ];
  return `${lines.join("\n")}\n`;
}

export function renderHelp(): string {
  const lines = [
    "Usage: ukp <command> [options]",
    "",
    "Start here: 'ukp guide service' (first setup - covers init and register) or 'ukp list' (see registered endpoints).",
    "",
    "Commands:",
    ...COMMAND_GROUPS.flatMap((group) => [
      `${group.heading}:`,
      ...group.commands.map((name) =>
        `  ${name.padEnd(10)} ${COMMAND_DESCRIPTIONS[name]}`
      ),
      "",
    ]),
    "Endpoint names for --endpoint come from 'ukp list'.",
    "",
    "A Service's declared capabilities are backed by a provider (QMD, an external tool, backs search and update today); rg and nav work on endpoint files directly, no provider needed.",
    "",
    "A Service is a folder with a manifest (a name plus optional declared capabilities); registering it binds that name as an endpoint you address with --endpoint. The scope is which endpoints commands use when no --endpoint is given; -g widens a command to every registered endpoint; 'ukp guide client' shows how to set the workspace default.",
    "",
    "Guides:",
    ...GUIDE_TOPICS.map(([topic, summary]) => `  ukp ${`guide ${topic}`.padEnd(17)} ${summary}`),
    "",
    "Options:",
    "  -h, --help     show this help",
    "  -V, --version  show version",
  ];
  return `${lines.join("\n")}\n`;
}

function writeCommandResult(
  result: CliCommandResult,
  stdout: (message?: unknown) => void,
  stderr: (message?: unknown) => void,
): number {
  if (result.stdout) stdout(result.stdout.trimEnd());
  if (result.stderr) stderr(result.stderr.trimEnd());
  return result.exitCode;
}

/** Channel philosophy for `ukp list` (ukp_list W2): stdout is the data
 * channel — byte contract, one row per line, the terminal wraps what it
 * must; stderr to an INTERACTIVE terminal is the human channel — progress
 * frames already live there, and the footnote lines (degradation warnings,
 * drift notes) may exceed any terminal width (pins are ~44 chars, urls
 * longer), so the terminal would otherwise break them mid-word or
 * mid-hash. This wraps them at word boundaries (over-long tokens
 * hard-split at the width) — only when the emitter knows the width;
 * piped/CI stderr keeps raw single lines, the machine-parseable form. */
export function wrapLinesForTerminal(text: string, columns: number): string {
  if (!Number.isSafeInteger(columns) || columns < 8) return text;
  const wrapped: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= columns) {
      wrapped.push(line);
      continue;
    }
    let current = "";
    for (const token of line.split(" ")) {
      // A token longer than the width hard-splits at the width (paths and
      // SPKI pins have no spaces to break on); the remainder re-enters the
      // same greedy fill so following words still pack.
      const pieces: string[] = [];
      let rest = token;
      while (rest.length > columns) {
        pieces.push(rest.slice(0, columns));
        rest = rest.slice(columns);
      }
      pieces.push(rest);
      for (const piece of pieces) {
        if (current.length === 0) {
          current = piece;
        } else if (current.length + 1 + piece.length <= columns) {
          current += ` ${piece}`;
        } else {
          wrapped.push(current);
          current = piece;
        }
      }
    }
    wrapped.push(current);
  }
  return wrapped.join("\n");
}

function executeVersionCommand(args: readonly string[]): CliCommandResult {
  if (args.length === 0) {
    return { exitCode: 0, stdout: renderVersion(), stderr: "" };
  }

  // Help wins wherever it appears (option order-independence; same rule as
  // the commander-wrapped commands via isCommanderHelpIntent).
  if (args.includes("-h") || args.includes("--help")) {
    return { exitCode: 0, stdout: renderVersionHelp(), stderr: "" };
  }

  if (args.length === 1 && (args[0] === "-v" || args[0] === "--verbose")) {
    return { exitCode: 0, stdout: renderVersion({ verbose: true }), stderr: "" };
  }

  return {
    exitCode: 2,
    stdout: "",
    stderr: [
      `ukp version: unexpected argument '${args[0] ?? ""}'`,
      "Run 'ukp version --help' for details.",
    ].join("\n"),
  };
}

function writeVersionCommandResult(
  createResult: () => CliCommandResult,
  stdout: (message?: unknown) => void,
  stderr: (message?: unknown) => void,
): number {
  try {
    return writeCommandResult(createResult(), stdout, stderr);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`ukp: unable to read version metadata: ${message}`);
    return 1;
  }
}

/** Conditional-async dispatch shim (ukp_remote W2): local-only invocations
 * stay fully synchronous (returning a number); scopes that include remote
 * endpoints resolve over the network and return a promise. The bin entry
 * awaits promises; sync callers (tests) see numbers unchanged. */
function writeCommandResultMaybeAsync(
  result: CliCommandResult | Promise<CliCommandResult>,
  stdout: (message?: unknown) => void,
  stderr: (message?: unknown) => void,
): number | Promise<number> {
  if (result instanceof Promise) {
    return result.then((resolved) => writeCommandResult(resolved, stdout, stderr));
  }
  return writeCommandResult(result, stdout, stderr);
}

export function runCli(
  args: readonly string[],
  stdout = console.log,
  stderr = console.error,
  context: CliContext = {},
): number | Promise<number> {
  const [command] = args;
  const currentDirectory = context.currentDirectory ?? process.cwd();
  const registryPath = context.registryPath ?? join(homedir(), ".ukp", "registry.toml");

  if (!command || command === "-h" || command === "--help") {
    stdout(renderHelp().trimEnd());
    return 0;
  }

  if (command === "-V" || command === "--version") {
    return writeVersionCommandResult(
      () => ({ exitCode: 0, stdout: renderVersion(), stderr: "" }),
      stdout,
      stderr,
    );
  }

  if (command === "version") {
    return writeVersionCommandResult(() => executeVersionCommand(args.slice(1)), stdout, stderr);
  }

  if (command === "diagnose") {
    return writeCommandResult(executeDiagnoseCommand(args.slice(1), {
      currentDirectory,
      registryPath,
      resolveProvider: context.resolveProvider,
    }), stdout, stderr);
  }

  if (command === "read") {
    return writeCommandResultMaybeAsync(executeReadCommand(args.slice(1), {
      currentDirectory,
      registryPath,
      qmdCommand: context.qmdCommand,
    }), stdout, stderr);
  }

  if (command === "guide") {
    return writeCommandResult(executeGuideCommand(args.slice(1)), stdout, stderr);
  }

  if (command === "init") {
    return writeCommandResult(executeInitCommand(args.slice(1), {
      currentDirectory,
    }), stdout, stderr);
  }

  if (command === "inspect") {
    return writeCommandResult(executeInspectCommand(args.slice(1), {
      currentDirectory,
      registryPath,
      resolveProvider: context.resolveProvider,
    }), stdout, stderr);
  }

  if (command === "register") {
    return writeCommandResultMaybeAsync(executeRegisterCommand(args.slice(1), {
      currentDirectory,
      registryPath,
      resolveProvider: context.resolveProvider,
    }), stdout, stderr);
  }

  if (command === "update") {
    return writeCommandResult(executeUpdateCommand(args.slice(1), {
      currentDirectory,
      registryPath,
      qmdCommand: context.qmdCommand,
    }), stdout, stderr);
  }

  if (command === "serve") {
    return writeCommandResult(executeServeCommand(args.slice(1), {
      currentDirectory,
      registryPath,
      qmdCommand: context.qmdCommand,
    }), stdout, stderr);
  }

  if (command === "unregister") {
    return writeCommandResult(executeUnregisterCommand(args.slice(1), {
      currentDirectory,
      registryPath,
    }), stdout, stderr);
  }

  if (command === "list") {
    // Streaming delivery (ukp_list W2 / ADR 0026 rule 3): line-by-line
    // through the same stdout writer every other print uses (console.log
    // per line ≡ the single print's trailing-newline form, so piped bytes
    // match the returned-text contract); progress frames only on an
    // interactive stderr, so piped runs stay progress-silent. The stderr
    // footnotes wrap at the terminal width there too — piped stderr keeps
    // the raw single lines (wrapLinesForTerminal's contract).
    const stderrColumns = process.stderr.columns ?? process.stdout.columns;
    const interactivelyWrap = (result: CliCommandResult): CliCommandResult =>
      process.stderr.isTTY === true && typeof stderrColumns === "number" && result.stderr.length > 0
        ? { ...result, stderr: wrapLinesForTerminal(result.stderr, stderrColumns) }
        : result;
    // Conditionality preserved (the W2 sync seam): an all-local listing
    // stays a synchronous value wrapped synchronously; only the remote
    // branch's promise goes through .then.
    const result = executeListCommand(args.slice(1), {
      currentDirectory,
      registryPath,
      ...(process.stderr.isTTY === true
        ? { emitProgress: (frame: string) => process.stderr.write(frame) }
        : {}),
      emitStdout: (line: string) => stdout(line),
    });
    return writeCommandResultMaybeAsync(
      result instanceof Promise ? result.then(interactivelyWrap) : interactivelyWrap(result),
      stdout,
      stderr,
    );
  }

  if (command === "nav") {
    return writeCommandResultMaybeAsync(executeNavCommand(args.slice(1), {
      currentDirectory,
      registryPath,
    }), stdout, stderr);
  }

  if (command === "propose") {
    return writeCommandResultMaybeAsync(executeProposeCommand(args.slice(1), {
      currentDirectory,
      registryPath,
    }), stdout, stderr);
  }

  if (command === "rg") {
    return writeCommandResultMaybeAsync(executeRgCommand(args.slice(1), {
      currentDirectory,
      registryPath,
      rgCommand: context.rgCommand,
    }), stdout, stderr);
  }

  if (command === "search") {
    return writeCommandResultMaybeAsync(executeSearchCommand(args.slice(1), {
      currentDirectory,
      registryPath,
      qmdCommand: context.qmdCommand,
      artifactRoot: context.artifactRoot,
      artifactRunId: context.artifactRunId,
      now: context.now,
    }), stdout, stderr);
  }

  stderr(`ukp: unknown command '${command}'`);
  stderr("Run 'ukp --help' for usage.");
  return 2;
}

if (import.meta.main) {
  const exitCode = runCli(process.argv.slice(2));
  if (exitCode instanceof Promise) {
    exitCode.then((code) => {
      process.exitCode = code;
    });
  } else {
    process.exitCode = exitCode;
  }
}
