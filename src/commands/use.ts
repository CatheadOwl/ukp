import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENDPOINT_NAME } from "../config/manifest.ts";
import { findNearestClientConfig, loadClientConfig } from "../config/client.ts";
import { readRegistry } from "../registry.ts";
import { LEGACY_UKP_SELF_IGNORE, UKP_SELF_IGNORE } from "./init.ts";
import {
  KitUsageError,
  parseKitArgs,
  renderKitHelp,
  renderKitUsageError,
  type UkpCommandSpec,
} from "./kit.ts";
import { HelpRequestError, isHelpRequest } from "./flags.ts";

export interface UseCommandContext {
  currentDirectory: string;
  registryPath: string;
}

export interface UseCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `ukp use` (inbox client-portability-and-skill-coverage, owner-endorsed
 * 2026-10-28): the one-step consumer onboarding gesture `register` is
 * deliberately not (register never edits Client Config — the guide owned
 * that journey until now, which left hand-writing the file plus a
 * version-control carve dance). Named `use` rather than `init client`
 * because the lifecycle is create-or-update and idempotent re-runs are the
 * point, while the init family is create-only and refuses re-runs. */
export const USE_SPEC: UkpCommandSpec = {
  name: "use",
  summary: "set this workspace's default endpoints in one step",
  group: "registry",
  description: "Write the workspace Client Config (default_endpoints) and keep it version-visible; idempotent.",
  usage: "<endpoint> [endpoint...]",
  arguments: [
    { name: "endpoint...", required: true, help: "registered endpoint name(s); the whole list becomes default_endpoints (explicit replace, no append)" },
  ],
  helpSuffix: [
    "",
    "Semantics:",
    "  The list REPLACES default_endpoints: re-running with the same names",
    "  changes nothing; running with new names rewrites the list (the old",
    "  list is reported). The nearest existing .ukp/client.toml found",
    "  walking up from here is updated; with none found, one is created in",
    "  the current folder. Every name must already be registered",
    "  ('ukp list -g'); registering stays a separate explicit gesture.",
    "",
    "Version control rides the same step: .ukp/.gitignore is created with",
    "  machine-local ignores only (declarations stay committable), or",
    "  migrated off the retired '*' template; an operator-owned file is",
    "  left untouched. 'ukp inspect' shows the active scope afterwards.",
    "",
  ].join("\n"),
};

/** Posture of `.ukp/.gitignore` after `ukp use` ran. */
export type UkpIgnorePosture =
  | "created"
  | "migrated"
  | "current"
  | "operator-owned"
  /** Operator-owned AND still carries a bare `*` rule — the declarations
   * stay invisible; surfaced as a stderr warning with the remedy. */
  | "operator-owned-star";

/** Bring `.ukp/.gitignore` to the precise-ignore posture (the one-step
 * version-control half of `ukp use`): create when absent, migrate a
 * verbatim legacy `*` template, leave anything else untouched — the
 * O-020 B-b operator-policy-wins rule. The `*` detector is advisory only
 * (a note, never a rewrite). */
