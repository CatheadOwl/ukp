import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeDiagnoseCommand } from "../src/commands/diagnose.ts";
import { registerAt } from "../src/registry.ts";

// Remote-binding stance (2026-11-13 walkthrough N1, inspect-aligned): a
// remote binding is applicability, not health — `status: local-only` names
// the limitation and points at 'ukp list' (whose TEXT face fresh-fetches
// each remote row), never `status: failed`; the exit code still yields 1
// (the requested check did not happen — the same contract inspect carries).

function setupRegistry(root: string): string {
  const localFolder = join(root, "notes-service");
  mkdirSync(join(localFolder, ".ukp"), { recursive: true });
  writeFileSync(
    join(localFolder, ".ukp", "service.toml"),
    'name = "notes"\n\n[capabilities]\n',
    "utf8",
  );
  const registryPath = join(root, "registry.toml");
  registerAt(registryPath, "notes", localFolder);
  // Append the remote binding after registerAt has created the registry.
  writeFileSync(
    registryPath,
    `${readFileSync(registryPath, "utf8")}[[endpoints]]\nname = "cad"\nkind = "remote"\nurl = "http://127.0.0.1:18771/cad"\n`,
    "utf8",
  );
  return registryPath;
}

describe("ukp diagnose remote bindings (walkthrough N1)", () => {
  test("an explicit remote binding renders local-only, not failed, exit 1", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-diagnose-remote-"));
    try {
      const registryPath = setupRegistry(root);
      const result = executeDiagnoseCommand(["--endpoint", "cad"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("== cad ==");
      expect(result.stdout).toContain("status: local-only");
      expect(result.stdout).toContain("a remote binding's reachability shows in 'ukp list'");
      expect(result.stdout).not.toContain("status: failed");
      expect(result.stdout).not.toContain("error:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("-g mixes a healthy local with the local-only remote; the local still deep-checks", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-diagnose-mixed-"));
    try {
      const registryPath = setupRegistry(root);
      const result = executeDiagnoseCommand(["-g"], {
        currentDirectory: root,
        registryPath,
      });
      // Exit contract aligned with inspect: the remote check did not happen,
      // so the run is non-zero even with a healthy local beside it.
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("== notes ==");
      expect(result.stdout).toContain("status: ok");
      expect(result.stdout).toContain("== cad ==");
      expect(result.stdout).toContain("status: local-only");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
