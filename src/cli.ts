#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  executeDiagnoseCommand,
  type ProviderResolver,
} from "./commands/diagnose.ts";
import { executeGetCommand } from "./commands/get.ts";
import { executeGuideCommand } from "./commands/guide.ts";
import { executeInitCommand } from "./commands/init.ts";
import { executeInspectCommand } from "./commands/inspect.ts";
import { executeListCommand, executeRegisterCommand, executeUnregisterCommand } from "./commands/inventory.ts";
import { executeProposeCommand } from "./commands/propose.ts";
import { executeRefreshCommand } from "./commands/refresh.ts";
import { executeSearchCommand } from "./commands/search.ts";

export { renderSearchHelp } from "./commands/search.ts";
export { renderDiagnoseHelp } from "./commands/diagnose.ts";
export { renderGetHelp } from "./commands/get.ts";
export { renderGuideHelp, renderServiceGuide, renderServiceQmdGuide, renderClientGuide, renderProposeGuide } from "./commands/guide.ts";
export { renderInitHelp, renderInitServiceHelp } from "./commands/init.ts";
export { renderInspectHelp } from "./commands/inspect.ts";
export { renderRefreshHelp } from "./commands/refresh.ts";
export { renderProposeHelp } from "./commands/propose.ts";

export const COMMANDS = [
  ["diagnose", "validate a Service folder or endpoint scope"],
  ["get", "read an endpoint-scoped resource reference"],
  ["guide", "show short operational guides"],
  ["init", "initialize UKP-owned files"],
  ["inspect", "explain current scope and endpoint routing"],
  ["refresh", "trigger provider-owned Service maintenance"],
  ["register", "register a Service endpoint"],
  ["unregister", "remove a registered endpoint"],
  ["list", "list registered endpoint bindings"],
  ["propose", "submit an idempotent change proposal"],
  ["search", "run atomic lexical search"],
  ["version", "show version information"],
] as const;

export interface CliContext {
  currentDirectory?: string;
  registryPath?: string;
  resolveProvider?: ProviderResolver;
  qmdCommand?: readonly string[];
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
    "Commands:",
    ...COMMANDS.map(([name, description]) => `  ${name.padEnd(10)} ${description}`),
    "",
    "Guides:",
    "  ukp guide service     first Service setup, inspect, search, get, and refresh path",
    "  ukp guide service qmd provider setup for the default QMD provider",
    "  ukp guide client      use registered Services by default from a workspace",
    "  ukp guide propose     submit idempotent change proposals to a Service",
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

function executeVersionCommand(args: readonly string[]): CliCommandResult {
  if (args.length === 0) {
    return { exitCode: 0, stdout: renderVersion(), stderr: "" };
  }

  if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) {
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

export function runCli(
  args: readonly string[],
  stdout = console.log,
  stderr = console.error,
  context: CliContext = {},
): number {
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

  if (command === "get") {
    return writeCommandResult(executeGetCommand(args.slice(1), {
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
    return writeCommandResult(executeRegisterCommand(args.slice(1), {
      currentDirectory,
      registryPath,
      resolveProvider: context.resolveProvider,
    }), stdout, stderr);
  }

  if (command === "refresh") {
    return writeCommandResult(executeRefreshCommand(args.slice(1), {
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
    return writeCommandResult(executeListCommand(args.slice(1), {
      currentDirectory,
      registryPath,
    }), stdout, stderr);
  }

  if (command === "propose") {
    return writeCommandResult(executeProposeCommand(args.slice(1), {
      currentDirectory,
      registryPath,
    }), stdout, stderr);
  }

  if (command === "search") {
    return writeCommandResult(executeSearchCommand(args.slice(1), {
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
  process.exitCode = runCli(process.argv.slice(2));
}
