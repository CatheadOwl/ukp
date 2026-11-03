import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, unlinkSync, readFileSync, readdirSync, renameSync, realpathSync, statSync } from "node:fs";
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
    "Creates .ukp/service.toml with the provider-free Service baseline:",
    "  [capabilities]",
    "Optional:",
    "  ukp guide service qmd   add QMD-backed indexed search/update setup",
    "  --dependency <name>   declare another endpoint as a contextual dependency entry",
    "  each --dependency emits [[dependencies]] with endpoint + kind = \"context\"",
    "",
    "Next:",
    "  ukp diagnose",
    "  ukp register",
    "  ukp nav / ukp read / ukp rg",
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
    capabilities: {},
  });
  return encoded.endsWith("\n") ? encoded : `${encoded}\n`;
}

/** Precise self-ignore template for `.ukp/` (2026-10-28, inbox
 * client-portability-and-skill-coverage adoption; `/tls/` line retired
 * 2026-11-01 by the inbox service-dir-layering adjudication item 2): the
 * tool-owned directory holds exactly two declaration files
 * (`service.toml`, `client.toml` — pure declarations with zero machine
 * paths, versionable by design: a fresh clone re-registers the Service
 * with one `ukp register`) plus the machine-local state named below.
 * Ignoring by name keeps identity out of version control and folder sync
 * (the O-020 B-b goal) while declarations ride with the repo — the `*`
 * blanket it replaces swallowed them (workflow-lab migration evidence:
 * the endpoint declaration did not travel with the clone, and carving
 * client.toml back into tracking cost three fiddly steps). The serve TLS
 * identity no longer lives here (see UKP_SELF_IGNORE_WITH_TLS). */
export const UKP_SELF_IGNORE = [
  "# UKP machine-local state (instance identity) only;",
  "# declarations (service.toml, client.toml) are versionable by design.",
  "/instance-uid",
  "",
].join("\n");

/** The 2026-10-28 template's first form, retired 2026-11-01 when the
 * serve TLS identity moved to the machine home (`~/.ukp/tls/<name>/`,
 * inbox service-dir-layering item 2): its `/tls/` rule named a resident
 * that no longer exists. Kept verbatim for two recognitions — the posture
 * ladder classifies it "current" (it IS precise, and a folder that still
 * carries its legacy `tls/` dir stays correctly ignored until the
 * serve-side migration moves the material out), and the serve migration
 * (`retireTlsIgnoreLine`) swaps it onto the current template in the same
 * gesture that removes the directory. */
export const UKP_SELF_IGNORE_WITH_TLS = [
  "# UKP machine-local state (instance identity, TLS key material) only;",
  "# declarations (service.toml, client.toml) are versionable by design.",
  "/instance-uid",
  "/tls/",
  "",
].join("\n");

/** The superseded 2026-09-23 `*` template (the original O-020 B-b
 * landing), kept verbatim for recognition: the posture step below migrates
 * a `.ukp/.gitignore` that still carries it onto the precise template;
 * anything else is operator-owned and stays untouched (the B-b
 * operator-policy-wins posture). */
export const LEGACY_UKP_SELF_IGNORE = [
  "# UKP local Service state (manifest, identity, TLS keys) is machine-local:",
  "# self-ignored to keep it out of version control and folder sync.",
  "*",
  "",
].join("\n");

/** Closed resident set of `.ukp/` (INV-21, owner ruling 2026-11-02): the
 * declarations, the instance identity, the ignore guard — plus the two
 * atomic-write transients a crash can leave behind (documented as
 * "overwritten by the next write"; tolerating them is not an ignore rule,
 * it is the tool owning its own residue). Anything else is a violation
 * the posture step refuses on. The serve TLS identity left this directory
 * on 2026-11-01 (ADR-REM-012), which is exactly why the set is closed:
 * the template no longer carries defensive rules for residents that
 * must not exist. */
const UKP_RESIDENTS: ReadonlySet<string> = new Set([
  "service.toml",
  "client.toml",
  "instance-uid",
  ".gitignore",
  ".gitignore.ukp-tmp",
  "client.toml.ukp-tmp",
]);

/** Refusal of a posture step over a `.ukp/` holding entries outside the
 * closed set. Carries the offending paths so every carrier gesture can
 * print the same operator-facing body. */
