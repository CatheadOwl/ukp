import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  COMMANDS,
  COMMAND_GROUPS,
  renderDiagnoseHelp,
  renderReadHelp,
  renderGuideHelp,
  renderHelp,
  renderInitHelp,
  renderInitServiceHelp,
  renderInspectHelp,
  renderUpdateHelp,
  renderSearchHelp,
  renderVersion,
  renderVersionHelp,
  renderServiceGuide,
  renderServiceQmdGuide,
  renderClientGuide,
  renderProposeGuide,
  renderProposeHelp,
  renderNavHelp,
  renderRgHelp,
  runCli,
} from "../src/cli.ts";
import { UPDATE_SPEC } from "../src/commands/update.ts";
import { DIAGNOSE_SPEC } from "../src/commands/diagnose.ts";
import { INSPECT_SPEC } from "../src/commands/inspect.ts";
import { SEARCH_SPEC } from "../src/commands/search.ts";
import { NAV_SPEC } from "../src/commands/nav.ts";
import { PROPOSE_SPEC } from "../src/commands/propose.ts";
import { RG_SPEC } from "../src/commands/rg.ts";
import { READ_SPEC } from "../src/commands/read.ts";
import { INIT_SPEC } from "../src/commands/init.ts";
import { GUIDE_SPEC } from "../src/commands/guide.ts";
import { LIST_SPEC, REGISTER_SPEC, UNREGISTER_SPEC } from "../src/commands/inventory.ts";
import { INIT_SERVICE_SPEC } from "../src/commands/init.ts";
import { renderKitHelp, type UkpCommandSpec } from "../src/commands/kit.ts";

/** Every spec-based command in the CLI (version stays hand-written).
 * ROOT_MIGRATED_SPECS feeds the root help; the subcommand spec joins only
 * the structural guard. */
const ROOT_MIGRATED_SPECS: ReadonlyArray<UkpCommandSpec> = [
  DIAGNOSE_SPEC,
  INSPECT_SPEC,
  UPDATE_SPEC,
  SEARCH_SPEC,
  NAV_SPEC,
  PROPOSE_SPEC,
  RG_SPEC,
  READ_SPEC,
  INIT_SPEC,
  GUIDE_SPEC,
  REGISTER_SPEC,
  UNREGISTER_SPEC,
  LIST_SPEC,
];
const MIGRATED_SPECS: ReadonlyArray<UkpCommandSpec> = [...ROOT_MIGRATED_SPECS, INIT_SERVICE_SPEC];
import { loadManifest } from "../src/config/manifest.ts";
import { registerAt } from "../src/registry.ts";
import { createQmdFixtureCopy } from "./helpers/qmd-fixture.ts";

// Private per-file copy: the fixture's invocation state is written into the
// service folder, and bun runs test files in parallel (see helper doc).
const fixture = createQmdFixtureCopy("cli-fixture");
const fixtureExecutable = join(fixture, "qmd-fixture.mjs");
const nodeExecutable = Bun.which("node") ?? process.execPath;

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});
const packageJson = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
) as { version: string };
const expectedVersionOutput = `ukp ${packageJson.version}`;

