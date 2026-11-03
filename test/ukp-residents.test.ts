import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../src/cli.ts";
import { LEGACY_UKP_SELF_IGNORE, UKP_SELF_IGNORE, UKP_SELF_IGNORE_WITH_TLS } from "../src/commands/init.ts";
import { readRegistry, registerAt } from "../src/registry.ts";

// INV-21 (owner ruling 2026-11-02): .ukp/ holds a closed resident set —
// declarations (service.toml, client.toml), instance-uid, the ignore guard
// (plus the two atomic-write transients). Every posture carrier (init /
// use / register) refuses BEFORE writing when anything else is present.
// The anchor shape is the 2026-11-02 KB incident: a pre-2026-11-01 folder
// carrying the '*' guard and a legacy tls/ identity ran register, the
// guard was swapped onto the current template (which no longer names
// tls/), and key.pem became addable.

function freshService(gitignore?: string): {
  root: string;
  folder: string;
  ukp: string;
  registryPath: string;
  context: { currentDirectory: string; registryPath: string; resolveProvider: () => { supported: boolean } };
} {
  const root = mkdtempSync(join(tmpdir(), "ukp-residents-"));
  const folder = join(root, "svc-a");
  const ukp = join(folder, ".ukp");
  mkdirSync(ukp, { recursive: true });
  writeFileSync(join(ukp, "service.toml"), 'name = "svc-a"\n\n[capabilities]\n', "utf8");
  if (gitignore !== undefined) writeFileSync(join(ukp, ".gitignore"), gitignore, "utf8");
  const registryPath = join(root, "registry.toml");
  return {
    root,
    folder,
    ukp,
    registryPath,
    context: { currentDirectory: folder, registryPath, resolveProvider: () => ({ supported: true }) },
  };
}

function plantLegacyTls(ukp: string): void {
  mkdirSync(join(ukp, "tls"), { recursive: true });
  writeFileSync(join(ukp, "tls", "cert.pem"), "cert", "utf8");
  writeFileSync(join(ukp, "tls", "key.pem"), "key", "utf8");
}

