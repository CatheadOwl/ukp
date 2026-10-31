import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  NAV_DEFAULT_DEPTH,
  NAV_MAX_DEPTH,
  type NavContext,
  type NavRequest,
} from "../src/capabilities/nav.ts";
import { executeNavCommand as executeNavCommandMaybeAsync, parseNavArgs, renderNavHelp, type NavCommandResult } from "../src/commands/nav.ts";
import { NavUsageError } from "../src/capabilities/nav.ts";
// Parse-layer usage errors surface as kit usage errors since the ADR 0024
// migration; the capability's NavUsageError remains for the re-validation
// path inside runNav.
import { KitUsageError } from "../src/commands/kit.ts";
import { loadManifest } from "../src/config/manifest.ts";
import { registerAt } from "../src/registry.ts";

// Since the scan-engine delegation (2026-10-22) local nav shares the remote
// branch's async contract: runNav drives an in-flight read window. This
// wrapper keeps the call sites uniform.
async function executeNavCommand(
  args: readonly string[],
  context: NavContext,
): Promise<NavCommandResult> {
  return await executeNavCommandMaybeAsync(args, context);
}

function createNavService(root: string, name: string, provider = "file"): string {
  const folder = join(root, `${name}-service`);
  mkdirSync(join(folder, ".ukp"), { recursive: true });
  writeFileSync(
    join(folder, ".ukp", "service.toml"),
    `name = "${name}"\n[capabilities.nav]\nprovider = "${provider}"\n`,
  );
  return folder;
}

interface FileSpec {
  path: string;
  description?: string;
  /** Raw content overrides the description-derived template. */
  content?: string;
}

/** Writes files under `folder` from slash-separated specs. */
function writeFiles(folder: string, files: readonly FileSpec[]): void {
  for (const file of files) {
    const target = join(folder, ...file.path.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    const content = file.content !== undefined
      ? file.content
      : file.description === undefined
        ? `# ${file.path}\n`
        : `---\ndescription: ${file.description}\n---\n# ${file.path}\n`;
    writeFileSync(target, content);
  }
}

function setup(root: string, files: readonly FileSpec[], name = "kb"): NavContext {
  const service = createNavService(root, name);
  writeFiles(service, files);
  const registryPath = join(root, "registry.toml");
  registerAt(registryPath, name, service);
  return { currentDirectory: root, registryPath };
}

/** Runs nav through the CLI adapter with --json and parses the envelope. */
async function navJson(request: Omit<NavRequest, "json">, context: NavContext) {
  const args = [
    "--endpoint", request.endpoint,
    ...(request.path === undefined ? [] : [request.path]),
    ...(request.depth === undefined ? [] : ["--depth", String(request.depth)]),
    "--json",
  ];
  const result = await executeNavCommand(args, context);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout);
}

