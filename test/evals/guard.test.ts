import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Black-box boundary guard (adjudication E-2): nothing under test/evals/ may
 * import from src/. The eval layer's whole reason to exist next to test/ and
 * test/e2e/ is that it drives the CLI only through its published surface —
 * a spawned process and its observable output. Importing implementation
 * details would collapse it into another integration suite.
 */

const EVALS_DIR = import.meta.dir;

function listTsFiles(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      entries.push(...listTsFiles(full));
    } else if (name.endsWith(".ts")) {
      entries.push(full);
    }
  }
  return entries;
}

const SRC_IMPORT_PATTERN = /(?:from\s+|import\s*\(\s*)["'][^"']*\/src\/[^"']*["']/;

describe("evals black-box boundary (E-2)", () => {
  test("no file under test/evals/ imports from src/", () => {
    const files = listTsFiles(EVALS_DIR);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((file) => SRC_IMPORT_PATTERN.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => `scenario imports implementation: ${file}`)).toEqual([]);
  });
});
