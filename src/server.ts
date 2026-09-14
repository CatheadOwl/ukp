import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { loadManifest, type LoadedManifest } from "./config/manifest.ts";
import { localPathOf, readRegistry } from "./registry.ts";
import { FILE_NATIVE_CAPABILITIES } from "./config/file-native.ts";
import { certSanOf, ensureSelfSignedTlsFiles, spkiPinOf } from "./capabilities/tls-identity.ts";
import {
  buildInlineReferences,
  projectSearchEnvelope,
  runSearch,
  type SearchEnvelope,
} from "./capabilities/search.ts";
import { projectReadEnvelope, runRead, type ReadRequest } from "./capabilities/read.ts";
import { parseReadArgs } from "./commands/read.ts";
import { KitUsageError } from "./commands/kit.ts";

/** ukp-remote wire v1 server core (ADR-REM-001/002/003, ukp_remote W1
 * slice): exposes ONE registered endpoint over HTTP — a discovery document
 * (manifest projection + protocol version + instance identity) plus the two
 * read-side capability routes. The capability layer runs unchanged behind
 * the routes (provider/transport axes stay orthogonal): search via `runSearch`
 * with a single-endpoint scope, read via `runRead`. There is no session, no
 * streaming, and no server-side artifact: responses inline the reference
 * data (RQ-07) and generate a serve-scoped run id. */

export const PROTOCOL_NAME = "ukp-remote";
export const PROTOCOL_VERSION = "1";
export const DISCOVERY_PATH = "/.well-known/ukp.json";

export interface ServeConfig {
  endpointName: string;
  currentDirectory: string;
  registryPath: string;
  qmdCommand?: readonly string[];
  host?: string;
  /** 0 (or undefined → 8570) — 0 binds an ephemeral port for tests. */
  port?: number;
  /** When set, /v1/* requires `Authorization: Bearer <token>` matching ANY
   * listed token (RQ-16 multi-token: `UKP_SERVE_TOKEN=a,b,c`); the discovery
   * document stays public (ADR-REM-003: security is declared, the card is
   * readable without it). */
  tokens?: readonly string[];
  /** TLS transport (W5' / D-079): `self-signed` generates and persists an
   * identity under the Service folder (`.ukp/tls/`); `certificates` serves
   * operator-provided PEM files (Let's Encrypt IP certs, mkcert, private
   * CA). `opensslCommand` is a test injection point for the self-signing. */
  tls?:
    | { mode: "self-signed"; opensslCommand?: readonly string[] }
    | { mode: "certificates"; certPath: string; keyPath: string };
}

export interface DiscoveryDocument {
  protocol: typeof PROTOCOL_NAME;
  protocol_version: typeof PROTOCOL_VERSION;
  instance_uid: string;
  name: string;
  description?: string;
  capabilities: Record<string, { provider: string; derived?: boolean }>;
  security: { schemes: string[] };
}

export interface ServeInfo {
  endpoint: string;
  folder: string;
  instanceUid: string;
  url: string;
  host: string;
  port: number;
  authRequired: boolean;
  /** TLS identity summary (W5' / D-079) when serving over HTTPS; the pin is
   * what remote clients TOFU-pin at registration. */
  tls?: {
    pin: string;
    san: string;
    source: "generated" | "persisted" | "operator";
  };
}

export class ServeSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeSetupError";
  }
}

/** Instance identity (ADR-REM-003 / RQ-05): a UUIDv4 generated at first
 * serve and persisted beside the manifest. Clients pin it TOFU-style at
 * binding time; equality detects service replacement. Explicit deletion is
 * the only way it changes. */
function readInstanceUid(serviceFolder: string): string {
  const path = join(serviceFolder, ".ukp", "instance-uid");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(existing)) {
      return existing;
    }
  } catch {
    // first serve: generate below
  }
  const uid = crypto.randomUUID();
  writeFileSync(path, `${uid}\n`, { encoding: "utf8", mode: 0o600 });
  return uid;
}

