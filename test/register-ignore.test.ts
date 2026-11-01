import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../src/cli.ts";
import { LEGACY_UKP_SELF_IGNORE, UKP_SELF_IGNORE } from "../src/commands/init.ts";
import { registerAt } from "../src/registry.ts";

// The service-dir layering adjudication (inbox/service-dir-layering, owner
// ruling 2026-11-01 item 6): the `*` -> precise-ignore migration hung only
// on `ukp use` (a client gesture) and fresh init (refused once the manifest
// exists) — pure Service folders had no service-side touchpoint, which is
// exactly how the cli-dev description loss happened. Register's local path
// (plain and --rebind) is that touchpoint now.

/** Fresh Service folder (name svc-a, description) + registry context. */
function freshService(): {
  root: string;
  folder: string;
  registryPath: string;
  context: { currentDirectory: string; registryPath: string; resolveProvider: () => { supported: boolean } };
} {
  const root = mkdtempSync(join(tmpdir(), "ukp-reg-ignore-"));
  const folder = join(root, "svc-a");
  mkdirSync(join(folder, ".ukp"), { recursive: true });
  writeFileSync(
    join(folder, ".ukp", "service.toml"),
    'name = "svc-a"\ndescription = "fixture service"\n\n[capabilities]\n',
    "utf8",
  );
  const registryPath = join(root, "registry.toml");
  return {
    root,
    folder,
    registryPath,
    context: { currentDirectory: folder, registryPath, resolveProvider: () => ({ supported: true }) },
  };
}

describe("ukp register local path carries the .ukp/.gitignore posture (adjudication 2026-11-01 item 6)", () => {
  test("plain register creates the precise ignore when absent", () => {
    const { root, context } = freshService();
    try {
      const output: string[] = [];
      const errors: string[] = [];
      expect(runCli(["register"], (message) => output.push(message), (message) => errors.push(message), context)).toBe(0);
      expect(errors.join("\n")).toBe("");
      const text = output.join("\n");
      expect(text).toContain("registered: svc-a");
      expect(text).toContain("description: fixture service");
      expect(text).toContain("version_control: .ukp/.gitignore created");
      expect(readFileSync(join(context.currentDirectory, ".ukp", ".gitignore"), "utf8")).toBe(UKP_SELF_IGNORE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("plain register migrates a verbatim legacy '*' template", () => {
    const { root, context } = freshService();
    try {
      writeFileSync(join(context.currentDirectory, ".ukp", ".gitignore"), LEGACY_UKP_SELF_IGNORE, "utf8");
      const output: string[] = [];
      expect(runCli(["register"], (message) => output.push(message), undefined, context)).toBe(0);
      expect(output.join("\n")).toContain("migrated off the retired '*' template");
      expect(readFileSync(join(context.currentDirectory, ".ukp", ".gitignore"), "utf8")).toBe(UKP_SELF_IGNORE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--rebind (the fresh-clone revival gesture) migrates too", () => {
    const { root, folder, registryPath, context } = freshService();
    try {
      // The name is already bound to a previous local folder; the clone at
      // `folder` revives it — the exact cli-dev incident shape.
      const oldFolder = join(root, "svc-a-old");
      mkdirSync(oldFolder, { recursive: true });
      registerAt(registryPath, "svc-a", oldFolder);
      writeFileSync(join(folder, ".ukp", ".gitignore"), LEGACY_UKP_SELF_IGNORE, "utf8");
      const output: string[] = [];
      const errors: string[] = [];
      expect(runCli(["register", "--rebind"], (message) => output.push(message), (message) => errors.push(message), context)).toBe(0);
      expect(errors.join("\n")).toBe("");
      const text = output.join("\n");
      expect(text).toContain("rebound: svc-a");
      expect(text).toContain(`from: ${oldFolder}`);
      expect(text).toContain("migrated off the retired '*' template");
      expect(readFileSync(join(folder, ".ukp", ".gitignore"), "utf8")).toBe(UKP_SELF_IGNORE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("operator-owned narrow file stays untouched; a bare '*' one warns on stderr", () => {
    const { root, context } = freshService();
    try {
      writeFileSync(join(context.currentDirectory, ".ukp", ".gitignore"), "tls/\n", "utf8");
      const output: string[] = [];
      expect(runCli(["register"], (message) => output.push(message), undefined, context)).toBe(0);
      expect(output.join("\n")).toContain("operator-owned - left untouched");
      expect(readFileSync(join(context.currentDirectory, ".ukp", ".gitignore"), "utf8")).toBe("tls/\n");

      writeFileSync(join(context.currentDirectory, ".ukp", ".gitignore"), "# mine\n*\n", "utf8");
      const warned: string[] = [];
      const warnings: string[] = [];
      expect(runCli(["register"], (message) => warned.push(message), (message) => warnings.push(message), context)).toBe(0);
      expect(readFileSync(join(context.currentDirectory, ".ukp", ".gitignore"), "utf8")).toBe("# mine\n*\n");
      expect(warnings.join("\n")).toContain("ignores everything ('*')");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an already-precise file is reported current and left byte-identical", () => {
    const { root, context } = freshService();
    try {
      writeFileSync(join(context.currentDirectory, ".ukp", ".gitignore"), UKP_SELF_IGNORE, "utf8");
      const output: string[] = [];
      expect(runCli(["register"], (message) => output.push(message), undefined, context)).toBe(0);
      expect(output.join("\n")).toContain("already precise");
      expect(readFileSync(join(context.currentDirectory, ".ukp", ".gitignore"), "utf8")).toBe(UKP_SELF_IGNORE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    // Workspaces clean themselves in finally blocks; nothing shared remains.
  });
});
