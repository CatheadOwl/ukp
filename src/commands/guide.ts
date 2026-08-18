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

function createGuideCommand(): Command {
  return new Command("ukp guide")
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(false)
    .helpOption("-h, --help", "show this help")
    .usage("<topic> [subtopic]")
    .description("Show short operational guides.")
    .argument("<topic>", "guide topic: service | service qmd | client")
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
      throw new GuideUsageError(`unknown guide topic '${topic} ${subtopic}'. Available topics: service, service qmd, client`);
    }
    switch (topic) {
      case "client":
        return { exitCode: 0, stdout: renderClientGuide(), stderr: "" };
      default:
        throw new GuideUsageError(`unknown guide topic '${topic}'. Available topics: service, service qmd, client`);
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
  return [
    "UKP Service quickstart",
    "",
    "Goal: make a folder a named Knowledge Service, register it, inspect the route, search it, read an endpoint-scoped reference, and refresh provider-owned state.",
    "Run the setup commands from the Service folder root.",
    "",
    "Model:",
    "- A UKP Service is a knowledge endpoint that declares capabilities.",
    "- Four separate journeys:",
    "  - provider path: init service + register make a folder an addressable Service;",
    "  - content-searchable: provider setup decides what content is indexed (provider-owned; see 'ukp guide service qmd');",
    "  - declared dependencies: a Service Manifest can declare [[dependencies]] entries with endpoint + kind; this is declarative only;",
    "  - client path: a workspace .ukp/client.toml default scope lets you use Services by default instead of naming one each call.",
    "- Registered as a Service does not mean its content is searchable; both steps are needed.",
    "- QMD is the current default search/refresh provider, not the definition of a Service.",
    "- Provider setup is provider-owned: the provider owns collection, index, ranking, and config.",
    "",
    "1. Choose a stable Service folder",
    "   Use the project or knowledge-domain root. Limit searchable subfolders in the provider, not in the UKP Registry.",
    "",
    "2. Create the UKP Service Manifest",
    "   ukp init service --name your-endpoint-name",
    "   Optional: add --description \"Short boundary note\"",
    "   Name must be a lowercase endpoint slug, for example: cad-notes",
    "   This writes .ukp/service.toml with the current minimal provider declaration:",
    "   [capabilities.search]",
    "   provider = \"qmd\"",
    "",
    "3. Make content searchable through the provider (provider-owned)",
    "   Provider setup is not a UKP step. For the default QMD provider:",
    "   ukp guide service qmd",
    "   That topic reuses QMD's own help for exact syntax.",
    "",
    "   If this Service depends on other externally consumed knowledge endpoints,",
    "   declare them in the Manifest with repeated --dependency <name> entries;",
    "   each entry becomes [[dependencies]] with kind = \"context\" and can be edited later.",
    "",
    "4. Validate and register",
    "   ukp diagnose",
    "   ukp register",
    "   ukp list",
    "   At this point the folder is a registered Service: addressable and callable.",
    "   Its content is searchable only because step 3 configured the provider.",
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
    "7. Read an endpoint-scoped reference",
    "   Every registered local Service has the derived get/file baseline; no Manifest get entry is needed.",
    "   ukp get --endpoint your-endpoint-name docs/example.md",
    "   ukp get --endpoint your-endpoint-name docs/example.md --lines 10:20",
    "   On a QMD-backed Service (including observe mode), read with",
    "   'ukp get --endpoint <name> <reference>' (e.g. running_agents.md); do not",
    "   manually convert qmd:// provider locations into Service-folder paths.",
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
    "- Provider collection decides what content is indexed; folder-external authoritative knowledge should be modeled as its own endpoint when UKP ownership matters.",
    "- Register makes the folder addressable; it does not make content searchable (provider indexing does).",
    "- Register does not edit .ukp/client.toml or provider configuration.",
    "- Declarative dependencies live in the Service Manifest as [[dependencies]] entries; they describe related knowledge endpoints and do not change search/get behavior by themselves.",
    "- Future providers should add provider adapters instead of turning provider internals into UKP rules.",
    "- To register an already-used name at a new location, unregister the old binding first:",
    "  ukp unregister --endpoint <name>",
  ].join("\n") + "\n";
}

