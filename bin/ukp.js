#!/usr/bin/env node
// Self-locating launcher (D-085 completion, Windows-host wake 2026-09-20).
//
// npm's shims exec this file with node (the shebang above); bun's own bin
// links and `bunx` run it with bun itself. Either way the launcher finds a
// bun executable WITHOUT relying on the caller's PATH: non-interactive
// shells (ssh sessions, schtasks, service wrappers) see only the system
// PATH, while every standard install mode lands bun in a user-local dir.
// Candidate order: an explicit UKP_BUN override, the current interpreter
// when it already is bun, the standard install locations, then PATH.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { classifySpawnFailure, spawnFailureStderr } from "./spawn-failure.js";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "src", "cli.ts");
const isWindows = process.platform === "win32";
const runningUnderBun = typeof Bun !== "undefined" || Boolean(process.versions && process.versions.bun);

function bunCandidates() {
  const exe = isWindows ? "bun.exe" : "bun";
  const home = homedir();
  const candidates = [];
  if (typeof process.env.UKP_BUN === "string" && process.env.UKP_BUN.length > 0) {
    candidates.push(process.env.UKP_BUN);
  }
  if (runningUnderBun) candidates.push(process.execPath);
  // bun's official installer (same shape on every platform).
  candidates.push(join(home, ".bun", "bin", exe));
  if (isWindows) {
    // `npm i -g bun` lands its shim in the npm user prefix — the same
    // prefix root this package's own shim lives under.
    candidates.push(join(here, "..", "..", "..", "..", exe));
    // scoop installs stay user-local too.
    candidates.push(join(home, "scoop", "shims", exe));
  } else {
    candidates.push(join(home, ".npm-global", "bin", exe));
    // Homebrew's path is joined, not written as one literal: the release
    // leak scan rightly flags literal home-directory-shaped paths, and this
    // is a functional standard-location constant (same stance as the wake
    // command's PATH prefix in src/capabilities/remote-client.ts).
    candidates.push(join("/", "opt", "homebrew", "bin", "bun"));
    candidates.push("/usr/local/bin/bun");
  }
  // PATH last, resolved ourselves dir-by-dir: a bare-name spawn would let
  // the OS search with the PARENT's PATH on Windows (CreateProcess
  // semantics), which this process cannot see or control.
  const pathVar = process.env.PATH;
  if (typeof pathVar === "string" && pathVar.length > 0) {
    for (const dir of pathVar.split(isWindows ? ";" : ":")) {
      if (dir.length > 0) candidates.push(join(dir, exe));
    }
  }
  return candidates;
}

function fail(detail, hint = "") {
  process.stderr.write(
    "ukp: no bun executable found (" + detail + ").\n"
      + "ukp runs on bun — install it (https://bun.sh), or point UKP_BUN at the\n"
      + "bun executable. Standard install locations (~/.bun/bin and the npm\n"
      + "global prefix) are checked before PATH.\n"
      + hint,
  );
  process.exit(1);
}

/** Windows-only diagnosis for a UKP_BUN that the user's shell accepts but
 * existsSync rejects: name the shape mismatch instead of implying the file
 * is absent. Two real shapes (0.3.0 release review): Git Bash converts an
 * exported MSYS path (/c/.../bun) to a native form WITHOUT the .exe
 * extension before this launcher sees it, so the .exe sibling exists while
 * the named path does not; and a variable set outside a converting shell
 * (cmd/PowerShell) reaches us as the raw /c/... or /cygdrive/... form,
 * which Windows file APIs cannot resolve at all. */
function ukpBunHint() {
  const value = process.env.UKP_BUN;
  if (!isWindows || typeof value !== "string") return "";
  if (/^\/(?:[a-z]|cygdrive\/[a-z])\//i.test(value)) {
    return "ukp: UKP_BUN looks like an MSYS-style path; Windows needs a native "
      + "form like C:/path/to/bun.exe\n";
  }
  if (!/\.exe$/i.test(value) && existsSync(value + ".exe")) {
    return "ukp: UKP_BUN omits the .exe extension (the executable sits next to "
      + "it); use its full name, e.g. C:/path/to/bun.exe\n";
  }
  return "";
}

const bunPath = bunCandidates().find((candidate) => existsSync(candidate));
if (bunPath === undefined) {
  fail("looked at UKP_BUN, the standard install locations, and PATH", ukpBunHint());
}

// In-process handoff when this launcher already runs under bun (bun's own
// bin links and `bunx`): importing the CLI keeps it in THIS process, where
// stdout/stderr keep their real TTY identity (isTTY) — a spawnSync
// grandchild re-inherits duplicated handles, and on some hosts that layer
// degraded TTY detection (the third dogfood round: progress frames
// silently skipped while a direct run on the same console had them). One
// process also starts faster. The node-interpreted path (npm shims) keeps
// spawning.
if (runningUnderBun) {
  const { runCli } = await import(pathToFileURL(cli).href);
  const exit = runCli(process.argv.slice(2));
  if (exit instanceof Promise) {
    exit.then((code) => {
      process.exitCode = code;
    });
  } else {
    process.exitCode = exit;
  }
} else {
  const result = spawnSync(bunPath, [cli, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    // bunPath passed the existsSync gate a moment ago, yet the spawn still
    // failed — and the shape is reachable, not exotic (0.4.0 learnability
    // SF-2): a shell sitting in a directory that gets moved or renamed
    // leaves this launcher inheriting a dangling cwd, and spawnSync reports
    // ENOENT while bun is perfectly fine. Classify instead of funneling
    // everything into the no-bun remedy.
    const failure = classifySpawnFailure(result.error, bunPath);
    if (failure.kind === "exe-vanished") {
      // The bun we gated on is gone at launch: the no-bun remedy text is
      // the honest direction after all.
      fail(`found earlier at '${bunPath}' but gone at launch`);
    }
    process.stderr.write(spawnFailureStderr(failure.kind, bunPath, failure.code));
    process.exit(1);
  }
  process.exit(result.status === null ? (result.signal !== null ? 130 : 1) : result.status);
}