export class UkpResidentError extends Error {
  constructor(
    readonly ukpDirectory: string,
    readonly residents: readonly string[],
    endpointName?: string,
  ) {
    const home = `~/.ukp/tls/${endpointName ?? "<endpoint-name>"}/`;
    const hasTls = residents.includes("tls");
    const others = residents.filter((name) => name !== "tls");
    const lines = [
      ".ukp/ holds entries UKP does not own (INV-21: service.toml, client.toml, instance-uid and .gitignore only):",
      ...residents.map((name) => `  ${join(ukpDirectory, name)}`),
      ...(hasTls
        ? [`tls/ is a pre-2026-11-01 serve TLS identity: move its cert.pem and key.pem to ${home} to keep the pin clients hold, or delete it.`]
        : []),
      ...(others.length > 0 ? [`Delete ${hasTls ? "the rest" : "them"}.`] : []),
      "The version-control step is refused until .ukp/ is clean - rewriting the ignore guard over material it no longer covers is how a private key becomes committable.",
    ];
    super(lines.join("\n"));
    this.name = "UkpResidentError";
  }
}

/** INV-21 admission gate of every posture step (init / use / register):
 * enumerate `.ukp/` and refuse on any entry outside the closed resident
 * set. Runs BEFORE any write of the carrying gesture — the template
 * rewrite most of all. The 2026-11-02 KB incident was a `*` guard swapped
 * onto the current template while a legacy `tls/` still sat beneath it:
 * key.pem became addable. Disposition is the owner's (delete, or move the
 * identity to its machine home); nothing migrates here (key material
 * relocation is serve's lifecycle), nothing is ignored, no tombstone rule
 * is written. A missing `.ukp/` passes (nothing to inspect). */
