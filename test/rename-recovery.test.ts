import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeReadCommand as executeReadCommandMaybeAsync, type ReadCommandResult } from "../src/commands/read.ts";

// ukp_remote W2 conditional-async seam: local reads stay synchronous; this
// wrapper keeps the call sites untouched (see read.test.ts for the pattern).
function executeReadCommand(args: readonly string[], context: Parameters<typeof executeReadCommandMaybeAsync>[1]): ReadCommandResult {
  const result = executeReadCommandMaybeAsync(args, context);
  if (result instanceof Promise) throw new Error("local read unexpectedly took the async path");
  return result;
}
import { registerAt } from "../src/registry.ts";
import { isValidPin, pinHashOf } from "../src/capabilities/rename-recovery.ts";

/** Per-test timeout: fixture git + recovery-layer git spawns retry under
 * transient sandbox denial, which can exceed bun's 5s default. */
const GIT_TEST_TIMEOUT_MS = 120_000;

/** File-backed service fixture with a bare nav declaration (read is a
 * derived baseline, ADR 0016; the manifest needs at least one explicit
 * capability for registration). */
function createService(root: string, endpointName: string): string {
  const service = join(root, endpointName);
  mkdirSync(join(service, ".ukp"), { recursive: true });
  mkdirSync(join(service, "docs"), { recursive: true });
  writeFileSync(
    join(service, ".ukp", "service.toml"),
    `name = "${endpointName}"\n\n[capabilities.nav]\n`,
    "utf8",
  );
  writeFileSync(join(service, "docs", "note.md"), "one\ntwo\nthree\nfour\n", "utf8");
  return service;
}

function git(service: string, ...args: string[]): void {
  // The DSH file sandbox intermittently denies spawnSync stdio pipes; retry
  // a few times so the fixture setup is not flaky under it.
  let lastStderr = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = spawnSync("git", args, { cwd: service, encoding: "utf8" });
    if (result.status === 0) return;
    lastStderr = result.stderr ?? String(result.error ?? "");
    Bun.sleepSync(100);
  }
  throw new Error(`git ${args.join(" ")} failed: ${lastStderr}`);
}

/** Init a git repo in the service folder and commit everything once. */
function initGitRepo(service: string): void {
  git(service, "init");
  git(service, "add", "-A");
  git(service, "-c", "user.name=fixture", "-c", "user.email=fixture@local", "commit", "-m", "seed", "-q");
}

function commit(service: string, message: string): void {
  git(service, "add", "-A");
  git(service, "-c", "user.name=fixture", "-c", "user.email=fixture@local", "commit", "-m", message, "-q");
}

function setup(endpointName = "notes"): { root: string; registryPath: string; service: string } {
  const root = mkdtempSync(join(tmpdir(), "ukp-rename-recovery-"));
  const registryPath = join(root, "registry.toml");
  const service = createService(root, endpointName);
  registerAt(registryPath, endpointName, service);
  return { root, registryPath, service };
}

