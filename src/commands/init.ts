import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, unlinkSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { stringify } from "smol-toml";
import { ENDPOINT_NAME, loadManifest, type ManifestDependency } from "../config/manifest.ts";
import {
  KitUsageError,
  parseKitArgs,
  renderKitHelp,
  renderKitUsageError,
  type UkpCommandSpec,
} from "./kit.ts";
import { HelpRequestError, isHelpRequest } from "./flags.ts";

export interface InitCommandContext {
  currentDirectory: string;
}

export interface InitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Single-source command specs (ADR 0024). `init service` subcommand routing
 * stays command-side (executeInitCommand peels the first token before
 * parsing) — kit has no subcommand layer, by design. */
export const INIT_SPEC: UkpCommandSpec = {
  name: "init",
  summary: "initialize UKP-owned files",
  group: "registry",
  description: "Initialize UKP-owned files.",
  usage: "<target>",
  arguments: [{ name: "target", required: true, help: "init target: service" }],
  strictArguments: true,
  helpSuffix: [
    "",
    "Run 'ukp init service' to create a Service Manifest",
    "('.ukp/service.toml') in the current folder; 'service' is currently",
    "the only target.",
    "",
  ].join("\n"),
};

export const INIT_SERVICE_SPEC: UkpCommandSpec = {
  name: "init service",
  summary: "create a Service Manifest in the current folder",
  group: "registry",
  description: "Create a Service Manifest in the current folder.",
  usage: "[--name <name>] [--description <text>] [--dependency <name>]",
  options: [
    { flags: "--name <name>", help: "explicit Service endpoint name; defaults to the folder basename" },
    { flags: "--description <text>", help: "human-readable Service description" },
    { flags: "--dependency <name>", help: "declare a contextual dependency endpoint", multi: true },
  ],
  strictArguments: true,
  helpSuffix: [
    "Creates .ukp/service.toml with the current minimal search provider:",
    "  [capabilities.search]",
    "  provider = \"qmd\"",
    "Optional:",
    "  --dependency <name>   declare another endpoint as a contextual dependency entry",
    "  each --dependency emits [[dependencies]] with endpoint + kind = \"context\"",
    "",
    "Next:",
    "  ukp guide service qmd",
    "  ukp diagnose",
    "  ukp register",
    "",
  ].join("\n"),
};

interface InitServiceOptions extends Record<string, unknown> {
  name?: string;
  description?: string;
  dependency?: string[];
}

function resolveServiceFolder(currentDirectory: string): string {
  try {
    const folder = realpathSync(currentDirectory);
    if (!statSync(folder).isDirectory()) throw new Error("not a directory");
    return folder;
  } catch (error) {
    throw new Error(`Service folder is not accessible: ${currentDirectory}`, { cause: error });
  }
}

function resolveServiceName(folder: string, explicitName?: string): { name: string; source: "option" | "folder-name" } {
  const name = explicitName ?? basename(folder);
  const source = explicitName === undefined ? "folder-name" : "option";
  if (!ENDPOINT_NAME.test(name)) {
    const hint = source === "folder-name"
      ? "Pass '--name <name>' with a lowercase endpoint slug."
      : "Name must be a lowercase endpoint slug.";
    throw new KitUsageError(`invalid Service name '${name}'. ${hint}`);
  }
  return { name, source };
}

function validateInitServiceOptions(
  folder: string,
  options: InitServiceOptions,
): { name: string; nameSource: "option" | "folder-name"; dependencies?: ManifestDependency[] } {
  const { name, source } = resolveServiceName(folder, options.name);
  if (options.description === "") {
    throw new KitUsageError("description must be a non-empty string");
  }
  let dependencies: ManifestDependency[] | undefined;
  if (options.dependency) {
    dependencies = [];
    const seen = new Set<string>();
    for (const dependency of options.dependency) {
      if (!ENDPOINT_NAME.test(dependency)) {
        throw new KitUsageError(`invalid dependency name '${dependency}'. Dependencies must use the endpoint slug grammar.`);
      }
      if (dependency === name) {
        throw new KitUsageError(`dependency '${dependency}' cannot target the Service itself`);
      }
      if (seen.has(dependency)) {
        throw new KitUsageError(`duplicate dependency '${dependency}'`);
      }
      seen.add(dependency);
      dependencies.push({
        endpoint: dependency,
        kind: "context",
      });
    }
  }
  return { name, nameSource: source, dependencies };
}

