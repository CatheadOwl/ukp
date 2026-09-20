import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Release-face boundary guard: nothing in the published `ukp/` tree may
 * reference private meta material (the feedback workbench, internal
 * work-unit folders, the private docs tree, or private absolute paths).
 * The public repository ships this whole subtree; a stranger reading any
 * file here must never be sent somewhere that does not exist for them.
 *
 * Policy exceptions, explicit and dated:
 * - `CHANGELOG.md` released version sections are published history and are
 *   never rewritten; the rule applies to future entries (release review
 *   checks the Unreleased section).
 * - The allowlist is empty and capped: no new offender may join it.
 */

const UKP_ROOT = join(import.meta.dir, "..", "..");

const ALLOWLIST: { file: string; contains: string }[] = [];

const PRIVATE_REFERENCE_PATTERN =
  /agent-eval|unit-docs|surface-units|workunits\/|product\/(status|index|specs)|docs\/(spec|adr|prd|archive|release)\/|D:\\+Document|D:\/+Document/i;

function listTextFiles(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === ".cache" || name === "bun.lock") continue;
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      entries.push(...listTextFiles(full));
    } else if (/\.(ts|mjs|js|md|txt|json|toml)$/.test(name)) {
      entries.push(full);
    }
  }
  return entries;
}

function isAllowlisted(file: string, line: string): boolean {
  return ALLOWLIST.some((entry) => file.endsWith(entry.file) && line.includes(entry.contains));
}

describe("release-face boundary (no private meta references)", () => {
  test("no file in the published tree points at private material", () => {
    // The guard file itself carries the pattern strings — it guards, it does
    // not apply to itself.
    const files = listTextFiles(UKP_ROOT).filter(
      (file) => !file.endsWith(join("CHANGELOG.md")) && !file.endsWith("release-face-guard.test.ts"),
    );
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (PRIVATE_REFERENCE_PATTERN.test(line) && !isAllowlisted(file, line)) {
          offenders.push(`${file.replace(UKP_ROOT, "")}:${index + 1}: ${line.trim().slice(0, 90)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
