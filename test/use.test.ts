import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../src/cli.ts";
import { LEGACY_UKP_SELF_IGNORE, UKP_SELF_IGNORE } from "../src/commands/init.ts";
import { registerAt } from "../src/registry.ts";
import { createQmdFixtureCopy } from "./helpers/qmd-fixture.ts";

// Private per-file copy: the fixture's invocation state is written into the
// service folder, and bun runs test files in parallel (see helper doc).
const fixture = createQmdFixtureCopy("use-fixture");

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

/** Fresh consumer workspace + a registry holding one healthy Service
 * (`fixture-qmd`, capabilities search+update) and one bare-folder binding
 * (`second`). Returns the tmp root for cleanup. */
function freshWorkspace(): {
  root: string;
  workspace: string;
  context: { currentDirectory: string; registryPath: string; resolveProvider: () => { supported: boolean } };
} {
  const root = mkdtempSync(join(tmpdir(), "ukp-use-"));
  const registryPath = join(root, "registry.toml");
  registerAt(registryPath, "fixture-qmd", fixture);
  registerAt(registryPath, "second", mkdtempSync(join(tmpdir(), "ukp-use-second-")));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  return {
    root,
    workspace,
    context: { currentDirectory: workspace, registryPath, resolveProvider: () => ({ supported: true }) },
  };
}

