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

const rgAvailable = Bun.spawnSync(["rg", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

describe("serve /v1/nav (W6)", () => {
  test("returns the ukp.nav.v1 envelope; a missing route root is a 404", async () => {
    const { info } = start();
    const response = await fetch(`${info.url}/v1/nav`);
    expect(response.status).toBe(200);
    const envelope = await response.json() as {
      schema: string;
      endpoint: string;
      root: string;
      entries: Array<{ path: string; kind: string; description: string | null; truncated?: boolean; omittedMarkdownCount?: number }>;
    };
    expect(envelope.schema).toBe("ukp.nav.v1");
    expect(envelope.endpoint).toBe("serve-fixture");
    expect(envelope.root).toBe(".");
    expect(envelope.entries).toEqual([
      { path: "documents", kind: "folder", description: null, truncated: true, omittedMarkdownCount: 1 },
    ]);

    const deep = await fetch(`${info.url}/v1/nav?depth=1`);
    expect(deep.status).toBe(200);
    const deepBody = await deep.json() as { entries: Array<{ path: string; kind: string; description: string | null }> };
    expect(deepBody.entries).toEqual([{ path: "documents/cad-notes.md", kind: "file", description: null }]);

    const miss = await fetch(`${info.url}/v1/nav?path=missing`);
    expect(miss.status).toBe(404);
    expect(((await miss.json()) as { error: { class: string; message: string } }).error.class).toBe("route-root-not-found");

    const notDirectory = await fetch(`${info.url}/v1/nav?path=documents/cad-notes.md`);
    expect(notDirectory.status).toBe(400);
    expect(((await notDirectory.json()) as { error: { class: string } }).error.class).toBe("route-root-not-directory");

    const badDepth = await fetch(`${info.url}/v1/nav?depth=eleven`);
    expect(badDepth.status).toBe(400);
    expect(((await badDepth.json()) as { error: { class: string } }).error.class).toBe("usage-error");
  });
});

describe("serve /v1/rg (W6)", () => {
  test.skipIf(!rgAvailable)(
    "returns the single-endpoint ukp.rg.v1 envelope with ukp_uri handoff keys",
    async () => {
      const { info } = start();
      const response = await fetch(`${info.url}/v1/rg?query=CAD`);
      expect(response.status).toBe(200);
      const envelope = await response.json() as {
        schema: string;
        endpoints: Array<{
          name: string;
          status: string;
          matches: Array<{ path: string; ukp_uri?: string }>;
        }>;
      };
      expect(envelope.schema).toBe("ukp.rg.v1");
      expect(envelope.endpoints[0]?.name).toBe("serve-fixture");
      expect(envelope.endpoints[0]?.status).toBe("succeeded");
      expect(envelope.endpoints[0]?.matches[0]?.path).toBe("documents/cad-notes.md");
      expect(envelope.endpoints[0]?.matches[0]?.ukp_uri).toBe("ukp://serve-fixture/documents/cad-notes.md");

      const noMatch = await fetch(`${info.url}/v1/rg?query=zzz-no-such-token`);
      expect(noMatch.status).toBe(200);
      const noMatchBody = await noMatch.json() as { endpoints: Array<{ status: string }> };
      expect(noMatchBody.endpoints[0]?.status).toBe("no_matches");
    },
    // The server-side run spawns rg via node spawnSync — measured ~9s per
    // spawn on this machine (Windows Defender); bun's 5s default is not enough.
    30000,
  );

  test("validates the query form and rejects non-GET methods", async () => {
    const { info } = start();
    const missing = await fetch(`${info.url}/v1/rg`);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { class: string } }).error.class).toBe("usage-error");

    const badPassthrough = await fetch(`${info.url}/v1/rg?query=x&passthrough=--json`);
    expect(badPassthrough.status).toBe(400);

    const badBoolean = await fetch(`${info.url}/v1/rg?query=x&i=true`);
    expect(badBoolean.status).toBe(400);
    expect(((await badBoolean.json()) as { error: { class: string } }).error.class).toBe("usage-error");

    const post = await fetch(`${info.url}/v1/rg?query=x`, { method: "POST" });
    expect(post.status).toBe(405);
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
    const missing = await fetch(`${info.url}/v1/nope`);
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

// ---------------------------------------------------------------------------
// W5' / D-079: serve-side TLS. --tls self-signs through the local openssl
// (Bun.spawn bypasses shell path mangling, so tests sign on every platform
// that has openssl); --tls-cert/--tls-key serve operator certificates.

const opensslAvailable =
  Bun.spawnSync(["openssl", "version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

describe("serve TLS (W5' / D-079)", () => {
  test.skipIf(!opensslAvailable)("--tls generates a self-signed identity, persists it, and reuses it on restart", async () => {
    const { spkiPinOf } = await import("../src/capabilities/tls-identity.ts");
    const first = start({ tls: { mode: "self-signed" } });
    expect(first.info.url.startsWith("https://")).toBe(true);
    expect(first.info.tls?.source).toBe("generated");
    const certPem = readFileSync(join(serviceFolder, ".ukp", "tls", "cert.pem"), "utf8");
    expect(first.info.tls?.pin).toBe(spkiPinOf(certPem));

    // Plain fetch rejects the self-signed chain; an anchored fetch (what a
    // registered client does) serves the discovery document.
    await expect(fetch(`${first.info.url}${DISCOVERY_PATH}`)).rejects.toThrow();
    const response = await fetch(`${first.info.url}${DISCOVERY_PATH}`, { tls: { ca: certPem } });
    const doc = (await response.json()) as DiscoveryDocument;
    expect(doc.protocol).toBe("ukp-remote");

    first.server.stop(true);
    const second = start({ tls: { mode: "self-signed" } });
    expect(second.info.tls?.source).toBe("persisted");
    expect(second.info.tls?.pin).toBe(first.info.tls?.pin);
  });

  test("explicit certificates with unreadable paths fail setup before listening", () => {
    expect(() =>
      start({
        tls: {
          mode: "certificates",
          certPath: join(root, "missing.cert.pem"),
          keyPath: join(root, "missing.key.pem"),
        },
      }),
    ).toThrow("TLS material");
  });

  test("--tls and --tls-cert/--tls-key flag family validation (usage errors, no listener)", async () => {
    const { executeServeCommand } = await import("../src/commands/serve.ts");
    const context = { currentDirectory: root, registryPath, qmdCommand, tokens: ["t"] };
    const clash = executeServeCommand(["--endpoint", "serve-fixture", "--tls", "--tls-cert", "x.pem"], context);
    expect(clash.exitCode).toBe(2);
    expect(clash.stderr).toContain("--tls and --tls-cert/--tls-key are mutually exclusive");
    const half = executeServeCommand(["--endpoint", "serve-fixture", "--tls-cert", "x.pem"], context);
    expect(half.exitCode).toBe(2);
    expect(half.stderr).toContain("--tls-cert and --tls-key are used together");
  });
});