function renderServiceManifest(options: { name?: string; description?: string; dependencies?: ManifestDependency[] }): string {
  const encoded = stringify({
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
    capabilities: {
      search: {
        provider: "qmd",
      },
    },
  });
  return encoded.endsWith("\n") ? encoded : `${encoded}\n`;
}

function createServiceManifest(
  currentDirectory: string,
  options: InitServiceOptions,
): { folder: string; manifestPath: string; name: string; nameSource: "option" | "folder-name" } {
  const folder = resolveServiceFolder(currentDirectory);
  const ukpDirectory = join(folder, ".ukp");
  const manifestPath = join(ukpDirectory, "service.toml");
  const { name, nameSource, dependencies } = validateInitServiceOptions(folder, options);
  if (existsSync(manifestPath)) {
    throw new Error(`Service Manifest already exists: ${manifestPath}`);
  }

  mkdirSync(ukpDirectory, { recursive: true });
  const descriptor = openSync(manifestPath, "wx", 0o600);
  let committed = false;
  try {
    writeFileSync(descriptor, renderServiceManifest({ ...options, dependencies }), "utf8");
    committed = true;
  } finally {
    closeSync(descriptor);
    if (!committed && existsSync(manifestPath)) unlinkSync(manifestPath);
  }

  try {
    loadManifest(folder);
  } catch (error) {
    if (existsSync(manifestPath)) unlinkSync(manifestPath);
    throw error;
  }

  return { folder, manifestPath, name, nameSource };
}

function executeInitServiceCommand(args: readonly string[], context: InitCommandContext): InitCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderInitServiceHelp(), stderr: "" };
  }

  try {
    const parsed = parseKitArgs<InitServiceOptions>(INIT_SERVICE_SPEC, args);
    const result = createServiceManifest(context.currentDirectory, parsed.options);
    return {
      exitCode: 0,
      stdout: [
        `initialized Service: ${result.name}`,
        `name_source: ${result.nameSource}`,
        `manifest: ${result.manifestPath}`,
        `location: ${result.folder}`,
        "capability: search",
        "provider: qmd",
        "next: ukp guide service qmd",
        "next: ukp diagnose",
        "next: ukp register",
      ].join("\n"),
      stderr: "",
    };
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderInitServiceHelp(), stderr: "" };
    }
    if (error instanceof KitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderKitUsageError(INIT_SERVICE_SPEC, error.message) };
    }
    return { exitCode: 1, stdout: "", stderr: `ukp init service: ${error instanceof Error ? error.message : String(error)}\n` };
  }
}

export function executeInitCommand(args: readonly string[], context: InitCommandContext): InitCommandResult {
  if (args[0] === "service") {
    return executeInitServiceCommand(args.slice(1), context);
  }
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderInitHelp(), stderr: "" };
  }

  try {
    const parsed = parseKitArgs(INIT_SPEC, args);
    const [target] = parsed.positionals;
    if (target !== "service") {
      throw new KitUsageError(`unknown init target '${target}'. Available target: service`);
    }
    return executeInitServiceCommand([], context);
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderInitHelp(), stderr: "" };
    }
    if (error instanceof KitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderKitUsageError(INIT_SPEC, error.message) };
    }
    return { exitCode: 1, stdout: "", stderr: `ukp init: ${error instanceof Error ? error.message : String(error)}\n` };
  }
}

export function renderInitHelp(): string {
  return renderKitHelp(INIT_SPEC);
}

export function renderInitServiceHelp(): string {
  return renderKitHelp(INIT_SERVICE_SPEC);
}
