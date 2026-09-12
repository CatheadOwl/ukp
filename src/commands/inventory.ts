import { ENDPOINT_NAME, loadManifest } from "../config/manifest.ts";
import { FILE_NATIVE_CAPABILITIES, isFileNativeCapability } from "../config/file-native.ts";
import { diagnoseService, type ProviderResolver } from "./diagnose.ts";
import { readRegistry, registerAt, unregisterAt } from "../registry.ts";
import {
  KitUsageError,
  parseKitArgs,
  renderKitHelp,
  renderKitUsageError,
  type UkpCommandSpec,
} from "./kit.ts";
import { HelpRequestError, isHelpRequest } from "./flags.ts";

export interface InventoryCommandContext {
  currentDirectory: string;
  registryPath: string;
  resolveProvider?: ProviderResolver;
}

export interface InventoryCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Single-source command specs (ADR 0024): summaries feed the root help via
 * cli.ts; usage feeds the help header and the usage-error line; excess
 * positionals are rejected by commander (strictArguments). */
export const REGISTER_SPEC: UkpCommandSpec = {
  name: "register",
  summary: "register a Service endpoint",
  group: "registry",
  description: "Register the current Service folder.",
  usage: "[options]",
  strictArguments: true,
  helpSuffix: [
    "",
    "Recovery:",
    "  Registering a name already bound to a different location is rejected.",
    "  Unregister the old binding first, then register from the new Service folder:",
    "  ukp unregister --endpoint <name>",
    "",
    "Binding:",
    "  The Host Registry binds the Service Manifest's effective name to this",
    "  folder's location; 'ukp list' shows the resulting bindings.",
    "",
  ].join("\n"),
};

export const LIST_SPEC: UkpCommandSpec = {
  name: "list",
  summary: "list registered endpoint bindings",
  group: "registry",
  description: "List registered endpoint bindings and capabilities.",
  usage: "[options]",
  strictArguments: true,
};

export const UNREGISTER_SPEC: UkpCommandSpec = {
  name: "unregister",
  summary: "remove a registered endpoint binding (files on disk are untouched)",
  group: "registry",
  description: "Remove a registered endpoint.",
  usage: "--endpoint <name>",
  arguments: [{ name: "name", help: "legacy alias for --endpoint <name>; prefer the flag form" }],
  options: [{ flags: "-c, --endpoint <name>", help: "select the endpoint binding to remove" }],
  strictArguments: true,
};

interface UnregisterCommandOptions extends Record<string, unknown> {
  endpoint?: string;
}

// Derived file-native capabilities (read/nav today) exist on every registered
// endpoint without a declaration (ADR 0016 rule 2); they are stated once in
// the header instead of being repeated on every row. Everything else a
// Service declares (search, update, propose, ...) is per-endpoint news and
// gets its own column.
const DEFAULT_CAPABILITIES = (Object.keys(FILE_NATIVE_CAPABILITIES) as Array<keyof typeof FILE_NATIVE_CAPABILITIES>)
  .filter((name) => FILE_NATIVE_CAPABILITIES[name].derived)
  .sort();

function renderListRow(endpoint: { name: string; path: string }): { line: string; warning?: string } {
  let service;
  try {
    service = loadManifest(endpoint.path);
  } catch (error) {
    // One-line headline only: an inventory warning must stay scannable even
    // when the underlying ManifestError carries a full zod schema dump.
    const headline = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    return {
      line: `${endpoint.name}\t${endpoint.path}\t(unavailable)`,
      warning: `endpoint '${endpoint.name}' capabilities unavailable: ${headline}`,
    };
  }
  const extras = Object.keys(service.manifest.capabilities)
    .filter((name) => !(isFileNativeCapability(name) && FILE_NATIVE_CAPABILITIES[name].derived))
    .sort();
  return { line: `${endpoint.name}\t${endpoint.path}\t${extras.length > 0 ? extras.join(",") : "-"}` };
}

export function executeRegisterCommand(
  args: readonly string[],
  context: InventoryCommandContext,
): InventoryCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderKitHelp(REGISTER_SPEC), stderr: "" };
  }

  try {
    parseKitArgs(REGISTER_SPEC, args);
    const report = diagnoseService(context.currentDirectory, context.resolveProvider);
    registerAt(context.registryPath, report.service.effectiveName, report.service.folder);
    const lines = [
      `registered: ${report.service.effectiveName}`,
      ...(report.service.manifest.description ? [`description: ${report.service.manifest.description}`] : []),
      `location: ${report.service.folder}`,
    ];
    return {
      exitCode: 0,
      stdout: lines.join("\n"),
      stderr: "",
    };
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderKitHelp(REGISTER_SPEC), stderr: "" };
    }
    if (error instanceof KitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderKitUsageError(REGISTER_SPEC, error.message) };
    }
    return { exitCode: 1, stdout: "", stderr: `ukp register: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function executeListCommand(args: readonly string[], context: InventoryCommandContext): InventoryCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderKitHelp(LIST_SPEC), stderr: "" };
  }

  try {
    parseKitArgs(LIST_SPEC, args);
    const endpoints = readRegistry(context.registryPath);
    if (endpoints.length === 0) {
      return { exitCode: 0, stdout: "No endpoints registered.", stderr: "" };
    }
    const warnings: string[] = [];
    const rows = endpoints.map((endpoint) => {
      const rendered = renderListRow(endpoint);
      if (rendered.warning) warnings.push(rendered.warning);
      return rendered.line;
    });
    const stdout = [
      `capabilities on every endpoint: ${DEFAULT_CAPABILITIES.join(", ")} (derived file-native); additional declared capabilities per endpoint:`,
      ...rows,
    ].join("\n");
    return {
      exitCode: 0,
      stdout,
      stderr: warnings.length > 0 ? `${warnings.join("\n")}\n` : "",
    };
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderKitHelp(LIST_SPEC), stderr: "" };
    }
    if (error instanceof KitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderKitUsageError(LIST_SPEC, error.message) };
    }
    return { exitCode: 1, stdout: "", stderr: `ukp list: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function executeUnregisterCommand(
  args: readonly string[],
  context: InventoryCommandContext,
): InventoryCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderKitHelp(UNREGISTER_SPEC), stderr: "" };
  }

  try {
    const parsed = parseKitArgs<UnregisterCommandOptions>(UNREGISTER_SPEC, args);
    const positional = parsed.positionals[0];
    if (parsed.options.endpoint && positional) {
      throw new KitUsageError("unregister accepts either --endpoint <name> or legacy positional <name>, not both");
    }
    const name = parsed.options.endpoint ?? positional;
    if (!name || !ENDPOINT_NAME.test(name)) {
      throw new KitUsageError("unregister requires a valid endpoint name via --endpoint <name>");
    }
    const previous = readRegistry(context.registryPath).find((binding) => binding.name === name);
    unregisterAt(context.registryPath, name);
    return {
      exitCode: 0,
      stdout: `unregistered: ${name}\nlocation: ${previous?.path ?? "unknown"}`,
      stderr: "",
    };
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderKitHelp(UNREGISTER_SPEC), stderr: "" };
    }
    if (error instanceof KitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderKitUsageError(UNREGISTER_SPEC, error.message) };
    }
    return { exitCode: 1, stdout: "", stderr: `ukp unregister: ${error instanceof Error ? error.message : String(error)}` };
  }
}
