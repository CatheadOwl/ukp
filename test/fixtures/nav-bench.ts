/**
 * Nav scan benchmark (G2 regression tooling, ADR 0018 lineage): times runNav
 * against a service folder at depths 0 and 2, reporting per-run wall time,
 * entry count and diagnostic count. Pairs with generate-large-tree.ts for
 * synthetic corpora; point it at a copied real corpus for realistic mixes.
 *
 * Usage: bun run ukp/test/fixtures/nav-bench.ts <service-folder> [name] [runs]
 *
 * Registers the folder as a temp-registry endpoint (writes .ukp/service.toml
 * into it when absent) — point it at fixtures and copies, never at live repo
 * directories.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runNav } from "../../src/capabilities/nav.ts";
import { registerAt } from "../../src/registry.ts";

const folder = process.argv[2];
if (!folder) {
  console.error("usage: bun run ukp/test/fixtures/nav-bench.ts <service-folder> [name] [runs]");
  process.exit(2);
}
const name = process.argv[3] ?? "bench";
const runs = Number(process.argv[4] ?? 3);

mkdirSync(join(folder, ".ukp"), { recursive: true });
const manifestPath = join(folder, ".ukp", "service.toml");
if (!existsSync(manifestPath)) {
  writeFileSync(manifestPath, `name = "${name}"\n\n[capabilities]\n`, "utf8");
}
const root = mkdtempSync(join(tmpdir(), "ukp-navbench-"));
const registryPath = join(root, "registry.toml");
registerAt(registryPath, name, folder);
const context = { currentDirectory: root, registryPath };

console.log(`bench ${name}: folder=${folder} runs=${runs}`);
for (const depth of [0, 2] as const) {
  const times: number[] = [];
  let entries = -1;
  let diagnostics = -1;
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    const outcome = await runNav({ endpoint: name, depth, json: true }, context);
    const elapsed = performance.now() - start;
    if (!outcome.ok) throw new Error(outcome.failure.message);
    times.push(elapsed);
    entries = outcome.result.routeCount;
    diagnostics = outcome.result.diagnostics.length;
  }
  console.log(
    `depth ${depth}: ${times.map((t) => t.toFixed(0)).join("/")}ms (entries ${entries}, diagnostics ${diagnostics})`,
  );
}
