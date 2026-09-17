import { describe, expect, test, afterAll } from "bun:test";
import { createHash } from "node:crypto";
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

// ADR 0025: the fixture emits disk-honest docids; the assertion computes
// the same sha256 prefix from the served file's content.
const shaPrefix = (content: string): string =>
  createHash("sha256").update(content).digest("hex").slice(0, 6);
import { registerAt } from "../src/registry.ts";
import {
  DISCOVERY_PATH,
  startUkpServer,
  type DiscoveryDocument,
  type DoorDocument,
  type StartedServe,
} from "../src/server.ts";
import { parseServeArgs, renderServeBanner } from "../src/commands/serve.ts";
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
// A second servable endpoint for door-mode rosters (W7).
const doorSecondFolder = createService("door-second-svc", "door-second");
registerAt(registryPath, "door-second", doorSecondFolder);
// W8 write-face fixtures: a propose-declaring Service and a zero-declaration
// readonly Service (D-081) — the write face is the manifest declaration.
const writeFolder = join(root, "write-svc");
mkdirSync(join(writeFolder, ".ukp"), { recursive: true });
writeFileSync(join(writeFolder, ".ukp", "service.toml"), 'name = "write-notes"\n\n[capabilities.propose]\n', "utf8");
registerAt(registryPath, "write-notes", writeFolder);
const zeroFolder = join(root, "zero-svc");
mkdirSync(join(zeroFolder, ".ukp"), { recursive: true });
writeFileSync(join(zeroFolder, ".ukp", "service.toml"), 'name = "zero-archive"\n\n[capabilities]\n', "utf8");
registerAt(registryPath, "zero-archive", zeroFolder);

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