describe("nav capability", () => {
  test("depth 0 lists root markdown files and truncated folders with recursive counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const context = setup(root, [
        { path: "README.md", description: "Root knowledge base" },
        { path: "docs/guide.md" },
        { path: "docs/notes/a.md" },
        { path: "docs/notes/b.md" },
        { path: "empty/none.txt" },
      ]);
      const parsed = await navJson({ endpoint: "kb" }, context);
      expect(parsed.root).toBe(".");
      expect(parsed.depth).toBe(0);
      expect(parsed.entries).toEqual([
        { path: "docs", kind: "folder", description: null, truncated: true, omittedMarkdownCount: 3 },
        { path: "README.md", kind: "file", description: "Root knowledge base" },
      ]);
      expect(parsed.routeCount).toBe(2);
      expect(parsed.diagnostics).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("depth 1 expands one level; deeper folders truncate", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const context = setup(root, [
        { path: "docs/guide.md", description: "The guide" },
        { path: "docs/notes/a.md" },
        { path: "docs/notes/b.md" },
      ]);
      const parsed = await navJson({ endpoint: "kb", depth: 1 }, context);
      expect(parsed.entries).toEqual([
        { path: "docs/guide.md", kind: "file", description: "The guide" },
        { path: "docs/notes", kind: "folder", description: null, truncated: true, omittedMarkdownCount: 2 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("path selects a sub-root; counts are independent of the observing root", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const context = setup(root, [
        { path: "docs/README.md", description: "Documentation area" },
        { path: "docs/guide.md" },
        { path: "docs/deep/x.md" },
        { path: "outside.md" },
      ]);
      const parsed = await navJson({ endpoint: "kb", path: "docs" }, context);
      expect(parsed.root).toBe("docs");
      expect(parsed.entries).toEqual([
        { path: "docs/deep", kind: "folder", description: null, truncated: true, omittedMarkdownCount: 1 },
        { path: "docs/guide.md", kind: "file", description: null },
        { path: "docs/README.md", kind: "file", description: "Documentation area" },
      ]);
      // observed from the endpoint root the same subtree counts identically
      const whole = await navJson({ endpoint: "kb" }, context);
      expect(whole.entries.find((entry: { path: string }) => entry.path === "docs").omittedMarkdownCount).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("truncated folder keeps its README description on the route line", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const context = setup(root, [
        { path: "area/README.md", description: "The area" },
        { path: "area/a.md" },
      ]);
      const parsed = await navJson({ endpoint: "kb" }, context);
      expect(parsed.entries).toEqual([
        { path: "area", kind: "folder", description: "The area", truncated: true, omittedMarkdownCount: 2, markdown: "area/README.md" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("R3 description chain: head description line and first substantive line are picked up", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const context = setup(root, [
        {
          path: "head.md",
          // No description in frontmatter; the body head carries an explicit
          // `description:` line — the chain's second rung (engine-adopted).
          content: "---\ntitle: Head\n---\ndescription: Head-line description\n\n# Head\n",
        },
        {
          path: "firstline.md",
          // No frontmatter at all; the first substantive line is long enough.
          content: "This line is long enough to serve as the first substantive summary.\n\n# Later\n",
        },
      ]);
      const parsed = await navJson({ endpoint: "kb" }, context);
      const byPath = new Map(parsed.entries.map((entry: { path: string; description: string | null }) => [entry.path, entry.description]));
      expect(byPath.get("head.md")).toBe("Head-line description");
      expect(byPath.get("firstline.md")).toBe("This line is long enough to serve as the first substantive summary.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("R3 folder description chain: standardized carriers — package.json wins over README; the retired _category_ sidecar no longer shadows (any-nav DEC-0025)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const service = createNavService(root, "kb");
      writeFiles(service, [
        { path: "area/README.md", description: "The README description" },
        { path: "area/a.md" },
      ]);
      writeFileSync(join(service, "area", "package.json"), JSON.stringify({ description: "The npm description" }));
      writeFileSync(join(service, "area", "_category_.yml"), "description: Sidecar area blurb\n");
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", service);
      const parsed = await navJson({ endpoint: "kb" }, { currentDirectory: root, registryPath });
      expect(parsed.entries).toEqual([
        { path: "area", kind: "folder", description: "The npm description", truncated: true, omittedMarkdownCount: 2, markdown: "area/README.md" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("R3 markdown locator: truncated folder entries surface the representative README path (additive, engine model field)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const service = createNavService(root, "kb");
      writeFiles(service, [
        { path: "area/README.md", description: "The README description" },
        { path: "area/a.md" },
        { path: "top.md" },
      ]);
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", service);
      const parsed = await navJson({ endpoint: "kb" }, { currentDirectory: root, registryPath });
      const area = parsed.entries.find((entry: { path: string }) => entry.path === "area");
      expect(area.markdown).toBe("area/README.md");
      // File entries are their own read target — the locator is folder-only.
      expect(parsed.entries.find((entry: { path: string }) => entry.path === "top.md")?.markdown).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("R3 markdown locator: absent when the representative README is excluded — the engine field stays missing, never derived", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const folder = join(root, "kb-service");
      mkdirSync(join(folder, ".ukp"), { recursive: true });
      writeFileSync(
        join(folder, ".ukp", "service.toml"),
        [
          'name = "kb"',
          "[capabilities.nav]",
          'provider = "file"',
          "[capabilities.nav.config]",
          'exclude_files = ["README.md"]',
        ].join("\n") + "\n",
      );
      writeFiles(folder, [
        { path: "area/README.md", description: "The README description" },
        { path: "area/a.md" },
      ]);
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", folder);
      const parsed = await navJson({ endpoint: "kb" }, { currentDirectory: root, registryPath });
      expect(parsed.entries).toEqual([
        { path: "area", kind: "folder", description: null, truncated: true, omittedMarkdownCount: 1 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("E1 audience triage: descriptionless files keep null; maintainer findings ride human stderr only", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const context = setup(root, [{ path: "bare.md" }]);
      const parsed = await navJson({ endpoint: "kb" }, context);
      // The ukp.nav.v1 contract keeps description: null (engine placeholder
      // text is mapped back), and the no-description finding never enters
      // the envelope — maintainer audience, human stderr only (E1).
      expect(parsed.entries).toEqual([{ path: "bare.md", kind: "file", description: null }]);
      expect(parsed.diagnostics).toEqual([]);

      const human = await executeNavCommand(["--endpoint", "kb"], context);
      expect(human.exitCode).toBe(0);
      expect(human.stderr).toContain("no-description");
      const json = await executeNavCommand(["--endpoint", "kb", "--json"], context);
      expect(json.stderr).not.toContain("no-description");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bare [capabilities.nav] declaration defaults to the file provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const folder = join(root, "kb-service");
      mkdirSync(join(folder, ".ukp"), { recursive: true });
      writeFileSync(join(folder, ".ukp", "service.toml"), 'name = "kb"\n[capabilities.nav]\n');
      writeFileSync(join(folder, "a.md"), "# a\n");
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", folder);
      const parsed = await navJson({ endpoint: "kb" }, { currentDirectory: root, registryPath });
      expect(parsed.entries).toEqual([{ path: "a.md", kind: "file", description: null }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(".gitignore rules hide files, directories, and their truncated counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const service = createNavService(root, "kb");
      writeFiles(service, [
        { path: "keep.md" },
        { path: "drop.md" },
        { path: "secret/hidden.md" },
        { path: "secret/also-hidden.md" },
      ]);
      writeFileSync(join(service, ".gitignore"), "drop.md\nsecret/\n");
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", service);
      const parsed = await navJson({ endpoint: "kb" }, { currentDirectory: root, registryPath });
      expect(parsed.entries).toEqual([{ path: "keep.md", kind: "file", description: null }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(".gitignore negation re-includes; deeper .gitignore overrides shallower", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const service = createNavService(root, "kb");
      writeFiles(service, [
        { path: "area/keep.md" },
        { path: "area/drop-nested.md" },
        { path: "area/reinstated.md" },
      ]);
      writeFileSync(join(service, ".gitignore"), "area/*.md\n!area/reinstated.md\n");
      writeFileSync(join(service, "area", ".gitignore"), "!keep.md\ndrop-nested.md\n");
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", service);
      const parsed = await navJson({ endpoint: "kb" }, { currentDirectory: root, registryPath });
      // root: area/*.md ignored except reinstated; deeper file: keep re-included, drop-nested ignored
      expect(parsed.entries).toEqual([
        { path: "area", kind: "folder", description: null, truncated: true, omittedMarkdownCount: 2 },
      ]);
      const deep = await navJson({ endpoint: "kb", path: "area" }, { currentDirectory: root, registryPath });
      expect(deep.entries).toEqual([
        { path: "area/keep.md", kind: "file", description: null },
        { path: "area/reinstated.md", kind: "file", description: null },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("double-star patterns hide nested files and subtrees at any depth", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const service = createNavService(root, "kb");
      writeFiles(service, [
        { path: "keep.md" },
        { path: "tmp.md" },
        { path: "area/tmp.md" },
        { path: "area/deep/tmp.md" },
        { path: "area/keep-deep.md" },
        { path: "logs/2026/a.md" },
        { path: "logs/2026/06/b.md" },
        { path: "x/y/b.md" },
      ]);
      writeFileSync(join(service, ".gitignore"), "**/tmp.md\nlogs/**\nx/**/b.md\n");
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", service);
      const parsed = await navJson({ endpoint: "kb", depth: 5 }, { currentDirectory: root, registryPath });
      // Engine `**` semantics are git-native since the pathscope facade
      // (ADR 0029): `**` matches zero or more directories, so `**/tmp.md`
      // hides the ROOT-level tmp.md too — the 0.1.0 "one or more dirs"
      // deviation is retired (DEC-0023 case-absorption set, git oracle).
      expect(parsed.entries.map((entry: { path: string }) => entry.path)).toEqual([
        "area/keep-deep.md",
        "keep.md",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gitignore matching is case-insensitive (engine matcher semantics, ADR 0029)", async () => {
    // Two fixtures on separate roots: one tree cannot carry both `Build/`
    // and `build/` on a case-insensitive Windows filesystem.
    const exactRoot = mkdtempSync(join(tmpdir(), "ukp-nav-case-exact-"));
    const divergentRoot = mkdtempSync(join(tmpdir(), "ukp-nav-case-div-"));
    try {
      const writeFixture = (root: string) => {
        const service = createNavService(root, "kb");
        writeFiles(service, [
          { path: "keep.md" },
          { path: "Build/artifact.md" },
        ]);
        const registryPath = join(root, "registry.toml");
        registerAt(registryPath, "kb", service);
        return { service, registryPath };
      };
      // Exact-case rule hides the directory.
      const exact = writeFixture(exactRoot);
      writeFileSync(join(exact.service, ".gitignore"), "Build/\n");
      const exactParsed = await navJson({ endpoint: "kb", depth: 3 }, { currentDirectory: exactRoot, registryPath: exact.registryPath });
      expect(exactParsed.entries.map((entry: { path: string }) => entry.path)).toEqual(["keep.md"]);
      // Case-divergent rule hides it too: the facade chain's matcher
      // (node-ignore v7, via @catheadowl/pathscope) is case-insensitive —
      // the 0.1.0 case-sensitive stance is retired. On Windows this aligns
      // nav with the platform git default (core.ignorecase=true), closing
      // the old bilateral ask #3 nav/git split in the insensitive direction.
      const divergent = writeFixture(divergentRoot);
      writeFileSync(join(divergent.service, ".gitignore"), "build/\n");
      const divergentParsed = await navJson({ endpoint: "kb", depth: 3 }, { currentDirectory: divergentRoot, registryPath: divergent.registryPath });
      expect(divergentParsed.entries.map((entry: { path: string }) => entry.path)).toEqual([
        "keep.md",
      ]);
    } finally {
      rmSync(exactRoot, { recursive: true, force: true });
      rmSync(divergentRoot, { recursive: true, force: true });
    }
  });

  test("directory exclusions match names case-insensitively; coverage and vendor join the engine floor (ADR 0029)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const service = createNavService(root, "kb");
      writeFiles(service, [
        { path: "real.md" },
        { path: "Build/artifact.md" },
        { path: "coverage/report.md" },
      ]);
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", service);
      const parsed = await navJson({ endpoint: "kb", depth: 3 }, { currentDirectory: root, registryPath });
      // Facade floor (DEC-0023 preset mapping): vcs/deps/build presets
      // carry the old floor plus `vendor/` and `coverage/` (accepted
      // increments — negatable by a repo's `!coverage/`), and the engine
      // matcher's case-insensitivity brings case-divergent names
      // (`Build/` vs floor `build`) back under the floor.
      expect(parsed.entries.map((entry: { path: string }) => entry.path)).toEqual([
        "real.md",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-nav capability without a provider still fails fast at Manifest load", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const folder = join(root, "kb-service");
      mkdirSync(join(folder, ".ukp"), { recursive: true });
      writeFileSync(join(folder, ".ukp", "service.toml"), 'name = "kb"\n[capabilities.search]\n');
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", folder);
      const result = await executeNavCommand(
        ["--endpoint", "kb"],
        { currentDirectory: root, registryPath },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("[capabilities.search] must declare a provider");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nested frontmatter description keys surface via the engine chain (R3 whole-chain semantics)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const service = createNavService(root, "kb");
      const target = join(service, "doc.md");
      writeFileSync(
        target,
        ["---", "metadata:", "  description: nested value", "---", "# doc", ""].join("\n"),
      );
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", service);
      const parsed = await navJson({ endpoint: "kb" }, { currentDirectory: root, registryPath });
      // The engine's yaml-like frontmatter read tolerates indentation
      // (tuition-paid port; R3 adopted the chain whole), so an indented
      // `description:` under another key DOES surface — UKP's old
      // indentation guard was a local divergence, superseded 2026-10-22.
      expect(parsed.entries[0].description).toBe("nested value");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("agent-instruction files are excluded by default, counts included", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const service = createNavService(root, "kb");
      writeFiles(service, [
        { path: "AGENTS.md" },
        { path: "docs/CLAUDE.md" },
        { path: "docs/real.md" },
      ]);
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", service);
      const parsed = await navJson({ endpoint: "kb" }, { currentDirectory: root, registryPath });
      // docs still appears (real.md counts); AGENTS.md never shows.
      expect(parsed.entries).toEqual([
        { path: "docs", kind: "folder", description: null, truncated: true, omittedMarkdownCount: 1 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("max_description_files is retired (R6/C1): presence fails as a provider error", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-retired-"));
    try {
      const folder = join(root, "kb-service");
      mkdirSync(join(folder, ".ukp"), { recursive: true });
      writeFileSync(
        join(folder, ".ukp", "service.toml"),
        'name = "kb"\n[capabilities.nav]\nprovider = "file"\n[capabilities.nav.config]\nmax_description_files = 2\n',
      );
      writeFiles(folder, [
        { path: "a.md", description: "A" },
        { path: "b.md", description: "B" },
        { path: "c.md", description: "C" },
      ]);
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", folder);
      const result = await executeNavCommand(["--endpoint", "kb"], { currentDirectory: root, registryPath });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("max_description_files' is retired");
      // Loud retirement — any presence, even a formerly valid value, is a
      // hard error pointing at the ruling; never a silent no-op.
      expect(result.stderr).toContain("R6");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nav config can replace exclude_files and exclude_dirs wholesale", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const folder = join(root, "kb-service");
      mkdirSync(join(folder, ".ukp"), { recursive: true });
      writeFileSync(
        join(folder, ".ukp", "service.toml"),
        [
          'name = "kb"',
          "[capabilities.nav]",
          'provider = "file"',
          "[capabilities.nav.config]",
          "exclude_files = []",
          'exclude_dirs = ["drafts"]',
        ].join("\n") + "\n",
      );
      writeFiles(folder, [
        { path: "AGENTS.md" },
        { path: "drafts/wip.md" },
        { path: "keep.md" },
      ]);
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", folder);
      const parsed = await navJson({ endpoint: "kb", depth: 3 }, { currentDirectory: root, registryPath });
      // AGENTS.md re-included by the override (whole-set replacement over
      // the engine's terminal arrays); drafts excluded; defaults replaced.
      expect(parsed.entries.map((entry: { path: string }) => entry.path)).toEqual([
        "AGENTS.md",
        "keep.md",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid nav config lists fail as provider errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const folder = join(root, "kb-service");
      mkdirSync(join(folder, ".ukp"), { recursive: true });
      writeFileSync(
        join(folder, ".ukp", "service.toml"),
        'name = "kb"\n[capabilities.nav]\nprovider = "file"\n[capabilities.nav.config]\nexclude_dirs = "docs"\n',
      );
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", folder);
      const result = await executeNavCommand(["--endpoint", "kb"], { currentDirectory: root, registryPath });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("nav config 'exclude_dirs' must be an array of non-empty strings");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bare file-native declarations (nav, propose) load with provider=file; others fail fast", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const folder = join(root, "kb-service");
      mkdirSync(join(folder, ".ukp"), { recursive: true });
      writeFileSync(
        join(folder, ".ukp", "service.toml"),
        'name = "kb"\n[capabilities.nav]\n[capabilities.propose]\n',
      );
      const loaded = loadManifest(folder);
      expect(loaded.manifest.capabilities.nav?.provider).toBe("file");
      expect(loaded.manifest.capabilities.propose?.provider).toBe("file");

      const strict = join(root, "other-service");
      mkdirSync(join(strict, ".ukp"), { recursive: true });
      writeFileSync(
        join(strict, ".ukp", "service.toml"),
        'name = "other"\n[capabilities.search]\n',
      );
      expect(() => loadManifest(strict)).toThrow("must declare a provider");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dot entries and engine-floor directory names never appear", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const service = createNavService(root, "kb");
      writeFiles(service, [
        { path: "real.md" },
        { path: ".hidden/secret.md" },
        { path: "node_modules/pkg/readme.md" },
        { path: "dist/out.md" },
      ]);
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", service);
      const parsed = await navJson({ endpoint: "kb", depth: 3 }, { currentDirectory: root, registryPath });
      expect(parsed.entries).toEqual([{ path: "real.md", kind: "file", description: null }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("file entries keep the .md suffix so get can consume the path", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const context = setup(root, [{ path: "docs/guide.md" }]);
      const parsed = await navJson({ endpoint: "kb", depth: 1 }, context);
      expect(parsed.entries[0].path).toBe("docs/guide.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("nav capability failures", () => {
  test("nav is a derived default: endpoint without a nav declaration still works", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const folder = join(root, "kb-service");
      mkdirSync(join(folder, ".ukp"), { recursive: true });
      writeFileSync(
        join(folder, ".ukp", "service.toml"),
        'name = "kb"\n[capabilities.search]\nprovider = "file"\n',
      );
      writeFiles(folder, [{ path: "a.md" }, { path: "AGENTS.md" }]);
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", folder);
      const parsed = await navJson({ endpoint: "kb" }, { currentDirectory: root, registryPath });
      expect(parsed.entries).toEqual([{ path: "a.md", kind: "file", description: null }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("flat visibility keys under [capabilities.nav] work without a config subtable", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const folder = join(root, "kb-service");
      mkdirSync(join(folder, ".ukp"), { recursive: true });
      writeFileSync(
        join(folder, ".ukp", "service.toml"),
        [
          'name = "kb"',
          "[capabilities.nav]",
          "exclude_files = []",
          'exclude_dirs = ["drafts"]',
        ].join("\n") + "\n",
      );
      writeFiles(folder, [{ path: "AGENTS.md" }, { path: "drafts/wip.md" }, { path: "keep.md" }]);
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", folder);
      const parsed = await navJson({ endpoint: "kb", depth: 3 }, { currentDirectory: root, registryPath });
      expect(parsed.entries.map((entry: { path: string }) => entry.path)).toEqual([
        "AGENTS.md",
        "keep.md",
      ]);
      // flat keys are normalized into config at load
      const loaded = loadManifest(folder);
      expect(loaded.manifest.capabilities.nav?.config).toEqual({
        exclude_files: [],
        exclude_dirs: ["drafts"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the same key flat and under .config is a declaration conflict", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const folder = join(root, "kb-service");
      mkdirSync(join(folder, ".ukp"), { recursive: true });
      writeFileSync(
        join(folder, ".ukp", "service.toml"),
        'name = "kb"\n[capabilities.nav]\nexclude_files = []\n[capabilities.nav.config]\nexclude_files = ["x.md"]\n',
      );
      expect(() => loadManifest(folder)).toThrow("declared both directly and under");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-file provider fails as unsupported", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const service = createNavService(root, "kb", "qmd");
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", service);
      const result = await executeNavCommand(
        ["--endpoint", "kb"],
        { currentDirectory: root, registryPath },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unsupported nav provider 'qmd'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("path miss fails precisely without fuzzy candidates", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const context = setup(root, [{ path: "docs/guide.md" }]);
      const result = await executeNavCommand(["--endpoint", "kb", "doc"], context);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("was not found in endpoint 'kb'");
      expect(result.stderr).not.toContain("Did you mean");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("path pointing at a file fails as not a directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const context = setup(root, [{ path: "docs/guide.md" }]);
      const result = await executeNavCommand(["--endpoint", "kb", "docs/guide.md"], context);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("is not a directory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("route trailing separator addresses the same route (docs/ == docs)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-trailing-sep-"));
    try {
      const context = setup(root, [{ path: "docs/guide.md" }]);
      const result = await executeNavCommand(["--endpoint", "kb", "docs/"], context);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("docs/guide.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("nav command surface", () => {
  function commandFixture(): { root: string; context: NavContext } {
    const root = mkdtempSync(join(tmpdir(), "ukp-navcmd-"));
    const service = createNavService(root, "kb");
    writeFiles(service, [
      { path: "README.md", description: "Root kb" },
      { path: "docs/guide.md" },
      { path: "docs/deep/a.md" },
      { path: "docs/deep/b.md" },
    ]);
    const registryPath = join(root, "registry.toml");
    registerAt(registryPath, "kb", service);
    return { root, context: { currentDirectory: root, registryPath } };
  }

  test("parses --endpoint, [path], --depth, --json", () => {
    expect(parseNavArgs(["--endpoint", "kb", "docs", "--depth", "1", "--json"]))
      .toEqual({ endpoint: "kb", path: "docs", depth: 1, json: true });
    expect(parseNavArgs(["-c", "kb"])).toEqual({ endpoint: "kb", json: false });
    expect(parseNavArgs(["--endpoint", "kb", "--depth", "0"]))
      .toEqual({ endpoint: "kb", depth: 0, json: false });
  });

  test("rejects -g, missing --endpoint, duplicate flags, extra positionals, bad depth", () => {
    expect(() => parseNavArgs(["-g", "--endpoint", "kb"])).toThrow(KitUsageError);
    expect(() => parseNavArgs([])).toThrow(KitUsageError);
    expect(() => parseNavArgs(["--endpoint", "kb", "--endpoint", "kb2"])).toThrow(KitUsageError);
    expect(() => parseNavArgs(["--depth", "1"])).toThrow(KitUsageError);
    expect(() => parseNavArgs(["--endpoint", "kb", "a", "b"])).toThrow(KitUsageError);
    expect(() => parseNavArgs(["--endpoint", "kb", "--depth", "-1"])).toThrow(KitUsageError);
    expect(() => parseNavArgs(["--endpoint", "kb", "--depth", String(NAV_MAX_DEPTH + 1)]))
      .toThrow(KitUsageError);
    expect(() => parseNavArgs(["--endpoint", "kb", "--depth", "x"])).toThrow(KitUsageError);
  });

  test("rejects absolute and traversal paths as usage errors", () => {
    expect(() => parseNavArgs(["--endpoint", "kb", "/etc"])).toThrow(NavUsageError);
    expect(() => parseNavArgs(["--endpoint", "kb", "../escape"])).toThrow(NavUsageError);
  });

  test("help request renders help; usage error carries the usage line", async () => {
    const { root, context } = commandFixture();
    try {
      const help = await executeNavCommand(["--help"], context);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("Usage: ukp nav");
      expect(renderNavHelp()).toContain("--depth");
      const usage = await executeNavCommand(["-g"], context);
      expect(usage.exitCode).toBe(2);
      expect(usage.stderr).toContain("Usage: ukp nav");
      const dotPath = await executeNavCommand(["--endpoint", "kb", "."], context);
      expect(dotPath.exitCode).toBe(2);
      expect(dotPath.stderr).toContain("path must not contain '.' or '..' path segments");
      expect(dotPath.stderr).toContain("Usage: ukp nav");
      expect(dotPath.stderr).not.toContain("NavUsageError");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("human output renders descriptions and truncated folders", async () => {
    const { root, context } = commandFixture();
    try {
      const result = await executeNavCommand(["--endpoint", "kb"], context);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`endpoint: kb (root: ., depth: ${NAV_DEFAULT_DEPTH})`);
      expect(result.stdout).toContain("README.md | Root kb");
      expect(result.stdout).toContain("docs/ (+3 .md)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("json output uses the ukp.nav.v1 envelope", async () => {
    const { root, context } = commandFixture();
    try {
      const result = await executeNavCommand(["--endpoint", "kb", "--json"], context);
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.schema).toBe("ukp.nav.v1");
      expect(envelope.command).toBe("nav");
      expect(envelope.capability).toBe("nav");
      expect(envelope.endpoint).toBe("kb");
      expect(envelope.routeCount).toBe(2);
      expect(envelope.entries).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unknown endpoint fails with a recovery hint", async () => {
    const { root, context } = commandFixture();
    try {
      const result = await executeNavCommand(["--endpoint", "nope"], context);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("ukp list");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
