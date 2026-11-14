import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// bin/ is launcher-side plain ESM outside the TS program (no declarations
// by design — it ships as-is); the expect-error keeps typecheck honest
// about that boundary while bun runs the module natively.
// @ts-expect-error TS7016: untyped plain-JS module
import { classifySpawnFailure, spawnFailureStderr } from "../bin/spawn-failure.js";

// Classification re-checks bun existence on the real filesystem, so the
// fixtures are real paths: the interpreter binary always exists; the
// vanished shape is a never-created name inside a fresh temp dir.
const existingPath = process.execPath;
const tempDir = mkdtempSync(join(tmpdir(), "ukp-spawn-failure-"));
const vanishedPath = join(tempDir, "vanished-bun");

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("bin/spawn-failure classifySpawnFailure", () => {
  test("ENOENT with the bun still present and the cwd unreachable is cwd-missing", () => {
    expect(existsSync(existingPath)).toBe(true); // fixture honesty
    expect(classifySpawnFailure({ code: "ENOENT" }, existingPath, false).kind).toBe("cwd-missing");
  });

  test("ENOENT with the bun gone is exe-vanished (the no-bun remedy is then true)", () => {
    expect(existsSync(vanishedPath)).toBe(false); // fixture honesty
    expect(classifySpawnFailure({ code: "ENOENT" }, vanishedPath, true).kind).toBe("exe-vanished");
  });

  test("ENOENT with the bun present and the cwd reachable is start-failed (cause unknown)", () => {
    const failure = classifySpawnFailure({ code: "ENOENT" }, existingPath, true);
    expect(failure.kind).toBe("start-failed");
    expect(failure.code).toBe("ENOENT");
  });

  test("EACCES is start-failed carrying the errno code", () => {
    const failure = classifySpawnFailure({ code: "EACCES" }, existingPath, true);
    expect(failure.kind).toBe("start-failed");
    expect(failure.code).toBe("EACCES");
  });

  test("a codeless error falls to start-failed without a code", () => {
    const failure = classifySpawnFailure({}, existingPath, true);
    expect(failure.kind).toBe("start-failed");
    expect(failure.code).toBeUndefined();
  });

  test("the default cwd probe reads the real process cwd (reachable in a test run)", () => {
    expect(classifySpawnFailure({ code: "ENOENT" }, existingPath).kind).toBe("start-failed");
  });
});

describe("bin/spawn-failure spawnFailureStderr", () => {
  test("cwd-missing names the bun path and the directory remedy, never the no-bun remedy", () => {
    const text = spawnFailureStderr("cwd-missing", existingPath, "ENOENT");
    expect(text).toContain(existingPath);
    expect(text).toContain("working directory");
    expect(text).not.toContain("no bun executable found");
    expect(text).not.toContain("bun.sh");
  });

  test("cwd-missing carries the missing directory path when the caller can read it (F5)", () => {
    const text = spawnFailureStderr("cwd-missing", existingPath, "ENOENT", "D:/moved/notes");
    expect(text).toContain("working directory 'D:/moved/notes'");
    expect(text).toContain("moved or renamed");
  });

  test("cwd-missing without a readable cwd still renders the remedy (no empty quotes)", () => {
    const text = spawnFailureStderr("cwd-missing", existingPath, "ENOENT", undefined);
    expect(text).toContain("the working directory");
    expect(text).not.toContain("working directory ''");
  });

  test("start-failed keeps the errno code as the safe detail; only EACCES adds the permission clause", () => {
    const eacces = spawnFailureStderr("start-failed", existingPath, "EACCES");
    expect(eacces).toContain(existingPath);
    expect(eacces).toContain("could not start (EACCES)");
    expect(eacces).toContain("execute permission");
    const eagain = spawnFailureStderr("start-failed", existingPath, "EAGAIN");
    expect(eagain).toContain("could not start (EAGAIN)");
    expect(eagain).not.toContain("execute permission");
    expect(eagain).not.toContain("no bun executable found");
  });

  test("a codeless start failure renders the generic spawn-error detail", () => {
    expect(spawnFailureStderr("start-failed", existingPath, undefined)).toContain(
      "could not start (spawn error)",
    );
  });

  test("exe-vanished renders nothing; the caller routes it to the no-bun fail()", () => {
    expect(spawnFailureStderr("exe-vanished", existingPath, "ENOENT")).toBe("");
  });
});
