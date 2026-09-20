import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildEvalWorld, git, gitCommitAll } from "../harness/scenario.ts";

/**
 * Scenario family: recovery-chain (ukp_evals W1, adjudication E-4).
 *
 * Task artifact: a git-tracked Service whose document is renamed in history.
 * Consumer: a stranger holding a stale `ukp://` reference plus the ukp-pin
 * that was printed next to it when the reference was fresh. Verifier: the
 * stale reference still reads the moved content (exit 0, recovery echo on
 * stderr), the printed pin equals an independently computed LF-normalized
 * sha256, pin verification passes through recovery, and an unrecoverable
 * reference classifies as resource-missing instead of pretending.
 */

const NOTE_BODY = "one\ntwo\nthree\nfour\n";
const NOTE_PIN = `sha256-${createHash("sha256").update(NOTE_BODY, "utf8").digest("hex")}`;

const world = buildEvalWorld("recovery-chain");

const serviceFolder = (() => {
  const folder = join(mkdtempSync(join(tmpdir(), "ukp-evals-recovery-svc-")), "");
  mkdirSync(join(folder, ".ukp"), { recursive: true });
  mkdirSync(join(folder, "docs"), { recursive: true });
  writeFileSync(
    join(folder, ".ukp", "service.toml"),
    'name = "recovery-eval"\n\n[capabilities.nav]\n',
    "utf8",
  );
  writeFileSync(join(folder, "docs", "note.md"), NOTE_BODY, "utf8");
  git(folder, "init");
  gitCommitAll(folder, "seed");
  return folder;
})();

describe("scenario: recovery-chain (stale ukp:// → recovery → pin)", () => {
  test(
    "registration succeeds while the reference is still fresh",
    () => {
      const registered = world.runUkp(["register"], { cwd: serviceFolder });
      expect(registered.exitCode).toBe(0);

      const fresh = world.runUkp(["read", "ukp://recovery-eval/docs/note.md"]);
      expect(fresh.exitCode).toBe(0);
      expect(fresh.stdout).toContain("three");
    },
    60_000,
  );

  test(
    "a renamed document: the stale uri recovers with an echo naming the move",
    () => {
      git(serviceFolder, "mv", "docs/note.md", "docs/renamed.md");
      gitCommitAll(serviceFolder, "rename");

      const recovered = world.runUkp(["read", "ukp://recovery-eval/docs/note.md"]);
      expect(recovered.exitCode).toBe(0);
      expect(recovered.stdout).toContain("three");
      expect(recovered.stderr).toMatch(
        /^ukp read: recovered: '.*note\.md' moved to '.*renamed\.md' \(git history/m,
      );
    },
    60_000,
  );

  test(
    "--show-pin prints an independently verifiable whole-file pin",
    () => {
      const pinned = world.runUkp([
        "read",
        "ukp://recovery-eval/docs/renamed.md",
        "--show-pin",
      ]);
      expect(pinned.exitCode).toBe(0);
      const pinLine = pinned.stderr.match(/pin: <!-- ukp-pin: (sha256-[0-9a-f]{64}) -->/);
      expect(pinLine).not.toBeNull();
      expect(pinLine![1]).toBe(NOTE_PIN);
    },
    60_000,
  );

  test(
    "the pin carried next to the stale reference verifies through recovery",
    () => {
      const verified = world.runUkp([
        "read",
        "ukp://recovery-eval/docs/note.md",
        "--pin",
        NOTE_PIN,
      ]);
      expect(verified.exitCode).toBe(0);
      expect(verified.stdout).toContain("three");
      expect(verified.stderr).not.toContain("content changed after move");
      expect(verified.stderr).not.toContain("recovered without verification");
    },
    60_000,
  );

  test(
    "an unrecoverable reference classifies as resource-missing, exit 1",
    () => {
      const missing = world.runUkp(["read", "ukp://recovery-eval/docs/never-existed.md"]);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain("resource-missing");
    },
    60_000,
  );
});
