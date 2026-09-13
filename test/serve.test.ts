import { describe, expect, test, afterAll } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerAt } from "../src/registry.ts";
import {
  DISCOVERY_PATH,
  startUkpServer,
  type DiscoveryDocument,
  type StartedServe,
} from "../src/server.ts";
import { parseServeArgs } from "../src/commands/serve.ts";
import { createQmdFixtureCopy } from "./helpers/qmd-fixture.ts";

// Private fixture copy (see helper doc: invocation state is written into the
// served folder and bun runs test files in parallel).
const fixture = createQmdFixtureCopy("serve-fixture");
const nodeExecutable = Bun.which("node") ?? process.execPath;
const qmdCommand = [nodeExecutable, join(fixture, "qmd-fixture.mjs")];

const root = mkdtempSync(join(tmpdir(), "ukp-serve-"));
const registryPath = join(root, "registry.toml");

function createService(folderName: string, endpointName: string): string {
  const folder = join(root, folderName);
  mkdirSync(join(folder, ".ukp"), { recursive: true });
  mkdirSync(join(folder, "documents"), { recursive: true });
  writeFileSync(
    join(folder, ".ukp", "service.toml"),
    `name = "${endpointName}"\ndescription = "serve test service"\n\n[capabilities.search]\nprovider = "qmd"\n`,
    "utf8",
  );
  writeFileSync(
    join(folder, "documents", "cad-notes.md"),
    "# CAD notes\n\nCAD fixture note content.\n",
    "utf8",
  );
  return folder;
}

const serviceFolder = createService("serve-svc", "serve-fixture");
registerAt(registryPath, "serve-fixture", serviceFolder);

const started: StartedServe[] = [];
function start(overrides: Partial<Parameters<typeof startUkpServer>[0]> = {}): StartedServe {
  const handle = startUkpServer({
    endpointName: "serve-fixture",
    currentDirectory: root,
    registryPath,
    qmdCommand,
    port: 0,
    ...overrides,
  });
  started.push(handle);
  return handle;
}

afterAll(() => {
  for (const { server } of started) server.stop(true);
  rmSync(root, { recursive: true, force: true });
  rmSync(fixture, { recursive: true, force: true });
});

describe("serve discovery document", () => {
  test("GET /.well-known/ukp.json projects the manifest plus transport metadata", async () => {
    const { info } = start();
    const response = await fetch(`${info.url}${DISCOVERY_PATH}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const doc = await response.json() as DiscoveryDocument;
    expect(doc.protocol).toBe("ukp-remote");
    expect(doc.protocol_version).toBe("1");
    expect(doc.name).toBe("serve-fixture");
    expect(doc.description).toBe("serve test service");
    expect(doc.capabilities.read).toEqual({ provider: "file", derived: true });
    expect(doc.capabilities.nav).toEqual({ provider: "file", derived: true });
    expect(doc.capabilities.search).toEqual({ provider: "qmd" });
    expect(doc.security.schemes).toEqual([]);
    expect(doc.instance_uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("instance uid persists in the Service folder and stays stable across fetches", async () => {
    const { info } = start();
    const first = await (await fetch(`${info.url}${DISCOVERY_PATH}`)).json() as DiscoveryDocument;
    const uidPath = join(serviceFolder, ".ukp", "instance-uid");
    expect(existsSync(uidPath)).toBe(true);
    expect(readFileSync(uidPath, "utf8").trim()).toBe(first.instance_uid);
    const second = await (await fetch(`${info.url}${DISCOVERY_PATH}`)).json() as DiscoveryDocument;
    expect(second.instance_uid).toBe(first.instance_uid);
  });
});

describe("serve /v1/search", () => {
  test("POST returns the search envelope with inline references and ukp_uri", async () => {
    const { info } = start();
    const response = await fetch(`${info.url}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "fixture-cad-search-token", limit: 5 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      schema: string;
      run_id: string;
      endpoints: Array<{ name: string; status: string }>;
      references: {
        schema: string;
        results: Array<{ reference: string; status: string; ukp_uri?: string }>;
      };
    };
    expect(body.schema).toBe("ukp.search.v1");
    expect(body.run_id).toMatch(/^serve-/);
    expect(body.endpoints[0]).toMatchObject({ name: "serve-fixture", status: "succeeded" });
    expect(body.references.schema).toBe("ukp.search.references.v1");
    expect(body.references.results[0]).toMatchObject({
      reference: "a1b2c3",
      status: "read_ready",
      ukp_uri: "ukp://serve-fixture/documents/cad-notes.md",
    });
  });

  test("rejects an invalid body and a non-POST method", async () => {
    const { info } = start();
    const badBody = await fetch(`${info.url}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "" }),
    });
    expect(badBody.status).toBe(400);
    expect(((await badBody.json()) as { error: { class: string } }).error.class).toBe("usage-error");

    const badLimit = await fetch(`${info.url}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "x", limit: 0 }),
    });
    expect(badLimit.status).toBe(400);

    const wrongMethod = await fetch(`${info.url}/v1/search`);
    expect(wrongMethod.status).toBe(405);
    expect(((await wrongMethod.json()) as { error: { class: string } }).error.class).toBe("method-not-allowed");
  });
});