export function ensureVersionVisibleUkpIgnore(ukpDirectory: string): UkpIgnorePosture {
  const gitignorePath = join(ukpDirectory, ".gitignore");
  const classify = (): UkpIgnorePosture => {
    const content = readFileSync(gitignorePath, "utf8");
    if (content === UKP_SELF_IGNORE) return "current";
    if (content === LEGACY_UKP_SELF_IGNORE) {
      // Same-file swap through a temp + rename: a concurrent reader sees
      // either template, never a torn file.
      const tempPath = join(ukpDirectory, ".gitignore.ukp-tmp");
      writeFileSync(tempPath, UKP_SELF_IGNORE, "utf8");
      renameSync(tempPath, gitignorePath);
      return "migrated";
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

function renderClientConfig(names: readonly string[]): string {
  // Hand-rendered rather than smol-toml stringify: the schema is exactly
  // one string-array field, and the serializer's `[ "a", "b" ]` spacing
  // would diverge from every documented example (`["a", "b"]`). A slug
  // name needs no escapes, so JSON.stringify is a valid TOML basic string.
  return `default_endpoints = [${names.map((name) => JSON.stringify(name)).join(", ")}]\n`;
}

export function executeUseCommand(
  args: readonly string[],
  context: UseCommandContext,
): UseCommandResult {
  if (isHelpRequest(args)) {
    return { exitCode: 0, stdout: renderKitHelp(USE_SPEC), stderr: "" };
  }

  try {
    const parsed = parseKitArgs(USE_SPEC, args);
    const names = parsed.positionals;
    if (names.length === 0) {
      throw new KitUsageError("use requires at least one endpoint name");
    }
    for (const name of names) {
      if (!ENDPOINT_NAME.test(name)) {
        throw new KitUsageError(`invalid endpoint name '${name}'. Endpoint names use the lowercase slug grammar ([a-z0-9-]).`);
      }
    }
    // The written file must satisfy the Client Config schema on the spot —
    // duplicates are refused here, not left for every later load to warn.
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) {
        throw new KitUsageError(`duplicate endpoint '${name}' - default_endpoints cannot repeat`);
      }
      seen.add(name);
    }
    // Admission against the registry (the file stores names only; names
    // must resolve): catches typos at write time instead of as dangling
    // warnings on every later command. Registering stays separate.
    const registered = new Set(readRegistry(context.registryPath).map((binding) => binding.name));
    const unknown = names.filter((name) => !registered.has(name));
    if (unknown.length > 0) {
      throw new Error(
        `unknown endpoint '${unknown[0]}'; run 'ukp list -g' to see every registered endpoint, or 'ukp register' first`,
      );
    }

    // Nearest-wins, the same lookup rule scope resolution applies: the
    // config updated is the one actually in effect from here; a workspace
    // without one gets it created at the current folder.
    const existingPath = findNearestClientConfig(context.currentDirectory);
    const targetPath = existingPath ?? join(context.currentDirectory, ".ukp", "client.toml");
    const ukpDirectory = dirname(targetPath);
    let status: "created" | "updated" | "unchanged";
    let previous: string[] | undefined;
    if (existingPath !== undefined) {
      // Structural refusal, never a clobber: an invalid config is the
      // operator's to fix or delete; overwriting it would silently discard
      // whatever they were trying to express.
      try {
        const current = loadClientConfig(existingPath);
        previous = current.default_endpoints;
      } catch (error) {
        throw new Error(
          `existing Client Config is invalid (${existingPath}): ${error instanceof Error ? error.message : String(error)}; fix or delete the file, then re-run 'ukp use'`,
        );
      }
      status = previous.length === names.length && previous.every((name, index) => name === names[index])
        ? "unchanged"
        : "updated";
    } else {
      status = "created";
    }
    if (status !== "unchanged") {
      mkdirSync(ukpDirectory, { recursive: true });
      // Fixed temp name + atomic rename: readers (this CLI included) never
      // see a torn file; a crash residue is one file, overwritten next run.
      const tempPath = join(ukpDirectory, "client.toml.ukp-tmp");
      writeFileSync(tempPath, renderClientConfig(names), "utf8");
      renameSync(tempPath, targetPath);
    }
    const posture = ensureVersionVisibleUkpIgnore(ukpDirectory);

    const lines = [
      `default_endpoints: ${names.join(", ")}`,
      ...(previous !== undefined && status === "updated" ? [`replaced: ${previous.join(", ")}`] : []),
      `client_config: ${status}: ${targetPath}`,
      ...versionControlLines(posture, ukpDirectory),
      "next: ukp inspect (see the active scope)",
    ];
    return {
      exitCode: 0,
      stdout: lines.join("\n"),
      stderr: posture === "operator-owned-star"
        ? `warning: ${join(ukpDirectory, ".gitignore")} ignores everything ('*'); client.toml stays invisible to version control - narrow it to machine-local state (instance-uid, tls/) so declarations can be committed\n`
        : "",
    };
  } catch (error) {
    if (error instanceof HelpRequestError) {
      return { exitCode: 0, stdout: renderKitHelp(USE_SPEC), stderr: "" };
    }
    if (error instanceof KitUsageError) {
      return { exitCode: 2, stdout: "", stderr: renderKitUsageError(USE_SPEC, error.message) };
    }
    return { exitCode: 1, stdout: "", stderr: `ukp use: ${error instanceof Error ? error.message : String(error)}\n` };
  }
}

function versionControlLines(posture: UkpIgnorePosture, ukpDirectory: string): string[] {
  switch (posture) {
    case "created":
      return [`version_control: .ukp/.gitignore created (machine-local state ignored; declarations committable)`];
    case "migrated":
      return [`version_control: .ukp/.gitignore migrated off the retired '*' template (declarations committable; machine-local state stays ignored)`];
    case "current":
      return [`version_control: .ukp/.gitignore already precise (machine-local state only)`];
    case "operator-owned":
      return [`version_control: .ukp/.gitignore is operator-owned - left untouched (${join(ukpDirectory, ".gitignore")})`];
    case "operator-owned-star":
      return [`version_control: .ukp/.gitignore is operator-owned - left untouched (see warning)`];
  }
}
