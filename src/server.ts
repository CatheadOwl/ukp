import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, fstatSync, constants as fsConstants } from "node:fs";
import { createServer as netCreateServer, connect as netConnect, type Server as NetServer } from "node:net";
import { ENDPOINT_NAME, loadManifest, type LoadedManifest } from "./config/manifest.ts";
import { localPathOf, readRegistry } from "./registry.ts";
import { FILE_NATIVE_CAPABILITIES, resolveFileNativeCapability } from "./config/file-native.ts";
import { EXTERNAL_PROVIDER, EXTERNAL_TOOL_CAPABILITIES } from "./config/external-tool.ts";
import {
  PROPOSE_SLUG,
  ProposeBusyError,
  ProposeProviderError,
  proposeEnvelope,
  proposeUpsert,
} from "./capabilities/propose.ts";
import { certSanOf, ensureSelfSignedTlsFiles, spkiPinOf } from "./capabilities/tls-identity.ts";
import {
  buildInlineReferences,
  projectSearchEnvelope,
  runSearch,
  type SearchEnvelope,
} from "./capabilities/search.ts";
import { projectReadEnvelope, runRead, type ReadRequest } from "./capabilities/read.ts";
import { parseReadArgs } from "./commands/read.ts";
import { parseNavArgs } from "./commands/nav.ts";
import {
  runNav,
  projectNavEnvelope,
  NavUsageError,
  type NavRequest,
} from "./capabilities/nav.ts";
import {
  rgExecutableAvailable,
  runRg,
  projectRgEnvelope,
  RG_DEFAULT_LIMIT,
  RG_FILES_DEFAULT_LIMIT,
  RG_MAX_LIMIT,
  validateRgPassthrough,
  RgUsageError,
  type ParsedRg,
} from "./capabilities/rg.ts";
import { KitUsageError } from "./commands/kit.ts";

/** ukp-remote wire v1 server core (ADR-REM-001/002/003, ukp_remote W1/W7):
 * two serving shapes over one wire. Single-endpoint mode exposes ONE
 * registered endpoint; door mode (`endpointName` absent, ADR-REM-004) serves
 * every local binding in the registry, routed by name at `/e/<name>/…` with
 * a `scope:"host"` door document — the registry is read fresh per request so
 * the door grows without restart. Both shapes expose a discovery document
 * (manifest projection + protocol version + instance identity) plus the
 * read-side capability routes (search/read since W1, nav/rg since W6); the
 * per-endpoint documents are byte-identical across modes, so client-side
 * TOFU and name-assertion paths are shared. The capability layer runs
 * unchanged behind the routes (provider/transport axes stay orthogonal):
 * search via `runSearch` with a single-endpoint scope, read via `runRead`,
 * nav via `runNav`, rg via `runRg`. There is no session, no streaming, and
 * no server-side artifact: responses inline the reference data (RQ-07) and
 * generate a serve-scoped run id. */

export const PROTOCOL_NAME = "ukp-remote";
export const PROTOCOL_VERSION = "1";
export const DISCOVERY_PATH = "/.well-known/ukp.json";

/** PUT /v1/propose/{id} body cap (ADR-REM-005 §5): proposals are markdown
 * long-form text; 1 MiB is generous headroom and bounds serve memory. */
export const PROPOSE_BODY_LIMIT_BYTES = 1024 * 1024;

