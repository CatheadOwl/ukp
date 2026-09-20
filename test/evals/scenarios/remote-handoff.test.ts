import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createQmdFixtureCopy } from "../../helpers/qmd-fixture.ts";
import { buildServedTopology, freePort, waitServeReady } from "../harness/scenario.ts";

/**
 * Scenario family: remote-handoff (ukp_evals W2, adjudication E-4).
 *
 * Task artifact: a real `ukp serve` process (spawned, never imported) holding
 * a deterministic search endpoint, plus a client that knows only a URL and a
 * bearer token. Consumer: a scripted stranger on the client side. Verifier:
 * registration via `--url` lands the endpoint under the declared name, and
 * every handoff the remote search output offers — the human-mode `read:` hint
 * and the printed `ukp://` uri — replays verbatim into a successful read over
 * the wire.
 */

const fixtureCopy = createQmdFixtureCopy("evals-remote-handoff");
const documentBody = readFileSync(join(fixtureCopy, "documents", "cad-notes.md"), "utf8");
const expectedPhrase = documentBody.trim();

const topology = buildServedTopology("remote-handoff", join(fixtureCopy, "qmd-fixture.mjs"));
const token = "evals-remote-handoff-token";
let port = -1;

beforeAll(async () => {
  const registered = topology.serverRun(["register"], { cwd: fixtureCopy });
  expect(registered.exitCode).toBe(0);

  port = await freePort();
  topology.startServe({ port, token, endpoint: "fixture-qmd" });
  await waitServeReady(port);
}, 60_000);

afterAll(() => {
  topology.stopAll();
});

describe("scenario: remote-handoff (register --url → remote search → read)", () => {
  test(
    "register --url lands the declared endpoint name with the token stored",
    () => {
      const registered = topology.clientRun([
        "register",
        "--url",
        `http://127.0.0.1:${port}`,
        "--token",
        token,
      ]);
      expect(registered.exitCode).toBe(0);
      expect(registered.stdout).toContain("fixture-qmd");

      const listed = topology.clientRun(["list"]);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain("fixture-qmd");
    },
    30_000,
  );

  test(
    "the printed read: hint replays verbatim into a remote read",
    () => {
      const searched = topology.clientRun([
        "search",
        "fixture-cad-search-token",
        "--endpoint",
        "fixture-qmd",
      ]);
      expect(searched.exitCode).toBe(0);

      const hintLine = searched.stdout.match(/^\s*read:\s+ukp\s+(.+)$/m);
      expect(hintLine).not.toBeNull();
      const args = hintLine![1].trim().split(/\s+/);
      const replay = topology.clientRun(args);
      expect(replay.exitCode).toBe(0);
      expect(replay.stdout).toContain(expectedPhrase);
    },
    30_000,
  );

  test(
    "the ukp:// uri carried by the hint reads back over the wire on its own",
    () => {
      const searched = topology.clientRun([
        "search",
        "fixture-cad-search-token",
        "--endpoint",
        "fixture-qmd",
      ]);
      expect(searched.exitCode).toBe(0);

      // Remote human output carries one handoff line — the read: hint in
      // ukp:// form. The uri itself must be a first-class reference: strip
      // the line-window fragment and read it directly.
      const hintUri = searched.stdout.match(/^\s*read:\s+ukp read\s+(ukp:\/\/\S+)$/m);
      expect(hintUri).not.toBeNull();
      const uri = hintUri![1].replace(/#L\d+$/, "");
      const read = topology.clientRun(["read", uri]);
      expect(read.exitCode).toBe(0);
      expect(read.stdout).toContain(expectedPhrase);
    },
    30_000,
  );

  test(
    "the remote JSON envelope reports the endpoint healthy",
    () => {
      // On the remote face the JSON envelope reports status; the copyable
      // handoff keys ride the human output (the line this suite replays
      // verbatim above). A stranger consuming --json gets an honest ok.
      const searched = topology.clientRun([
        "search",
        "fixture-cad-search-token",
        "--json",
        "--endpoint",
        "fixture-qmd",
      ]);
      expect(searched.exitCode).toBe(0);
      const envelope = JSON.parse(searched.stdout) as {
        schema: string;
        endpoints: { name: string; status: string }[];
        warnings: unknown[];
      };
      expect(envelope.schema).toMatch(/^ukp\.search\./);
      expect(envelope.endpoints[0]).toMatchObject({ name: "fixture-qmd", status: "succeeded" });
      expect(envelope.warnings).toEqual([]);
    },
    30_000,
  );
});
