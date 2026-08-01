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
    "UKP Service onboarding",
    "",
    "Goal: make the current folder a named Knowledge Service backed by QMD search.",
    "Run these commands from the Service folder root.",
    "",
    "1. Choose a stable Service folder",
    "   Use the project or knowledge-domain root. Limit searchable subfolders in QMD, not in the UKP Registry.",
    "",
    "2. Create .ukp/service.toml",
    "   ukp init service --name your-endpoint-name",
    "   Optional: add --description \"Short boundary note\"",
    "   Name must be a lowercase endpoint slug, for example: cad-notes",
    "",
    "3. Configure QMD inside the Service folder",
    "   qmd init",
    "   qmd collection add <searchable-folder>",
    "   Example: qmd collection add .\\docs",
    "   qmd update",
    "   Optional: qmd collection list, then rename path-shaped collection names.",
    "",
    "4. Validate and register",
    "   ukp diagnose",
    "   ukp register",
    "   ukp list",
    "",
    "5. Smoke test",
    "   ukp search \"keyword\" --endpoint your-endpoint-name --limit 3",
    "   ukp search \"keyword\" --endpoint your-endpoint-name --limit 3 --json",
    "",
    "Remember:",
    "- Endpoint name identifies the Service.",
    "- Host Registry stores endpoint name -> Service folder path.",
    "- QMD collection decides what content inside the Service is indexed.",
    "- Register does not edit .ukp/client.toml or QMD configuration.",
  ].join("\n") + "\n";
}

export function renderGuideUsageError(message: string): string {
  return [
    `ukp guide: ${message}`,
    "Usage: ukp guide <topic>",
    "Run 'ukp guide --help' for details.",
  ].join("\n");
}