describe("rename recovery", () => {
  test("pin contract: sha256 form and CRLF->LF normalization", () => {
    expect(isValidPin(`sha256-${"a".repeat(64)}`)).toBe(true);
    expect(isValidPin("sha256-ABC")).toBe(false);
    expect(isValidPin("sha384-abcdef")).toBe(false);
    // Q7: a pin computed over CRLF content equals the LF pin.
    expect(pinHashOf("one\r\ntwo\r\n")).toBe(pinHashOf("one\ntwo\n"));
  });

  test("--pin / --format validation", () => {
    const { root, registryPath } = setup();
    try {
      const badPin = executeReadCommand(
        ["--endpoint", "notes", "docs/note.md", "--pin", "sha256-not-hex"],
        { currentDirectory: root, registryPath },
      );
      expect(badPin.exitCode).toBe(2);
      expect(badPin.stderr).toContain("--pin must use sha256-");

      const badFormat = executeReadCommand(
        ["--endpoint", "notes", "docs/note.md", "--format", "yaml"],
        { currentDirectory: root, registryPath },
      );
      expect(badFormat.exitCode).toBe(2);
      expect(badFormat.stderr).toContain("--format only supports 'json'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("URI slot miss after committed git mv recovers with echo and stale-unknown warning", () => {
    const { root, registryPath, service } = setup();
    try {
      initGitRepo(service);
      git(service, "mv", "docs/note.md", "docs/moved.md");
      commit(service, "relocate note");

      const result = executeReadCommand(["ukp://notes/docs/note.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("one\ntwo\nthree\nfour\n");
      expect(result.stderr).toContain("recovered: 'docs/note.md' moved to 'docs/moved.md' (git history)");
      expect(result.stderr).toContain("recovered without verification (no ukp-pin");
      expect(result.recovery?.outcome).toBe("recovered");
      expect(result.recovery?.recoveredTo).toBe("docs/moved.md");
      expect(result.recovery?.attempted).toContain("git-derived");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS);

  test("pin match recovers without the unverified warning", () => {
    const { root, registryPath, service } = setup();
    try {
      initGitRepo(service);
      git(service, "mv", "docs/note.md", "docs/moved.md");
      commit(service, "relocate note");
      const pin = `sha256-${pinHashOf("one\ntwo\nthree\nfour\n")}`;

      const result = executeReadCommand(
        ["ukp://notes/docs/note.md", "--pin", pin],
        { currentDirectory: root, registryPath },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("recovered: 'docs/note.md' moved to 'docs/moved.md'");
      expect(result.stderr).not.toContain("without verification");
      expect(result.recovery?.verification).toBe("match");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS);

  test("pin drift from a post-move edit is stale, not a block", () => {
    const { root, registryPath, service } = setup();
    try {
      initGitRepo(service);
      const pin = `sha256-${pinHashOf("one\ntwo\nthree\nfour\n")}`;
      git(service, "mv", "docs/note.md", "docs/moved.md");
      commit(service, "relocate note");
      writeFileSync(join(service, "docs", "moved.md"), "one\ntwo\nthree\nfour\nedited\n", "utf8");
      commit(service, "edit after move");

      const result = executeReadCommand(
        ["ukp://notes/docs/note.md", "--pin", pin],
        { currentDirectory: root, registryPath },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("content changed after the move (pin stale)");
      expect(result.recovery?.verification).toBe("stale-unknown");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS);

  test("clean pin mismatch blocks the git-mapped candidate and fails classified", () => {
    const { root, registryPath, service } = setup();
    try {
      initGitRepo(service);
      git(service, "mv", "docs/note.md", "docs/moved.md");
      commit(service, "relocate note");
      const foreignPin = `sha256-${pinHashOf("entirely different content")}`;

      const result = executeReadCommand(
        ["ukp://notes/docs/note.md", "--pin", foreignPin],
        { currentDirectory: root, registryPath },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("resource-missing 'docs/note.md'");
      expect(result.stderr).toContain("docs/moved.md (recovery candidate, mismatch)");
      // D-088: the mismatch listing points at the emission flag instead of
      // leaving the reader to hand-compute the current pin.
      expect(result.stderr).toContain("check the current content pin with 'ukp read --show-pin'");
      expect(result.recovery?.outcome).toBe("exhausted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS);

  test("uncommitted bare mv stays resource-missing (accepted window, Q6)", () => {
    const { root, registryPath, service } = setup();
    try {
      initGitRepo(service);
      writeFileSync(join(service, "docs", "renamed.md"), "one\ntwo\nthree\nfour\n", "utf8");
      rmSync(join(service, "docs", "note.md"));

      const result = executeReadCommand(["ukp://notes/docs/note.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("resource-missing 'docs/note.md'");
      expect(result.stderr).not.toContain("recovered:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS);

  test("non-git folder: L1 absent, miss wording unchanged", () => {
    const { root, registryPath } = setup();
    try {
      const result = executeReadCommand(["--endpoint", "notes", "docs/gone.md"], {
        currentDirectory: root,
        registryPath,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("'docs/gone.md' was not found");
      expect(result.stderr).not.toContain("recovered:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--format json recovered envelope carries recovery metadata", () => {
    const { root, registryPath, service } = setup();
    try {
      initGitRepo(service);
      git(service, "mv", "docs/note.md", "docs/moved.md");
      commit(service, "relocate note");

      const result = executeReadCommand(
        ["ukp://notes/docs/note.md", "--format", "json"],
        { currentDirectory: root, registryPath },
      );
      expect(result.exitCode).toBe(0); // recovered read
      const envelope = JSON.parse(result.stderr.split(/\r?\n/)[0]);
      expect(envelope.ok).toBe(true);
      expect(envelope.recovered_to).toBe("docs/moved.md");
      expect(result.stdout).toBe("one\ntwo\nthree\nfour\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS);

  test("--format json exhausted envelope classifies resource-missing", () => {
    const { root, registryPath, service } = setup();
    try {
      initGitRepo(service);

      const miss = executeReadCommand(
        ["ukp://notes/docs/never-existed.md", "--format", "json"],
        { currentDirectory: root, registryPath },
      );
      expect(miss.exitCode).toBe(1);
      const envelope = JSON.parse(miss.stdout);
      expect(envelope.ok).toBe(false);
      expect(envelope.error.class).toBe("resource-missing");
      // No rename record ever mentioned this route: no layer produced a
      // candidate, so `attempted` is empty (exhausted by absence, not error).
      expect(envelope.error.recovery.attempted).toEqual([]);
      expect(envelope.error.recovery.outcome).toBe("exhausted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS);

  test("--from source document supplies the same-line ukp-pin", () => {
    const { root, registryPath, service } = setup();
    try {
      initGitRepo(service);
      const pin = `sha256-${pinHashOf("one\ntwo\nthree\nfour\n")}`;
      writeFileSync(
        join(service, "docs", "index.md"),
        `see [note](note.md) <!-- ukp-pin: ${pin} -->\n`,
        "utf8",
      );
      commit(service, "add index");
      git(service, "mv", "docs/note.md", "docs/moved.md");
      commit(service, "relocate note");

      const result = executeReadCommand(
        ["--endpoint", "notes", "--from", "docs/index.md", "note.md"],
        { currentDirectory: root, registryPath },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("one\ntwo\nthree\nfour\n");
      expect(result.stderr).toContain("resolved 'note.md' from 'docs/index.md'");
      expect(result.stderr).toContain("recovered:");
      expect(result.stderr).not.toContain("without verification");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS);

  // --- L2 search re-anchor E2E (stub provider; the shared qmd fixture's
  // search token cannot produce a basename-recall hit) ---

  function createQmdBackedService(root: string, endpointName: string): string {
    const service = join(root, endpointName);
    mkdirSync(join(service, ".ukp"), { recursive: true });
    mkdirSync(join(service, "docs"), { recursive: true });
    writeFileSync(
      join(service, ".ukp", "service.toml"),
      `name = "${endpointName}"\n\n[capabilities.search]\nprovider = "qmd"\n`,
      "utf8",
    );
    return service;
  }

  /** Stub qmd: ignores args, prints a JSON search result array pointing at
   * the given files (absolute path-shaped provider locations) with honest
   * docids — sha256 of each file's raw bytes, first 6 hex (ADR 0025): the
   * verified L2 re-anchor adjudicates candidates by content fingerprint. */
  function writeSearchStub(root: string, files: string[]): string {
    const stub = join(root, "qmd-stub.mjs");
    const script = files.length === 0
      ? `process.stdout.write("[]\\n");\n`
      : [
        "import { createHash } from \"node:crypto\";",
        "import { readFileSync } from \"node:fs\";",
        `const files = ${JSON.stringify(files)};`,
        "const results = files.map((file) => ({",
        "  docid: \"#\" + createHash(\"sha256\").update(readFileSync(file)).digest(\"hex\").slice(0, 6),",
        "  file: \"qmd://\" + file,",
        "}));",
        "process.stdout.write(JSON.stringify(results) + \"\\n\");",
      ].join("\n");
    writeFileSync(stub, script, "utf8");
    return stub;
  }

  test("L2 search re-anchor recovers a no-rename-record move on pin match", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-recovery-l2-hit-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "l2-notes");
    // Target exists at docs/renamed/note.md, committed as an ADD (no R
    // record): L1 must miss, L2 must recall by basename.
    mkdirSync(join(service, "docs", "renamed"), { recursive: true });
    writeFileSync(join(service, "docs", "renamed", "note.md"), "one\ntwo\nthree\nfour\n", "utf8");
    registerAt(registryPath, "l2-notes", service);
    const stub = writeSearchStub(root, [join(service, "docs", "renamed", "note.md")]);
    try {
      initGitRepo(service);
      const pin = `sha256-${pinHashOf("one\ntwo\nthree\nfour\n")}`;

      const result = executeReadCommand(
        ["ukp://l2-notes/docs/note.md", "--pin", pin],
        { currentDirectory: root, registryPath, qmdCommand: [process.execPath, stub] },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("one\ntwo\nthree\nfour\n");
      expect(result.stderr).toContain("recovered: 'docs/note.md' moved to 'docs/renamed/note.md' (search re-anchor)");
      expect(result.stderr).toContain("advisory");
      expect(result.recovery?.layer).toBe("search-reanchor");
      expect(result.recovery?.attempted).toContain("search-reanchor");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS);

  test("L2 multi-candidate recall never auto-recovers: candidates on the miss", () => {
    const root = mkdtempSync(join(tmpdir(), "ukp-recovery-l2-multi-"));
    const registryPath = join(root, "registry.toml");
    const service = createQmdBackedService(root, "l2-multi");
    mkdirSync(join(service, "docs", "a"), { recursive: true });
    mkdirSync(join(service, "docs", "b"), { recursive: true });
    writeFileSync(join(service, "docs", "a", "note.md"), "variant a\n", "utf8");
    writeFileSync(join(service, "docs", "b", "note.md"), "variant b\n", "utf8");
    registerAt(registryPath, "l2-multi", service);
    const stub = writeSearchStub(root, [
      join(service, "docs", "a", "note.md"),
      join(service, "docs", "b", "note.md"),
    ]);
    try {
      initGitRepo(service);

      const result = executeReadCommand(
        ["ukp://l2-multi/docs/note.md"],
        { currentDirectory: root, registryPath, qmdCommand: [process.execPath, stub] },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("resource-missing 'docs/note.md'");
      expect(result.stderr).toContain("docs/a/note.md (recovery candidate, unverified)");
      expect(result.stderr).toContain("docs/b/note.md (recovery candidate, unverified)");
      expect(result.stderr).not.toContain("recovered:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS);

  test("CRLF working copy verifies against an LF-computed pin (Q7 E2E)", () => {
    const { root, registryPath, service } = setup();
    try {
      initGitRepo(service);
      git(service, "mv", "docs/note.md", "docs/moved.md");
      // Rewrite the moved file with CRLF endings: the pin was computed over
      // the LF text; normalization must keep it a match, not a mismatch.
      writeFileSync(join(service, "docs", "moved.md"), "one\r\ntwo\r\nthree\r\nfour\r\n", "utf8");
      commit(service, "relocate with crlf");
      const pin = `sha256-${pinHashOf("one\ntwo\nthree\nfour\n")}`;

      const result = executeReadCommand(
        ["ukp://notes/docs/note.md", "--pin", pin],
        { currentDirectory: root, registryPath },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("pin stale");
      expect(result.recovery?.verification).toBe("match");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS);

  // D-088 review follow-up: emission must survive the recovery request
  // spread — a refactor that rebuilds the recovery request without emitPin
  // would silently regress this.
  test("recovered read emits the pin of the recovered file (--show-pin through recovery)", () => {
    const { root, registryPath, service } = setup();
    try {
      initGitRepo(service);
      git(service, "mv", "docs/note.md", "docs/moved.md");
      commit(service, "relocate note");

      const result = executeReadCommand(
        ["ukp://notes/docs/note.md", "--show-pin"],
        { currentDirectory: root, registryPath },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("recovered: 'docs/note.md' moved to 'docs/moved.md'");
      // The emitted pin is the RECOVERED file's whole-content pin.
      expect(result.stderr).toContain(`<!-- ukp-pin: sha256-${pinHashOf("one\ntwo\nthree\nfour\n")} -->`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS);
});
