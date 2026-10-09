#!/usr/bin/env bun
// pack-audit —— 嵌套发布面 gate（AGENTS.md「ukp/ 是唯一发布面」硬边界的机械执法面）。
//
// 断言两件事：
//   A. manifest：ukp/package.json 的 scripts / files 无包外路径（../ 段、绝对路径、
//      盘符）且无 meta 层条目（hooks/ bunfig test/ .coggit TODO workunits cognition
//      board scripts/ 本身）；
//   B. tarball 模拟：npm pack --dry-run --json 的实际文件清单 ⊆ files 白名单展开
//      ∪ npm 标配（package.json），且逐条不命中 meta deny-list。
// 内层 dry-run 带 --ignore-scripts：prepack 本身是 lifecycle script，不带会无限递归。
// 内容级扫描（发布文件文本里的 meta 引用 grep）不在此——那是发布前手动审计
// （2026-10-09 首轮证据见 hooks/README.md 嵌套发布面一节）。
//
// 触发：npm pack / npm publish 经 package.json "prepack" 自动跑；手动：
//   cd ukp && bun scripts/pack-audit.mjs
// 退出码 0 = 通过（一行摘要），1 = 有违规（逐条 VIOLATION）。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const violations = [];

// meta 层 deny-list：这些名字出现在 files 条目或 tarball 清单里即违规
const META = [
  "hooks/", "bunfig", "test/", ".coggit", "TODO", "workunits/", "cognition", "board/",
  "scripts/", "AGENTS.md", "CLAUDE.md",
];
const metaHit = (p) => META.some((m) => p === m || p === m.slice(0, -1) || p.startsWith(m));
const outOfPkg = (p) => p.includes("../") || p.startsWith("/") || /^[a-z]:/i.test(p);

// A. manifest 面（scripts 只查包外路径——值是命令不是路径，meta 名词如 bun test
//    子命令不是泄露信号；files 条目两者都查）
for (const [key, value] of Object.entries(manifest.scripts ?? {})) {
  if (outOfPkg(value)) violations.push(`manifest scripts.${key} references outside the package: ${value}`);
}
for (const entry of manifest.files ?? []) {
  if (outOfPkg(entry)) violations.push(`manifest files entry leaves the package: ${entry}`);
  if (metaHit(entry)) violations.push(`manifest files entry is meta layer: ${entry}`);
}

// B. tarball 模拟面（--ignore-scripts 防递归）
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = spawnSync(npmBin, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: pkgDir,
  encoding: "utf8",
});
if (packed.status !== 0) {
  console.error("pack-audit: npm pack --dry-run failed");
  console.error(packed.stderr);
  process.exit(1);
}
const jsonText = packed.stdout.slice(packed.stdout.indexOf("["), packed.stdout.lastIndexOf("]") + 1);
let packedFiles = [];
try {
  packedFiles = JSON.parse(jsonText).flatMap((block) => (block.files ?? []).map((f) => f.path));
} catch {
  violations.push("could not parse npm pack --json output");
}

const allowed = (p) =>
  p === "package.json" ||
  (manifest.files ?? []).includes(p) ||
  (manifest.files ?? []).some((entry) => p.startsWith(entry + "/"));

for (const path of packedFiles) {
  const rel = path.replace(/^package\//, "");
  if (metaHit(rel)) violations.push(`tarball contains meta-layer file: ${rel}`);
  else if (!allowed(rel)) violations.push(`tarball file outside the files whitelist: ${rel}`);
}

for (const v of violations) console.error(`VIOLATION pack-audit: ${v}`);
if (violations.length > 0) {
  console.error(`\npack-audit: ${violations.length} violation(s) — publish face NOT clean, FAILED`);
  process.exit(1);
}
console.log(`pack-audit: ${packedFiles.length} files, 0 violations — publish face clean`);
