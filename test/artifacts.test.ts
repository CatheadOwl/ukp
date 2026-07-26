import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createArtifactRun } from "../src/artifacts.ts";

describe("artifact retention", () => {
  test("best-effort removes completed run directories older than seven days", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-artifacts-"));
    const oldRun = join(root, "old-run");
    mkdirSync(oldRun);
    const now = new Date("2026-07-26T12:00:00Z");
    const old = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(oldRun, old, old);
    try {
      const run = createArtifactRun({ root, runId: "new-run", now });
      expect(existsSync(oldRun)).toBe(false);
      expect(existsSync(run.directory)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
