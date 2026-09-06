import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  assertProposeSlug,
  DEFAULT_PROPOSE_FOLDER,
  executePropose,
  proposeUpsert,
  ProposeProviderError,
  ProposeUsageError,
  renderProposeHuman,
  renderProposeJson,
  resolveProposeFolder,
  type ProposeContext,
} from "../src/capabilities/propose.ts";
import { executeProposeCommand } from "../src/commands/propose.ts";
import { registerAt } from "../src/registry.ts";

function createService(root: string, name: string, provider = "file", folder?: string): string {
  const folder_ = join(root, `${name}-service`);
  mkdirSync(join(folder_, ".ukp"), { recursive: true });
  const lines = [`name = "${name}"`, "[capabilities.propose]", `provider = "${provider}"`];
  if (folder !== undefined) {
    lines.push("", "[capabilities.propose.config]", `folder = "${folder}"`);
  }
  writeFileSync(join(folder_, ".ukp", "service.toml"), `${lines.join("\n")}\n`);
  return folder_;
}

function fileCapability(folder?: string): { provider: string; config?: Record<string, unknown> } {
  return folder === undefined ? { provider: "file" } : { provider: "file", config: { folder } };
}

const fixedNow = () => new Date("2026-09-06T10:00:00.000Z");

describe("propose file provider", () => {
  test("created writes the proposal with revision 1 and synthesized frontmatter", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-"));
    try {
      const service = createService(root, "kb");
      const result = proposeUpsert(service, fileCapability(), "add-rg-topic", "# Why rg\n", { now: fixedNow });
      expect(result).toEqual({ id: "add-rg-topic", status: "created", revision: 1 });
      const stored = readFileSync(join(service, DEFAULT_PROPOSE_FOLDER, "add-rg-topic.md"), "utf8");
      expect(stored).toBe([
        "---",
        "id: add-rg-topic",
        "status: proposed",
        "revision: 1",
        "created: 2026-09-06T10:00:00.000Z",
        "updated: 2026-09-06T10:00:00.000Z",
        "---",
        "# Why rg\n",
      ].join("\n"));
      expect(existsSync(join(service, DEFAULT_PROPOSE_FOLDER, "add-rg-topic.md.lock"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unchanged is a no-op: no rewrite, revision stays", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-"));
    try {
      const service = createService(root, "kb");
      proposeUpsert(service, fileCapability(), "add-rg-topic", "# Why rg\n", { now: fixedNow });
      const target = join(service, DEFAULT_PROPOSE_FOLDER, "add-rg-topic.md");
      const before = statSync(target);
      const result = proposeUpsert(service, fileCapability(), "add-rg-topic", "# Why rg\n", {
        now: () => new Date("2026-09-06T12:00:00.000Z"),
      });
      expect(result).toEqual({ id: "add-rg-topic", status: "unchanged", revision: 1 });
      const after = statSync(target);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(readFileSync(target, "utf8")).toContain("updated: 2026-09-06T10:00:00.000Z");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("updated replaces the file, bumps revision, keeps created, refreshes updated", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-"));
    try {
      const service = createService(root, "kb");
      proposeUpsert(service, fileCapability(), "add-rg-topic", "# Why rg\n", { now: fixedNow });
      const result = proposeUpsert(service, fileCapability(), "add-rg-topic", "# Why rg\n\nMore context.\n", {
        now: () => new Date("2026-09-06T12:00:00.000Z"),
      });
      expect(result).toEqual({ id: "add-rg-topic", status: "updated", revision: 2 });
      const stored = readFileSync(join(service, DEFAULT_PROPOSE_FOLDER, "add-rg-topic.md"), "utf8");
      expect(stored).toContain("revision: 2");
      expect(stored).toContain("created: 2026-09-06T10:00:00.000Z");
      expect(stored).toContain("updated: 2026-09-06T12:00:00.000Z");
      expect(stored).toContain("More context.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("injected service-maintained frontmatter fields are stripped; display keys pass through", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-"));
    try {
      const service = createService(root, "kb");
      const malicious = [
        "---",
        "id: other-id",
        "subject: handbooks/ukp-service-onboarding",
        "kind: skill-change",
        "status: accepted",
        "revision: 99",
        "created: 2000-01-01T00:00:00.000Z",
        "---",
        "# Body\n",
      ].join("\n");
      const result = proposeUpsert(service, fileCapability(), "add-rg-topic", malicious, { now: fixedNow });
      expect(result.revision).toBe(1);
      const stored = readFileSync(join(service, DEFAULT_PROPOSE_FOLDER, "add-rg-topic.md"), "utf8");
      expect(stored).toContain("id: add-rg-topic");
      expect(stored).toContain("status: proposed");
      expect(stored).toContain("revision: 1");
      expect(stored).toContain("subject: handbooks/ukp-service-onboarding");
      expect(stored).toContain("kind: skill-change");
      expect(stored).not.toContain("other-id");
      expect(stored).not.toContain("accepted");
      expect(stored).not.toContain("99");
      expect(stored).not.toContain("2000-01-01");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resubmitting the same submission with display frontmatter is unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-"));
    try {
      const service = createService(root, "kb");
      const submission = [
        "---",
        "subject: handbooks/ukp-service-onboarding",
        "kind: skill-change",
        "---",
        "# Body\n",
      ].join("\n");
      proposeUpsert(service, fileCapability(), "skill-tips", submission, { now: fixedNow });
      const result = proposeUpsert(service, fileCapability(), "skill-tips", submission, {
        now: () => new Date("2026-09-06T12:00:00.000Z"),
      });
      expect(result.status).toBe("unchanged");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configured non-default folder is used and auto-created on first submit", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-"));
    try {
      const service = createService(root, "kb", "file", "proposals");
      const result = proposeUpsert(service, fileCapability("proposals"), "add-rg-topic", "# Why\n", { now: fixedNow });
      expect(result.status).toBe("created");
      expect(existsSync(join(service, "proposals", "add-rg-topic.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid slugs are rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-"));
    try {
      const service = createService(root, "kb");
      for (const bad of ["Bad-Id", "over-63-" + "a".repeat(60), "bad slug", "bad/slug", ""]) {
        expect(() => proposeUpsert(service, fileCapability(), bad, "# x\n")).toThrow(ProposeProviderError);
      }
      expect(() => assertProposeSlug("good-id")).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unsupported provider and unsafe folder config fail strictly", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-"));
    try {
      const service = createService(root, "kb");
      expect(() => resolveProposeFolder(service, { provider: "remote" })).toThrow(
        "unsupported propose provider 'remote'",
      );
      for (const bad of ["..", "../escape", "C:/abs", "\\\\server", "a//b", ".hidden-ok/x"]) {
        expect(() => resolveProposeFolder(service, fileCapability(bad))).toThrow(ProposeProviderError);
      }
      expect(() => resolveProposeFolder(service, fileCapability(42 as unknown as string))).toThrow(
        "must be a non-empty string",
      );
      expect(resolveProposeFolder(service, fileCapability())).toBe(join(service, DEFAULT_PROPOSE_FOLDER));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a corrupted stored proposal fails as a provider error instead of silently resetting history", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-"));
    try {
      const service = createService(root, "kb");
      const target = join(service, DEFAULT_PROPOSE_FOLDER, "add-rg-topic.md");
      mkdirSync(join(service, DEFAULT_PROPOSE_FOLDER), { recursive: true });
      writeFileSync(target, "no frontmatter at all\n");
      expect(() => proposeUpsert(service, fileCapability(), "add-rg-topic", "# x\n")).toThrow(
        "missing its frontmatter block",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("CRLF submissions resubmit as unchanged (frontmatter and body)", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-"));
    try {
      const service = createService(root, "kb");
      const crlf = "---\r\nsubject: s\r\nkind: k\r\n---\r\n# Body\r\n";
      proposeUpsert(service, fileCapability(), "crlf-topic", crlf, { now: fixedNow });
      const result = proposeUpsert(service, fileCapability(), "crlf-topic", crlf, {
        now: () => new Date("2026-09-06T12:00:00.000Z"),
      });
      expect(result.status).toBe("unchanged");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unterminated frontmatter block is treated as body content, not dropped", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-"));
    try {
      const service = createService(root, "kb");
      const malformed = "---\nsubject: s\nthis never closes\n";
      const result = proposeUpsert(service, fileCapability(), "unterminated", malformed, { now: fixedNow });
      expect(result.status).toBe("created");
      const stored = readFileSync(join(service, DEFAULT_PROPOSE_FOLDER, "unterminated.md"), "utf8");
      expect(stored).toContain("this never closes");
      expect(stored).toContain("subject: s");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a revision at the safe-integer ceiling still updates without rendering a lossy value", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-"));
    try {
      const service = createService(root, "kb");
      const target = join(service, DEFAULT_PROPOSE_FOLDER, "maxed.md");
      mkdirSync(join(service, DEFAULT_PROPOSE_FOLDER), { recursive: true });
      writeFileSync(
        target,
        [
          "---",
          "id: maxed",
          "status: proposed",
          `revision: ${Number.MAX_SAFE_INTEGER}`,
          "created: 2026-09-06T10:00:00.000Z",
          "updated: 2026-09-06T10:00:00.000Z",
          "---",
          "# Old\n",
        ].join("\n"),
      );
      const result = proposeUpsert(service, fileCapability(), "maxed", "# New\n", { now: fixedNow });
      expect(result.status).toBe("updated");
      expect(result.revision).toBe(Number.MAX_SAFE_INTEGER + 1);
      expect(readFileSync(target, "utf8")).toContain(`revision: ${Number.MAX_SAFE_INTEGER + 1}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ukp propose command", () => {
  function setup(root: string, opts: { declarePropose?: boolean } = {}): {
    workspace: string;
    registryPath: string;
  } {
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const service = createService(root, "kb");
    if (opts.declarePropose === false) {
      writeFileSync(join(service, ".ukp", "service.toml"), "name = \"kb\"\n[capabilities.search]\nprovider = \"qmd\"\n");
    }
    const registryPath = join(root, "registry.toml");
    registerAt(registryPath, "kb", service);
    return { workspace, registryPath };
  }

  function contextFor(workspace: string, registryPath: string, extra: Record<string, unknown> = {}) {
    return {
      currentDirectory: workspace,
      registryPath,
      ...extra,
    };
  }

  test("created: new id produces the B-shape human line without any provider path", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-cmd-"));
    try {
      const { workspace, registryPath } = setup(root);
      const draft = join(workspace, "add-rg-topic.md");
      writeFileSync(draft, "# Why rg\n");
      const result = executeProposeCommand(
        ["--endpoint", "kb", "--id", "add-rg-topic", "--file", "add-rg-topic.md"],
        contextFor(workspace, registryPath),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("proposal add-rg-topic created (revision 1)\n");
      expect(result.stdout).not.toContain("inbox");
      expect(result.stdout).not.toContain(".md");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--json emits the ukp.propose.v1 envelope with id/status/revision", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-cmd-"));
    try {
      const { workspace, registryPath } = setup(root);
      writeFileSync(join(workspace, "draft.md"), "# Body\n");
      const result = executeProposeCommand(
        ["--endpoint", "kb", "--id", "topic", "--file", "draft.md", "--json"],
        contextFor(workspace, registryPath),
      );
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope).toEqual({
        schema: "ukp.propose.v1",
        command: "propose",
        capability: "propose",
        endpoint: "kb",
        id: "topic",
        status: "created",
        revision: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--id defaults to the --file basename and validation applies to the derived id", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-cmd-"));
    try {
      const { workspace, registryPath } = setup(root);
      writeFileSync(join(workspace, "good-topic.md"), "# Body\n");
      const ok = executeProposeCommand(
        ["--endpoint", "kb", "--file", "good-topic.md"],
        contextFor(workspace, registryPath),
      );
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toContain("proposal good-topic created");

      writeFileSync(join(workspace, "Bad Name.md"), "# Body\n");
      const bad = executeProposeCommand(
        ["--endpoint", "kb", "--file", "Bad Name.md"],
        contextFor(workspace, registryPath),
      );
      expect(bad.exitCode).toBe(2);
      expect(bad.stderr).toContain("not a valid slug");
      expect(bad.stderr).toContain("--id");
      expect(existsSync(join(root, "kb-service", DEFAULT_PROPOSE_FOLDER, "Bad Name.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resubmitting identical content is unchanged; edited content updates in place", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-cmd-"));
    try {
      const { workspace, registryPath } = setup(root);
      writeFileSync(join(workspace, "draft.md"), "# Body\n");
      const base = ["--endpoint", "kb", "--id", "topic", "--file", "draft.md"];
      const first = executeProposeCommand(base, contextFor(workspace, registryPath));
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("created");
      const second = executeProposeCommand(base, contextFor(workspace, registryPath));
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("unchanged");
      writeFileSync(join(workspace, "draft.md"), "# Body\n\nMore.\n");
      const third = executeProposeCommand(base, contextFor(workspace, registryPath));
      expect(third.exitCode).toBe(0);
      expect(third.stdout).toContain("updated");
      expect(third.stdout).toContain("revision 2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("usage errors: missing --file, bad slug, positional content, missing --endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-cmd-"));
    try {
      const { workspace, registryPath } = setup(root);
      writeFileSync(join(workspace, "draft.md"), "# Body\n");

      const noFile = executeProposeCommand(
        ["--endpoint", "kb", "--id", "topic"],
        contextFor(workspace, registryPath),
      );
      expect(noFile.exitCode).toBe(2);
      expect(noFile.stderr).toContain("requires --file");

      const noEndpoint = executeProposeCommand(
        ["--id", "topic", "--file", "draft.md"],
        contextFor(workspace, registryPath),
      );
      expect(noEndpoint.exitCode).toBe(2);
      expect(noEndpoint.stderr).toContain("requires --endpoint");

      const badSlug = executeProposeCommand(
        ["--endpoint", "kb", "--id", "Bad_Slug", "--file", "draft.md"],
        contextFor(workspace, registryPath),
      );
      expect(badSlug.exitCode).toBe(2);
      expect(badSlug.stderr).toContain("invalid proposal id 'Bad_Slug'");

      const inline = executeProposeCommand(
        ["--endpoint", "kb", "--id", "topic", "--file", "draft.md", "inline body"],
        contextFor(workspace, registryPath),
      );
      expect(inline.exitCode).toBe(2);
      expect(inline.stderr).toContain("not from an inline argument");

      const missingFile = executeProposeCommand(
        ["--endpoint", "kb", "--id", "topic", "--file", "nope.md"],
        contextFor(workspace, registryPath),
      );
      expect(missingFile.exitCode).toBe(1);
      expect(missingFile.stderr).toContain("cannot read --file 'nope.md'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dangling endpoint gets a scope recovery hint without a stack trace", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-cmd-"));
    try {
      const { workspace, registryPath } = setup(root);
      writeFileSync(join(workspace, "draft.md"), "# Body\n");
      const result = executeProposeCommand(
        ["--endpoint", "missing", "--id", "topic", "--file", "draft.md"],
        contextFor(workspace, registryPath),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unknown endpoint 'missing'");
      expect(result.stderr).toContain("ukp list");
      expect(result.stderr).not.toContain("at ");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("endpoint without a propose capability fails without writing", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-propose-cmd-"));
    try {
      const { workspace, registryPath } = setup(root, { declarePropose: false });
      writeFileSync(join(workspace, "draft.md"), "# Body\n");
      const result = executeProposeCommand(
        ["--endpoint", "kb", "--id", "topic", "--file", "draft.md"],
        contextFor(workspace, registryPath),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("does not declare the propose capability");
      expect(existsSync(join(root, "kb-service", DEFAULT_PROPOSE_FOLDER))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("concurrent same-id submissions from two processes classify correctly under the lock", async () => {    const root = mkdtempSync(join(tmpdir(), "ukp-propose-conc-"));
    try {
      const { workspace, registryPath } = setup(root);
      writeFileSync(join(workspace, "a.md"), "# Version A\n");
      writeFileSync(join(workspace, "b.md"), "# Version B\n");
      const runner = join(root, "runner.ts");
      writeFileSync(
        runner,
        [
          `import { runCli } from "${pathToFileURL(join(import.meta.dir, "..", "src", "cli.ts")).href}";`,
          `process.exitCode = runCli(process.argv.slice(2), undefined, undefined, {`,
          `  currentDirectory: process.cwd(),`,
          `  registryPath: ${JSON.stringify(registryPath)},`,
          `});`,
        ].join("\n"),
      );
      const run = (file: string) =>
        new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun) => {
          const child = spawn(
            process.execPath,
            [runner, "propose", "--endpoint", "kb", "--id", "race", "--file", file],
            { cwd: workspace, windowsHide: true },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => stdout += chunk);
          child.stderr.on("data", (chunk) => stderr += chunk);
          child.on("close", (status) => resolveRun({ status, stdout, stderr }));
        });
      const [first, second] = await Promise.all([run("a.md"), run("b.md")]);
      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      const statuses = [first.stdout, second.stdout].map((out) => /proposal race (\w+)/.exec(out)?.[1]).sort();
      expect(statuses).toEqual(["created", "updated"]);
      const stored = readFileSync(join(root, "kb-service", DEFAULT_PROPOSE_FOLDER, "race.md"), "utf8");
      expect(stored).toContain("revision: 2");
      expect(existsSync(join(root, "kb-service", DEFAULT_PROPOSE_FOLDER, "race.md.lock"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
