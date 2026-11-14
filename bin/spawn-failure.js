// Spawn-failure classification for the launcher (0.4.0 learnability
// review SF-2). bin/ukp.js gates its bun candidate with existsSync, so a
// spawn error there used to read as "exotic" — wrong: a shell left inside
// a directory that then gets moved or renamed makes spawnSync (which gets
// no cwd option and inherits the dangling one) fail ENOENT while bun is
// perfectly fine, and the old funnel taught "install bun" for that shape.
// This module is pure (no top-level side effects) because bin/ukp.js
// itself cannot be imported without launching; purity is what makes the
// classification unit-testable cross-platform. Classification precedes
// disposition, same stance as src/capabilities/rg.ts (the errno code is
// the safe detail) and the pure exported classifiers in
// src/capabilities/remote-client.ts.
import { existsSync } from "node:fs";

/** True when this process still has a reachable working directory. A
 * deleted cwd makes process.cwd() itself throw; a moved/renamed one still
 * returns the old path, which existsSync then rejects. */
function currentCwdReachable() {
  try {
    return existsSync(process.cwd());
  } catch {
    return false;
  }
}

/** Split a spawnSync result.error into the three honest shapes. bunPath is
 * re-checked against the filesystem because the launcher's gate ran before
 * the spawn: a candidate that existed then can be gone now. cwdReachable is
 * injectable so tests can drive the dangling-cwd branch without deleting
 * their own cwd. */
export function classifySpawnFailure(error, bunPath, cwdReachable = currentCwdReachable()) {
  const code = typeof error?.code === "string" ? error.code : undefined;
  if (code === "ENOENT" && !existsSync(bunPath)) {
    return { kind: "exe-vanished", code };
  }
  if (code === "ENOENT" && !cwdReachable) {
    return { kind: "cwd-missing", code };
  }
  return { kind: "start-failed", code };
}

/** stderr text for the kinds the caller prints itself. exe-vanished
 * returns "" — the caller routes it to the existing no-bun fail() instead,
 * whose remedy text is finally the honest direction there. */
export function spawnFailureStderr(kind, bunPath, errnoCode) {
  if (kind === "exe-vanished") return "";
  if (kind === "cwd-missing") {
    return "ukp: bun was found at '" + bunPath + "', but the working directory no\n"
      + "longer exists (moved or renamed?). Change to an existing directory and\n"
      + "rerun ukp from there.\n";
  }
  const detail = errnoCode === undefined || errnoCode === "" ? "spawn error" : errnoCode;
  const eaccesHint = errnoCode === "EACCES"
    ? "Check that the bun executable's execute permission allows this user\n"
      + "to run it.\n"
    : "";
  return "ukp: bun was found at '" + bunPath + "', but it could not start (" + detail + ").\n"
    + eaccesHint;
}
