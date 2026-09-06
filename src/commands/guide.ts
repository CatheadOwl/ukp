import { readFileSync } from "node:fs";
import { Command, CommanderError } from "commander";

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

const GUIDE_CONTENT_URL = new URL("./guide-content/", import.meta.url);

function readGuideContent(filename: string): string {
  return readFileSync(new URL(filename, GUIDE_CONTENT_URL), "utf8");
}

function createGuideCommand(): Command {
  return new Command("ukp guide")
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(false)
    .helpOption("-h, --help", "show this help")
    .usage("<topic> [subtopic]")
    .description("Show short operational guides.")
    .argument("<topic>", "guide topic: service | service qmd | client | propose")
    .argument("[subtopic]", "provider subtopic for a topic, e.g. service qmd");
}

function parseGuideCommand(args: readonly string[]): [topic: string, subtopic?: string] {
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

  return [command.args[0] ?? "", command.args[1]];
}

export function executeGuideCommand(args: readonly string[]): GuideCommandResult {
  if (args.includes("-h") || args.includes("--help")) {
    return { exitCode: 0, stdout: renderGuideHelp(), stderr: "" };
  }

  try {
    const [topic, subtopic] = parseGuideCommand(args);
    if (topic === "service") {
      if (subtopic === "qmd") {
        return { exitCode: 0, stdout: renderServiceQmdGuide(), stderr: "" };
      }
      if (subtopic) {
        throw new GuideUsageError(`unknown provider subtopic '${subtopic}'. Available subtopic for service: qmd`);
      }
      return { exitCode: 0, stdout: renderServiceGuide(), stderr: "" };
    }
    if (subtopic) {
      throw new GuideUsageError(`unknown guide topic '${topic} ${subtopic}'. Available topics: service, service qmd, client, propose`);
    }
    switch (topic) {
      case "client":
        return { exitCode: 0, stdout: renderClientGuide(), stderr: "" };
      case "propose":
        return { exitCode: 0, stdout: renderProposeGuide(), stderr: "" };
      default:
        throw new GuideUsageError(`unknown guide topic '${topic}'. Available topics: service, service qmd, client, propose`);
    }
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
  return readGuideContent("service.txt");
}

export function renderServiceQmdGuide(): string {
  return readGuideContent("service-qmd.txt");
}

export function renderClientGuide(): string {
  return readGuideContent("client.txt");
}

export function renderProposeGuide(): string {
  return readGuideContent("propose.txt");
}

export function renderGuideUsageError(message: string): string {
  return [
    `ukp guide: ${message}`,
    "Usage: ukp guide <topic>",
    "Run 'ukp guide --help' for details.",
  ].join("\n");
}
