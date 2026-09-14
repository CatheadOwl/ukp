import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ADR 0021 capability-contract guard: capabilities return structured
// outcomes — never `stdout`/`stderr`/`exitCode` returns, never CLI argument
// parsing. New capabilities must land in MIGRATED shape from day one;
// providers of not-yet-migrated files are held in PENDING until their
// Phase-1-style refactor, then moved over here (never deleted silently).

const capabilitiesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "capabilities");

/** Files already holding the ADR 0021 contract. */
const MIGRATED = new Set(["nav.ts", "qmd.ts", "remote-client.ts", "rename-recovery.ts", "search.ts", "read.ts", "update.ts", "propose.ts", "rg.ts"]);

/** Files still carrying CLI-shaped returns; remove an entry here and add it
 * to MIGRATED in the same change that migrates it. The set is empty — every
 * capability holds the contract; new capabilities must land in MIGRATED
 * shape from day one. */
const PENDING = new Set<string>([]);

// A CLI-shaped return constructs `stdout:` / `stderr:` / `exitCode:` object
// members. Word-boundary + colon keeps comments, provider spawnSync results
// (`result.stdout` reads), and `stdio:`/`stdoutFd` identifiers out of scope;
// the `"ignore"` negative lookahead keeps Bun.spawn stdio config
// (`stdout: "ignore"`) out of scope — that is process plumbing, not a
// CLI-shaped return.
const CLI_SHAPED_RETURN = /\b(exitCode|stdout|stderr)\s*:(?!\s*"ignore")/;
const COMMANDER_IMPORT = /from\s+["']commander["']/;

function capabilityFiles(): string[] {
  return readdirSync(capabilitiesDir).filter((name) => name.endsWith(".ts"));
}

describe("capability contract guard (ADR 0021)", () => {
  test("every capability file is classified as MIGRATED or PENDING", () => {
    const files = capabilityFiles();
    const classified = new Set([...MIGRATED, ...PENDING]);
    const unclassified = files.filter((name) => !classified.has(name));
    expect(
      unclassified,
      `new capability files must hold the ADR 0021 structured-outcome contract from day one `
      + `(add to MIGRATED when conforming, or to PENDING only as an explicitly tracked migration debt): ${unclassified.join(", ")}`,
    ).toEqual([]);
    const missing = [...classified].filter((name) => !files.includes(name));
    expect(missing, `classified files that no longer exist must be removed from the sets: ${missing.join(", ")}`).toEqual([]);
  });

  test("MIGRATED capabilities hold the structured-outcome contract", () => {
    for (const name of MIGRATED) {
      const source = readFileSync(join(capabilitiesDir, name), "utf8");
      expect(COMMANDER_IMPORT.test(source), `${name} must not import a CLI argument parser`).toBe(false);
      expect(CLI_SHAPED_RETURN.test(source), `${name} must not construct stdout/stderr/exitCode returns`).toBe(false);
    }
  });

  test("PENDING capabilities still carry CLI-shaped debt (move to MIGRATED on migration)", () => {
    for (const name of PENDING) {
      const source = readFileSync(join(capabilitiesDir, name), "utf8");
      const stillDebted = CLI_SHAPED_RETURN.test(source) || COMMANDER_IMPORT.test(source);
      expect(
        stillDebted,
        `${name} no longer violates the contract — move it from PENDING to MIGRATED in the same change`,
      ).toBe(true);
    }
  });
});
