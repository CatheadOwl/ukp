import { readFileSync } from "node:fs";
import {
  KitUsageError,
  parseKitArgs,
  renderKitHelp,
  renderKitUsageError,
  type UkpCommandSpec,
} from "./kit.ts";
import { HelpRequestError } from "./flags.ts";

export interface GuideCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const GUIDE_CONTENT_URL = new URL("./guide-content/", import.meta.url);

/** Single source for guide topic one-liners — root help and
 * `ukp guide --help` render the same summaries (blank-agent sweep 2026-09-11:
 * the inversion of root help describing guides better than guide's own help
 * was a confirmed doc-gap). */
export const GUIDE_TOPICS: ReadonlyArray<readonly [string, string]> = [
  ["service", "first Service setup with provider-free nav/read/rg baseline"],
  ["service qmd", "provider setup for the default QMD provider"],
  ["client", "use registered Services by default from a workspace; set your default scope here"],
  ["rg", "lexical search and file enumeration: modes, glob semantics, visibility tiers"],
  ["remote", "serve and consume remote endpoints with a host door, ssh, or TLS"],
  ["propose", "submit idempotent change proposals to a Service"],
];

/** Single-source command spec (ADR 0024): summary feeds the root help via
 * cli.ts; usage feeds the help header and the usage-error line. Topic
 * dispatch stays command-side. */
export const GUIDE_SPEC: UkpCommandSpec = {
  name: "guide",
  summary: "show short operational guides",
  group: "help",
  description: "Show short operational guides.",
  usage: "<topic> [subtopic]",
  arguments: [
    { name: "topic", required: true, help: "guide topic: service | service qmd | client | rg | remote | propose" },
    { name: "subtopic", help: "provider subtopic for a topic, e.g. 'qmd' as in 'ukp guide service qmd'" },
  ],
  strictArguments: true,
  helpSuffix: [
    "",
    "Topics:",
    ...GUIDE_TOPICS.map(([topic, summary]) => `  ${topic.padEnd(12)} ${summary}`),
    "",
  ].join("\n"),
};

function readGuideContent(filename: string): string {
  return readFileSync(new URL(filename, GUIDE_CONTENT_URL), "utf8");
}

export function executeGuideCommand(args: readonly string[]): GuideCommandResult {
  if (args.includes("-h") || args.includes("--help")) {
    return { exitCode: 0, stdout: renderGuideHelp(), stderr: "" };
  }

  try {
    const parsed = parseKitArgs(GUIDE_SPEC, args);
    const [topic = "", subtopic] = parsed.positionals;
    if (topic === "service") {
      if (subtopic === "qmd") {
        return { exitCode: 0, stdout: renderServiceQmdGuide(), stderr: "" };
      }
      if (subtopic) {
        throw new KitUsageError(`unknown provider subtopic '${subtopic}'. Available subtopic for service: qmd`);
      }
      return { exitCode: 0, stdout: renderServiceGuide(), stderr: "" };
    }
    if (subtopic) {
      throw new KitUsageError(`unknown guide topic '${topic} ${subtopic}'. Available topics: service, service qmd, client, rg, remote, propose`);
    }
    switch (topic) {
      case "client":
        return { exitCode: 0, stdout: renderClientGuide(), stderr: "" };
      case "rg":
        return { exitCode: 0, stdout: renderRgGuide(), stderr: "" };
      case "remote":
        return { exitCode: 0, stdout: renderRemoteGuide(), stderr: "" };
      case "propose":
        return { exitCode: 0, stdout: renderProposeGuide(), stderr: "" };
      default:
        throw new KitUsageError(`unknown guide topic '${topic}'. Available topics: service, service qmd, client, rg, remote, propose`);
    }
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderGuideHelp(), stderr: "" };
    }
    if (error instanceof KitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderGuideUsageError(error.message) };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `ukp guide: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

export function renderGuideHelp(): string {
  return renderKitHelp(GUIDE_SPEC);
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

export function renderRgGuide(): string {
  return readGuideContent("rg.txt");
}

export function renderRemoteGuide(): string {
  return readGuideContent("remote.txt");
}

export function renderProposeGuide(): string {
  return readGuideContent("propose.txt");
}

export function renderGuideUsageError(message: string): string {
  return renderKitUsageError(GUIDE_SPEC, message);
}
