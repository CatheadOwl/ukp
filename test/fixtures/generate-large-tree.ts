/**
 * Deterministic large-tree fixture generator for the miss-path/scan
 * performance audit (workunits/ukp_uri/TODO/20260909-miss-path-scan-performance-audit.md).
 *
 * Usage: bun run ukp/test/fixtures/generate-large-tree.ts <target-dir> [fileCount] [fanout]
 *
 * Shape: a fanout-4 markdown tree (~fileCount .md files, each with a frontmatter
 * description), plus audit-relevant extras:
 *   - .gitignore at root ignoring `ignored-branch/` (ignore-inheritance path)
 *   - one deep chain (deep/deep/... 12 levels) ending in needle files
 *   - `needle-<i>.md` files scattered for miss/candidate-scan timing
 *   - a `vendor/` subtree with dense non-markdown files (.txt) to pad readdir work
 * Deterministic: same args -> byte-identical tree; safe to regenerate anywhere.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("usage: bun run generate-large-tree.ts <target-dir> [fileCount] [fanout]");
  process.exit(2);
}
const totalFiles = Number(process.argv[3] ?? 50_000);
const fanout = Number(process.argv[4] ?? 4);
const maxFilesPerDir = 25;

if (totalFiles < 100) throw new Error("fileCount must be >= 100 for a meaningful audit fixture");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
writeFileSync(join(target, ".gitignore"), "ignored-branch/\n", "utf8");

let created = 0;
let dirIndex = 0;
const dirQueue: string[] = [target];

function pad(n: number): string {
  return n.toString().padStart(6, "0");
}

// Breadth-first fanout tree until totalFiles is reached.
while (created < totalFiles) {
  const dir = dirQueue.shift();
  if (dir === undefined) break;
  dirIndex += 1;
  // Files in this directory
  for (let f = 0; f < maxFilesPerDir && created < totalFiles; f += 1) {
    created += 1;
    writeFileSync(
      join(dir, `doc-${pad(dirIndex)}-${pad(f)}.md`),
      `---\ndescription: Audit fixture doc ${created} in ${dirIndex}.\n---\n\n# Doc ${created}\n\nbody line\n`,
      "utf8",
    );
  }
  // Needle files for miss/scan timing (every 20th dir)
  if (dirIndex % 20 === 0) {
    writeFileSync(join(dir, `needle-${dirIndex}.md`), `---\ndescription: Needle ${dirIndex}.\n---\n\nneedle body\n`, "utf8");
  }
  // Child dirs
  if (dirQueue.length < 4000) {
    for (let c = 0; c < fanout; c += 1) {
      const child = join(dir, `d${dirIndex}-${c}`);
      mkdirSync(child, { recursive: true });
      dirQueue.push(child);
    }
  }
}

// Deep chain (12 levels) ending in a needle
let deepDir = join(target, "deep");
for (let i = 0; i < 12; i += 1) {
  deepDir = join(deepDir, `level${i}`);
  mkdirSync(deepDir, { recursive: true });
}
writeFileSync(join(deepDir, "deep-needle.md"), "---\ndescription: Deep needle.\n---\n\ndeep body\n", "utf8");

// Ignored branch (gitignore inheritance path)
mkdirSync(join(target, "ignored-branch"), { recursive: true });
writeFileSync(join(target, "ignored-branch", "hidden.md"), "---\ndescription: Ignored.\n---\n\nhidden\n", "utf8");

// Vendor padding: dense non-markdown subtree (readdir work, no .md)
const vendor = join(target, "vendor");
mkdirSync(vendor, { recursive: true });
for (let i = 0; i < 2000; i += 1) {
  writeFileSync(join(vendor, `pkg-${pad(i)}.txt`), `vendor artifact ${i}\n`, "utf8");
}

console.log(`created ${created} md files across ${dirIndex} dirs (+deep chain, ignored-branch, 2000 vendor .txt) at ${target}`);