export function assertUkpResidents(ukpDirectory: string, options: { endpointName?: string } = {}): void {
  let entries: string[];
  try {
    entries = readdirSync(ukpDirectory);
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const strangers = entries.filter((name) => !UKP_RESIDENTS.has(name)).sort();
  if (strangers.length === 0) return;
  throw new UkpResidentError(ukpDirectory, strangers, options.endpointName);
}

/** Posture of `.ukp/.gitignore` after a version-control step ran. Two
 * gestures carry the declarations' version visibility and share this
 * ladder: `ukp use` (client face) and `ukp register`'s local path (service
 * face — the service-side touchpoint pure Service folders were missing
 * until 2026-11-01; they have no reason to run `use`, and re-running
 * `init service` is refused once the manifest exists). */
export type UkpIgnorePosture =
  | "created"
  | "migrated"
  /** The 2026-10-28 first precise form (WITH_TLS) swapped onto the current
   * template: its `/tls/` rule named a resident INV-21 now guarantees
   * absent — safe to drop only because the admission gate ran first. */
  | "refreshed"
  | "current"
  | "operator-owned"
  /** Operator-owned AND still carries a bare `*` rule — the declarations
   * stay invisible; surfaced as a stderr warning with the remedy. */
  | "operator-owned-star";

/** Same-file template swap through a temp + rename: a concurrent reader
 * sees either template, never a torn file. */
function swapUkpIgnoreTemplate(ukpDirectory: string): void {
  const tempPath = join(ukpDirectory, ".gitignore.ukp-tmp");
  writeFileSync(tempPath, UKP_SELF_IGNORE, "utf8");
  renameSync(tempPath, join(ukpDirectory, ".gitignore"));
}

/** Bring `.ukp/.gitignore` to the precise-ignore posture (the version
 * control half of `ukp use` and register's local path): create when absent,
 * migrate a verbatim legacy `*` template, refresh the retired first precise
 * form, leave anything else untouched — the O-020 B-b operator-policy-wins
 * rule. The `*` detector is advisory only (a note, never a rewrite). The
 * INV-21 gate runs here too, so the rewrite itself can never land over
 * foreign residents even if a carrier forgot to pre-gate (carriers still
 * pre-gate before their own writes so the whole gesture fails atomically). */
export function ensureVersionVisibleUkpIgnore(ukpDirectory: string): UkpIgnorePosture {
  assertUkpResidents(ukpDirectory);
  const gitignorePath = join(ukpDirectory, ".gitignore");
  const classify = (): UkpIgnorePosture => {
    const content = readFileSync(gitignorePath, "utf8");
    if (content === UKP_SELF_IGNORE) return "current";
    if (content === LEGACY_UKP_SELF_IGNORE) {
      swapUkpIgnoreTemplate(ukpDirectory);
      return "migrated";
    }
    if (content === UKP_SELF_IGNORE_WITH_TLS) {
      swapUkpIgnoreTemplate(ukpDirectory);
      return "refreshed";
    }
    return content.split("\n").some((line) => line.trim() === "*")
      ? "operator-owned-star"
      : "operator-owned";
  };
  if (!existsSync(gitignorePath)) {
    try {
      writeFileSync(gitignorePath, UKP_SELF_IGNORE, { flag: "wx", mode: 0o644 });
      return "created";
    } catch (error) {
      // Concurrent writer installed a guard — classify whatever landed.
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return classify();
}

/** stdout line reporting a posture — shared verbatim by every carrier
 * gesture so the version-control face reads identically wherever it runs. */
export function renderUkpIgnorePostureLine(posture: UkpIgnorePosture, ukpDirectory: string): string {
  switch (posture) {
    case "created":
      return `version_control: .ukp/.gitignore created (machine-local state ignored; declarations committable)`;
    case "migrated":
      return `version_control: .ukp/.gitignore migrated off the retired '*' template (declarations committable; machine-local state stays ignored)`;
    case "refreshed":
      return `version_control: .ukp/.gitignore refreshed (retired tls/ rule dropped; machine-local state stays ignored)`;
    case "current":
      return `version_control: .ukp/.gitignore already precise (machine-local state only)`;
    case "operator-owned":
      return `version_control: .ukp/.gitignore is operator-owned - left untouched (${join(ukpDirectory, ".gitignore")})`;
    case "operator-owned-star":
      return `version_control: .ukp/.gitignore is operator-owned - left untouched (see warning)`;
  }
}

/** stderr warning for the operator-owned-star posture: the declarations
 * stay invisible until the operator narrows the file. */
export function ukpIgnoreStarWarning(ukpDirectory: string): string {
  return `warning: ${join(ukpDirectory, ".gitignore")} ignores everything ('*'); declarations stay invisible to version control - narrow it to machine-local state (instance-uid) so they can be committed\n`;
}

/** Serve-side half of the TLS identity relocation (2026-11-01): once the
 * legacy `.ukp/tls/` material has moved into the machine home, the
 * by-then-retired first precise template (whose `/tls/` rule guarded it)
 * swaps onto the current one — verbatim recognition only, so an
 * operator-owned file is never touched. The posture ladder performs the
 * same swap as its `refreshed` state; this entry point exists for serve,
 * which carries no posture step. Returns whether a swap happened. */
export function retireTlsIgnoreLine(ukpDirectory: string): boolean {
  const gitignorePath = join(ukpDirectory, ".gitignore");
  let content: string;
  try {
    content = readFileSync(gitignorePath, "utf8");
  } catch {
    return false; // no guard in place — nothing to retire
  }
  if (content !== UKP_SELF_IGNORE_WITH_TLS) return false;
  swapUkpIgnoreTemplate(ukpDirectory);
  return true;
}

function ensureUkpSelfIgnore(ukpDirectory: string): void {
  const gitignorePath = join(ukpDirectory, ".gitignore");
  if (existsSync(gitignorePath)) return;
  try {
    writeFileSync(gitignorePath, UKP_SELF_IGNORE, { flag: "wx", mode: 0o644 });
  } catch (error) {
    // Concurrent writer installed the same guard — in place either way.
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function createServiceManifest(
  currentDirectory: string,
  options: InitServiceOptions,
): { folder: string; manifestPath: string; name: string; nameSource: "option" | "folder-name" } {
  const folder = resolveServiceFolder(currentDirectory);
  const ukpDirectory = join(folder, ".ukp");
  const manifestPath = join(ukpDirectory, "service.toml");
  const { name, nameSource, dependencies } = validateInitServiceOptions(folder, options);
  // INV-21 admission gate: a pre-existing .ukp/ must hold nothing UKP does
  // not own before init writes into it — operator-made junk fails loudly
  // with zero residue (nothing has been written yet).
  assertUkpResidents(ukpDirectory, { endpointName: name });
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

  ensureUkpSelfIgnore(ukpDirectory);

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
        "declared_capabilities: -",
        "derived_capabilities: read, nav",
        "base_tier: rg (external tool; active when ripgrep is installed)",
        // Folder-existence probe only (no provider state read): an existing
        // provider index means collections may already be registered — route
        // to the provider-scoped topic instead of naming provider commands
        // (provider-agnostic stdout, same pattern as diagnose's hint).
        ...(existsSync(join(result.folder, ".qmd"))
          ? ["note: existing provider index detected (.qmd/); align collection naming before adding new ones (see 'ukp guide service qmd')"]
          : []),
        "next: ukp diagnose",
        "next: ukp register",
        "optional: ukp guide service qmd",
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