/** Discovery document = manifest projection + transport metadata. Derived
 * file-native defaults (read/nav) are always present; declared capabilities
 * override or extend them (a declared nav replaces the derived entry). */
export function buildDiscoveryDocument(
  loaded: LoadedManifest,
  instanceUid: string,
  bearerRequired: boolean,
): DiscoveryDocument {
  const capabilities: DiscoveryDocument["capabilities"] = {};
  for (const [name, spec] of Object.entries(FILE_NATIVE_CAPABILITIES)) {
    if (spec.derived) capabilities[name] = { provider: "file", derived: true };
  }
  for (const name of Object.keys(loaded.manifest.capabilities).sort()) {
    const declared = loaded.manifest.capabilities[name]!;
    capabilities[name] = { provider: declared.provider ?? "file" };
  }
  return {
    protocol: PROTOCOL_NAME,
    protocol_version: PROTOCOL_VERSION,
    instance_uid: instanceUid,
    name: loaded.effectiveName,
    ...(loaded.manifest.description !== undefined ? { description: loaded.manifest.description } : {}),
    capabilities,
    security: { schemes: bearerRequired ? ["bearer"] : [] },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorBody(className: string, message: string): { error: { class: string; message: string } } {
  return { error: { class: className, message } };
}

/** Failure classification → HTTP status (ADR-REM-002 §6): the envelope's
 * error class is data; the status carries the same verdict for
 * non-envelope-aware middleware. */
function readHttpStatus(errorClass: string): number {
  if (errorClass === "resource-missing") return 404;
  if (errorClass === "provider-unavailable" || errorClass === "provider-timeout") return 503;
  if (errorClass === "usage-error") return 400;
  return 500;
}

function parseSearchBody(raw: unknown): { query: string; limit: number } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "request body must be a JSON object: {\"query\": string, \"limit\"?: integer}" };
  }
  const { query, limit } = raw as { query?: unknown; limit?: unknown };
  if (typeof query !== "string" || query.trim() === "") {
    return { error: "field 'query' must be a non-empty string" };
  }
  if (limit === undefined) return { query, limit: 20 };
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    return { error: "field 'limit' must be an integer between 1 and 1000" };
  }
  return { query, limit };
}

/** Wire read params → ReadRequest via the command-layer parser (single
 * source for pin form, line-window syntax, and ukp:// decoding — commands/
 * read.ts). Serve fixes the endpoint: a `uri` carrying a different endpoint
 * is an identity mismatch (RQ-14 symmetry), not a miss. */
function parseReadParams(
  endpointName: string,
  ref: string | null,
  uri: string | null,
  lines: string | null,
  pin: string | null,
): { request: ReadRequest } | { error: string; class?: string } {
  if ((ref === null) === (uri === null)) {
    return { error: "exactly one of 'ref' (endpoint-relative) or 'uri' (ukp://…) is required" };
  }
  const args = uri !== null
    ? [
      uri,
      ...(lines !== null ? ["--lines", lines] : []),
      ...(pin !== null ? ["--pin", pin] : []),
    ]
    : [
      "--endpoint",
      endpointName,
      ref!,
      ...(lines !== null ? ["--lines", lines] : []),
      ...(pin !== null ? ["--pin", pin] : []),
    ];
  let request: ReadRequest;
  try {
    request = parseReadArgs(args);
  } catch (error) {
    if (error instanceof KitUsageError) return { error: error.message };
    throw error;
  }
  if (request.endpoint !== undefined && request.endpoint !== endpointName) {
    return {
      error: `uri endpoint '${request.endpoint}' does not match served endpoint '${endpointName}'`,
      class: "identity-mismatch",
    };
  }
  return { request };
}

export interface StartedServe {
  server: ReturnType<typeof Bun.serve>;
  info: ServeInfo;
}

