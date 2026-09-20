import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildServedTopology, freePort, waitServeReady } from "../harness/scenario.ts";

/**
 * Scenario family: write-loop (ukp_evals W2, adjudication E-4).
 *
 * Task artifact: a real `ukp serve` process holding a propose-declaring
 * endpoint; a client with a draft file. Consumer: a scripted stranger. 
 * Verifier: the proposal three-state lifecycle (created → unchanged →
 * updated), the proposal content landing on the server's inbox as a file
 * (end state), and the freshly written resource reading back over the wire
 * through the `ukp://` form printed nowhere else but the propose output's
 * world — the write-face handoff loop.
 */

const DRAFT_V1 = "# Eval draft\n\nfirst version of the write-loop proposal body\n";
const DRAFT_V2 = "# Eval draft\n\nsecond version with an amended body\n";

const topology = buildServedTopology("write-loop");
const token = "evals-write-loop-token";
let port = -1;

const writeService = (() => {
  const folder = join(topology.root, "write-svc");
  mkdirSync(join(folder, ".ukp"), { recursive: true });
  writeFileSync(
    join(folder, ".ukp", "service.toml"),
    'name = "write-notes"\n\n[capabilities.propose]\n',
    "utf8",
  );
  return folder;
})();

const draftPath = join(topology.root, "draft.md");
writeFileSync(draftPath, DRAFT_V1, "utf8");

beforeAll(async () => {
  const registered = topology.serverRun(["register"], { cwd: writeService });
  expect(registered.exitCode).toBe(0);

  port = await freePort();
  topology.startServe({ port, token, endpoint: "write-notes" });
  await waitServeReady(port);

  const clientRegistered = topology.clientRun([
    "register",
    "--url",
    `http://127.0.0.1:${port}`,
    "--token",
    token,
  ]);
  expect(clientRegistered.exitCode).toBe(0);
}, 60_000);

afterAll(() => {
  topology.stopAll();
});

describe("scenario: write-loop (propose three states → remote read back)", () => {
  test(
    "first propose creates; the proposal reads back over the wire",
    () => {
      const proposed = topology.clientRun([
        "propose",
        "--endpoint",
        "write-notes",
        "--id",
        "eval-draft",
        "--file",
        draftPath,
      ]);
      expect(proposed.exitCode).toBe(0);
      expect(proposed.stdout).toContain("created");

      // End state on the server side: the proposal landed in the inbox.
      expect(existsSync(join(writeService, "inbox", "eval-draft.md"))).toBe(true);

      const read = topology.clientRun(["read", "ukp://write-notes/inbox/eval-draft.md"]);
      expect(read.exitCode).toBe(0);
      expect(read.stdout).toContain("first version of the write-loop proposal body");
    },
    60_000,
  );

  test(
    "re-proposing the same bytes is unchanged — no rewrite",
    () => {
      const proposed = topology.clientRun([
        "propose",
        "--endpoint",
        "write-notes",
        "--id",
        "eval-draft",
        "--file",
        draftPath,
      ]);
      expect(proposed.exitCode).toBe(0);
      expect(proposed.stdout).toContain("unchanged");
    },
    30_000,
  );

  test(
    "amended bytes update the proposal; the remote read reflects the new body",
    () => {
      writeFileSync(draftPath, DRAFT_V2, "utf8");
      const proposed = topology.clientRun([
        "propose",
        "--endpoint",
        "write-notes",
        "--id",
        "eval-draft",
        "--file",
        draftPath,
      ]);
      expect(proposed.exitCode).toBe(0);
      expect(proposed.stdout).toContain("updated");

      const read = topology.clientRun(["read", "ukp://write-notes/inbox/eval-draft.md"]);
      expect(read.exitCode).toBe(0);
      expect(read.stdout).toContain("second version with an amended body");
      expect(read.stdout).not.toContain("first version of the write-loop proposal body");
    },
    30_000,
  );
});
