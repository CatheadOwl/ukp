import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  capabilitySchema,
  dependencyKindSchema,
  dependencySchema,
  loadManifest,
  manifestSchema,
} from "../src/config/manifest.ts";

/** The published manifest reference (skills/ukp/reference/manifest.md) is
 * the normative declaration grammar; the zod schema in src/config/manifest.ts
 * is the machine truth. This anchor test keeps the two from drifting apart:
 * the doc's machine-readable key block must equal the schema's shape, and
 * every ```toml example in the doc must load through the real loader.
 * When a schema key changes without the doc (or vice versa), this goes red. */
const referencePath = join(import.meta.dir, "..", "skills", "ukp", "reference", "manifest.md");
const reference = readFileSync(referencePath, "utf8");

function schemaKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape).sort();
}

function docKeySets(): Map<string, string[]> {
  const textBlocks = [...reference.matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const anchorBlock = textBlocks.find((block) => block.includes("manifest-keys:"));
  if (!anchorBlock) throw new Error("reference doc lacks the machine-readable key block");
  const sets = new Map<string, string[]>();
  for (const line of anchorBlock.split("\n")) {
    const [label, keys] = line.split(":");
    if (!label || !keys) continue;
    sets.set(label.trim(), keys.trim().split(/\s+/).sort());
  }
  return sets;
}

describe("manifest reference anchor: the published doc equals the schema", () => {
  test("the doc's key block matches the zod schema shapes", () => {
    const docSets = docKeySets();
    expect(docSets.get("manifest-keys")).toEqual(schemaKeys(manifestSchema));
    expect(docSets.get("capability-keys")).toEqual(schemaKeys(capabilitySchema));
    expect(docSets.get("dependency-keys")).toEqual(schemaKeys(dependencySchema));
    expect(docSets.get("dependency-kinds")).toEqual([...dependencyKindSchema.options].sort());
  });

  test("every toml example in the doc loads through the real manifest loader", () => {
    const examples = [...reference.matchAll(/```toml\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(examples.length).toBeGreaterThanOrEqual(3);
    const root = mkdtempSync(join(tmpdir(), "ukp-manifest-ref-"));
    try {
      examples.forEach((toml, index) => {
        const folder = join(root, `example-${index}`);
        mkdirSync(join(folder, ".ukp"), { recursive: true });
        writeFileSync(join(folder, ".ukp", "service.toml"), toml, "utf8");
        // Throws (and fails the test) on any grammar the loader rejects —
        // the doc must never teach a shape the strict schema refuses.
        expect(() => loadManifest(folder)).not.toThrow();
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