export interface ServeConfig {
  /** Absent = host door mode (ADR-REM-004 / O-2): serve EVERY local binding
   * in the registry over one listener, routed by name at `/e/<name>/…`, with
   * a `scope:"host"` door document at the well-known path. Present = the
   * original single-endpoint mode (N=1 retreat stays legal long-term). */
  endpointName?: string;
  currentDirectory: string;
  registryPath: string;
  qmdCommand?: readonly string[];
  host?: string;
  /** 0 (or undefined → 8570) — 0 binds an ephemeral port for tests. */
  port?: number;
  /** When set, /v1/* requires `Authorization: Bearer <token>` matching ANY
   * listed token (RQ-16 multi-token: `UKP_SERVE_TOKEN=a,b,c`); the discovery
   * document stays public (ADR-REM-003: security is declared, the card is
   * readable without it). In door mode the same gate covers all
   * `/e/<name>/v1/*` routes (door-level auth, O-2). */
  tokens?: readonly string[];
  /** TLS transport (W5' / D-079): `self-signed` generates and persists an
   * identity under the Service folder (`.ukp/tls/`) — in door mode under the
   * registry's directory, since a door has no single Service folder;
   * `certificates` serves operator-provided PEM files (Let's Encrypt IP
   * certs, mkcert, private CA). `sanEntries` (the `--tls-san` flag, already
   * normalized `IP:x`/`DNS:y`) merges extra coverage into the self-signed
   * SAN — a NAT/EIP public address no NIC carries; a persisted certificate
   * lacking a requested entry is re-signed over the same key (pin unchanged,
   * clients re-anchor). `opensslCommand` is a test injection point for the
   * self-signing. */
  tls?:
    | { mode: "self-signed"; opensslCommand?: readonly string[]; sanEntries?: readonly string[] }
    | { mode: "certificates"; certPath: string; keyPath: string };
  /** W9 / ADR-REM-006: self-reap after this many seconds without requests.
   * The orphan backstop for on-demand-woken doors — a no-TTY remote command
   * can escape SIGHUP on an abrupt disconnect, so the door bounds its own
   * lifetime instead of trusting the session to reap it. */
  maxIdleSeconds?: number;
  /** W10 / ADR-REM-006: serve on the systemd socket-activation listener
   * (LISTEN_FDS fd 3) instead of binding a port — the port belongs to the
   * socket unit; the process only exists while in use. Linux-only. */
  systemdSocket?: boolean;
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

/** Door discovery document (ADR-REM-004 / O-1): shares the well-known path
 * with endpoint documents and self-describes via `scope:"host"` — clients
 * discriminate on that field (absence = endpoint document, byte-identical to
 * the pre-door era). No door-level instance_uid: the trust anchors are the
 * per-endpoint pins inside `endpoints[]`. */
export interface DoorEndpointSummary {
  name: string;
  instance_uid: string;
  capabilities: Record<string, { provider: string; derived?: boolean }>;
}

export interface DoorDocument {
  protocol: typeof PROTOCOL_NAME;
  protocol_version: typeof PROTOCOL_VERSION;
  scope: "host";
  endpoints: DoorEndpointSummary[];
  security: { schemes: string[] };
}

export interface ServeInfo {
  /** `"door"` when serving the whole registry (endpointName absent). */
  mode: "endpoint" | "door";
  /** Single-endpoint mode fields (present iff mode === "endpoint"). */
  endpoint?: string;
  folder?: string;
  instanceUid?: string;
  /** Door mode fields (present iff mode === "door"): the startup snapshot of
   * servable endpoint names (the door itself grows without restart), plus
   * the snapshot of write-capable (propose-declaring) names — the banner's
   * "you opened a write face" line (ADR-REM-005 verdict C). */
  door?: { endpoints: string[]; write: string[] };
  url: string;
  host: string;
  port: number;
  authRequired: boolean;
  /** ripgrep availability probed once at startup IN THE DOOR'S OWN PROCESS
   * (2026-09-20, liku feedback): /v1/rg serves every endpoint and a missing
   * binary degrades per-endpoint on the wire by design — but that truth is
   * consumer-channel only. The banner line is the operator channel, and the
   * probe environment is by construction the one that matters (ukp diagnose
   * measures the invoking shell instead, which can differ from the door's
   * Task Scheduler / wake environment). */
  rg: "ok" | "missing";
  /** TLS identity summary (W5' / D-079) when serving over HTTPS; the pin is
   * what remote clients TOFU-pin at registration. `source` "re-signed" marks
   * the one start that grew SAN coverage over the existing key (--tls-san
   * added an entry the persisted certificate lacked) — pin unchanged. */
  tls?: {
    pin: string;
    san: string;
    source: "generated" | "re-signed" | "persisted" | "operator";
  };
  /** Present when --max-idle armed the self-reap timer (W9). */
  maxIdleSeconds?: number;
}

/** W9 / ADR-REM-006 (--max-idle): wrap a serve handler so the listener stops
 * itself after `maxIdleSeconds` without requests. Requests re-arm the timer
 * on entry and again once the response settles; the exit mirrors the SIGINT
 * path (stderr line + server.stop(true)), after which the process exits with
 * its already-set code. The timer is unref'd so a SIGINT/SIGTERM stop is
 * immediate — the listener, not the timer, is what holds the serve process
 * open. `stopped` fences the settle-rearm of a request that outlived the
 * window (no second fire after the first stop). The bind indirection exists
 * because Bun.serve hands back the server only after `fetch` is fixed. */
function armIdleExit(
  handler: (request: Request) => Response | Promise<Response>,
  maxIdleSeconds: number,
): { fetch: (request: Request) => Response | Promise<Response>; bind: (stop: () => void) => void } {
  const control = { stop: (): void => {} };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const rearm = () => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      stopped = true;
      console.error(`ukp serve: idle exit (--max-idle ${maxIdleSeconds}s without requests)`);
      control.stop();
    }, maxIdleSeconds * 1000);
    // Best-effort unref: present in Bun and Node; a missing no-op keeps this
    // portable without changing the firing behavior while serving.
    (timer as { unref?: () => void }).unref?.();
  };
  rearm();
  return {
    fetch: (request: Request) => {
      rearm();
      const response = handler(request);
      Promise.resolve(response).then(rearm, () => {});
      return response;
    },
    bind(stop: () => void) {
      control.stop = stop;
    },
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

/** Capability projection shared by endpoint and door documents: derived
 * file-native defaults (read/nav) are always present, then the external-tool
 * base tier (rg, ADR-RG-003 — served on /v1/rg for every endpoint; a missing
 * binary degrades to per-endpoint availability data per the W6 wire
 * contract, never an undeclared capability); declared capabilities override
 * or extend both (a declared nav or rg replaces the default entry). */
function projectCapabilities(loaded: LoadedManifest): DiscoveryDocument["capabilities"] {
  const capabilities: DiscoveryDocument["capabilities"] = {};
  for (const [name, spec] of Object.entries(FILE_NATIVE_CAPABILITIES)) {
    if (spec.derived) capabilities[name] = { provider: "file", derived: true };
  }
  for (const name of Object.keys(EXTERNAL_TOOL_CAPABILITIES)) {
    capabilities[name] = { provider: EXTERNAL_PROVIDER, derived: true };
  }
  for (const name of Object.keys(loaded.manifest.capabilities).sort()) {
    const declared = loaded.manifest.capabilities[name]!;
    capabilities[name] = { provider: declared.provider ?? "file" };
  }
  return capabilities;
}

/** Discovery document = manifest projection + transport metadata. */
export function buildDiscoveryDocument(
  loaded: LoadedManifest,
  instanceUid: string,
  bearerRequired: boolean,
): DiscoveryDocument {
  return {
    protocol: PROTOCOL_NAME,
    protocol_version: PROTOCOL_VERSION,
    instance_uid: instanceUid,
    name: loaded.effectiveName,
    ...(loaded.manifest.description !== undefined ? { description: loaded.manifest.description } : {}),
    capabilities: projectCapabilities(loaded),
    security: { schemes: bearerRequired ? ["bearer"] : [] },
  };
}

/** Servable endpoints of a door (O-2): every LOCAL binding in the registry,
 * read fresh by the caller per request (new endpoints appear without a
 * restart). Remote bindings are not servable and never make the roster. */
function listDoorEndpoints(registryPath: string): Array<{ name: string; folder: string }> {
  return readRegistry(registryPath)
    .filter((binding) => binding.kind !== "remote")
    .map((binding) => ({ name: binding.name, folder: binding.path! }));
}

/** Startup snapshot of write-capable (propose-declaring) door endpoints —
 * the banner line that makes the opened write face visible (ADR-REM-005
 * verdict C). Unreadable/name-drifted Services drop out silently here;
 * they are already reported by the roster/discovery paths. */
function listWriteEndpoints(registryPath: string): string[] {
  return listDoorEndpoints(registryPath).flatMap((endpoint) => {
    try {
      const loaded = loadManifest(endpoint.folder);
      return loaded.effectiveName === endpoint.name
        && resolveFileNativeCapability(loaded.manifest, "propose") !== undefined
        ? [endpoint.name]
        : [];
    } catch {
      return [];
    }
  });
}

/** Door document (O-1): per-endpoint projection of the same fields an
 * endpoint document carries (name, instance_uid, capabilities). Endpoints
 * whose manifest is unreadable or whose name drifted from the binding
 * (RQ-14) are omitted from the roster with a serve-side stderr note — a
 * broken Service must not take the whole door document down. */
function buildDoorDocument(
  endpoints: ReadonlyArray<{ name: string; folder: string }>,
  bearerRequired: boolean,
): DoorDocument {
  const summaries: DoorEndpointSummary[] = [];
  for (const endpoint of endpoints) {
    try {
      const loaded = loadManifest(endpoint.folder);
      if (loaded.effectiveName !== endpoint.name) {
        console.error(
          `ukp serve: door endpoint '${endpoint.name}' skipped: binding resolves to a Service declaring '${loaded.effectiveName}'`,
        );
        continue;
      }
      summaries.push({
        name: endpoint.name,
        instance_uid: readInstanceUid(endpoint.folder),
        capabilities: projectCapabilities(loaded),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`ukp serve: door endpoint '${endpoint.name}' skipped: ${reason.split("\n")[0]}`);
    }
  }
  return {
    protocol: PROTOCOL_NAME,
    protocol_version: PROTOCOL_VERSION,
    scope: "host",
    endpoints: summaries,
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

/** Same verdict carrier for nav's failure vocabulary (W6): a missed route
 * root is a 404, addressing a non-directory is a client fault, and the
 * identity/config classes say "this service cannot answer right now". */
function navHttpStatus(errorClass: string): number {
  if (errorClass === "route-root-not-found") return 404;
  if (errorClass === "route-root-not-directory") return 400;
  if (
    errorClass === "provider-unsupported"
    || errorClass === "no-endpoint"
    || errorClass === "endpoint-name-mismatch"
  ) {
    return 503;
  }
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
    return { error: "exactly one of 'ref' (endpoint-relative) or 'uri' (ukp://...) is required" };
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

/** Wire nav params → NavRequest via the command-layer parser (same
 * single-source stance as read: depth form/range and route-path lexical
 * validation live in one place). Serve fixes the endpoint. */
function parseNavParams(
  endpointName: string,
  path: string | null,
  depth: string | null,
): { request: NavRequest } | { error: string } {
  const args = [
    "--endpoint",
    endpointName,
    ...(path !== null ? [path] : []),
    ...(depth !== null ? ["--depth", depth] : []),
  ];
  try {
    return { request: parseNavArgs(args) };
  } catch (error) {
    if (error instanceof KitUsageError || error instanceof NavUsageError) {
      return { error: error.message };
    }
    throw error;
  }
}

/** Wire rg params → ParsedRg with serve-fixed scope. Params are flat (no
 * argv reconstruction needed): query/limit/glob/type/i/count/files map onto
 * ParsedRg directly and passthrough re-validates against the same
 * allowlist (ADR-RG-002) before any endpoint work starts. Files mode
 * (ADR-RG-005) mirrors the CLI parse layer's mutual exclusions so the wire
 * keeps the same strictness as query/limit. */
function parseRgParams(
  endpointName: string,
  url: URL,
): { parsed: ParsedRg } | { error: string } {
  // Boolean params are strictly "1"/"0" — same strictness as query/limit, so
  // a hand-crafted `i=true` is a visible usage error, not a silent mode miss.
  const booleanOf = (name: string): boolean | { error: string } => {
    const raw = url.searchParams.get(name);
    if (raw === null) return false;
    if (raw === "1") return true;
    if (raw === "0") return false;
    return { error: `'${name}' must be 1 or 0` };
  };
  const files = booleanOf("files");
  if (typeof files === "object") return files;
  const ignoreCase = booleanOf("i");
  if (typeof ignoreCase === "object") return ignoreCase;
  const count = booleanOf("count");
  if (typeof count === "object") return count;
  const query = url.searchParams.get("query");
  if (files && count) {
    return { error: "'files' and 'count' cannot be used together (pick one output mode)" };
  }
  if (files && ignoreCase) {
    return { error: "'files' cannot be combined with 'i': pass an --iglob passthrough arg for a case-insensitive glob filter" };
  }
  if (files && query !== null) {
    return { error: "'files' takes no 'query' - use 'glob' to filter by name" };
  }
  if (!files && (query === null || query.length === 0)) {
    return { error: "'query' is required and must be a non-empty pattern (or pass files=1 for enumeration mode)" };
  }
  let limit = files ? RG_FILES_DEFAULT_LIMIT : RG_DEFAULT_LIMIT;
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null) {
    if (!/^[0-9]+$/.test(rawLimit)) return { error: "'limit' must be a decimal integer" };
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RG_MAX_LIMIT) {
      return { error: `'limit' must be between 1 and ${RG_MAX_LIMIT}` };
    }
  }
  const passthrough = url.searchParams.getAll("passthrough");
  try {
    validateRgPassthrough(passthrough);
  } catch (error) {
    if (error instanceof RgUsageError) return { error: error.message };
    throw error;
  }
  const globs = url.searchParams.getAll("glob");
  const type = url.searchParams.get("type");
  return {
    parsed: {
      request: { query: files ? "" : query!, limit },
      options: {
        explicitEndpoints: [endpointName],
        global: false,
        ...(globs.length > 0 ? { globs } : {}),
        ...(type !== null ? { type } : {}),
        ...(ignoreCase ? { ignoreCase: true } : {}),
        ...(count ? { count: true } : {}),
        ...(files ? { files: true } : {}),
        passthrough,
      },
      warnings: [],
    },
  };
}

export interface StartedServe {
  server: ReturnType<typeof Bun.serve>;
  info: ServeInfo;
  /** Composite stop: in socket-activation mode this also closes the fd3
   * acceptor (Bun.serve's own stop alone would leave the process alive
   * holding the systemd-passed listener). Safe to call from the SIGINT/
   * SIGTERM/SIGHUP handlers and the idle-exit path alike. */
  stopAll: () => void;
}

/** W10 / ADR-REM-006: parse the systemd LISTEN_FDS convention — exactly one
 * listening fd expected (fd 3), PID-guarded, and the variables are CONSUMED
 * (unset) so any child process does not double-count inherited activation
 * fds (the podman fd-counting pitfall, knowledge §5.2). */
const S_ISSOCK = fsConstants.S_IFSOCK;

export function parseListenFds(env: NodeJS.ProcessEnv): { fd: number } | { error: string } {
  if ((env.LISTEN_FDS ?? "") === "" || (env.LISTEN_PID ?? "") === "") {
    return {
      error:
        "--systemd-socket requires systemd socket activation: LISTEN_FDS/LISTEN_PID are not set (run under a .socket unit or systemd-socket-activate)",
    };
  }
  if (Number(env.LISTEN_PID) !== process.pid) {
    return { error: `LISTEN_PID ${env.LISTEN_PID} does not match this process (${process.pid}) - inherited activation variables belong to another process` };
  }
  const count = Number(env.LISTEN_FDS);
  if (!Number.isSafeInteger(count) || count < 1) {
    return { error: `LISTEN_FDS=${String(env.LISTEN_FDS)} is not a positive integer` };
  }
  if (count !== 1) {
    return { error: `expected exactly one listening fd (LISTEN_FDS=1), got ${count} - run one socket unit per serve instance` };
  }
  delete env.LISTEN_FDS;
  delete env.LISTEN_PID;
  return { fd: 3 };
}

/** W10 / ADR-REM-006: the in-process bridge. Bun.serve cannot adopt a raw
 * listening fd (no public API; ali probe 2026-09-19), but node:net can
 * (`createServer().listen({fd: 3})` verified under bun). Each connection the
 * systemd-held listener accepts is piped to the real Bun.serve listener on
 * an ephemeral loopback port — the fake-ssh proxy pattern, in-process. */
export function createSocketBridge(acceptor: NetServer, targetPort: number): { destroyAll: () => void } {
  // Live connections are tracked so stopAll can force-close the pairs — a
  // peer that receives FIN but never closes (half-open keep-alive shape)
  // would otherwise hold the process open after the idle exit forever
  // (review P2: probe-confirmed liveness hang), letting stale serve
  // processes accumulate beside systemd's fresh spawns.
  const live = new Set<{ socket: import("node:net").Socket; upstream: import("node:net").Socket }>();
  acceptor.on("connection", (socket) => {
    const upstream = netConnect({ host: "127.0.0.1", port: targetPort });
    const pair = { socket, upstream };
    live.add(pair);
    socket.pipe(upstream);
    upstream.pipe(socket);
    const drop = () => {
      live.delete(pair);
      socket.destroy();
      upstream.destroy();
    };
    socket.on("error", drop);
    upstream.on("error", drop);
    socket.on("close", () => {
      live.delete(pair);
      upstream.destroy();
    });
    upstream.on("close", () => {
      live.delete(pair);
      socket.destroy();
    });
  });
  return {
    destroyAll() {
      for (const pair of live) {
        pair.socket.destroy();
        pair.upstream.destroy();
      }
      live.clear();
    },
  };
}

/** One serve listener, both modes (W10): plain binding by default; under
 * `systemdSocket` the systemd-passed fd 3 is adopted via node:net and
 * bridged to the real Bun.serve listener on an ephemeral loopback port. */
function startServeListener(
  handler: (request: Request) => Response | Promise<Response>,
  options: {
    host: string;
    port?: number;
    tlsMaterial?: { cert: string; key: string };
    maxIdleSeconds?: number;
    systemdSocket?: boolean;
  },
): { server: ReturnType<typeof Bun.serve>; stopAll: () => void; publicUrl: string; port: number } {
  const idle = options.maxIdleSeconds !== undefined ? armIdleExit(handler, options.maxIdleSeconds) : undefined;
  const fetch = idle?.fetch ?? handler;
  const tls = options.tlsMaterial !== undefined ? { tls: { cert: options.tlsMaterial.cert, key: options.tlsMaterial.key } } : {};
  const scheme = options.tlsMaterial !== undefined ? "https" : "http";

  if (options.systemdSocket !== true) {
    const server = Bun.serve({ hostname: options.host, port: options.port ?? 8570, ...tls, fetch });
    idle?.bind(() => server.stop(true));
    const port = server.port ?? (options.port ?? 8570);
    return { server, stopAll: () => server.stop(true), publicUrl: `${scheme}://${options.host}:${port}`, port };
  }

  if (process.platform !== "linux") {
    throw new ServeSetupError("--systemd-socket is Linux-only (systemd socket activation)");
  }
  const parsed = parseListenFds(process.env);
  if ("error" in parsed) throw new ServeSetupError(parsed.error);
  // Validate the fd synchronously: systemd passes a bound LISTENING socket;
  // anything else (EBADF, wrong type) must fail setup, not crash later.
  let isSocket = false;
  try {
    const stats = fstatSync(parsed.fd);
    isSocket = (stats.mode & S_ISSOCK) === S_ISSOCK;
  } catch {
    isSocket = false;
  }
  if (!isSocket) {
    throw new ServeSetupError(`fd ${parsed.fd} is not an open socket - socket activation must pass a bound listening socket`);
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, ...tls, fetch });
  const acceptor = netCreateServer();
  const bridge = createSocketBridge(acceptor, server.port ?? 0);
  acceptor.on("error", (error) => {
    // Async setup failure channel (e.g. fd 3 is a CONNECTED socket — passes
    // the S_IFSOCK pre-check but cannot listen): no hard exit from library
    // code — report, stop both listeners, and let the loop drain with a
    // failing exit code.
    console.error(`ukp serve: fd${parsed.fd} acceptor failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    acceptor.close();
    bridge.destroyAll();
    server.stop(true);
  });
  acceptor.listen({ fd: parsed.fd });
  const stopAll = () => {
    acceptor.close();
    bridge.destroyAll();
    server.stop(true);
  };
  idle?.bind(stopAll);
  return {
    server,
    stopAll,
    publicUrl: `systemd:fd${parsed.fd} (bridge ${scheme}://127.0.0.1:${server.port})`,
    port: server.port ?? 0,
  };
}

/** TLS material resolution (W5' / D-079), shared by both serve modes: a
 * self-signed identity is generated/re-signed/persisted under `identityDir`
 * (the Service folder's `.ukp/tls/` in endpoint mode, the registry directory
 * in door mode — a door has no single Service folder), explicit certificates
 * are read from the operator's paths. Bun.serve takes PEM contents
 * (path-string handling is platform-dependent). Every failure — unreadable
 * operator files, an unusable persisted identity, openssl unable to sign —
 * surfaces as one ServeSetupError naming the certificate path. */
function resolveTlsMaterial(
  config: ServeConfig,
  identityDir: string,
): { cert: string; key: string; pin: string; san: string; source: "generated" | "re-signed" | "persisted" | "operator" } | undefined {
  if (config.tls === undefined) return undefined;
  const tls = config.tls;
  let certPath: string | undefined;
  try {
    let keyPath: string;
    let source: "generated" | "re-signed" | "persisted" | "operator";
    if (tls.mode === "self-signed") {
      const identity = ensureSelfSignedTlsFiles(
        identityDir,
        {
          ...(tls.opensslCommand !== undefined ? { opensslCommand: tls.opensslCommand } : {}),
          ...(tls.sanEntries !== undefined ? { extraSanEntries: tls.sanEntries } : {}),
        },
      );
      certPath = identity.certPath;
      keyPath = identity.keyPath;
      source = identity.source;
    } else {
      certPath = tls.certPath;
      keyPath = tls.keyPath;
      source = "operator";
    }
    const cert = readFileSync(certPath, "utf8");
    return {
      cert,
      key: readFileSync(keyPath, "utf8"),
      pin: spkiPinOf(cert),
      san: certSanOf(cert),
      source,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ServeSetupError(`TLS material is unusable (${certPath ?? join(identityDir, "cert.pem")}): ${reason}`);
  }
}

function bearerGate(
  request: Request,
  tokens: readonly string[] | undefined,
): Response | undefined {
  if ((tokens?.length ?? 0) === 0) return undefined;
  const authorization = request.headers.get("authorization");
  if (!tokens!.some((token) => authorization === `Bearer ${token}`)) {
    return jsonResponse(
      errorBody("auth-failure", "missing or invalid bearer token (Authorization: Bearer <token>)"),
      401,
    );
  }
  return undefined;
}

/** Per-request endpoint resolution for door routing (O-2): the registry is
 * read fresh, the name segment has already passed ENDPOINT_NAME (injection
 * unreachable), unknown and non-servable names get the roster 404, and the
 * RQ-14 binding↔manifest identity check runs per request like the
 * single-mode discovery fetch does. */
function resolveDoorRoute(
  registryPath: string,
  name: string,
): { folder: string } | { response: Response } {
  let binding;
  try {
    binding = readRegistry(registryPath).find((entry) => entry.name === name);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { response: jsonResponse(errorBody("provider-unavailable", `Host Registry is not readable: ${reason}`), 503) };
  }
  if (binding === undefined || binding.kind === "remote") {
    const roster = listDoorEndpoints(registryPath).map((endpoint) => endpoint.name).join(", ");
    return {
      response: jsonResponse(
        errorBody("not-found", `no such endpoint '${name}' on this host door (available: ${roster})`),
        404,
      ),
    };
  }
  let folder: string;
  try {
    folder = localPathOf(binding);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { response: jsonResponse(errorBody("provider-unavailable", reason), 503) };
  }
  try {
    const loaded = loadManifest(folder);
    if (loaded.effectiveName !== name) {
      return {
        response: jsonResponse(
          errorBody(
            "identity-mismatch",
            `binding '${name}' resolves to a Service declaring '${loaded.effectiveName}'`,
          ),
          503,
        ),
      };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { response: jsonResponse(errorBody("provider-unavailable", `Service Manifest is not readable: ${reason}`), 503) };
  }
  return { folder };
}

/** Door-mode routing table (ADR-REM-004 / O-2). The door document and the
 * per-endpoint documents stay public (ADR-REM-003 declaration/capability
 * divide); every `/e/<name>/v1/*` route passes the door-level bearer gate. */
function doorNotFound(name: string | undefined, registryPath: string): Response {
  if (name !== undefined) {
    const roster = listDoorEndpoints(registryPath).map((endpoint) => endpoint.name).join(", ");
    return jsonResponse(
      errorBody("not-found", `no such endpoint '${name}' on this host door (available: ${roster})`),
      404,
    );
  }
  return jsonResponse(
    errorBody(
      "not-found",
      `no such route (ukp-remote v1 host door: GET ${DISCOVERY_PATH}, GET /e/<name>${DISCOVERY_PATH}, POST /e/<name>/v1/search, GET /e/<name>/v1/read, GET /e/<name>/v1/nav, GET /e/<name>/v1/rg, PUT /e/<name>/v1/propose/<id>)`,
    ),
    404,
  );
}

function startDoorServer(config: ServeConfig, host: string, tlsMaterial: ReturnType<typeof resolveTlsMaterial>): StartedServe {
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === DISCOVERY_PATH) {
      if (request.method !== "GET") {
        return jsonResponse(errorBody("method-not-allowed", `the discovery document is a GET resource`), 405);
      }
      try {
        return jsonResponse(buildDoorDocument(listDoorEndpoints(config.registryPath), (config.tokens?.length ?? 0) > 0));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return jsonResponse(errorBody("provider-unavailable", `Host Registry is not readable: ${reason}`), 503);
      }
    }

    // /e/<name>/… — the name segment is validated against ENDPOINT_NAME
    // before any filesystem work; anything else cannot name an endpoint.
    const routeMatch = url.pathname.match(/^\/e\/([^/]+)(\/.*)?$/);
    if (routeMatch !== null) {
      const name = routeMatch[1]!;
      const rest = routeMatch[2] ?? "/";
      if (!ENDPOINT_NAME.test(name)) {
        return doorNotFound(name, config.registryPath);
      }
      if (rest === DISCOVERY_PATH) {
        if (request.method !== "GET") {
          return jsonResponse(errorBody("method-not-allowed", `the discovery document is a GET resource`), 405);
        }
        const resolved = resolveDoorRoute(config.registryPath, name);
        if ("response" in resolved) return resolved.response;
        try {
          const loaded = loadManifest(resolved.folder);
          return jsonResponse(
            buildDiscoveryDocument(loaded, readInstanceUid(resolved.folder), (config.tokens?.length ?? 0) > 0),
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return jsonResponse(errorBody("provider-unavailable", `Service Manifest is not readable: ${reason}`), 503);
        }
      }
      if (rest.startsWith("/v1/propose/")) {
        const denied = bearerGate(request, config.tokens);
        if (denied !== undefined) return denied;
        const id = rest.slice("/v1/propose/".length);
        if (id.includes("/")) return doorNotFound(undefined, config.registryPath);
        const resolved = resolveDoorRoute(config.registryPath, name);
        if ("response" in resolved) return resolved.response;
        return await handlePropose(request, config, name, resolved.folder, id);
      }
      if (rest === "/v1/search" || rest === "/v1/read" || rest === "/v1/nav" || rest === "/v1/rg") {
        const denied = bearerGate(request, config.tokens);
        if (denied !== undefined) return denied;
        const resolved = resolveDoorRoute(config.registryPath, name);
        if ("response" in resolved) return resolved.response;
        if (rest === "/v1/search") {
          return await handleSearch(request, config, name, resolved.folder);
        }
        if (rest === "/v1/read") {
          return handleRead(url, request, config, name);
        }
        if (rest === "/v1/nav") {
          return handleNav(url, request, config, name);
        }
        return handleRg(url, request, config, name);
      }
      return doorNotFound(undefined, config.registryPath);
    }

    return doorNotFound(undefined, config.registryPath);
  };

  const listener = startServeListener(handler, {
    host,
    ...(config.port !== undefined ? { port: config.port } : {}),
    ...(tlsMaterial !== undefined ? { tlsMaterial } : {}),
    ...(config.maxIdleSeconds !== undefined ? { maxIdleSeconds: config.maxIdleSeconds } : {}),
    ...(config.systemdSocket === true ? { systemdSocket: true } : {}),
  });
  const { server } = listener;

  const info: ServeInfo = {
    mode: "door",
    door: {
      endpoints: listDoorEndpoints(config.registryPath).map((endpoint) => endpoint.name),
      write: listWriteEndpoints(config.registryPath),
    },
    url: listener.publicUrl,
    host,
    port: listener.port,
    authRequired: (config.tokens?.length ?? 0) > 0,
    rg: rgExecutableAvailable() ? "ok" : "missing",
    ...(tlsMaterial !== undefined
      ? { tls: { pin: tlsMaterial.pin, san: tlsMaterial.san, source: tlsMaterial.source } }
      : {}),
    ...(config.maxIdleSeconds !== undefined ? { maxIdleSeconds: config.maxIdleSeconds } : {}),
  };
  return { server, info, stopAll: listener.stopAll };
}

export function startUkpServer(config: ServeConfig): StartedServe {
  const host = config.host ?? "127.0.0.1";

  if (config.endpointName === undefined) {
    // Door mode: no single binding to resolve; the registry is read per
    // request (new endpoints appear without restart, O-2).
    const tlsMaterial = resolveTlsMaterial(config, join(dirname(config.registryPath), "tls"));
    return startDoorServer(config, host, tlsMaterial);
  }

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

  const tlsMaterial = resolveTlsMaterial(config, join(serviceFolder, ".ukp", "tls"));

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

    if (url.pathname.startsWith("/v1/propose/")) {
      const denied = bearerGate(request, config.tokens);
      if (denied !== undefined) return denied;
      const id = url.pathname.slice("/v1/propose/".length);
      if (id.includes("/")) {
        return jsonResponse(
          errorBody(
            "not-found",
            `no such route '${url.pathname}' (ukp-remote v1: GET ${DISCOVERY_PATH}, POST /v1/search, GET /v1/read, GET /v1/nav, GET /v1/rg, PUT /v1/propose/<id>)`,
          ),
          404,
        );
      }
      return await handlePropose(request, config, binding.name, serviceFolder, id);
    }

    if (
      url.pathname === "/v1/search"
      || url.pathname === "/v1/read"
      || url.pathname === "/v1/nav"
      || url.pathname === "/v1/rg"
    ) {
      const denied = bearerGate(request, config.tokens);
      if (denied !== undefined) return denied;
      if (url.pathname === "/v1/search") {
        return await handleSearch(request, config, binding.name, serviceFolder);
      }
      if (url.pathname === "/v1/read") {
        return handleRead(url, request, config, binding.name);
      }
      if (url.pathname === "/v1/nav") {
        return handleNav(url, request, config, binding.name);
      }
      return handleRg(url, request, config, binding.name);
    }

    return jsonResponse(
      errorBody(
        "not-found",
        `no such route '${url.pathname}' (ukp-remote v1: GET ${DISCOVERY_PATH}, POST /v1/search, GET /v1/read, GET /v1/nav, GET /v1/rg, PUT /v1/propose/<id>)`,
      ),
      404,
    );
  };

  const listener = startServeListener(handler, {
    host,
    ...(config.port !== undefined ? { port: config.port } : {}),
    ...(tlsMaterial !== undefined ? { tlsMaterial } : {}),
    ...(config.maxIdleSeconds !== undefined ? { maxIdleSeconds: config.maxIdleSeconds } : {}),
    ...(config.systemdSocket === true ? { systemdSocket: true } : {}),
  });
  const { server } = listener;

  const info: ServeInfo = {
    mode: "endpoint",
    endpoint: binding.name,
    folder: serviceFolder,
    instanceUid: readInstanceUid(serviceFolder),
    url: listener.publicUrl,
    host,
    port: listener.port,
    authRequired: (config.tokens?.length ?? 0) > 0,
    rg: rgExecutableAvailable() ? "ok" : "missing",
    ...(tlsMaterial !== undefined
      ? { tls: { pin: tlsMaterial.pin, san: tlsMaterial.san, source: tlsMaterial.source } }
      : {}),
    ...(config.maxIdleSeconds !== undefined ? { maxIdleSeconds: config.maxIdleSeconds } : {}),
  };
  return { server, info, stopAll: listener.stopAll };
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

/** GET /v1/nav?path=&depth= → the nav envelope IS the response (W6): the
 * client renders it through the same renderNavHuman/renderNavJson path as a
 * local run. Failures use the transport error shape with nav's classes. */
function handleNav(url: URL, request: Request, config: ServeConfig, endpointName: string): Response {
  if (request.method !== "GET") {
    return jsonResponse(errorBody("method-not-allowed", "/v1/nav is a GET route"), 405);
  }
  const parsed = parseNavParams(endpointName, url.searchParams.get("path"), url.searchParams.get("depth"));
  if ("error" in parsed) {
    return jsonResponse(errorBody("usage-error", parsed.error), 400);
  }
  const outcome = runNav(parsed.request, {
    currentDirectory: config.currentDirectory,
    registryPath: config.registryPath,
  });
  if (outcome.ok) {
    return jsonResponse(projectNavEnvelope(outcome.result));
  }
  return jsonResponse(
    errorBody(outcome.failure.errorClass, outcome.failure.message),
    navHttpStatus(outcome.failure.errorClass),
  );
}

/** GET /v1/rg?query=… → the single-endpoint rg envelope (W6). Failures are
 * per-endpoint data inside the envelope (D-036), so the route always
 * answers 200 — same stance as /v1/search. */
function handleRg(url: URL, request: Request, config: ServeConfig, endpointName: string): Response {
  if (request.method !== "GET") {
    return jsonResponse(errorBody("method-not-allowed", "/v1/rg is a GET route"), 405);
  }
  const parsed = parseRgParams(endpointName, url);
  if ("error" in parsed) {
    return jsonResponse(errorBody("usage-error", parsed.error), 400);
  }
  const result = runRg(parsed.parsed, {
    currentDirectory: config.currentDirectory,
    registryPath: config.registryPath,
  });
  return jsonResponse(projectRgEnvelope(result));
}

/** PUT /v1/propose/{id} (W8 / ADR-REM-005): the write face. Body = the
 * proposal text itself (UTF-8); the response IS the ukp.propose.v1
 * envelope, byte-equivalent to the CLI --json rendering. Wire guards: slug
 * re-validation (422), body cap (413), strict UTF-8 (415); the write-face
 * scope is the manifest declaration (RQ-23) — an endpoint not declaring
 * propose has no writable route (503 capability-undeclared). */
async function handlePropose(
  request: Request,
  _config: ServeConfig,
  endpointName: string,
  endpointFolder: string,
  id: string,
): Promise<Response> {
  if (request.method !== "PUT") {
    return jsonResponse(errorBody("method-not-allowed", "/v1/propose/<id> is a PUT route"), 405);
  }
  if (!PROPOSE_SLUG.test(id)) {
    return jsonResponse(
      errorBody("usage-error", `invalid proposal id '${id}': expected 1-63 lowercase ASCII slug characters ([a-z0-9-])`),
      422,
    );
  }
  // Size gate before reading (declared length) and after (truth) — the
  // content-length header can be absent or a lie; the post-read check is
  // the authoritative bound (the transport-level buffer ceiling is
  // Bun.serve's default request-body cap, not this limit).
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > PROPOSE_BODY_LIMIT_BYTES) {
    return jsonResponse(errorBody("payload-too-large", `proposal body exceeds ${PROPOSE_BODY_LIMIT_BYTES} bytes`), 413);
  }
  let buffer: ArrayBuffer;
  try {
    buffer = await request.arrayBuffer();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return jsonResponse(errorBody("usage-error", `cannot read proposal body: ${reason}`), 400);
  }
  if (buffer.byteLength > PROPOSE_BODY_LIMIT_BYTES) {
    return jsonResponse(errorBody("payload-too-large", `proposal body exceeds ${PROPOSE_BODY_LIMIT_BYTES} bytes`), 413);
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return jsonResponse(errorBody("unsupported-content-type", "proposal body must be valid UTF-8 text"), 415);
  }

  let loaded: LoadedManifest;
  try {
    loaded = loadManifest(endpointFolder);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return jsonResponse(errorBody("provider-unavailable", `Service Manifest is not readable: ${reason}`), 503);
  }
  const resolved = resolveFileNativeCapability(loaded.manifest, "propose");
  if (!resolved) {
    return jsonResponse(
      errorBody("capability-undeclared", `endpoint '${endpointName}' does not declare the propose capability`),
      503,
    );
  }

  try {
    const result = proposeUpsert(endpointFolder, resolved.capability, id, content);
    return jsonResponse(proposeEnvelope(endpointName, result));
  } catch (error) {
    if (error instanceof ProposeBusyError || error instanceof ProposeProviderError) {
      // Same-family transient/provider failures on the write path (lock
      // contention, folder config, stored-document corruption): the
      // message is factual data ("retry shortly" for busy) and maps to
      // the provider-failed transport class (RQ-09).
      return jsonResponse(errorBody("provider-failed", error.message), 503);
    }
    const reason = error instanceof Error ? error.message : String(error);
    return jsonResponse(errorBody("provider-failed", `proposal submission failed: ${reason}`), 500);
  }
}
