import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createQmdFixtureCopy } from "../../helpers/qmd-fixture.ts";
import { buildEvalWorld } from "../harness/scenario.ts";

/**
 * Scenario family: local-handoff (ukp_evals W1, adjudication E-4).
 *
 * Task artifact: a registered local Service with a deterministic search
 * provider, one known document. Consumer: a scripted stranger that only sees
 * what the CLI prints. Verifier: every handoff key the output offers — the
 * JSON sidecar reference, the dual-key `ukp://` uri, and the Human-mode
 * `read:` hint — replays verbatim into a successful read of the same content.
 * The docid is additionally checked against an independently computed
 * sha256 prefix (content identity, not just executability).
 */

const fixtureCopy = createQmdFixtureCopy("evals-local-handoff");
const documentPath = join(fixtureCopy, "documents", "cad-notes.md");
const documentBody = readFileSync(documentPath, "utf8");
const expectedDocid = createHash("sha256").update(documentBody, "utf8").digest("hex").slice(0, 6);
const expectedUri = "ukp://fixture-qmd/documents/cad-notes.md";
/** Distinctive phrase of the on-disk fixture document — the content-identity
 * marker every read leg must hand back. */
const expectedPhrase = documentBody.trim();

const world = buildEvalWorld("local-handoff", join(fixtureCopy, "qmd-fixture.mjs"));

describe("scenario: local-handoff (search → handoff key → read)", () => {
  test(
    "registration from the service folder succeeds and list shows the endpoint",
    () => {
      const registered = world.runUkp(["register"], { cwd: fixtureCopy });
      expect(registered.exitCode).toBe(0);

      const listed = world.runUkp(["list"]);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain("fixture-qmd");
    },
    30_000,
  );

  test(
    "JSON envelope sidecar hands off a content-identity docid and a ukp:// uri",
    () => {
      const searched = world.runUkp([
        "search",
        "fixture-cad-search-token",
        "--json",
        "--endpoint",
        "fixture-qmd",
      ]);
      expect(searched.exitCode).toBe(0);

      // Consume the envelope exactly as an agent would: parse stdout, follow
      // the references_artifact pointer, read the sidecar file.
      const envelope = JSON.parse(searched.stdout) as {
        endpoints: { references_artifact?: string }[];
      };
      const artifact = envelope.endpoints[0]?.references_artifact;
      expect(artifact).toBeDefined();
      const sidecar = JSON.parse(readFileSync(artifact!, "utf8")) as {
        results: { reference: string; status: string; ukp_uri?: string }[];
      };
      const first = sidecar.results[0];
      expect(first.status).toBe("read_ready");
      expect(first.reference).toBe(expectedDocid);
      expect(first.ukp_uri).toBe(expectedUri);
    },
    30_000,
  );

  test(
    "verbatim docid handoff: ukp read <docid> returns the same content",
    () => {
      const read = world.runUkp(["read", "--endpoint", "fixture-qmd", expectedDocid]);
      expect(read.exitCode).toBe(0);
      expect(read.stdout).toContain(expectedPhrase);
    },
    30_000,
  );

  test(
    "verbatim dual-key handoff: the printed ukp:// uri reads back on its own",
    () => {
      const read = world.runUkp(["read", expectedUri]);
      expect(read.exitCode).toBe(0);
      expect(read.stdout).toContain(expectedPhrase);
    },
    30_000,
  );

  test(
    "Human-mode hint replays verbatim: the printed read: line, executed as printed, exits 0",
    () => {
      const searched = world.runUkp([
        "search",
        "fixture-cad-search-token",
        "--endpoint",
        "fixture-qmd",
      ]);
      expect(searched.exitCode).toBe(0);

      const hintLine = searched.stdout.match(/^\s*read:\s+ukp\s+(.+)$/m);
      expect(hintLine).not.toBeNull();
      // Copy-paste replay: split the printed command on whitespace; the
      // leading `ukp` launcher word maps onto the CLI entry, the rest runs
      // verbatim — verb included.
      const args = hintLine![1].trim().split(/\s+/);
      const replay = world.runUkp(args);
      expect(replay.exitCode).toBe(0);
      expect(replay.stdout).toContain(expectedPhrase);
    },
    30_000,
  );
});