describe("CLI bootstrap", () => {
  test("renders every P0 command in help", () => {
    const help = renderHelp();
    for (const [name] of COMMANDS) {
      expect(help).toContain(name);
    }
  });

  test("every command belongs to exactly one help group (ADR 0022)", () => {
    const grouped: string[] = COMMAND_GROUPS.flatMap((group) => group.commands);
    const names: string[] = COMMANDS.map(([name]) => name);
    expect(grouped.sort()).toEqual(names.sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  test("help renders group headings", () => {
    const help = renderHelp();
    for (const group of COMMAND_GROUPS) {
      expect(help).toContain(`${group.heading}:`);
    }
  });

  // Probe 20260911-root-help-onboarding (promoted): on-ramp line plus
  // search/rg/unregister summaries carry the choice criteria verbatim.
  // Sweep round 2 amended the on-ramp to state that guide service covers
  // init and register (confirmed on-ramp hole).
  test("root help states the on-ramp and the search/rg choice criteria", () => {
    const help = renderHelp();
    expect(help).toContain("Start here: 'ukp guide service' (first setup — covers init and register) or 'ukp list' (see registered endpoints).");
    expect(help).toContain("search a Service's indexed content (provider-backed; use 'ukp rg' to grep raw files)");
    expect(help).toContain("grep raw endpoint files with ripgrep (no index or declaration needed");
    expect(help).toContain("remove a registered endpoint binding (files on disk are untouched)");
  });

  // Probe 20260912-root-gloss-and-roles (promoted): the gloss line and the
  // diagnose/inspect/propose role summaries carry the wiring/scope/write-path
  // criteria verbatim.
  test("root help carries the provider gloss and command-role criteria", () => {
    const help = renderHelp();
    expect(help).toContain("A Service's declared capabilities are backed by a provider (QMD backs search and update today); rg and nav work on endpoint files directly, no provider needed.");
    expect(help).toContain("check a Service or endpoints for wiring problems (manifest, provider setup)");
    expect(help).toContain("show which endpoints the current scope selects and their capabilities");
    expect(help).toContain("submit an idempotent change proposal (the write path into a Service)");
  });

  // Probe 20260912-root-terminology-gloss (promoted): the second gloss line
  // defines Service / endpoint / scope. The "-g (every registered endpoint)"
  // parenthetical was added at ship time in response to the cross-arm finding
  // that -g was never defined in root help — implicitly verified by the
  // 2026-09-12 targeted follow-up batch (sweep doc third batch). The scope
  // gloss now also points at guide client for changing the default
  // (registered round-3 candidate: "scope how to set, not just what").
  test("root help defines Service, endpoint, and scope (with the change pointer)", () => {
    const help = renderHelp();
    expect(help).toContain("A Service is a folder with a manifest (a name plus optional declared capabilities); registering it binds that name as an endpoint you address with --endpoint.");
    expect(help).toContain("The scope is which endpoints commands use when no --endpoint or -g (every registered endpoint) is given; 'ukp guide client' shows how to set the workspace default.");
    expect(help).toContain("set your default scope here");
  });

  test("help exits successfully", () => {
    const output: string[] = [];
    expect(runCli(["--help"], (message) => output.push(message))).toBe(0);
    const help = output.join("\n");
    expect(help).toContain("Usage: ukp");
    expect(help).toContain("ukp guide service");
    expect(help).toContain("-V, --version");
  });

  test("version exits successfully through command and standard root aliases", () => {
    const commandOutput: string[] = [];
    const longOutput: string[] = [];
    const shortOutput: string[] = [];
    expect(renderVersion()).toBe(`${expectedVersionOutput}\n`);
    expect(runCli(["version"], (message) => commandOutput.push(message))).toBe(0);
    expect(runCli(["--version"], (message) => longOutput.push(message))).toBe(0);
    expect(runCli(["-V"], (message) => shortOutput.push(message))).toBe(0);
    expect(commandOutput.join("\n")).toBe(expectedVersionOutput);
    expect(longOutput.join("\n")).toBe(expectedVersionOutput);
    expect(shortOutput.join("\n")).toBe(expectedVersionOutput);
  });

  test("version help and verbose mode expose debug build identity", () => {
    const helpOutput: string[] = [];
    const verboseOutput: string[] = [];
    expect(renderVersionHelp()).toContain("Usage: ukp version [options]");
    expect(runCli(["version", "--help"], (message) => helpOutput.push(message))).toBe(0);
    expect(runCli(["version", "-v"], (message) => verboseOutput.push(message))).toBe(0);

    const help = helpOutput.join("\n");
    expect(help).toContain("-v, --verbose");

    const verbose = verboseOutput.join("\n");
    expect(verbose).toContain(expectedVersionOutput);
    expect(verbose).toContain("source_updated_local:");
    expect(verbose).toMatch(/source_updated_utc: \d{4}-\d{2}-\d{2}T/);
    expect(verbose).toContain("package_updated_local:");
    expect(verbose).toMatch(/package_updated_utc: \d{4}-\d{2}-\d{2}T/);
    expect(verbose).toContain(`runtime: bun ${Bun.version}`);
    expect(verbose).toContain("source:");
    expect(verbose).toContain("package:");
  });

  test("version rejects unexpected arguments with command help guidance", () => {
    const errors: string[] = [];
    expect(runCli(["version", "--bad"], undefined, (message) => errors.push(message))).toBe(2);
    expect(errors.join("\n")).toContain("ukp version: unexpected argument '--bad'");
    expect(errors.join("\n")).toContain("Run 'ukp version --help' for details.");
  });

  test("search help documents selectors and exits successfully", () => {
    const output: string[] = [];
    expect(renderSearchHelp()).toContain("Usage: ukp search <query>");
    expect(runCli(["search", "--help"], (message) => output.push(message))).toBe(0);
    const help = output.join("\n");
    expect(help).toContain("--endpoint <name>");
    expect(help).toContain("-c, --endpoint <name>");
    expect(help).toContain("-g");
    expect(help).toContain("--recursive");
    expect(help).toContain("authority/context dependencies at depth 1");
    expect(help.replace(/\s+/g, " ")).toContain("takes no value");
    expect(help).not.toContain("default: []");
  });

  test("diagnose help documents endpoint selectors and exits successfully", () => {
    const output: string[] = [];
    expect(renderDiagnoseHelp()).toContain("Usage: ukp diagnose");
    expect(runCli(["diagnose", "--help"], (message) => output.push(message))).toBe(0);
    const help = output.join("\n");
    expect(help).toContain("--endpoint <name>");
    expect(help).toContain("-c, --endpoint <name>");
    expect(help).toContain("-g");
    expect(help.replace(/\s+/g, " ")).toContain("takes no value");
  });

  test("read help documents endpoint selector and line ranges; the retired get spelling is rejected", () => {
    const output: string[] = [];
    expect(renderReadHelp()).toContain("Usage: ukp read --endpoint <name> <reference>");
    expect(runCli(["read", "--help"], (message) => output.push(message))).toBe(0);
    const help = output.join("\n");
    expect(help).toContain("--endpoint <name>");
    expect(help).toContain("-c, --endpoint <name>");
    expect(help).toContain("--lines <start[:count]>]");
    // `get` was renamed to `read` (D-062); the old spelling is not an alias.
    const mainHelp = renderHelp();
    expect(mainHelp).toContain("\n  read");
    expect(mainHelp).not.toContain("\n  get ");
    const errors: string[] = [];
    expect(runCli(["get", "-c", "notes", "docs/note.md"], undefined, (message) => errors.push(message))).toBe(2);
    expect(errors.join("\n")).toContain("unknown command 'get'");
  });

  test("ukp move does not exist (Q4 retirement): recovery adds no command surface", () => {
    const errors: string[] = [];
    expect(runCli(["move", "-c", "notes", "docs/a.md", "docs/b.md"], undefined, (message) => errors.push(message))).toBe(2);
    expect(errors.join("\n")).toContain("unknown command 'move'");
    // The help surface stays clean of a move entry.
    expect(renderHelp()).not.toContain("\n  move");
  });

  test("inspect help documents endpoint selectors and exits successfully", () => {
    const output: string[] = [];
    expect(renderInspectHelp()).toContain("Usage: ukp inspect");
    expect(runCli(["inspect", "--help"], (message) => output.push(message))).toBe(0);
    const help = output.join("\n");
    expect(help).toContain("--endpoint <name>");
    expect(help).toContain("-c, --endpoint <name>");
    expect(help).toContain("-g");
    expect(help.replace(/\s+/g, " ")).toContain("takes no value");
  });

  test("update help documents endpoint selectors and exits successfully", () => {
    const output: string[] = [];
    expect(renderUpdateHelp()).toContain("Usage: ukp update");
    expect(runCli(["update", "--help"], (message) => output.push(message))).toBe(0);
    const help = output.join("\n");
    expect(help).toContain("--endpoint <name>");
    expect(help).toContain("-c, --endpoint <name>");
    expect(help).toContain("-g");
    expect(help.replace(/\s+/g, " ")).toContain("takes no value");
    // ADR 0024 pilot: update's root-help summary is fed by its command spec.
    expect(renderHelp()).toContain(UPDATE_SPEC.summary);
    // Round-3 candidate (update semantic granularity): the help states what
    // maintenance actually runs.
    expect(help).toContain("qmd update");
  });

  // ADR 0024 migration guard: every migrated command's spec summary is the
  // single source of its root-help line (version stays hand-written).
  test("migrated command specs feed the root help summaries", () => {
    const help = renderHelp();
    for (const spec of ROOT_MIGRATED_SPECS) {
      expect(help).toContain(spec.summary);
    }
  });

  // ADR 0024 spec-driven structural guard: every declared option, argument,
  // and selector family must actually render into --help, and the usage
  // header must come from the spec's single usage string. Command-specific
  // copy stays pinned by the hand-written tests above; this test pins the
  // mechanical spec -> rendering contract for all commands at once.
  test("every spec renders its usage line and all declared option/argument help", () => {
    for (const spec of MIGRATED_SPECS) {
      const help = renderKitHelp(spec);
      const flat = help.replace(/\s+/g, " ");
      expect(flat).toContain(`Usage: ukp ${spec.name} ${spec.usage}`.replace(/\s+/g, " "));
      for (const argument of spec.arguments ?? []) {
        expect(flat).toContain(argument.help.replace(/\s+/g, " "));
      }
      for (const option of spec.options ?? []) {
        const primary = option.flags.split(",")[0]!.trim().split(/\s+/)[0];
        expect(help).toContain(primary);
        expect(flat).toContain(option.help.replace(/\s+/g, " "));
      }
      if (spec.scope) {
        expect(flat).toContain(spec.scope.endpointHelp.replace(/\s+/g, " "));
        expect(flat).toContain(spec.scope.globalHelp.replace(/\s+/g, " "));
      }
      if (spec.singleEndpoint) {
        expect(flat).toContain(spec.singleEndpoint.endpointHelp.replace(/\s+/g, " "));
        expect(flat).toContain(spec.singleEndpoint.unsupportedHelp.replace(/\s+/g, " "));
      }
    }
  });

  test("guide service is a short provider-agnostic CLI-accessible onboarding guide", () => {
    const output: string[] = [];
    expect(renderGuideHelp()).toContain("Usage: ukp guide <topic>");
    expect(renderServiceGuide()).toContain("UKP Service quickstart");
    expect(runCli(["guide", "service"], (message) => output.push(message))).toBe(0);
    const guide = output.join("\n");
    expect(guide).toContain(".ukp/service.toml");
    expect(guide).toContain("QMD is the current default search/update provider");
    expect(guide).toContain("ukp diagnose");
    expect(guide).toContain("ukp register");
    expect(guide).toContain("ukp inspect --endpoint your-endpoint-name");
    expect(guide).toContain("ukp read --endpoint your-endpoint-name docs/example.md");
    expect(guide).toContain("derived read/file baseline");
    // Round-3 candidate (docid/ukp:// jargon → guide face): step 7 defines
    // the two reference forms search results carry.
    expect(guide).toContain("durable, endpoint-scoped reference");
    expect(guide).toContain("provider's short-lived document id (QMD handoff key)");
    expect(guide).toContain("ukp update --endpoint your-endpoint-name");
    expect(guide).toContain("Future providers should add provider adapters");
    expect(guide).toContain("ukp unregister --endpoint <name>");
    expect(guide.indexOf("Fast path:")).toBeLessThan(guide.indexOf("Model:"));
    expect(guide.indexOf("Key boundary:")).toBeLessThan(guide.indexOf("Model:"));
    expect(guide.indexOf("ukp init service --name your-endpoint-name"))
      .toBeLessThan(guide.indexOf("ukp guide service qmd"));
    expect(guide.indexOf("ukp guide service qmd"))
      .toBeLessThan(guide.indexOf("ukp diagnose"));
    expect(guide.indexOf("ukp diagnose")).toBeLessThan(guide.indexOf("ukp register"));
    expect(guide.indexOf("ukp register")).toBeLessThan(guide.indexOf("ukp inspect --endpoint your-endpoint-name"));
    expect(guide.indexOf("ukp inspect --endpoint your-endpoint-name"))
      .toBeLessThan(guide.indexOf("ukp search \"keyword\" --endpoint your-endpoint-name --limit 3"));
    expect(guide.indexOf("ukp search \"keyword\" --endpoint your-endpoint-name --limit 3"))
      .toBeLessThan(guide.indexOf("ukp read --endpoint your-endpoint-name <reference>"));
    expect(guide).not.toContain("[capabilities.get]");
    expect(guide).not.toContain("qmd init");
    expect(guide).not.toContain("qmd collection");
  });

  test("guide service qmd is the provider-owned setup topic delegating syntax to QMD help", () => {
    const output: string[] = [];
    expect(renderServiceQmdGuide()).toContain("QMD provider setup");
    expect(renderHelp()).toContain("ukp guide service qmd");
    expect(runCli(["guide", "service", "qmd"], (message) => output.push(message))).toBe(0);
    const guide = output.join("\n");
    expect(guide).toContain("qmd init");
    expect(guide).toContain("qmd collection add");
    expect(guide).toContain("provider-owned");
    expect(guide).toContain("qmd collection add --help");
    expect(guide).toContain("relevant QMD subcommand help");
    expect(guide).not.toContain("ukp register");
    expect(guide).not.toContain("qmd --help lists the commands");
    expect(guide).not.toContain("-n 3 --format json");
    expect(guide).not.toContain("short-name");
    expect(guide).not.toContain("<searchable-folder>");
  });

  test("guide shows help when -h/--help follows a topic or subtopic", () => {
    const help: string[] = [];
    expect(runCli(["guide", "service", "qmd", "--help"], (message) => help.push(message))).toBe(0);
    expect(help.join("\n")).toContain("Usage: ukp guide <topic>");
  });

  // Help-flag order-independence guard (D-074 / ADR 0024 adjudicated fix):
  // `--help` must win wherever it appears. The pre-fix behavior leaked
  // commander's `(outputHelp)` sentinel as a usage error with exit 2 on
  // every commander-wrapped command.
  test("help flag after positional arguments renders help and exits 0 on every command", () => {
    const cases: Array<[command: string, preceding: string[]]> = [
      ["search", ["query"]],
      ["read", ["ref"]],
      ["nav", ["path"]],
      ["rg", ["pattern"]],
      ["inspect", ["stray"]],
      ["diagnose", ["stray"]],
      ["update", ["stray"]],
      ["propose", ["stray"]],
      ["list", ["stray"]],
      ["register", ["stray"]],
      ["unregister", ["name"]],
      ["init", ["stray"]],
      ["guide", ["stray"]],
    ];
    for (const [command, preceding] of cases) {
      for (const help of ["-h", "--help"] as const) {
        const output: string[] = [];
        const errors: string[] = [];
        const exitCode = runCli([command, ...preceding, help], (message) => output.push(message), (message) => errors.push(message));
        expect(exitCode).toBe(0);
        expect(output.join("\n")).toContain(`Usage: ukp ${command}`);
        const errorText = errors.join("\n");
        expect(errorText).toBe("");
        expect(errorText).not.toContain("(outputHelp)");
      }
    }
  });

  test("init service renders help when --help follows other arguments", () => {
    const output: string[] = [];
    expect(runCli(["init", "service", "stray", "--help"], (message) => output.push(message))).toBe(0);
    expect(output.join("\n")).toContain("Usage: ukp init service");
  });

  test("version help wins over other flags", () => {
    const output: string[] = [];
    expect(runCli(["version", "--verbose", "--help"], (message) => output.push(message))).toBe(0);
    expect(output.join("\n")).toContain("Usage: ukp version [options]");
  });

  test("guide usage error advertises the subtopic slot", () => {
    const errors: string[] = [];
    expect(runCli(["guide", "nope"], undefined, (message) => errors.push(message))).toBe(2);
    const errorText = errors.join("\n");
    expect(errorText).toContain("unknown guide topic 'nope'");
    expect(errorText).toContain("Usage: ukp guide <topic> [subtopic]");
  });

  // 2026-09-11 help-cognition sweep copy fixes (agent-eval/unit-docs/
  // help-cognition-sweep.md): default-scope semantics, name sources, guide
  // topic descriptions, and the unregister legacy alias all became
  // load-bearing help text — pin them.
  test("help documents default scope, name sources, and guide topics (sweep fixes)", () => {
    // search / rg / update share the workspace default scope semantics.
    for (const render of [renderSearchHelp, renderRgHelp, renderUpdateHelp]) {
      const help = render();
      expect(help).toContain("workspace default scope");
      expect(help).toContain("'ukp inspect' shows the resolved");
    }
    expect(renderSearchHelp()).toContain("'read:'/'uri:' handoff line");
    // Name sources for registry-side identities.
    expect(renderInitServiceHelp().replace(/\s+/g, " ")).toContain("defaults to the folder basename");
    const registerHelp: string[] = [];
    expect(runCli(["register", "--help"], (message) => registerHelp.push(message))).toBe(0);
    expect(registerHelp.join("\n")).toContain("effective name");
    // Guide topics are described in guide's own help (single-sourced with root).
    expect(renderGuideHelp()).toContain("first Service setup, inspect, search, read, and update path");
    expect(renderHelp()).toContain("first Service setup, inspect, search, read, and update path");
    // Version help carries a description line.
    expect(renderVersionHelp()).toContain("Show version information.");
    // Unregister legacy positional steers to the canonical flag form.
    const unregisterHelp: string[] = [];
    expect(runCli(["unregister", "--help"], (message) => unregisterHelp.push(message))).toBe(0);
    expect(unregisterHelp.join("\n").replace(/\s+/g, " ")).toContain("prefer the flag form");
  });

  // Sweep round 2 fixes (2026-09-11): the remaining doc-gaps surfaced by the
  // second blank-agent pass — see the round-2 record in
  // agent-eval/unit-docs/help-cognition-sweep.md.
  test("help documents round-2 fixes (diagnose scope, read forms, propose/init pointers)", () => {
    // diagnose gains the Scope section its siblings already had.
    expect(renderDiagnoseHelp().replace(/\s+/g, " ")).toContain("validates the current folder as a Service");
    // read: all four reference forms with their endpoint rules, plus the
    // --lines count and --format defaults.
    const readHelp = renderReadHelp().replace(/\s+/g, " ");
    expect(readHelp).toContain("Reference forms:");
    expect(readHelp).toContain("docid[:line] / qmd://<reference> — provider-owned references");
    expect(readHelp).toContain("count omitted: to end of file");
    expect(readHelp).toContain("default is human output");
    // propose: endpoint-name discovery pointer + slug constraint scoped to
    // explicit ids and the default alike; lifecycle visibility (owner
    // adjudication, no accept/reject command yet).
    const proposeHelp = renderProposeHelp().replace(/\s+/g, " ");
    expect(proposeHelp).toContain("endpoint names come from 'ukp list'");
    expect(proposeHelp).toContain("enforced for explicit ids and the default alike");
    expect(proposeHelp).toContain("for the Service owner to adjudicate");
    expect(proposeHelp).toContain("no accept/reject command yet");
    // init: says what it creates and that service is the only target.
    expect(renderInitHelp()).toContain(".ukp/service.toml");
    // guide: subtopic example no longer reads like a two-word topic value.
    expect(renderGuideHelp().replace(/\s+/g, " ")).toContain("'qmd' as in 'ukp guide service qmd'");
    // nav: the [path] argument carries a description.
    expect(renderNavHelp()).toContain("endpoint-relative route to expand");
    // search/rg/update/diagnose: -g/--endpoint mutual exclusion stated.
    for (const help of [renderSearchHelp(), renderRgHelp(), renderUpdateHelp(), renderDiagnoseHelp()]) {
      expect(help.replace(/\s+/g, " ")).toContain("cannot be combined with --endpoint");
    }
  });

  test("guide rejects an unknown provider subtopic with recovery guidance", () => {
    const errors: string[] = [];
    expect(runCli(["guide", "service", "badsub"], undefined, (message) => errors.push(message))).toBe(2);
    expect(errors.join("\n")).toContain("unknown provider subtopic 'badsub'");
    expect(errors.join("\n")).toContain("Available subtopic for service: qmd");
  });

  test("init help documents service target and exits successfully", () => {
    const initOutput: string[] = [];
    const serviceOutput: string[] = [];
    expect(renderInitHelp()).toContain("Usage: ukp init <target>");
    expect(renderInitServiceHelp()).toContain("Usage: ukp init service");
    expect(runCli(["init", "--help"], (message) => initOutput.push(message))).toBe(0);
    expect(runCli(["init", "service", "--help"], (message) => serviceOutput.push(message))).toBe(0);
    expect(initOutput.join("\n")).toContain("service");
    const serviceHelp = serviceOutput.join("\n");
    expect(serviceHelp).toContain("--name <name>");
    expect(serviceHelp).toContain("--description <text>");
    expect(serviceHelp).toContain("--dependency <name>");
    expect(serviceHelp).toContain("[capabilities.search]");
    expect(serviceHelp).toContain("provider = \"qmd\"");
    expect(serviceHelp).toContain("ukp guide service");
    expect(serviceHelp).toContain("ukp guide service qmd");
    expect(serviceHelp).not.toContain("qmd init");
  });

  test("init service creates the minimal Manifest without Registry, Client Config, or QMD side effects", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-init-service-"));
    const service = join(root, "valid-service");
    const registryPath = join(root, "registry.toml");
    const output: string[] = [];
    mkdirSync(service);
    try {
      expect(runCli(["init", "service"], (message) => output.push(message), undefined, {
        currentDirectory: service,
        registryPath,
      })).toBe(0);
      const manifestPath = join(service, ".ukp", "service.toml");
      const manifest = readFileSync(manifestPath, "utf8");
      expect(manifest).not.toContain("name =");
      expect(manifest).toContain("[capabilities.search]");
      expect(manifest).toContain("provider = \"qmd\"");
      expect(output.join("\n")).toContain("initialized Service: valid-service");
      expect(output.join("\n")).toContain("name_source: folder-name");
      expect(output.join("\n")).toContain("next: ukp guide service qmd");
      expect(output.join("\n")).toContain("next: ukp diagnose");
      expect(output.join("\n")).toContain("next: ukp register");
      expect(output.join("\n")).not.toContain("qmd init");
      expect(existsSync(registryPath)).toBe(false);
      expect(existsSync(join(service, ".ukp", "client.toml"))).toBe(false);
      expect(existsSync(join(service, ".qmd"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init service writes optional name and description", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-init-service-options-"));
    const output: string[] = [];
    try {
      expect(runCli([
        "init",
        "service",
        "--name",
        "named-service",
        "--description",
        "A test knowledge service.",
      ], (message) => output.push(message), undefined, {
        currentDirectory: root,
        registryPath: join(root, "registry.toml"),
      })).toBe(0);
      const manifest = readFileSync(join(root, ".ukp", "service.toml"), "utf8");
      expect(manifest).toContain("name = \"named-service\"");
      expect(manifest).toContain("description = \"A test knowledge service.\"");
      expect(output.join("\n")).toContain("name_source: option");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init service writes declared dependencies", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-init-service-deps-"));
    const output: string[] = [];
    try {
      expect(runCli([
        "init",
        "service",
        "--name",
        "agent-dev",
        "--dependency",
        "anthropic-agent-patterns",
        "--dependency",
        "ukp-product",
      ], (message) => output.push(message), undefined, {
        currentDirectory: root,
        registryPath: join(root, "registry.toml"),
      })).toBe(0);
      const loaded = loadManifest(root);
      expect(loaded.manifest.dependencies).toEqual([
        { endpoint: "anthropic-agent-patterns", kind: "context" },
        { endpoint: "ukp-product", kind: "context" },
      ]);
      expect(output.join("\n")).toContain("initialized Service: agent-dev");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init service rejects invalid or duplicate dependencies", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-init-service-invalid-deps-"));
    const invalidErrors: string[] = [];
    const duplicateErrors: string[] = [];
    try {
      expect(runCli([
        "init",
        "service",
        "--name",
        "agent-dev",
        "--dependency",
        "Bad Name",
      ], undefined, (message) => invalidErrors.push(message), {
        currentDirectory: root,
        registryPath: join(root, "registry.toml"),
      })).toBe(2);
      expect(invalidErrors.join("\n")).toContain("invalid dependency name");
      expect(existsSync(join(root, ".ukp", "service.toml"))).toBe(false);

      expect(runCli([
        "init",
        "service",
        "--name",
        "agent-dev",
        "--dependency",
        "anthropic-agent-patterns",
        "--dependency",
        "anthropic-agent-patterns",
      ], undefined, (message) => duplicateErrors.push(message), {
        currentDirectory: root,
        registryPath: join(root, "registry.toml"),
      })).toBe(2);
      expect(duplicateErrors.join("\n")).toContain("duplicate dependency");
      expect(existsSync(join(root, ".ukp", "service.toml"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init service refuses invalid derived names unless --name is provided", () => {
    const root = mkdtempSync(join(tmpdir(), "UKP Bad Name "));
    const errors: string[] = [];
    try {
      expect(runCli(["init", "service"], undefined, (message) => errors.push(message), {
        currentDirectory: root,
        registryPath: join(root, "registry.toml"),
      })).toBe(2);
      const error = errors.join("\n");
      expect(error).toContain("invalid Service name");
      expect(error).toContain("Pass '--name <name>'");
      expect(existsSync(join(root, ".ukp", "service.toml"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init service refuses to overwrite an existing Manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-init-existing-"));
    const errors: string[] = [];
    mkdirSync(join(root, ".ukp"));
    writeFileSync(join(root, ".ukp", "service.toml"), "[capabilities.search]\nprovider = \"qmd\"\n");
    try {
      expect(runCli(["init", "service", "--name", "again"], undefined, (message) => errors.push(message), {
        currentDirectory: root,
        registryPath: join(root, "registry.toml"),
      })).toBe(1);
      expect(errors.join("\n")).toContain("Service Manifest already exists");
      expect(readFileSync(join(root, ".ukp", "service.toml"), "utf8")).not.toContain("again");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init service coexists with an existing Client Config in the same folder", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-init-dual-role-"));
    const output: string[] = [];
    mkdirSync(join(root, ".ukp"));
    writeFileSync(join(root, ".ukp", "client.toml"), 'default_endpoints = ["docs"]\n');
    try {
      expect(runCli(["init", "service", "--name", "dual-role"], (message) => output.push(message), undefined, {
        currentDirectory: root,
        registryPath: join(root, "registry.toml"),
      })).toBe(0);
      expect(existsSync(join(root, ".ukp", "service.toml"))).toBe(true);
      expect(readFileSync(join(root, ".ukp", "client.toml"), "utf8"))
        .toBe('default_endpoints = ["docs"]\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("guide client is a short CLI-accessible client-path guide", () => {
    const output: string[] = [];
    expect(renderClientGuide()).toContain("UKP Client quickstart");
    expect(runCli(["guide", "client"], (message) => output.push(message))).toBe(0);
    const guide = output.join("\n");
    expect(guide).toContain(".ukp/client.toml");
    expect(guide).toContain("default_endpoints");
    expect(guide).toContain("scope: explicit / global / client-config / registry-fallback");
    expect(guide).toContain("provider path (ukp guide service)");
    expect(guide).toContain("may hold both roles at once (dual-role)");
    expect(guide).toContain("does not fall back to the Registry");
    expect(guide).toContain("ukp register does not edit .ukp/client.toml");
  });

  test("guide propose is a short CLI-accessible propose-path guide", () => {
    const output: string[] = [];
    expect(renderProposeGuide()).toContain("UKP propose quickstart");
    expect(runCli(["guide", "propose"], (message) => output.push(message))).toBe(0);
    const guide = output.join("\n");
    expect(guide).toContain("three outcomes: created (new, revision 1), unchanged (identical content, no write), updated (replaced, revision +1)");
    expect(guide).toContain("ukp propose --endpoint <name> --file draft.md");
    expect(guide).toContain("--id defaults to the draft basename");
    expect(guide).toContain("becomes the proposal's persistent identity");
    expect(guide).toContain("Renaming the file and resubmitting creates a new proposal");
    expect(guide).toContain("resubmitting the same id updates the same proposal");
    expect(guide).toContain("Never edit Service-side proposal files directly");
    expect(guide).toContain("Service-maintained and stripped from submissions");
    expect(guide).not.toContain("stdin");
  });

  test("guide help lists the topics and subtopics", () => {
    expect(renderGuideHelp()).toContain("guide topic: service | service qmd | client | propose");
  });

  test("guide rejects unknown topics with recovery guidance", () => {
    const errors: string[] = [];
    expect(runCli(["guide", "remote"], undefined, (message) => errors.push(message))).toBe(2);
    expect(errors.join("\n")).toContain("unknown guide topic 'remote'");
    expect(errors.join("\n")).toContain("Run 'ukp guide --help' for details.");
  });

  test("inventory command help is owned by command handlers", () => {
    const listOutput: string[] = [];
    const registerOutput: string[] = [];
    const unregisterOutput: string[] = [];
    expect(runCli(["list", "--help"], (message) => listOutput.push(message))).toBe(0);
    expect(runCli(["register", "--help"], (message) => registerOutput.push(message))).toBe(0);
    expect(runCli(["unregister", "--help"], (message) => unregisterOutput.push(message))).toBe(0);
    expect(listOutput.join("\n")).toContain("Usage: ukp list");
    expect(registerOutput.join("\n")).toContain("Usage: ukp register");
    expect(registerOutput.join("\n")).toContain("ukp unregister --endpoint <name>");
    expect(unregisterOutput.join("\n")).toContain("Usage: ukp unregister");
    expect(unregisterOutput.join("\n")).toContain("--endpoint <name>");
    expect(unregisterOutput.join("\n")).toContain("-c, --endpoint <name>");
    // Legacy positional is named as an alias and steers to the flag form
    // (2026-09-11 sweep wording fix).
    expect(unregisterOutput.join("\n").replace(/\s+/g, " ")).toContain("legacy alias for --endpoint <name>; prefer the flag form");
  });

  test("search usage errors include recovery guidance", () => {
    const errors: string[] = [];
    expect(runCli(["search", "query", "-g", "product"], undefined, (message) => errors.push(message))).toBe(2);
    const error = errors.join("\n");
    expect(error).toContain("unexpected argument 'product'");
    expect(error).toContain("'-g' takes no value");
    expect(error).toContain("--endpoint <name>");
    expect(error).toContain("Run 'ukp search --help' for details.");
  });

  test("diagnose usage errors include recovery guidance", () => {
    const errors: string[] = [];
    expect(runCli(["diagnose", "-g", "product"], undefined, (message) => errors.push(message))).toBe(2);
    const error = errors.join("\n");
    expect(error).toContain("unexpected argument 'product'");
    expect(error).toContain("'-g' takes no value");
    expect(error).toContain("--endpoint <name>");
    expect(error).toContain("Run 'ukp diagnose --help' for details.");
  });

  test("inspect usage errors include recovery guidance", () => {
    const errors: string[] = [];
    expect(runCli(["inspect", "-g", "product"], undefined, (message) => errors.push(message))).toBe(2);
    const error = errors.join("\n");
    expect(error).toContain("unexpected argument 'product'");
    expect(error).toContain("'-g' takes no value");
    expect(error).toContain("--endpoint <name>");
    expect(error).toContain("Run 'ukp inspect --help' for details.");
  });

  test("diagnose local Service errors are rendered without a stack trace", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-diagnose-missing-manifest-"));
    const errors: string[] = [];
    try {
      expect(runCli(["diagnose"], undefined, (message) => errors.push(message), {
        currentDirectory: root,
        registryPath: join(root, "registry.toml"),
      })).toBe(1);
      const error = errors.join("\n");
      expect(error).toContain("ukp diagnose: Service Manifest is not readable:");
      expect(error).toContain(join(root, ".ukp", "service.toml"));
      expect(error).toContain("Hint: 'ukp diagnose' checks the current folder as a Service.");
      expect(error).toContain("ukp guide service");
      expect(error).toContain("Use 'ukp diagnose -g' to validate every registered endpoint");
      expect(error).toContain("ukp diagnose --endpoint <name>");
      expect(error).not.toContain("ManifestError:");
      expect(error).not.toContain("at loadManifest");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("diagnose registered endpoint errors when the Service folder has no manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-diagnose-stale-endpoint-"));
    const registryPath = join(root, "registry.toml");
    const endpointRoot = join(root, "meeting-room");
    const output: string[] = [];
    const errors: string[] = [];
    mkdirSync(endpointRoot, { recursive: true });
    registerAt(registryPath, "stale-meeting-room", endpointRoot);
    try {
      expect(runCli(["diagnose", "--endpoint", "stale-meeting-room"], (message) => output.push(message), (message) => errors.push(message), {
        currentDirectory: root,
        registryPath,
      })).toBe(1);
      const error = [...output, ...errors].join("\n");
      // The scoped per-endpoint failure renders as a structured report field
      // (`== name ==` block: status:/error: lines on stdout), not the
      // stderr channel prefix — field vocabulary stays as adjudicated (D-076
      // covers channel prefixes only).
      expect(error).toContain("error: Service Manifest is not readable:");
      expect(error).toContain(join(endpointRoot, ".ukp", "service.toml"));
      expect(error).not.toContain("ManifestError:");
      expect(error).not.toContain("at loadManifest");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty Registry inspect explains how to recover", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-inspect-empty-"));
    const output: string[] = [];
    const errors: string[] = [];
    try {
      expect(runCli(["inspect"], (message) => output.push(message), (message) => errors.push(message), {
        currentDirectory: root,
        registryPath: join(root, "registry.toml"),
      })).toBe(1);
      expect(output.join("\n")).toContain("scope: registry-fallback");
      expect(errors.join("\n")).toContain("the Host Registry is empty");
      expect(errors.join("\n")).toContain("ukp register");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty Registry search explains how to recover", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-empty-"));
    const output: string[] = [];
    expect(runCli(["search", "query", "--json"], (message) => output.push(message), undefined, {
      currentDirectory: root,
      registryPath: join(root, "registry.toml"),
      artifactRoot: join(root, "artifacts"),
    })).toBe(1);
    expect(output.join("\n")).toContain("the Host Registry is empty");
    expect(output.join("\n")).toContain("ukp register");
  });

  test("search -c compatibility alias executes end-to-end", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-search-alias-"));
    const registryPath = join(root, "registry.toml");
    const invocationPath = join(fixture, "qmd-fixture-invocation.json");
    const invocationLogPath = join(fixture, "qmd-fixture-invocations.jsonl");
    const output: string[] = [];
    registerAt(registryPath, "fixture-qmd", fixture);
    try {
      expect(runCli([
        "search",
        "fixture-cad-search-token",
        "-c",
        "fixture-qmd",
        "--limit=2",
      ], (message) => output.push(message), undefined, {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      })).toBe(0);
      expect(output.join("\n")).toContain("CAD fixture note");
      const invocation = JSON.parse(readFileSync(invocationPath, "utf8"));
      expect(invocation.cwd).toBe(fixture);
      expect(invocation.query).toBe("fixture-cad-search-token");
      expect(invocation.nativeLimit).toBe(2);
    } finally {
      if (existsSync(invocationPath)) rmSync(invocationPath);
      if (existsSync(invocationLogPath)) rmSync(invocationLogPath);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("read -c compatibility alias reads an endpoint-relative file", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-read-alias-"));
    const registryPath = join(root, "registry.toml");
    const service = join(root, "notes");
    const output: string[] = [];
    mkdirSync(join(service, ".ukp"), { recursive: true });
    mkdirSync(join(service, "docs"), { recursive: true });
    writeFileSync(
      join(service, ".ukp", "service.toml"),
      'name = "notes"\n\n[capabilities.get]\nprovider = "file"\n',
      "utf8",
    );
    writeFileSync(join(service, "docs", "note.md"), "alpha\nbeta\ngamma\n", "utf8");
    registerAt(registryPath, "notes", service);
    try {
      expect(runCli(["read", "-c", "notes", "docs/note.md", "--lines=2:1"], (message) => output.push(message), undefined, {
        currentDirectory: root,
        registryPath,
      })).toBe(0);
      expect(output.join("\n")).toBe("beta");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("search unknown endpoint errors without a stack trace", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-search-unknown-endpoint-"));
    const registryPath = join(root, "registry.toml");
    const errors: string[] = [];
    registerAt(registryPath, "fixture-qmd", fixture);
    try {
      expect(runCli([
        "search",
        "operation surface",
        "--endpoint",
        "does-not-exist",
      ], undefined, (message) => errors.push(message), {
        currentDirectory: root,
        registryPath,
      })).toBe(1);
      const error = errors.join("\n");
      expect(error).toContain("ukp search: unknown endpoint 'does-not-exist'");
      expect(error).not.toContain("ScopeError:");
      expect(error).not.toContain("at resolveScope");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("search stale default endpoint bindings warn without a stack trace", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-search-stale-default-"));
    const registryPath = join(root, "registry.toml");
    const workspace = join(root, "workspace");
    const stale = join(root, "meeting-room");
    const output: string[] = [];
    const errors: string[] = [];
    mkdirSync(join(workspace, ".ukp"), { recursive: true });
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(workspace, ".ukp", "client.toml"), 'default_endpoints = ["stale-meeting-room", "fixture-qmd"]\n');
    registerAt(registryPath, "stale-meeting-room", stale);
    registerAt(registryPath, "fixture-qmd", fixture);
    rmSync(stale, { recursive: true, force: true });
    try {
      expect(runCli([
        "search",
        "fixture-cad-search-token",
      ], (message) => output.push(message), (message) => errors.push(message), {
        currentDirectory: workspace,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      })).toBe(0);
      const rendered = [...output, ...errors].join("\n");
      expect(rendered).toContain("endpoint 'stale-meeting-room' is not accessible");
      expect(rendered).toContain("Service folder is not accessible");
      expect(rendered).toContain("ukp inspect --endpoint stale-meeting-room");
      expect(rendered).toContain("CAD fixture note");
      expect(rendered).not.toContain("ManifestError:");
      expect(rendered).not.toContain("at loadManifest");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("search endpoint name mismatch fails without a stack trace", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-search-name-mismatch-"));
    const registryPath = join(root, "registry.toml");
    const service = join(root, "renamed-service");
    const errors: string[] = [];
    mkdirSync(join(service, ".ukp"), { recursive: true });
    writeFileSync(
      join(service, ".ukp", "service.toml"),
      'name = "actual-name"\n\n[capabilities.search]\nprovider = "qmd"\n',
      "utf8",
    );
    registerAt(registryPath, "expected-name", service);
    try {
      expect(runCli([
        "search",
        "fixture-cad-search-token",
        "--endpoint",
        "expected-name",
      ], undefined, (message) => errors.push(message), {
        currentDirectory: root,
        registryPath,
        qmdCommand: [nodeExecutable, fixtureExecutable],
      })).toBe(1);
      const rendered = errors.join("\n");
      expect(rendered).toContain("ukp search: endpoint 'expected-name' no longer matches Service effective name 'actual-name'");
      expect(rendered).not.toContain("SearchPlanningError:");
      expect(rendered).not.toContain("at planSearch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("diagnose endpoint selectors execute against registered Service folders", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-diagnose-scope-"));
    const registryPath = join(root, "registry.toml");
    const output: string[] = [];
    const aliasOutput: string[] = [];
    registerAt(registryPath, "fixture-qmd", fixture);
    try {
      const context = {
        currentDirectory: root,
        registryPath,
        resolveProvider: () => ({ supported: true }),
      };
      expect(runCli(["diagnose", "--endpoint", "fixture-qmd"], (message) => output.push(message), undefined, context))
        .toBe(0);
      expect(output.join("\n")).toContain("== fixture-qmd ==");
      expect(output.join("\n")).toContain("endpoint: fixture-qmd");
      expect(output.join("\n")).toContain("description: Deterministic QMD-compatible search fixture");
      expect(output.join("\n")).not.toContain("dependency:");
      expect(output.join("\n")).toContain(`location: ${fixture}`);
      expect(output.join("\n")).toContain("hint: diagnose checks wiring, not indexed content");

      expect(runCli(["diagnose", "-c", "fixture-qmd"], (message) => aliasOutput.push(message), undefined, context))
        .toBe(0);
      expect(aliasOutput.join("\n")).toContain("endpoint: fixture-qmd");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("diagnose warns about unregistered dependency targets without failing capability checks", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-diagnose-dependency-warning-"));
    const registryPath = join(root, "registry.toml");
    const service = join(root, "agent-dev");
    const output: string[] = [];
    const errors: string[] = [];
    mkdirSync(join(service, ".ukp"), { recursive: true });
    writeFileSync(join(service, ".ukp", "service.toml"), [
      'name = "agent-dev"',
      "",
      "[[dependencies]]",
      'endpoint = "ukp-product"',
      'kind = "authority"',
      "",
      "[capabilities.search]",
      'provider = "qmd"',
      "",
    ].join("\n"));
    registerAt(registryPath, "agent-dev", service);
    try {
      expect(runCli(["diagnose", "--endpoint", "agent-dev"], (message) => output.push(message), (message) => errors.push(message), {
        currentDirectory: root,
        registryPath,
        resolveProvider: () => ({ supported: true }),
      })).toBe(0);
      expect(output.join("\n")).toContain("dependency: depends_on -> ukp-product (kind: authority)");
      expect(errors.join("\n")).toContain("dependency target 'ukp-product' is not registered (declared by agent-dev)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("inspect explains explicit endpoint routing without starting search", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-inspect-explicit-"));
    const registryPath = join(root, "registry.toml");
    const output: string[] = [];
    registerAt(registryPath, "fixture-qmd", fixture);
    try {
      expect(runCli(["inspect", "--endpoint", "fixture-qmd"], (message) => output.push(message), undefined, {
        currentDirectory: root,
        registryPath,
        resolveProvider: () => ({ supported: true }),
      })).toBe(0);
      const rendered = output.join("\n");
      expect(rendered).toContain("scope: explicit");
      expect(rendered).toContain("source: explicit endpoint selector");
      expect(rendered).toContain("selected_endpoints: 1");
      expect(rendered).toContain(`binding: fixture-qmd -> ${fixture}`);
      expect(rendered).toContain(`manifest: ${join(fixture, ".ukp", "service.toml")}`);
      expect(rendered).toContain("description: Deterministic QMD-compatible search fixture");
      expect(rendered).toContain("capability: search");
      expect(rendered).toContain("provider: qmd");
      expect(rendered).toContain("status: ok");
      expect(rendered).not.toContain("indexed content");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("inspect renders declared dependencies from the Service Manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-inspect-deps-"));
    const registryPath = join(root, "registry.toml");
    const service = join(root, "agent-dev");
    const output: string[] = [];
    const errors: string[] = [];
    mkdirSync(join(service, ".ukp"), { recursive: true });
    writeFileSync(join(service, ".ukp", "service.toml"), [
      'name = "agent-dev"',
      "",
      "[[dependencies]]",
      'endpoint = "anthropic-agent-patterns"',
      'kind = "context"',
      'reason = "Agent development uses these patterns as context."',
      "",
      "[capabilities.search]",
      'provider = "qmd"',
      "",
    ].join("\n"));
    registerAt(registryPath, "agent-dev", service);
    try {
      expect(runCli(["inspect", "--endpoint", "agent-dev"], (message) => output.push(message), (message) => errors.push(message), {
        currentDirectory: root,
        registryPath,
        resolveProvider: () => ({ supported: true }),
      })).toBe(0);
      const rendered = output.join("\n");
      expect(rendered).toContain("dependency: depends_on -> anthropic-agent-patterns (kind: context)");
      expect(rendered).toContain("dependency_reason: Agent development uses these patterns as context.");
      expect(errors.join("\n")).toContain(
        "dependency target 'anthropic-agent-patterns' is not registered (declared by agent-dev)",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("inspect explains workspace Client Config scope and dangling defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-inspect-client-config-"));
    const registryPath = join(root, "registry.toml");
    const workspace = join(root, "workspace");
    const child = join(workspace, "child");
    const output: string[] = [];
    const errors: string[] = [];
    mkdirSync(join(workspace, ".ukp"), { recursive: true });
    mkdirSync(child, { recursive: true });
    writeFileSync(join(workspace, ".ukp", "client.toml"), "default_endpoints = [\"fixture-qmd\", \"gone\"]\n");
    registerAt(registryPath, "fixture-qmd", fixture);
    try {
      expect(runCli(["inspect"], (message) => output.push(message), (message) => errors.push(message), {
        currentDirectory: child,
        registryPath,
        resolveProvider: () => ({ supported: true }),
      })).toBe(0);
      const rendered = output.join("\n");
      expect(rendered).toContain("scope: client-config");
      expect(rendered).toContain(`source: Client Config (${join(workspace, ".ukp", "client.toml")})`);
      expect(rendered).toContain("selected_endpoints: 1");
      expect(errors.join("\n")).toContain("'gone' is not registered");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("inspect reports deferred qmd capabilities as warnings while local get remains derived", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-inspect-deferred-"));
    const registryPath = join(root, "registry.toml");
    const service = join(root, "service");
    const output: string[] = [];
    mkdirSync(join(service, ".ukp"), { recursive: true });
    writeFileSync(join(service, ".ukp", "service.toml"), [
      'name = "deferred-qmd"',
      "",
      "[capabilities.vsearch]",
      'provider = "qmd"',
      "",
    ].join("\n"));
    registerAt(registryPath, "deferred-qmd", service);
    try {
      expect(runCli(["inspect", "--endpoint", "deferred-qmd"], (message) => output.push(message), undefined, {
        currentDirectory: root,
        registryPath,
      })).toBe(0);
      const rendered = output.join("\n");
      expect(rendered).toContain("capability: vsearch");
      expect(rendered).toContain("provider: qmd");
      expect(rendered).toContain("status: warning");
      expect(rendered).toContain("capability 'vsearch' is not implemented by this UKP build");
      expect(rendered).toContain("capability: read (derived local baseline)");
      expect(rendered).toContain("provider: file");
      expect(rendered).toContain("status: ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("inspect still shows manifest details when every provider is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-inspect-unavailable-"));
    const registryPath = join(root, "registry.toml");
    const output: string[] = [];
    registerAt(registryPath, "fixture-qmd", fixture);
    try {
      expect(runCli(["inspect", "--endpoint", "fixture-qmd"], (message) => output.push(message), undefined, {
        currentDirectory: root,
        registryPath,
        resolveProvider: () => ({ supported: false, reason: "provider disabled for test" }),
      })).toBe(1);
      const rendered = output.join("\n");
      expect(rendered).toContain(`manifest: ${join(fixture, ".ukp", "service.toml")}`);
      expect(rendered).toContain("service_status: unavailable");
      expect(rendered).toContain("capability: search");
      expect(rendered).toContain("provider: qmd");
      expect(rendered).toContain("status: warning");
      expect(rendered).toContain("warning: provider disabled for test");
      expect(rendered).not.toContain("NO_SUPPORTED_CAPABILITY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("diagnose global scope validates every registered endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-cli-diagnose-global-"));
    const registryPath = join(root, "registry.toml");
    const output: string[] = [];
    registerAt(registryPath, "fixture-qmd", fixture);
    try {
      expect(runCli(["diagnose", "-g"], (message) => output.push(message), undefined, {
        currentDirectory: root,
        registryPath,
        resolveProvider: () => ({ supported: true }),
      })).toBe(0);
      expect(output.join("\n")).toContain("== fixture-qmd ==");
      expect(output.join("\n")).toContain("status: ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("diagnose rejects bundled repeated global flags like -gg", () => {
    const errors: string[] = [];
    expect(runCli(["diagnose", "-gg"], undefined, (message) => errors.push(message))).toBe(2);
    expect(errors.join("\n")).toContain("-g may only be specified once");
  });

  test("diagnose rejects endpoint scope combined with global scope", () => {
    const errors: string[] = [];
    expect(runCli(["diagnose", "--endpoint", "fixture-qmd", "-g"], undefined, (message) => errors.push(message)))
      .toBe(2);
    expect(errors.join("\n")).toContain("--endpoint and -g cannot be used together");
  });

  test("inventory misuse includes command recovery guidance", () => {
    const listErrors: string[] = [];
    const unregisterErrors: string[] = [];
    expect(runCli(["list", "extra"], undefined, (message) => listErrors.push(message))).toBe(2);
    expect(listErrors.join("\n")).toContain("ukp list:");
    expect(listErrors.join("\n")).toContain("Run 'ukp list --help' for details.");

    expect(runCli(["unregister", "BadName"], undefined, (message) => unregisterErrors.push(message))).toBe(2);
    expect(unregisterErrors.join("\n")).toContain("valid endpoint name");
    expect(unregisterErrors.join("\n")).toContain("--endpoint <name>");
    expect(unregisterErrors.join("\n")).toContain("Run 'ukp unregister --help' for details.");
  });

  test("unregister accepts canonical endpoint selector and rejects ambiguous names", () => {
    const registryPath = join(mkdtempSync(join(tmpdir(), "ukp-cli-unregister-endpoint-")), "registry.toml");
    const context = {
      currentDirectory: fixture,
      registryPath,
      resolveProvider: () => ({ supported: true }),
    };
    const output: string[] = [];
    const errors: string[] = [];
    registerAt(registryPath, "fixture-qmd", fixture);
    expect(runCli(["unregister", "--endpoint", "fixture-qmd"], (message) => output.push(message), undefined, context))
      .toBe(0);
    expect(output.join("\n")).toContain("unregistered: fixture-qmd");

    registerAt(registryPath, "fixture-qmd", fixture);
    expect(runCli(["unregister", "-c", "fixture-qmd"], (message) => output.push(message), undefined, context)).toBe(0);

    registerAt(registryPath, "fixture-qmd", fixture);
    expect(runCli(
      ["unregister", "--endpoint", "fixture-qmd", "other"],
      undefined,
      (message) => errors.push(message),
      context,
    )).toBe(2);
    expect(errors.join("\n")).toContain("either --endpoint <name> or legacy positional <name>, not both");
  });

  test("unknown command is a usage error", () => {
    const errors: string[] = [];
    expect(runCli(["wat"], undefined, (message) => errors.push(message))).toBe(2);
    expect(errors.join("\n")).toContain("unknown command");
  });

  test("register, list, and unregister form an inventory lifecycle", () => {
    const registryPath = join(mkdtempSync(join(tmpdir(), "ukp-cli-")), "registry.toml");
    const context = {
      currentDirectory: fixture,
      registryPath,
      resolveProvider: () => ({ supported: true }),
    };
    const output: string[] = [];
    expect(runCli(["register"], (message) => output.push(message), undefined, context)).toBe(0);
    expect(runCli(["list"], (message) => output.push(message), undefined, context)).toBe(0);
    expect(output.join("\n")).toContain("fixture-qmd");
    expect(output.join("\n")).toContain("description: Deterministic QMD-compatible search fixture");
    expect(output.join("\n")).toContain("capabilities on every endpoint: nav, read");
    expect(output.join("\n")).toMatch(/fixture-qmd\t.*\tsearch,update/);
    expect(readFileSync(registryPath, "utf8")).not.toContain("description");
    expect(runCli(["unregister", "fixture-qmd"], (message) => output.push(message), undefined, context)).toBe(0);
    expect(runCli(["list"], (message) => output.push(message), undefined, context)).toBe(0);
    expect(output.at(-1)).toBe("No endpoints registered.");
  });
});