export function startUkpServer(config: ServeConfig): StartedServe {
  const host = config.host ?? "127.0.0.1";
  const registry = readRegistry(config.registryPath);
  const binding = registry.find((entry) => entry.name === config.endpointName);
  if (binding === undefined) {
    throw new ServeSetupError(
      `endpoint '${config.endpointName}' is not registered (Host Registry: ${config.registryPath}); run 'ukp list' to inspect registrations`,
    );
  }
  // serve exposes a local Service folder; remote bindings are refused here.
  const serviceFolder = localPathOf(binding);
  // RQ-14 symmetry: the served binding name must equal the manifest's
  // effective name, mirroring the local `effectiveName === binding.name`
  // assertion — checked at startup and on every discovery fetch.
  const startupManifest = loadManifest(serviceFolder);
  if (startupManifest.effectiveName !== binding.name) {
    throw new ServeSetupError(
      `identity mismatch: binding '${binding.name}' resolves to a Service declaring '${startupManifest.effectiveName}'`,
    );
  }

  // TLS material (W5' / D-079) is resolved before the listener starts: a
  // self-signed identity is generated/persisted beside the manifest, explicit
  // certificates are read from the operator's paths. Bun.serve takes PEM
  // contents (path-string handling is platform-dependent).
  let tlsMaterial: { cert: string; key: string; pin: string; san: string; source: "generated" | "persisted" | "operator" } | undefined;
  if (config.tls !== undefined) {
    const tls = config.tls;
    const paths = tls.mode === "self-signed"
      ? (() => {
          const identity = ensureSelfSignedTlsFiles(
            join(serviceFolder, ".ukp", "tls"),
            tls.mode === "self-signed" && tls.opensslCommand !== undefined ? { opensslCommand: tls.opensslCommand } : {},
          );
          return {
            certPath: identity.certPath,
            keyPath: identity.keyPath,
            source: identity.created ? ("generated" as const) : ("persisted" as const),
          };
        })()
      : { certPath: tls.certPath, keyPath: tls.keyPath, source: "operator" as const };
    try {
      const cert = readFileSync(paths.certPath, "utf8");
      tlsMaterial = {
        cert,
        key: readFileSync(paths.keyPath, "utf8"),
        pin: spkiPinOf(cert),
        san: certSanOf(cert),
        source: paths.source,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ServeSetupError(`TLS material for '${binding.name}' is unusable (${paths.certPath}): ${reason}`);
    }
  }

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === DISCOVERY_PATH) {
      if (request.method !== "GET") {
        return jsonResponse(errorBody("method-not-allowed", `the discovery document is a GET resource`), 405);
      }
      try {
        // Fresh manifest per fetch: same per-invocation freshness as the
        // local file-based loader (no server-side caching in v1).
        const loaded = loadManifest(serviceFolder);
        if (loaded.effectiveName !== binding.name) {
          return jsonResponse(
            errorBody(
              "identity-mismatch",
              `binding '${binding.name}' now resolves to a Service declaring '${loaded.effectiveName}'`,
            ),
            503,
          );
        }
        return jsonResponse(
          buildDiscoveryDocument(loaded, readInstanceUid(serviceFolder), (config.tokens?.length ?? 0) > 0),
        );
      } catch (error) {
        return jsonResponse(
          errorBody("provider-unavailable", `Service Manifest is not readable: ${error instanceof Error ? error.message : String(error)}`),
          503,
        );
      }
    }

    if (url.pathname === "/v1/search" || url.pathname === "/v1/read") {
      if ((config.tokens?.length ?? 0) > 0) {
        const authorization = request.headers.get("authorization");
        if (!config.tokens!.some((token) => authorization === `Bearer ${token}`)) {
          return jsonResponse(
            errorBody("auth-failure", "missing or invalid bearer token (Authorization: Bearer <token>)"),
            401,
          );
        }
      }
      return url.pathname === "/v1/search"
        ? await handleSearch(request, config, binding.name, serviceFolder)
        : handleRead(url, request, config, binding.name);
    }

    return jsonResponse(
      errorBody(
        "not-found",
        `no such route '${url.pathname}' (ukp-remote v1: GET ${DISCOVERY_PATH}, POST /v1/search, GET /v1/read)`,
      ),
      404,
    );
  };

  const server = Bun.serve({
    hostname: host,
    port: config.port ?? 8570,
    ...(tlsMaterial !== undefined ? { tls: { cert: tlsMaterial.cert, key: tlsMaterial.key } } : {}),
    fetch: handler,
  });

  const info: ServeInfo = {
    endpoint: binding.name,
    folder: serviceFolder,
    instanceUid: readInstanceUid(serviceFolder),
    url: `${tlsMaterial !== undefined ? "https" : "http"}://${host}:${server.port ?? (config.port ?? 8570)}`,
    host,
    port: server.port ?? (config.port ?? 8570),
    authRequired: (config.tokens?.length ?? 0) > 0,
    ...(tlsMaterial !== undefined
      ? { tls: { pin: tlsMaterial.pin, san: tlsMaterial.san, source: tlsMaterial.source } }
      : {}),
  };
  return { server, info };
}

