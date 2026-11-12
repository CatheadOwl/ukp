import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeInspectCommand } from "../src/commands/inspect.ts";

// Remote-binding render (2026-11-12 walkthrough F5): the binding line shows
// the url — binding.path is undefined on remotes and used to print as a
// literal `undefined` — and the local-only limitation is a named status,
// not `status: failed`, while the exit code stays 1 (the reword changed
// the render, not the code: the requested deep-dive did not happen).

function remoteRegistry(root: string, url: string): string {
  const registryPath = join(root, "registry.toml");
  writeFileSync(
    registryPath,
    // Door-form url (origin + single endpoint-name segment) — the registry
    // parser refuses anything else.
    `[[endpoints]]\nname = "cad"\nkind = "remote"\nurl = "${url}"\n`,
    "utf8",
  );
  return registryPath;
}

describe("inspect remote bindings (walkthrough F5)", () => {
  test("remote binding renders url + local-only status, exit 1", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-inspect-remote-"));
    try {
      const registryPath = remoteRegistry(root, "http://127.0.0.1:18770/cad");
      const result = executeInspectCommand(["--endpoint", "cad"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("binding: cad -> http://127.0.0.1:18770/cad");
      expect(result.stdout).toContain("status: local-only");
      expect(result.stdout).toContain("remote capabilities show in 'ukp list'");
      expect(result.stdout).not.toContain("-> undefined");
      expect(result.stdout).not.toContain("status: failed");
      expect(result.stdout).not.toContain("error:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a remote-only -g scope renders every url, exit 1 (mixed-scope baseline)", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-inspect-mixed-"));
    try {
      const registryPath = join(root, "registry.toml");
      writeFileSync(
        registryPath,
        [
          "[[endpoints]]",
          'name = "cad"',
          'kind = "remote"',
          'url = "http://127.0.0.1:18770/cad"',
          "",
          "[[endpoints]]",
          'name = "ghost"',
          'kind = "remote"',
          'url = "http://127.0.0.1:18770/ghost"',
          "",
        ].join("\n"),
        "utf8",
      );
      const result = executeInspectCommand(["-g"], {
        currentDirectory: root,
        registryPath,
      });
      // Every selected endpoint is remote-local-only: exit stays 1, both
      // rows render their urls.
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("binding: cad -> http://127.0.0.1:18770/cad");
      expect(result.stdout).toContain("binding: ghost -> http://127.0.0.1:18770/ghost");
      expect(result.stdout).not.toContain("-> undefined");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
