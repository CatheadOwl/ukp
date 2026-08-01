import { Command, CommanderError } from "commander";
import { isHelpRequest } from "./flags.ts";

export interface GuideCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class GuideUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuideUsageError";
  }
}

function createGuideCommand(): Command {
  return new Command("ukp guide")
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(false)
    .helpOption("-h, --help", "show this help")
    .usage("<topic>")
    .description("Show short operational guides.")
    .argument("<topic>", "guide topic: service");
}

function parseGuideCommand(args: readonly string[]): string {
  const command = createGuideCommand()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new GuideUsageError(error.message.replace(/^error: /, ""));
    }
    throw error;
  }

  return command.args[0] ?? "";
}

export function executeGuideCommand(args: readonly string[]): GuideCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderGuideHelp(), stderr: "" };
  }

  try {
    const topic = parseGuideCommand(args);
    if (topic !== "service") {
      throw new GuideUsageError(`unknown guide topic '${topic}'. Available topic: service`);
    }
    return { exitCode: 0, stdout: renderServiceGuide(), stderr: "" };
  } catch (error) {
    if (error instanceof GuideUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderGuideUsageError(error.message) };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `error: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

export function renderGuideHelp(): string {
  return createGuideCommand().helpInformation();
}

export function renderServiceGuide(): string {
  return [
    "UKP Service quickstart",
    "",
    "Goal: make a folder a named Knowledge Service, register it, inspect the route, search it, read a known file, and refresh provider-owned state.",
    "Run the setup commands from the Service folder root.",
    "",
    "Model:",
    "- A UKP Service is a knowledge endpoint that declares capabilities.",
    "- QMD is the current default search/refresh provider, not the definition of a Service.",
    "- QMD owns collection, index, ranking, and local/global config.",
    "",
    "1. Choose a stable Service folder",
    "   Use the project or knowledge-domain root. Limit searchable subfolders in QMD, not in the UKP Registry.",
    "",
    "2. Create the UKP Service Manifest",
    "   ukp init service --name your-endpoint-name",
    "   Optional: add --description \"Short boundary note\"",
    "   Name must be a lowercase endpoint slug, for example: cad-notes",
    "   This writes .ukp/service.toml with the current minimal provider declaration:",
    "   [capabilities.search]",
    "   provider = \"qmd\"",
    "",
    "3. Configure the current provider inside the Service folder",
    "   qmd init",
    "   qmd collection add <searchable-folder>",
    "   Example: qmd collection add .\\docs",
    "   qmd update",
    "",
    "4. Validate and register",
    "   ukp diagnose",
    "   ukp register",
    "   ukp list",
    "",
    "5. Inspect the effective route",
    "   ukp inspect --endpoint your-endpoint-name",
    "   Use inspect when you need to explain scope, Registry binding, Manifest capability, or provider availability.",
    "",
    "6. Search",
    "   ukp search \"keyword\" --endpoint your-endpoint-name --limit 3",
    "   ukp search \"keyword\" --endpoint your-endpoint-name --limit 3 --json",
    "   In a workspace with .ukp/client.toml default_endpoints, you can omit --endpoint for search.",
    "",
    "7. Read a known endpoint-local file",
    "   This is optional for the first search path. Add this capability to .ukp/service.toml when file reads should be exposed:",
    "   [capabilities.get]",
    "   provider = \"file\"",
    "   ukp get --endpoint your-endpoint-name docs/example.md",
    "   ukp get --endpoint your-endpoint-name docs/example.md --lines 10:20",
    "",
    "8. Refresh provider-owned state",
    "   This is optional for the first search path. Add this capability to .ukp/service.toml when provider maintenance should be exposed:",
    "   [capabilities.refresh]",
    "   provider = \"qmd\"",
    "   ukp refresh --endpoint your-endpoint-name",
    "   In a workspace with .ukp/client.toml default_endpoints, you can omit --endpoint for refresh too.",
    "   Use ukp refresh -g only when you explicitly want to refresh every registered endpoint.",
    "",
    "Remember:",
    "- Endpoint name identifies the Service.",
    "- Host Registry stores endpoint name -> Service folder path.",
    "- QMD collection decides what content inside the Service is indexed.",
    "- Register does not edit .ukp/client.toml or provider configuration.",
    "- Future providers should add provider adapters instead of turning QMD internals into UKP rules.",
  ].join("\n") + "\n";
}

export function renderGuideUsageError(message: string): string {
  return [
    `ukp guide: ${message}`,
    "Usage: ukp guide <topic>",
    "Run 'ukp guide --help' for details.",
  ].join("\n");
}