export function renderServiceQmdGuide(): string {
  return [
    "UKP Service quickstart — QMD provider setup",
    "",
    "Goal: make a registered Service's content searchable through the default QMD provider.",
    "Run these from the Service folder root.",
    "",
    "Boundary:",
    "- These are provider-owned steps. QMD owns collection, index, ranking, and config.",
    "- UKP only routes capability requests. This topic carries the journey; QMD's",
    "  own help (qmd --help) is the authority for exact flags and arguments.",
    "",
    "1. Initialize QMD (qmd init)",
    "2. Add the searchable collections (qmd collection add)",
    "   For a pure knowledge base, add the folder root; otherwise add the folder(s)",
    "   whose content should be searchable.",
    "3. Use a stable short collection name (qmd collection rename)",
    "   QMD names a collection from the indexed folder; rename it to a short",
    "   stable name so provider-native artifact URIs stay clean.",
    "4. Update the index (qmd update, qmd status)",
    "5. Verify the provider before returning to UKP (qmd search / qmd get)",
    "   If a search returns matches, the provider is ready; return to",
    "   'ukp guide service' step 4.",
    "   A read smoke ('qmd get <reference> --no-line-numbers') is required for",
    "   observe mode (external or nested collection root): it confirms the provider",
    "   can resolve the weak reference that ukp get will delegate to.",
    "",
    "Exact syntax for every command above comes from QMD's own help:",
    "  qmd --help lists the commands and their usage.",
    "",
    "Remember:",
    "- Provider config is not stored in the UKP Registry.",
    "- A registered Service is addressable; it is searchable only after provider setup.",
    "- Keep the local index out of version control: ignore .qmd/*.sqlite and .qmd/*.sqlite-*.",
  ].join("\n") + "\n";
}

export function renderClientGuide(): string {
  return [
    "UKP Client quickstart",
    "",
    "Goal: use registered Services from a workspace by default, without naming an endpoint on every call.",
    "",
    "Model:",
    "- Client path is separate from the provider path: it uses Services; it does not declare one.",
    "- A workspace .ukp/client.toml default_endpoints list selects which registered endpoints you mean when no selector is given.",
    "- UKP walks up from the current directory to find the nearest .ukp/client.toml.",
    "- Client Config stores endpoint names only; bindings live in the Host Registry.",
    "- Explicit --endpoint <name> or -g overrides the client defaults. With no Client Config, most commands fall back to every registered endpoint.",
    "- ukp refresh is stricter: it does not fall back to the Registry. It uses your Client Config defaults, or requires --endpoint <name> / -g.",
    "- ukp register does not edit .ukp/client.toml.",
    "",
    "1. Create a workspace Client Config",
    "   .ukp/client.toml at the workspace root:",
    "   default_endpoints = [\"endpoint-a\", \"endpoint-b\"]",
    "   Each name must match a registered endpoint; run 'ukp list' to see what is registered.",
    "",
    "2. Use Services without a selector",
    "   ukp search \"keyword\"",
    "   ukp inspect",
    "   ukp get --endpoint endpoint-a docs/example.md   (get still names a path, and --endpoint here wins)",
    "",
    "3. Check which scope is active",
    "   ukp inspect",
    "   It prints scope: explicit / global / client-config / registry-fallback and the source.",
    "",
    "4. Dangling defaults warn instead of failing silently",
    "   A default_endpoints entry not registered yet is reported as a warning by inspect, and commands still run on the resolvable ones.",
    "",
    "Remember:",
    "- Client path consumes Services; provider path (ukp guide service) creates them.",
    "- Client Config lists names, not paths or provider details.",
    "- Explicit selectors always beat Client Config defaults.",
    "- Register does not edit Client Config, and Client Config does not register endpoints.",
  ].join("\n") + "\n";
}

export function renderGuideUsageError(message: string): string {
  return [
    `ukp guide: ${message}`,
    "Usage: ukp guide <topic>",
    "Run 'ukp guide --help' for details.",
  ].join("\n");
}