async function handleSearch(
  request: Request,
  config: ServeConfig,
  endpointName: string,
  endpointFolder: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse(errorBody("method-not-allowed", "/v1/search is a POST route"), 405);
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse(errorBody("usage-error", "request body must be valid JSON"), 400);
  }
  const parsedBody = parseSearchBody(raw);
  if ("error" in parsedBody) {
    return jsonResponse(errorBody("usage-error", parsedBody.error), 400);
  }

  const result = runSearch(
    {
      request: { query: parsedBody.query, limit: parsedBody.limit },
      options: { explicitEndpoints: [endpointName], global: false, recursive: false, json: false },
      warnings: [],
    },
    {
      currentDirectory: config.currentDirectory,
      registryPath: config.registryPath,
      qmdCommand: config.qmdCommand,
    },
  );
  const envelope: SearchEnvelope = {
    ...projectSearchEnvelope(result),
    // No artifact run server-side (RQ-07): the run id is serve-scoped.
    run_id: `serve-${crypto.randomUUID()}`,
  };
  const first = result.endpoints[0];
  const references = first !== undefined && first.folder !== undefined && typeof first.providerOutput === "string"
    ? buildInlineReferences(endpointName, first.folder, first.providerOutput)
    : undefined;
  // Provider-native results array (ADR-REM-002 W2 amendment): the client's
  // human renderer needs result-unit material (title/snippet) that the
  // references mapping does not carry — this is providerOutput's wire form.
  let results: unknown[] | undefined;
  if (typeof first?.providerOutput === "string") {
    try {
      const parsed = JSON.parse(first.providerOutput);
      if (Array.isArray(parsed)) results = parsed;
    } catch {
      // Non-JSON provider output (fallback render path locally) — omit.
    }
  }
  return jsonResponse({
    ...envelope,
    ...(references !== undefined ? { references } : {}),
    ...(results !== undefined ? { results } : {}),
  });
}

function handleRead(url: URL, request: Request, config: ServeConfig, endpointName: string): Response {
  if (request.method !== "GET") {
    return jsonResponse(errorBody("method-not-allowed", "/v1/read is a GET route"), 405);
  }
  const parsed = parseReadParams(
    endpointName,
    url.searchParams.get("ref"),
    url.searchParams.get("uri"),
    url.searchParams.get("lines"),
    url.searchParams.get("pin"),
  );
  if ("error" in parsed) {
    return jsonResponse(errorBody(parsed.class ?? "usage-error", parsed.error), 400);
  }
  const outcome = runRead(parsed.request, {
    currentDirectory: config.currentDirectory,
    registryPath: config.registryPath,
    qmdCommand: config.qmdCommand,
  });
  const envelope = projectReadEnvelope(parsed.request, outcome);
  if (outcome.ok) {
    return jsonResponse({ ...envelope, content: outcome.result.content });
  }
  return jsonResponse(envelope, readHttpStatus(envelope.error?.class ?? "error"));
}