describe("serve /v1/read", () => {
  test("GET ?ref= returns the envelope with content for an existing file", async () => {
    const { info } = start();
    const response = await fetch(`${info.url}/v1/read?ref=documents/cad-notes.md`);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; endpoint: string; reference: string; content: string };
    expect(body.ok).toBe(true);
    expect(body.endpoint).toBe("serve-fixture");
    expect(body.reference).toBe("documents/cad-notes.md");
    expect(body.content).toContain("# CAD notes");
  });

  test("GET ?ref= miss maps to 404 with the resource-missing envelope", async () => {
    const { info } = start();
    const response = await fetch(`${info.url}/v1/read?ref=documents/missing.md`);
    expect(response.status).toBe(404);
    const body = await response.json() as { ok: boolean; error: { class: string } };
    expect(body.ok).toBe(false);
    expect(body.error.class).toBe("resource-missing");
  });

  test("GET ?uri= with a foreign endpoint is an identity mismatch, not a miss", async () => {
    const { info } = start();
    const response = await fetch(`${info.url}/v1/read?uri=${encodeURIComponent("ukp://other/x.md")}`);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { class: string; message: string } };
    expect(body.error.class).toBe("identity-mismatch");
    expect(body.error.message).toContain("does not match served endpoint 'serve-fixture'");
  });

  test("requires exactly one of ref/uri and validates lines syntax", async () => {
    const { info } = start();
    const both = await fetch(`${info.url}/v1/read?ref=a.md&uri=${encodeURIComponent("ukp://serve-fixture/a.md")}`);
    expect(both.status).toBe(400);
    expect(((await both.json()) as { error: { class: string } }).error.class).toBe("usage-error");

    const neither = await fetch(`${info.url}/v1/read`);
    expect(neither.status).toBe(400);

    const badLines = await fetch(`${info.url}/v1/read?ref=documents/cad-notes.md&lines=zero`);
    expect(badLines.status).toBe(400);
    expect(((await badLines.json()) as { error: { class: string } }).error.class).toBe("usage-error");

    const window = await fetch(`${info.url}/v1/read?ref=documents/cad-notes.md&lines=1:2`);
    expect(window.status).toBe(200);
    const body = await window.json() as { ok: boolean; content: string };
    expect(body.ok).toBe(true);
  });
});