describe("ukp use (client portability, inbox client-portability-and-skill-coverage)", () => {
  test("one step: writes default_endpoints, makes it version-visible, and inspect recognizes the scope", () => {
    const { root, workspace, context } = freshWorkspace();
    const output: string[] = [];
    const errors: string[] = [];
    try {
      expect(runCli(["use", "fixture-qmd"], (message) => output.push(message), (message) => errors.push(message), context)).toBe(0);
      expect(errors.join("\n")).toBe("");
      const text = output.join("\n");
      expect(text).toContain("default_endpoints: fixture-qmd");
      expect(text).toContain(`client_config: created: ${join(workspace, ".ukp", "client.toml")}`);
      expect(text).toContain("version_control: .ukp/.gitignore created");
      expect(text).toContain("next: ukp inspect");
      // Canonical single-field TOML, the documented hand-written shape.
      expect(readFileSync(join(workspace, ".ukp", "client.toml"), "utf8")).toBe('default_endpoints = ["fixture-qmd"]\n');
      // Precise ignores: declarations committable, machine-local state not.
      expect(readFileSync(join(workspace, ".ukp", ".gitignore"), "utf8")).toBe(UKP_SELF_IGNORE);
      // End of the journey: the scope system picks the file up as written.
      const inspectOut: string[] = [];
      expect(runCli(["inspect"], (message) => inspectOut.push(message), undefined, context)).toBe(0);
      const inspection = inspectOut.join("\n");
      expect(inspection).toContain("scope: client-config");
      expect(inspection).toContain(join(workspace, ".ukp", "client.toml"));
      expect(inspection).toContain("fixture-qmd");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("idempotent: same names again is unchanged; new names replace the list and report the old one", () => {
    const { root, workspace, context } = freshWorkspace();
    const output: string[] = [];
    try {
      runCli(["use", "fixture-qmd"], (message) => output.push(message), undefined, context);
      const before = readFileSync(join(workspace, ".ukp", "client.toml"), "utf8");
      output.length = 0;
      expect(runCli(["use", "fixture-qmd"], (message) => output.push(message), undefined, context)).toBe(0);
      const text = output.join("\n");
      expect(text).toContain("client_config: unchanged");
      expect(text).not.toContain("replaced:");
      expect(readFileSync(join(workspace, ".ukp", "client.toml"), "utf8")).toBe(before);

      output.length = 0;
      expect(runCli(["use", "fixture-qmd", "second"], (message) => output.push(message), undefined, context)).toBe(0);
      const replaced = output.join("\n");
      expect(replaced).toContain("client_config: updated");
      expect(replaced).toContain("replaced: fixture-qmd");
      expect(readFileSync(join(workspace, ".ukp", "client.toml"), "utf8")).toBe('default_endpoints = ["fixture-qmd", "second"]\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("migrates a verbatim legacy '*' template; operator-owned files stay untouched", () => {
    const { root, workspace, context } = freshWorkspace();
    try {
      mkdirSync(join(workspace, ".ukp"), { recursive: true });
      writeFileSync(join(workspace, ".ukp", ".gitignore"), LEGACY_UKP_SELF_IGNORE, "utf8");
      const output: string[] = [];
      expect(runCli(["use", "fixture-qmd"], (message) => output.push(message), undefined, context)).toBe(0);
      expect(output.join("\n")).toContain("migrated off the retired '*' template");
      expect(readFileSync(join(workspace, ".ukp", ".gitignore"), "utf8")).toBe(UKP_SELF_IGNORE);

      // Operator policy wins (O-020 B-b posture): custom narrow file.
      rmSync(join(workspace, ".ukp", "client.toml"));
      writeFileSync(join(workspace, ".ukp", ".gitignore"), "tls/\n", "utf8");
      const narrow: string[] = [];
      expect(runCli(["use", "fixture-qmd"], (message) => narrow.push(message), undefined, context)).toBe(0);
      expect(readFileSync(join(workspace, ".ukp", ".gitignore"), "utf8")).toBe("tls/\n");
      expect(narrow.join("\n")).toContain("operator-owned - left untouched");

      // Custom file that still ignores everything: untouched, but warned.
      rmSync(join(workspace, ".ukp", "client.toml"));
      writeFileSync(join(workspace, ".ukp", ".gitignore"), "# mine\n*\n", "utf8");
      const warned: string[] = [];
      const warnings: string[] = [];
      expect(runCli(["use", "fixture-qmd"], (message) => warned.push(message), (message) => warnings.push(message), context)).toBe(0);
      expect(readFileSync(join(workspace, ".ukp", ".gitignore"), "utf8")).toBe("# mine\n*\n");
      expect(warnings.join("\n")).toContain("ignores everything ('*')");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nearest config wins: updates the effective file up the tree, creates none below it", () => {
    const { root, workspace, context } = freshWorkspace();
    mkdirSync(join(workspace, ".ukp"), { recursive: true });
    writeFileSync(join(workspace, ".ukp", "client.toml"), 'default_endpoints = ["second"]\n', "utf8");
    const nested = join(workspace, "nested");
    mkdirSync(nested);
    const nestedContext = { ...context, currentDirectory: nested };
    const output: string[] = [];
    try {
      expect(runCli(["use", "fixture-qmd"], (message) => output.push(message), undefined, nestedContext)).toBe(0);
      expect(output.join("\n")).toContain(`client_config: updated: ${join(workspace, ".ukp", "client.toml")}`);
      expect(readFileSync(join(workspace, ".ukp", "client.toml"), "utf8")).toBe('default_endpoints = ["fixture-qmd"]\n');
      expect(existsSync(join(nested, ".ukp"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dual-role safe: never touches service.toml, and a broken config is refused, not clobbered", () => {
    const { root, workspace, context } = freshWorkspace();
    const output: string[] = [];
    try {
      // Dual-role: a service manifest already lives here — use adds the
      // client face without touching it.
      mkdirSync(join(workspace, ".ukp"), { recursive: true });
      writeFileSync(join(workspace, ".ukp", "service.toml"), "# sentinel manifest\n\n[capabilities]\n", "utf8");
      const sentinel = readFileSync(join(workspace, ".ukp", "service.toml"), "utf8");
      expect(runCli(["use", "fixture-qmd"], (message) => output.push(message), undefined, context)).toBe(0);
      expect(readFileSync(join(workspace, ".ukp", "service.toml"), "utf8")).toBe(sentinel);

      // Structural refusal: an invalid existing config is the operator's
      // to fix or delete — use never overwrites it.
      writeFileSync(join(workspace, ".ukp", "client.toml"), "not = 1\n", "utf8");
      const errors: string[] = [];
      expect(runCli(["use", "fixture-qmd"], undefined, (message) => errors.push(message), context)).toBe(1);
      expect(errors.join("\n")).toContain("existing Client Config is invalid");
      expect(readFileSync(join(workspace, ".ukp", "client.toml"), "utf8")).toBe("not = 1\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("admission and usage errors", () => {
    const { root, workspace, context } = freshWorkspace();
    try {
      const errors: string[] = [];
      expect(runCli(["use", "nope"], undefined, (message) => errors.push(message), context)).toBe(1);
      expect(errors.join("\n")).toContain("unknown endpoint 'nope'");
      expect(errors.join("\n")).toContain("ukp list");

      errors.length = 0;
      expect(runCli(["use"], undefined, (message) => errors.push(message), context)).toBe(2);
      expect(runCli(["use", "Bad_Name"], undefined, (message) => errors.push(message), context)).toBe(2);
      expect(runCli(["use", "fixture-qmd", "fixture-qmd"], undefined, (message) => errors.push(message), context)).toBe(2);
      const usage = errors.join("\n");
      expect(usage).toContain("lowercase slug grammar");
      expect(usage).toContain("duplicate endpoint 'fixture-qmd'");
      expect(usage).toContain("Usage: ukp use <endpoint> [endpoint...]");
      // Nothing was written by any refused run.
      expect(existsSync(join(workspace, ".ukp"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
