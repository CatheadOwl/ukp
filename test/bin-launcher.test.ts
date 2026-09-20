import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bin/ukp.js is the package bin (npm shims exec it with node; bun's own bin
// links and bunx run it with bun). The launcher must find a bun executable
// itself — the two entry shapes below cover both interpreter realities, plus
// the UKP_BUN override.
const launcher = join(import.meta.dir, "..", "bin", "ukp.js");

function run(argv: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const proc = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe", env });
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout ?? new Uint8Array()),
    stderr: new TextDecoder().decode(proc.stderr ?? new Uint8Array()),
  };
}

describe("bin/ukp.js self-locating launcher", () => {
  test("node entry (npm shim shape): locates bun and runs the CLI", () => {
    const node = Bun.which("node");
    if (node === null) return; // node-less machines: the bun entry below covers the shape
    const result = run([node, launcher, "--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^ukp \d+\.\d+\.\d+/);
  });

  test("bun entry (bun add -g trampoline / direct bun shape): runs directly via process.execPath", () => {
    const result = run([process.execPath, launcher, "--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^ukp \d+\.\d+\.\d+/);
  });

  test("UKP_BUN override is honored ahead of the standard locations", () => {
    const node = Bun.which("node");
    if (node === null) return;
    const result = run([node, launcher, "--version"], { ...process.env, UKP_BUN: process.execPath });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^ukp \d+\.\d+\.\d+/);
  });

  test("a missing bun fails with the remedy, not a stack trace", () => {
    // POSIX-only: Windows re-injects PATH (and USERPROFILE) into ANY child
    // environment block (CreateProcess semantics), so the no-bun shape is
    // unconstructible there — and de-facto unreachable, since the PATH scan
    // always sees something. The Linux CI leg covers the fail path.
    if (process.platform === "win32") return;
    // Skip when the launcher's absolute POSIX candidates exist on this
    // machine (homebrew / /usr/local bun) — the test env cannot suppress
    // absolute paths, so a bun there rescues the run and false-fails this.
    if (existsSync("/opt/homebrew/bin/bun") || existsSync("/usr/local/bin/bun")) return;
    const node = Bun.which("node");
    if (node === null) return;
    // Deterministic absence: UKP_BUN to a path that cannot exist, home
    // redirected to an empty temp dir (so the standard-location candidates
    // miss), and PATH stripped so the last-resort scan cannot rescue the run.
    const emptyHome = mkdtempSync(join(tmpdir(), "ukp-launcher-nohome-"));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        UKP_BUN: join(emptyHome, "definitely-not-here", "bun.exe"),
        USERPROFILE: emptyHome,
        HOME: emptyHome,
      };
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === "path") delete env[key];
      }
      const result = run([node, launcher, "--version"], env);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no bun executable found");
      expect(result.stderr).toContain("UKP_BUN");
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});