/** Door-mode starter: no endpointName = serve the whole registry (W7). */
function startDoor(overrides: Partial<Parameters<typeof startUkpServer>[0]> = {}): StartedServe {
  const { endpointName: _omitted, ...rest } = { endpointName: undefined, ...overrides };
  const handle = startUkpServer({ currentDirectory: root, registryPath, qmdCommand, port: 0, ...rest });
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
      reference: shaPrefix("# CAD notes\n\nCAD fixture note content.\n"),
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
  });

  test("--endpoint is optional: its absence is host door mode (W7)", () => {
    expect(parseServeArgs([])).toEqual({ host: "127.0.0.1", port: 8570 });
    expect(() => parseServeArgs(["-g"])).toThrow(/unknown option '-g'|no option/);
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

describe("serve host door mode (W7 / ADR-REM-004)", () => {
  test("GET /.well-known/ukp.json serves the scope:\"host\" door document with the full roster", async () => {
    const { info } = startDoor();
    const response = await fetch(`${info.url}${DISCOVERY_PATH}`);
    expect(response.status).toBe(200);
    const doc = await response.json() as DoorDocument;
    expect(doc.protocol).toBe("ukp-remote");
    expect(doc.protocol_version).toBe("1");
    expect(doc.scope).toBe("host");
    expect(doc.security.schemes).toEqual([]);
    // Alphabetical by name; write-notes (propose) and zero-archive (D-081
    // zero-declaration) joined the registry with the W8 write-face suite.
    expect(doc.endpoints.map((endpoint) => endpoint.name)).toEqual(
      ["door-second", "serve-fixture", "write-notes", "zero-archive"],
    );
    for (const endpoint of doc.endpoints) {
      expect(endpoint.instance_uid).toMatch(/^[0-9a-f-]{36}$/);
      expect(endpoint.capabilities.read).toEqual({ provider: "file", derived: true });
      if (endpoint.name === "door-second" || endpoint.name === "serve-fixture") {
        expect(endpoint.capabilities.search).toEqual({ provider: "qmd" });
      }
    }
    // Write-face projection: the propose declaration is visible wire-side;
    // the zero-declaration endpoint projects derived capabilities only.
    const writeNotes = doc.endpoints.find((endpoint) => endpoint.name === "write-notes");
    expect(writeNotes?.capabilities.propose).toEqual({ provider: "file" });
    const zeroArchive = doc.endpoints.find((endpoint) => endpoint.name === "zero-archive");
    expect(zeroArchive?.capabilities.propose).toBeUndefined();
    expect(zeroArchive?.capabilities.nav).toEqual({ provider: "file", derived: true });
    // No door-level identity: trust anchors are the per-endpoint pins.
    expect("instance_uid" in doc).toBe(false);
  });

  test("per-endpoint documents behind /e/<name>/ are byte-identical to single-endpoint mode", async () => {
    const door = startDoor();
    const single = start();
    const throughDoor = await (await fetch(`${door.info.url}/e/serve-fixture${DISCOVERY_PATH}`)).json() as DiscoveryDocument;
    const direct = await (await fetch(`${single.info.url}${DISCOVERY_PATH}`)).json() as DiscoveryDocument;
    expect(throughDoor).toEqual(direct);
  });

  test("/e/<name>/v1/* routes capabilities by name (search + read smoke)", async () => {
    const { info } = startDoor();
    const search = await fetch(`${info.url}/e/serve-fixture/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "fixture-cad-search-token", limit: 5 }),
    });
    expect(search.status).toBe(200);
    const envelope = await search.json() as { endpoints?: Array<{ name?: string; status?: string }> };
    expect(envelope.endpoints?.[0]?.name).toBe("serve-fixture");
    expect(envelope.endpoints?.[0]?.status).toBe("succeeded");

    const read = await fetch(`${info.url}/e/door-second/v1/read?ref=documents/cad-notes.md`);
    expect(read.status).toBe(200);
    const body = await read.json() as { ok?: boolean; content?: string };
    expect(body.ok).toBe(true);
    expect(body.content).toContain("CAD fixture note content");
  });

  test("unknown and invalid /e/<name>/ segments 404 with the available roster", async () => {
    const { info } = startDoor();
    // `%2F` (encoded slash) is the injection canary: it stays one opaque
    // segment end-to-end (WHATWG URLs normalize `%2e%2e` dot-segments but
    // never decode `%2F` into a separator), so it must die on the name gate
    // — path injection is unreachable by construction (ENDPOINT_NAME).
    for (const segment of ["missing", "Bad_Segment", "foo%2Fbar"]) {
      const response = await fetch(`${info.url}/e/${segment}${DISCOVERY_PATH}`);
      expect(response.status).toBe(404);
      const body = await response.json() as { error: { message: string } };
      expect(body.error.message).toContain(`no such endpoint '${segment}' on this host door (available: `);
      expect(body.error.message).toContain("serve-fixture");
    }
    // Door-mode route hint for non-/e/ paths.
    const alien = await fetch(`${info.url}/v1/search`, { method: "POST" });
    expect(alien.status).toBe(404);
    expect(((await alien.json()) as { error: { message: string } }).error.message).toContain("host door");
  });

  test("door-level auth: bearer covers /e/*/v1/*, documents stay public (RQ-16/18)", async () => {
    const { info } = startDoor({ tokens: ["door-token"] });
    expect((await fetch(`${info.url}${DISCOVERY_PATH}`)).status).toBe(200);
    expect((await fetch(`${info.url}/e/serve-fixture${DISCOVERY_PATH}`)).status).toBe(200);
    const denied = await fetch(`${info.url}/e/serve-fixture/v1/read?ref=documents/cad-notes.md`);
    expect(denied.status).toBe(401);
    const allowed = await fetch(`${info.url}/e/serve-fixture/v1/read?ref=documents/cad-notes.md`, {
      headers: { authorization: "Bearer door-token" },
    });
    expect(allowed.status).toBe(200);
  });

  test("the door grows without restart: a late registration appears in the roster", async () => {
    const { info } = startDoor();
    const before = await (await fetch(`${info.url}${DISCOVERY_PATH}`)).json() as DoorDocument;
    expect(before.endpoints.map((endpoint) => endpoint.name)).not.toContain("late-endpoint");
    const lateFolder = createService("late-svc", "late-endpoint");
    registerAt(registryPath, "late-endpoint", lateFolder);
    const after = await (await fetch(`${info.url}${DISCOVERY_PATH}`)).json() as DoorDocument;
    expect(after.endpoints.map((endpoint) => endpoint.name)).toContain("late-endpoint");
    const read = await fetch(`${info.url}/e/late-endpoint/v1/read?ref=documents/cad-notes.md`);
    expect(read.status).toBe(200);
  });

  test("banner: door form announces the roster and the ssh-door auth posture", () => {
    const door = startDoor();
    const doorBanner = renderServeBanner(door.info);
    expect(doorBanner).toContain("serving host door (ukp-remote v1)");
    expect(doorBanner).toContain(`discovery: ${door.info.url}${DISCOVERY_PATH} (host door)`);
    expect(doorBanner).toMatch(/endpoints: .*\bserve-fixture\b/);
    expect(doorBanner).toContain("auth: no token (loopback bind; ssh-forwarded clients authenticate by SSH key)");
    const tokenDoor = startDoor({ tokens: ["t"] });
    expect(renderServeBanner(tokenDoor.info)).toContain("auth: bearer token required");
    const single = start();
    expect(renderServeBanner(single.info)).toContain("serving endpoint 'serve-fixture' (ukp-remote v1)");
  });
});

describe("serve /v1/propose (W8 / ADR-REM-005)", () => {
  async function put(infoUrl: string, path: string, body: string, headers: Record<string, string> = {}) {
    return fetch(`${infoUrl}${path}`, {
      method: "PUT",
      headers: { "content-type": "text/plain; charset=utf-8", ...headers },
      body,
    });
  }

  test("PUT /v1/propose/<id> runs the idempotent upsert: created → unchanged → updated", async () => {
    const { info } = start({ endpointName: "write-notes" });
    const first = await put(info.url, "/v1/propose/w8-alpha", "# Proposal\n\nFirst submission.\n");
    expect(first.status).toBe(200);
    const created = await first.json() as { schema: string; status: string; revision: number; id: string; endpoint: string };
    expect(created.schema).toBe("ukp.propose.v1");
    expect(created.id).toBe("w8-alpha");
    expect(created.status).toBe("created");
    expect(created.revision).toBe(1);
    expect(created.endpoint).toBe("write-notes");
    // The file provider stored the proposal with service-maintained frontmatter.
    const stored = readFileSync(join(writeFolder, "inbox", "w8-alpha.md"), "utf8");
    expect(stored).toContain("id: w8-alpha");
    expect(stored).toContain("status: proposed");
    expect(stored).toContain("revision: 1");
    expect(stored).toContain("First submission.");

    const second = await (await put(info.url, "/v1/propose/w8-alpha", "# Proposal\n\nFirst submission.\n")).json();
    expect(second.status).toBe("unchanged");
    expect(second.revision).toBe(1);

    const third = await (await put(info.url, "/v1/propose/w8-alpha", "# Proposal\n\nRevised submission.\n")).json();
    expect(third.status).toBe("updated");
    expect(third.revision).toBe(2);
  });

  test("door face routes PUT /e/<name>/v1/propose/<id>; undeclared endpoints have no write route", async () => {
    const { info } = startDoor();
    const write = await put(info.url, "/e/write-notes/v1/propose/w8-door", "door proposal\n");
    expect(write.status).toBe(200);
    const body = await write.json() as { schema: string; status: string; endpoint: string };
    expect(body.schema).toBe("ukp.propose.v1");
    expect(body.status).toBe("created");
    expect(body.endpoint).toBe("write-notes");
    // Zero-declaration readonly Service (D-081): the write face is the
    // manifest declaration — an undeclared endpoint answers 503 with the
    // capability class, not a silent 404.
    const denied = await put(info.url, "/e/zero-archive/v1/propose/ghost", "should not land\n");
    expect(denied.status).toBe(503);
    const deniedBody = await denied.json() as { error: { class: string; message: string } };
    expect(deniedBody.error.class).toBe("capability-undeclared");
    expect(deniedBody.error.message).toContain("does not declare the propose capability");
    expect(existsSync(join(zeroFolder, "inbox", "ghost.md"))).toBe(false);
  });

  test("wire guards: method 405, bad slug 422, body cap 413, non-UTF-8 415", async () => {
    const { info } = start({ endpointName: "write-notes" });
    const wrongMethod = await fetch(`${info.url}/v1/propose/w8-alpha`, { method: "POST", body: "x" });
    expect(wrongMethod.status).toBe(405);
    expect(((await wrongMethod.json()) as { error: { class: string } }).error.class).toBe("method-not-allowed");

    const badSlug = await put(info.url, "/v1/propose/Bad_ID", "x");
    expect(badSlug.status).toBe(422);
    expect(((await badSlug.json()) as { error: { class: string } }).error.class).toBe("usage-error");

    const oversized = await put(info.url, "/v1/propose/w8-big", "x".repeat(1024 * 1024 + 1));
    expect(oversized.status).toBe(413);
    expect(((await oversized.json()) as { error: { class: string } }).error.class).toBe("payload-too-large");

    // 0xC0 0x00 is never valid UTF-8 — the fatal decoder must reject it.
    const binary = await fetch(`${info.url}/v1/propose/w8-bin`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([0xc0, 0x00, 0x41]),
    });
    expect(binary.status).toBe(415);
    expect(((await binary.json()) as { error: { class: string } }).error.class).toBe("unsupported-content-type");
  });

  test("streamed body without content-length: the post-read byte check is the authority", async () => {
    const { info } = start({ endpointName: "write-notes" });
    // No content-length header travels with a stream body, so the
    // declared-length gate sees nothing — only the post-read check bounds.
    const streamed = await fetch(`${info.url}/v1/propose/w8-big`, {
      method: "PUT",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(1024 * 1024 + 1)));
          controller.close();
        },
      }),
    });
    expect(streamed.status).toBe(413);
  });

  test("write face sits behind the bearer gate like every /v1 route", async () => {
    const { info } = start({ endpointName: "write-notes", tokens: ["w8-token"] });
    const denied = await put(info.url, "/v1/propose/w8-auth", "content\n");
    expect(denied.status).toBe(401);
    const allowed = await put(info.url, "/v1/propose/w8-auth", "content\n", { authorization: "Bearer w8-token" });
    expect(allowed.status).toBe(200);
  });

  test("banner write line: the opened write face is visible (verdict C)", () => {
    const door = startDoor();
    expect(door.info.door?.write).toEqual(["write-notes"]);
    expect(renderServeBanner(door.info)).toContain("write: write-notes (propose via PUT /e/<name>/v1/propose/<id>)");
    // A registry with no propose-declaring endpoint announces the absence.
    const bareRoot = mkdtempSync(join(tmpdir(), "ukp-serve-bare-"));
    const bareRegistry = join(bareRoot, "registry.toml");
    const bareFolder = join(bareRoot, "bare-svc");
    mkdirSync(join(bareFolder, ".ukp"), { recursive: true });
    writeFileSync(join(bareFolder, ".ukp", "service.toml"), 'name = "bare-notes"\n\n[capabilities]\n', "utf8");
    registerAt(bareRegistry, "bare-notes", bareFolder);
    const bare = startUkpServer({ currentDirectory: bareRoot, registryPath: bareRegistry, port: 0 });
    started.push(bare);
    expect(renderServeBanner(bare.info)).toContain("write: (no endpoint declares propose)");
    rmSync(bareRoot, { recursive: true, force: true });
  });
});
