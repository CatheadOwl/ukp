import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";

/** W13 / RQ-16c: the `src/plumbing/` subtree is a purity-tested, zero-UKP-
 * import layer (the internal boundary that keeps a future extraction to a
 * second package mechanical — the package split itself stays gated on a
 * second consumer appearing). This test IS the enforcement: every import
 * specifier in every file under the subtree must be either a `node:` builtin
 * or a relative import that stays inside the subtree. A bare package
 * specifier (npm dependency) or a `../`-escape into UKP code fails here. */
const PLUMBING_DIR = join(import.meta.dir, "..", "src", "plumbing");

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listSourceFiles(path) : [path];
  });
}

/** All static and dynamic import forms used in this codebase. New syntax
 * forms are expected to fail this scan (add them here consciously). */
const IMPORT_SPECIFIER_PATTERNS = [
  /(?:^|\n)[ \t]*import\s[^;\n]*?from\s*["']([^"']+)["']/g,
  /(?:^|\n)[ \t]*export\s[^;\n]*?from\s*["']([^"']+)["']/g,
  /(?:^|\n)[ \t]*import\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function importSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      specifiers.push(match[1]!);
      match = pattern.exec(text);
    }
  }
  return specifiers;
}

describe("plumbing purity (W13: zero-UKP-import subtree)", () => {
  test("the subtree exists and is scanned (guards a silent directory move)", () => {
    const files = listSourceFiles(PLUMBING_DIR).filter((path) => path.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
  });

  test("every import is node: builtin or subtree-relative", () => {
    const files = listSourceFiles(PLUMBING_DIR).filter((path) => path.endsWith(".ts"));
    const violations: string[] = [];
    for (const file of files) {
      const where = relative(join(PLUMBING_DIR, ".."), file);
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (specifier.startsWith("node:")) continue;
        if (specifier.startsWith(".")) {
          const resolved = normalize(join(file, "..", specifier));
          const rel = relative(PLUMBING_DIR, resolved);
          const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
          if (!inside) {
            violations.push(`${where}: '${specifier}' escapes the plumbing subtree`);
          }
          continue;
        }
        violations.push(`${where}: '${specifier}' is not a node: builtin or relative import`);
      }
    }
    expect(violations).toEqual([]);
  });
});
