import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executeNav,
  NAV_DEFAULT_DEPTH,
  NAV_MAX_DEPTH,
  type NavContext,
  type NavRequest,
} from "../src/capabilities/nav.ts";
import { executeNavCommand, parseNavArgs, renderNavHelp } from "../src/commands/nav.ts";
import { NavUsageError } from "../src/capabilities/nav.ts";
import { loadManifest } from "../src/config/manifest.ts";
import { registerAt } from "../src/registry.ts";

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
}

/** Writes files under `folder` from slash-separated specs. */
function writeFiles(folder: string, files: readonly FileSpec[]): void {
  for (const file of files) {
    const target = join(folder, ...file.path.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    const content = file.description === undefined
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

/** Runs nav with --json and parses the envelope. */
function navJson(request: Omit<NavRequest, "json">, context: NavContext) {
  const result = executeNav({ ...request, json: true }, context);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout);
}

describe("nav capability", () => {
  test("depth 0 lists root markdown files and truncated folders with recursive counts", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const context = setup(root, [
        { path: "README.md", description: "Root knowledge base" },
        { path: "docs/guide.md" },
        { path: "docs/notes/a.md" },
        { path: "docs/notes/b.md" },
        { path: "empty/none.txt" },
      ]);
      const parsed = navJson({ endpoint: "kb" }, context);
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

  test("depth 1 expands one level; deeper folders truncate", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const context = setup(root, [
        { path: "docs/guide.md", description: "The guide" },
        { path: "docs/notes/a.md" },
        { path: "docs/notes/b.md" },
      ]);
      const parsed = navJson({ endpoint: "kb", depth: 1 }, context);
      expect(parsed.entries).toEqual([
        { path: "docs/guide.md", kind: "file", description: "The guide" },
        { path: "docs/notes", kind: "folder", description: null, truncated: true, omittedMarkdownCount: 2 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("path selects a sub-root; counts are independent of the observing root", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const context = setup(root, [
        { path: "docs/README.md", description: "Documentation area" },
        { path: "docs/guide.md" },
        { path: "docs/deep/x.md" },
        { path: "outside.md" },
      ]);
      const parsed = navJson({ endpoint: "kb", path: "docs" }, context);
      expect(parsed.root).toBe("docs");
      expect(parsed.entries).toEqual([
        { path: "docs/deep", kind: "folder", description: null, truncated: true, omittedMarkdownCount: 1 },
        { path: "docs/guide.md", kind: "file", description: null },
        { path: "docs/README.md", kind: "file", description: "Documentation area" },
      ]);
      // observed from the endpoint root the same subtree counts identically
      const whole = navJson({ endpoint: "kb" }, context);
      expect(whole.entries.find((entry: { path: string }) => entry.path === "docs").omittedMarkdownCount).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("truncated folder keeps its README description on the route line", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const context = setup(root, [
        { path: "area/README.md", description: "The area" },
        { path: "area/a.md" },
      ]);
      const parsed = navJson({ endpoint: "kb" }, context);
      expect(parsed.entries).toEqual([
        { path: "area", kind: "folder", description: "The area", truncated: true, omittedMarkdownCount: 2 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bare [capabilities.nav] declaration defaults to the file provider", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const folder = join(root, "kb-service");
      mkdirSync(join(folder, ".ukp"), { recursive: true });
      writeFileSync(join(folder, ".ukp", "service.toml"), 'name = "kb"\n[capabilities.nav]\n');
      writeFileSync(join(folder, "a.md"), "# a\n");
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", folder);
      const parsed = navJson({ endpoint: "kb" }, { currentDirectory: root, registryPath });
      expect(parsed.entries).toEqual([{ path: "a.md", kind: "file", description: null }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(".gitignore rules hide files, directories, and their truncated counts", () => {
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
      const parsed = navJson({ endpoint: "kb" }, { currentDirectory: root, registryPath });
      expect(parsed.entries).toEqual([{ path: "keep.md", kind: "file", description: null }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(".gitignore negation re-includes; deeper .gitignore overrides shallower", () => {
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
      const parsed = navJson({ endpoint: "kb" }, { currentDirectory: root, registryPath });
      // root: area/*.md ignored except reinstated; deeper file: keep re-included, drop-nested ignored
      expect(parsed.entries).toEqual([
        { path: "area", kind: "folder", description: null, truncated: true, omittedMarkdownCount: 2 },
      ]);
      const deep = navJson({ endpoint: "kb", path: "area" }, { currentDirectory: root, registryPath });
      expect(deep.entries).toEqual([
        { path: "area/keep.md", kind: "file", description: null },
        { path: "area/reinstated.md", kind: "file", description: null },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("double-star patterns hide nested files and subtrees at any depth", () => {
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
      const parsed = navJson({ endpoint: "kb", depth: 5 }, { currentDirectory: root, registryPath });
      expect(parsed.entries.map((entry: { path: string }) => entry.path)).toEqual([
        "area/keep-deep.md",
        "keep.md",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gitignore and directory exclusions are case-insensitive (Windows git semantics)", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const service = createNavService(root, "kb");
      writeFiles(service, [
        { path: "keep.md" },
        { path: "Build/artifact.md" },
        { path: "Secret/hidden.md" },
      ]);
      writeFileSync(join(service, ".gitignore"), "build/\n");
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", service);
      const parsed = navJson({ endpoint: "kb", depth: 3 }, { currentDirectory: root, registryPath });
      // `Build/` matches the lowercase `build/` gitignore rule; `Secret` is
      // not in the exclusion set and stays visible.
      expect(parsed.entries.map((entry: { path: string }) => entry.path)).toEqual([
        "keep.md",
        "Secret/hidden.md",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-nav capability without a provider still fails fast at Manifest load", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const folder = join(root, "kb-service");
      mkdirSync(join(folder, ".ukp"), { recursive: true });
      writeFileSync(join(folder, ".ukp", "service.toml"), 'name = "kb"\n[capabilities.search]\n');
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", folder);
      const result = executeNavCommand(
        ["--endpoint", "kb"],
        { currentDirectory: root, registryPath },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("[capabilities.search] must declare a provider");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nested frontmatter description keys are not mistaken for the description", () => {
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
      const parsed = navJson({ endpoint: "kb" }, { currentDirectory: root, registryPath });
      expect(parsed.entries[0].description).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("agent-instruction files are excluded by default, counts included", () => {
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
      const parsed = navJson({ endpoint: "kb" }, { currentDirectory: root, registryPath });
      // docs still appears (real.md counts); AGENTS.md never shows.
      expect(parsed.entries).toEqual([
        { path: "docs", kind: "folder", description: null, truncated: true, omittedMarkdownCount: 1 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("description-read budget (ADR 0018): entries stay listed, omissions are loud", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-budget-"));
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
          "max_description_files = 2",
        ].join("\n") + "\n",
      );
      writeFiles(folder, [
        { path: "a.md", description: "A" },
        { path: "b.md", description: "B" },
        { path: "c.md", description: "C" },
        { path: "d.md", description: "D" },
      ]);
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", folder);
      const context = { currentDirectory: root, registryPath };

      const parsed = navJson({ endpoint: "kb", depth: 1 }, context);
      // All four entries stay listed; first two carry descriptions, the rest
      // are flagged — never silently dropped (ADR 0018 loud contract).
      expect(parsed.entries).toEqual([
        { path: "a.md", kind: "file", description: "A" },
        { path: "b.md", kind: "file", description: "B" },
        { path: "c.md", kind: "file", description: null, descriptionOmitted: "budget" },
        { path: "d.md", kind: "file", description: null, descriptionOmitted: "budget" },
      ]);
      expect(parsed.diagnostics).toEqual([
        {
          code: "description-budget-reached",
          message:
            "descriptions omitted for 2 entries beyond the description-read budget 2 "
            + "(nav config 'max_description_files'; entries stay listed, counts stay exact)",
        },
      ]);

      // Human mode: budget-hit entries carry a visible marker
      const human = executeNav({ endpoint: "kb", depth: 1, json: false }, context);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain("c.md | (description omitted: budget reached)");
      expect(human.stdout).not.toContain("C\n");
      // Diagnostics surface on stderr in BOTH modes (loud, read's channel discipline)
      expect(human.stderr).toContain("description-budget-reached: descriptions omitted for 2 entries");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid max_description_files fails as a provider error; default budget never binds", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-budget-invalid-"));
    const defaultRoot = mkdtempSync(join(tmpdir(), "ukp-nav-budget-default-"));
    try {
      const folder = join(root, "kb-service");
      mkdirSync(join(folder, ".ukp"), { recursive: true });
      writeFileSync(
        join(folder, ".ukp", "service.toml"),
        'name = "kb"\n[capabilities.nav]\nprovider = "file"\n[capabilities.nav.config]\nmax_description_files = 0\n',
      );
      writeFiles(folder, [{ path: "a.md" }]);
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", folder);
      const result = executeNavCommand(["--endpoint", "kb"], { currentDirectory: root, registryPath });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("nav config 'max_description_files' must be a positive integer");

      // Default (no config): small trees never hit the budget, zero diagnostics
      const context = setup(defaultRoot, [
        { path: "a.md", description: "A" },
        { path: "b.md", description: "B" },
      ], "kb-default");
      const parsed = navJson({ endpoint: "kb-default" }, context);
      expect(parsed.diagnostics).toEqual([]);
      expect(parsed.entries.every((entry: { descriptionOmitted?: string }) => entry.descriptionOmitted === undefined)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(defaultRoot, { recursive: true, force: true });
    }
  });

  test("nav config can replace exclude_files and exclude_dirs wholesale", () => {
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
      const parsed = navJson({ endpoint: "kb", depth: 3 }, { currentDirectory: root, registryPath });
      // AGENTS.md re-included by the override; drafts excluded; defaults replaced.
      expect(parsed.entries.map((entry: { path: string }) => entry.path)).toEqual([
        "AGENTS.md",
        "keep.md",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid nav config lists fail as provider errors", () => {
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
      const result = executeNavCommand(["--endpoint", "kb"], { currentDirectory: root, registryPath });
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

  test("dot entries and excluded directory names never appear", () => {
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
      const parsed = navJson({ endpoint: "kb", depth: 3 }, { currentDirectory: root, registryPath });
      expect(parsed.entries).toEqual([{ path: "real.md", kind: "file", description: null }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("file entries keep the .md suffix so get can consume the path", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const context = setup(root, [{ path: "docs/guide.md" }]);
      const parsed = navJson({ endpoint: "kb", depth: 1 }, context);
      expect(parsed.entries[0].path).toBe("docs/guide.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("nav capability failures", () => {
  test("nav is a derived default: endpoint without a nav declaration still works", () => {
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
      const parsed = navJson({ endpoint: "kb" }, { currentDirectory: root, registryPath });
      expect(parsed.entries).toEqual([{ path: "a.md", kind: "file", description: null }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("flat visibility keys under [capabilities.nav] work without a config subtable", () => {
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
      const parsed = navJson({ endpoint: "kb", depth: 3 }, { currentDirectory: root, registryPath });
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

  test("non-file provider fails as unsupported", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const service = createNavService(root, "kb", "qmd");
      const registryPath = join(root, "registry.toml");
      registerAt(registryPath, "kb", service);
      const result = executeNavCommand(
        ["--endpoint", "kb"],
        { currentDirectory: root, registryPath },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unsupported nav provider 'qmd'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("path miss fails precisely without fuzzy candidates", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const context = setup(root, [{ path: "docs/guide.md" }]);
      const result = executeNav({ endpoint: "kb", path: "doc", json: false }, context);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("was not found in endpoint 'kb'");
      expect(result.stderr).not.toContain("Did you mean");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("path pointing at a file fails as not a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-nav-"));
    try {
      const context = setup(root, [{ path: "docs/guide.md" }]);
      const result = executeNav({ endpoint: "kb", path: "docs/guide.md", json: false }, context);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("is not a directory");
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
    expect(() => parseNavArgs(["-g", "--endpoint", "kb"])).toThrow(NavUsageError);
    expect(() => parseNavArgs([])).toThrow(NavUsageError);
    expect(() => parseNavArgs(["--endpoint", "kb", "--endpoint", "kb2"])).toThrow(NavUsageError);
    expect(() => parseNavArgs(["--depth", "1"])).toThrow(NavUsageError);
    expect(() => parseNavArgs(["--endpoint", "kb", "a", "b"])).toThrow(NavUsageError);
    expect(() => parseNavArgs(["--endpoint", "kb", "--depth", "-1"])).toThrow(NavUsageError);
    expect(() => parseNavArgs(["--endpoint", "kb", "--depth", String(NAV_MAX_DEPTH + 1)]))
      .toThrow(NavUsageError);
    expect(() => parseNavArgs(["--endpoint", "kb", "--depth", "x"])).toThrow(NavUsageError);
  });

  test("rejects absolute and traversal paths as usage errors", () => {
    expect(() => parseNavArgs(["--endpoint", "kb", "/etc"])).toThrow(NavUsageError);
    expect(() => parseNavArgs(["--endpoint", "kb", "../escape"])).toThrow(NavUsageError);
  });

  test("help request renders help; usage error carries the usage line", () => {
    const { root, context } = commandFixture();
    try {
      const help = executeNavCommand(["--help"], context);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("Usage: ukp nav");
      expect(renderNavHelp()).toContain("--depth");
      const usage = executeNavCommand(["-g"], context);
      expect(usage.exitCode).toBe(2);
      expect(usage.stderr).toContain("Usage: ukp nav");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("human output renders descriptions and truncated folders", () => {
    const { root, context } = commandFixture();
    try {
      const result = executeNavCommand(["--endpoint", "kb"], context);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`endpoint: kb (root: ., depth: ${NAV_DEFAULT_DEPTH})`);
      expect(result.stdout).toContain("README.md | Root kb");
      expect(result.stdout).toContain("[truncated: 3] docs");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("json output uses the ukp.nav.v1 envelope", () => {
    const { root, context } = commandFixture();
    try {
      const result = executeNavCommand(["--endpoint", "kb", "--json"], context);
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

  test("unknown endpoint fails with a recovery hint", () => {
    const { root, context } = commandFixture();
    try {
      const result = executeNavCommand(["--endpoint", "nope"], context);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("ukp list");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