describe("serve auth", () => {
  test("token-protected /v1 routes reject missing/wrong bearer; discovery stays public", async () => {
    const { info } = start({ tokens: ["s3cret-token"] });
    const discovery = await fetch(`${info.url}${DISCOVERY_PATH}`);
    expect(discovery.status).toBe(200);
    expect(((await discovery.json()) as DiscoveryDocument).security.schemes).toEqual(["bearer"]);

    const unauthorized = await fetch(`${info.url}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "fixture-cad-search-token" }),
    });
    expect(unauthorized.status).toBe(401);
    expect(((await unauthorized.json()) as { error: { class: string } }).error.class).toBe("auth-failure");

    const wrongToken = await fetch(`${info.url}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify({ query: "fixture-cad-search-token" }),
    });
    expect(wrongToken.status).toBe(401);

    const authorized = await fetch(`${info.url}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer s3cret-token" },
      body: JSON.stringify({ query: "fixture-cad-search-token" }),
    });
    expect(authorized.status).toBe(200);
  });
});

describe("serve auth admission (RQ-18, deny by default)", () => {
  test("tokenless startup requires an explicit loopback-only opt-in", async () => {
    const { serveAuthDecision, executeServeCommand } = await import("../src/commands/serve.ts");
    // Token present: authorized, auth required.
    expect(serveAuthDecision("127.0.0.1", ["t1"], false)).toEqual({ ok: true, authRequired: true });
    // Loopback, no token, no flag: refused with the opt-in hint.
    const refused = serveAuthDecision("127.0.0.1", [], false);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("--allow-anonymous");
    // Explicit loopback opt-in: allowed, anonymous.
    expect(serveAuthDecision("127.0.0.1", [], true)).toEqual({ ok: true, authRequired: false });
    // Non-loopback: token always required; the flag does not help.
    expect(serveAuthDecision("0.0.0.0", [], true).ok).toBe(false);

    // The command layer refuses to start without a token and without the
    // flag (no server is left behind).
    const result = executeServeCommand(["--endpoint", "serve-fixture"], {
      currentDirectory: root,
      registryPath,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("serve requires authentication");
  });
});

describe("serve multi-token (RQ-16)", () => {
  test("any listed token authorizes; unlisted tokens are rejected", async () => {
    const { info } = start({ tokens: ["alice", "bob"] });
    for (const token of ["alice", "bob"]) {
      const response = await fetch(`${info.url}/v1/search`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: "fixture-cad-search-token" }),
      });
      expect(response.status).toBe(200);
    }
    const rejected = await fetch(`${info.url}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer carol" },
      body: JSON.stringify({ query: "fixture-cad-search-token" }),
    });
    expect(rejected.status).toBe(401);
  });
});

describe("serve routing and setup failures", () => {
  test("unknown routes 404 with the route hint; wrong methods 405", async () => {
    const { info } = start();
    const missing = await fetch(`${info.url}/v1/nav?path=`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { class: string } }).error.class).toBe("not-found");

    const postRead = await fetch(`${info.url}/v1/read?ref=a.md`, { method: "POST" });
    expect(postRead.status).toBe(405);
  });

  test("startup fails for an unregistered endpoint", () => {
    expect(() => start({ endpointName: "not-registered" })).toThrow("is not registered");
  });

  test("startup fails when the binding and manifest names disagree (RQ-14)", () => {
    const mismatchFolder = createService("mismatch-svc", "different-name");
    registerAt(registryPath, "mismatch-binding", mismatchFolder);
    expect(() => start({ endpointName: "mismatch-binding" })).toThrow("identity mismatch");
  });
});

describe("serve argument parsing", () => {
  test("defaults host and port; validates the port range", () => {
    const parsed = parseServeArgs(["--endpoint", "cad"]);
    expect(parsed).toEqual({ endpoint: "cad", host: "127.0.0.1", port: 8570 });
    expect(parseServeArgs(["--endpoint", "cad", "--port", "9000", "--host", "0.0.0.0"]))
      .toEqual({ endpoint: "cad", host: "0.0.0.0", port: 9000 });
    expect(() => parseServeArgs(["--endpoint", "cad", "--port", "99999"])).toThrow(
      "--port must be an integer between 1 and 65535",
    );
    expect(() => parseServeArgs(["-g"])).toThrow("serve requires --endpoint <name>");
  });
});
