import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

/**
 * Black-box eval harness (ukp_evals W1/W2).
 *
 * Hard boundary (adjudication E-2, enforced by guard.test.ts): scenarios and
 * this harness never import anything under src/. The only way to touch the
 * implementation is to spawn the CLI entry and consume stdout / stderr /
 * exit code / the filesystem after-state — the same surface a stranger (or a
 * dispatched agent) gets.
 *
 * Fixture-side setup (writing service folders, registries via the CLI, git
 * history for recovery scenarios, provider shims, spawned servers) is harness
 * code, not implementation coupling: a task artifact ships with its
 * environment fixture.
 */

const UKP_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI_ENTRY = join(UKP_ROOT, "src", "cli.ts");

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RunUkp = (args: string[], options?: { cwd?: string }) => SpawnResult;

export interface EvalWorld {
  /** Scratch root holding the isolated home and any scenario folders. */
  root: string;
  /** Isolated HOME (and USERPROFILE) — the Host Registry lives under it. */
  home: string;
  /** Run the published CLI entry with the world's isolated environment. */
  runUkp: RunUkp;
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

/** Isolated environment: temp HOME plus (optionally) the provider shim first
 * on PATH. `process.env` is kept (SystemRoot and friends must survive for
 * cmd.exe wrappers) with only the isolation keys overridden. */
function buildEnv(home: string, providerScript?: string, extraRoot?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
  if (providerScript !== undefined) {
    const shimDir = join(extraRoot ?? home, "shim");
    mkdirSync(shimDir, { recursive: true });
    writeQmdShim(shimDir, providerScript);
    env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;
  }
  return env;
}

function makeRunner(env: NodeJS.ProcessEnv, defaultCwd: string): RunUkp {
  return (args: string[], options: { cwd?: string } = {}): SpawnResult => {
    const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
      cwd: options.cwd ?? defaultCwd,
      encoding: "utf8",
      env,
    });
    if (result.error !== undefined) {
      throw new Error(`failed to spawn the CLI entry: ${String(result.error)}`);
    }
    return { exitCode: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

/**
 * Build an isolated world: temp HOME (registry lands inside it), and a PATH
 * `qmd` shim pointing at the given provider script.
 */
export function buildEvalWorld(label: string, providerScript?: string): EvalWorld {
  const root = mkdtempSync(join(tmpdir(), `ukp-evals-${label}-`));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { root, home, runUkp: makeRunner(buildEnv(home, providerScript, root), root) };
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

/** Ask the OS for a currently free TCP port (bind :0, read it back, release). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : -1;
      server.close(() => resolve(port));
    });
  });
}

export interface ServedTopology {
  root: string;
  serverHome: string;
  clientHome: string;
  /** CLI runner whose registry is the SERVER-side one. */
  serverRun: RunUkp;
  /** CLI runner whose registry is the CLIENT-side one (remote bindings land here). */
  clientRun: RunUkp;
  /** Spawn `ukp serve` in the server world and keep it alive. */
  startServe: (options: { port: number; token: string; endpoint?: string }) => ChildProcess;
  /** Kill every server this topology started. */
  stopAll: () => void;
}

/**
 * Two-machine topology: a server world (owns the real endpoints) and a client
 * world (owns only remote bindings) — the realistic `serve ↔ register --url`
 * shape, driven entirely through spawned processes.
 */
export function buildServedTopology(label: string, providerScript?: string): ServedTopology {
  const root = mkdtempSync(join(tmpdir(), `ukp-evals-${label}-`));
  const serverHome = join(root, "server-home");
  const clientHome = join(root, "client-home");
  mkdirSync(serverHome, { recursive: true });
  mkdirSync(clientHome, { recursive: true });
  const serverEnv = buildEnv(serverHome, providerScript, root);
  const clientEnv = buildEnv(clientHome, undefined, root);
  const children: ChildProcess[] = [];
  return {
    root,
    serverHome,
    clientHome,
    serverRun: makeRunner(serverEnv, root),
    clientRun: makeRunner(clientEnv, root),
    startServe: ({ port, token, endpoint }) => {
      const args = ["serve", "--host", "127.0.0.1", "--port", String(port)];
      if (endpoint !== undefined) args.push("--endpoint", endpoint);
      const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
        cwd: root,
        env: { ...serverEnv, UKP_SERVE_TOKEN: token },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      return child;
    },
    stopAll: () => {
      for (const child of children) {
        try {
          child.kill();
        } catch {
          // already gone
        }
      }
    },
  };
}

/** Wait until the served discovery document answers (auth-exempt route). */
export async function waitServeReady(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/.well-known/ukp.json`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`serve on port ${port} never became ready`);
    await Bun.sleep(100);
  }
}
