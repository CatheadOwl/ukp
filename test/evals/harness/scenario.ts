import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Black-box eval harness (ukp_evals W1).
 *
 * Hard boundary (adjudication E-2, enforced by guard.test.ts): scenarios and
 * this harness never import anything under src/. The only way to touch the
 * implementation is to spawn the CLI entry and consume stdout / stderr /
 * exit code / the filesystem after-state — the same surface a stranger (or a
 * dispatched agent) gets.
 *
 * Fixture-side setup (writing service folders, registries via the CLI, git
 * history for recovery scenarios, shims) is harness code, not implementation
 * coupling: a task artifact ships with its environment fixture.
 */

const UKP_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI_ENTRY = join(UKP_ROOT, "src", "cli.ts");

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface EvalWorld {
  /** Scratch root holding the isolated home and any scenario folders. */
  root: string;
  /** Isolated HOME (and USERPROFILE) — the Host Registry lives under it. */
  home: string;
  /** Run the published CLI entry with the world's isolated environment. */
  runUkp: (args: string[], options?: { cwd?: string }) => SpawnResult;
}

/**
 * Put a `qmd` shim on PATH that forwards to the deterministic fixture
 * provider. The CLI resolves the provider through PATH (Bun.which), so the
 * shim is how a spawned run gets a provider without touching src/.
 */
function writeQmdShim(shimDir: string, providerScript: string): void {
  const runner = process.execPath;
  if (process.platform === "win32") {
    // A .cmd shim is routed through the CLI's own cmd.exe wrapper
    // (defaultQmdCommand) — same shape as a real npm-installed qmd.cmd.
    writeFileSync(
      join(shimDir, "qmd.cmd"),
      `@"${runner}" "${providerScript}" %*\r\n`,
      "utf8",
    );
    return;
  }
  const shim = join(shimDir, "qmd");
  writeFileSync(shim, `#!/bin/sh\nexec "${runner}" "${providerScript}" "$@"\n`, "utf8");
  chmodSync(shim, 0o755);
}

/**
 * Build an isolated world: temp HOME (registry lands inside it), and a PATH
 * `qmd` shim pointing at the given provider script. `process.env` is kept
 * (SystemRoot and friends must survive for cmd.exe wrappers) with only the
 * isolation keys overridden.
 */
export function buildEvalWorld(label: string, providerScript?: string): EvalWorld {
  const root = mkdtempSync(join(tmpdir(), `ukp-evals-${label}-`));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
  if (providerScript !== undefined) {
    const shimDir = join(root, "shim");
    mkdirSync(shimDir, { recursive: true });
    writeQmdShim(shimDir, providerScript);
    env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;
  }
  const runUkp = (args: string[], options: { cwd?: string } = {}): SpawnResult => {
    const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
      cwd: options.cwd ?? root,
      encoding: "utf8",
      env,
    });
    if (result.error !== undefined) {
      throw new Error(`failed to spawn the CLI entry: ${String(result.error)}`);
    }
    return { exitCode: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { root, home, runUkp };
}

/** git fixture helper with the same transient-denial retry as the
 * rename-recovery suite (fixture setup must not be the flaky part). */
export function git(cwd: string, ...args: string[]): void {
  let lastStderr = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status === 0) return;
    lastStderr = result.stderr ?? String(result.error ?? "");
    Bun.sleepSync(100);
  }
  throw new Error(`git ${args.join(" ")} failed: ${lastStderr}`);
}

/** Commit helper matching the rename-recovery fixtures' identity config. */
export function gitCommitAll(cwd: string, message: string): void {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@local", "commit", "-m", message, "-q");
}