describe("INV-21: .ukp/ closed resident set — posture carriers refuse before writing", () => {
  test("the KB incident shape: '*' guard + legacy tls/ -> register refuses, guard untouched, registry untouched", () => {
    const { root, ukp, registryPath, context } = freshService(LEGACY_UKP_SELF_IGNORE);
    try {
      plantLegacyTls(ukp);
      const errors: string[] = [];
      expect(runCli(["register"], undefined, (message) => errors.push(message), context)).toBe(1);
      const text = errors.join("\n");
      expect(text).toContain("INV-21");
      expect(text).toContain(join(ukp, "tls"));
      // The tls hint carries the machine-home target keyed by the endpoint.
      expect(text).toContain("move its cert.pem and key.pem to ~/.ukp/tls/svc-a/");
      expect(text).toContain("refused until .ukp/ is clean");
      // Nothing was written: the '*' guard still covers tls/, the key is
      // not addable, the registry holds no binding.
      expect(readFileSync(join(ukp, ".gitignore"), "utf8")).toBe(LEGACY_UKP_SELF_IGNORE);
      expect(existsSync(join(ukp, "tls", "key.pem"))).toBe(true);
      expect(readRegistry(registryPath)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--rebind refuses the same way and leaves the old binding in place", () => {
    const { root, ukp, registryPath, context } = freshService(LEGACY_UKP_SELF_IGNORE);
    try {
      const oldFolder = join(root, "svc-a-old");
      mkdirSync(oldFolder, { recursive: true });
      registerAt(registryPath, "svc-a", oldFolder);
      plantLegacyTls(ukp);
      const errors: string[] = [];
      expect(runCli(["register", "--rebind"], undefined, (message) => errors.push(message), context)).toBe(1);
      expect(errors.join("\n")).toContain("INV-21");
      expect(readRegistry(registryPath).find((binding) => binding.name === "svc-a")?.path).toBe(oldFolder);
      expect(readFileSync(join(ukp, ".gitignore"), "utf8")).toBe(LEGACY_UKP_SELF_IGNORE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("use refuses on a dual-role folder in the same shape; client.toml is never written", () => {
    const { root, ukp, registryPath, context } = freshService(LEGACY_UKP_SELF_IGNORE);
    try {
      registerAt(registryPath, "svc-a", join(root, "svc-a"));
      plantLegacyTls(ukp);
      const errors: string[] = [];
      expect(runCli(["use", "svc-a"], undefined, (message) => errors.push(message), context)).toBe(1);
      expect(errors.join("\n")).toContain("INV-21");
      expect(existsSync(join(ukp, "client.toml"))).toBe(false);
      expect(readFileSync(join(ukp, ".gitignore"), "utf8")).toBe(LEGACY_UKP_SELF_IGNORE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("any foreign entry refuses: a stray file is named with the delete remedy; tls + stray lists both", () => {
    const { root, ukp, context } = freshService(UKP_SELF_IGNORE);
    try {
      writeFileSync(join(ukp, "notes.bak"), "x", "utf8");
      const errors: string[] = [];
      expect(runCli(["register"], undefined, (message) => errors.push(message), context)).toBe(1);
      const text = errors.join("\n");
      expect(text).toContain(join(ukp, "notes.bak"));
      expect(text).toContain("Delete them.");
      expect(text).not.toContain("tls/ is a pre-2026-11-01");

      plantLegacyTls(ukp);
      const both: string[] = [];
      expect(runCli(["register"], undefined, (message) => both.push(message), context)).toBe(1);
      const mixed = both.join("\n");
      expect(mixed).toContain(join(ukp, "notes.bak"));
      expect(mixed).toContain(join(ukp, "tls"));
      expect(mixed).toContain("tls/ is a pre-2026-11-01");
      expect(mixed).toContain("Delete the rest.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the two atomic-write transients are tolerated (crash residue, overwritten by the next write)", () => {
    const { root, ukp, context } = freshService(UKP_SELF_IGNORE);
    try {
      writeFileSync(join(ukp, ".gitignore.ukp-tmp"), "stale", "utf8");
      writeFileSync(join(ukp, "client.toml.ukp-tmp"), "stale", "utf8");
      const output: string[] = [];
      const errors: string[] = [];
      expect(runCli(["register"], (message) => output.push(message), (message) => errors.push(message), context)).toBe(0);
      expect(errors.join("\n")).toBe("");
      expect(output.join("\n")).toContain("registered: svc-a");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the retired first precise form (with the tls/ rule) is refreshed onto the current template once the gate is green", () => {
    const { root, ukp, context } = freshService(UKP_SELF_IGNORE_WITH_TLS);
    try {
      const output: string[] = [];
      expect(runCli(["register"], (message) => output.push(message), undefined, context)).toBe(0);
      expect(output.join("\n")).toContain("version_control: .ukp/.gitignore refreshed (retired tls/ rule dropped");
      expect(readFileSync(join(ukp, ".gitignore"), "utf8")).toBe(UKP_SELF_IGNORE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init service refuses a pre-existing .ukp/ holding foreign entries, with zero residue", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-residents-init-"));
    try {
      const folder = join(root, "svc-b");
      mkdirSync(join(folder, ".ukp"), { recursive: true });
      writeFileSync(join(folder, ".ukp", "leftover.txt"), "x", "utf8");
      const errors: string[] = [];
      expect(runCli(["init", "service"], undefined, (message) => errors.push(message), {
        currentDirectory: folder,
        registryPath: join(root, "registry.toml"),
      })).toBe(1);
      expect(errors.join("\n")).toContain(join(folder, ".ukp", "leftover.txt"));
      expect(existsSync(join(folder, ".ukp", "service.toml"))).toBe(false);
      expect(existsSync(join(folder, ".ukp", ".gitignore"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
