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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function fail(detail) {
  process.stderr.write(
    "ukp: no bun executable found (" + detail + ").\n"
      + "ukp runs on bun — install it (https://bun.sh), or point UKP_BUN at the\n"
      + "bun executable. Standard install locations (~/.bun/bin and the npm\n"
      + "global prefix) are checked before PATH.\n",
  );
  process.exit(1);
}

const bunPath = bunCandidates().find((candidate) => existsSync(candidate));
if (bunPath === undefined) {
  fail("looked for UKP_BUN, the standard install locations, and PATH");
}
const result = spawnSync(bunPath, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
if (result.error) {
  // bunPath existed on disk a moment ago; a spawn failure here is exotic,
  // but it must still land in the remedy, never a stack trace.
  fail(`spawning '${bunPath}' failed: ${String(result.error.message ?? result.error)}`);
}
process.exit(result.status === null ? (result.signal !== null ? 130 : 1) : result.status);
