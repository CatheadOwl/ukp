import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, fstatSync, constants as fsConstants } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
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
import { certSanOf, ensureSelfSignedTlsFiles, migrateLegacyServiceTlsDir, spkiPinOf } from "./capabilities/tls-identity.ts";
import { retireTlsIgnoreLine } from "./commands/init.ts";
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
import {
  authenticateBearerKey,
  loadTokenFile,
  parseTokenFileText,
  scopeAllows,
  type ScopeAccess,
  type TokenFileEntry,
} from "./plumbing/token-file.ts";

/** ukp-remote wire v1 server core (ADR-REM-001/002/003, ukp_remote W1/W7):
 * two serving shapes over one wire. Single-endpoint mode exposes ONE
 * registered endpoint; door mode (`endpointName` absent, ADR-REM-004) serves
 * local bindings in the registry, routed by name at `/e/<name>/…` with
 * a `scope:"host"` door document — the registry is read fresh per request so
 * the door grows without restart. Door mode comes in two widths
 * (ADR-REM-010): every local binding, or the `select` whitelist subset. To
 * anyone the subset excludes, the door pretends those endpoints do not
 * exist — roster, routes, per-endpoint documents, and 404 rosters all see
 * the same effective set (select ∩ current registry). Both shapes expose a
 * discovery document (manifest projection + protocol version + instance
 * identity) plus the read-side capability routes (search/read since W1,
 * nav/rg since W6); the per-endpoint documents are byte-identical across
 * modes, so client-side TOFU and name-assertion paths are shared. The
 * capability layer runs unchanged behind the routes (provider/transport
 * axes stay orthogonal): search via `runSearch` with a single-endpoint
 * scope, read via `runRead`, nav via `runNav`, rg via `runRg`. The bearer
 * gate has two sources (W13 / RQ-16c): env tokens — the full-power
 * shortcut, original RQ-16 semantics — or the labeled token file, read
 * fresh per request so deleting a line revokes without a restart; a file
 * key's scopes narrow the door's rosters exactly like `--select` does
 * (ADR-REM-010 mechanism reuse, no 403 class). There is no
 * session, no streaming, and no server-side artifact: responses inline the
 * reference data (RQ-07) and generate a serve-scoped run id. */

export const PROTOCOL_NAME = "ukp-remote";
export const PROTOCOL_VERSION = "1";
export const DISCOVERY_PATH = "/.well-known/ukp.json";

/** PUT /v1/propose/{id} body cap (ADR-REM-005 §5): proposals are markdown
 * long-form text; 1 MiB is generous headroom and bounds serve memory. */
export const PROPOSE_BODY_LIMIT_BYTES = 1024 * 1024;

export interface ServeConfig {
  /** Absent = host door mode (ADR-REM-004 / O-2): serve local bindings in
   * the registry over one listener, routed by name at `/e/<name>/…`, with a
   * `scope:"host"` door document at the well-known path. Present = the
   * original single-endpoint mode (N=1 retreat stays legal long-term). */
  endpointName?: string;
  /** Subset door (ADR-REM-010 / O-020 ruling D): a declarative name
   * whitelist next to an ABSENT endpointName — the door serves only the
   * selected local bindings, and to anyone the list excludes the door
   * pretends those endpoints do not exist (roster, routes, per-endpoint
   * documents, 404 rosters all carry the same effective set). The server
   * layer does NOT validate the names at startup — the command layer's
   * eager check (usage error with the roster) is the admission; here the
   * set just intersects with the per-request registry read. */
  select?: readonly string[];
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
  /** W13 / RQ-16c: the labeled token file (`~/.ukp/tokens`). When `tokens`
   * is absent, the gate arms from this file instead: it is read FRESH on
   * every request (revocation = deleting the line, no restart), a presented
   * `ukp_<label>_<id>_<secret>` key is verified against the row's SHA-256,
   * and the matched row's scopes decide which endpoints the key may touch
   * (`name:ro|rw`, Docker-registry grammar, required per row). When
   * `tokens` IS set, env wins outright and the file is not consulted —
   * env is the full-power shortcut form of the same gate (AWS/gh/kubectl
   * chain order). Scope enforcement reuses the ADR-REM-010 roster
   * mechanism: an out-of-scope name shares the roster 404 with an unknown
   * one, byte-identical, and the roster a scoped 404 carries is the key's
   * own effective set — no new 403 class exists. */
  tokenFilePath?: string;
  /** TLS transport (W5' / D-079): `self-signed` generates and persists an
   * identity in the machine home beside the registry — `~/.ukp/tls/<name>/`
   * in endpoint mode, the flat `~/.ukp/tls/` in door mode (a door has no
   * single Service folder; endpoint mode converged on the same home
   * 2026-11-01 because the identity is machine-scoped material);
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
  /** INV-03 override marker: --allow-http admitted plain http beyond a
   * verified loopback bind (TLS is terminated in front, at an edge the
   * operator owns). Banner signal only — the admission itself is the
   * command layer's serveTransportDecision; this keeps the operator channel
   * naming the plaintext hop the flag accepted. */
  insecureHttp?: boolean;
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
  /** Key-echo (ADR-REM-014 / INV-23): present iff this fetch presented a
   * valid file key — the `endpoints[]` names that key may address (its
   * scope ∩ select ∩ registry, read tier; the same roster a tier-2 route
   * denial prints as `available:`). Anonymous, invalid, and env-credential
   * fetches omit the field and keep the public document byte-identical. */
  admitted?: string[];
}

export interface ServeInfo {
  /** `"door"` when serving the whole registry (endpointName absent). */
  mode: "endpoint" | "door";
  /** Single-endpoint mode fields (present iff mode === "endpoint"). */
  endpoint?: string;
  folder?: string;
  instanceUid?: string;
  /** Door mode fields (present iff mode === "door"): the startup snapshot of
   * servable endpoint names (the door itself grows without restart), the
   * snapshot of write-capable (propose-declaring) names — the banner's
   * "you opened a write face" line (ADR-REM-005 verdict C) — and, on a
   * subset door (ADR-REM-010), the declared select whitelist itself (the
   * banner's `select:` line: what was asked for, next to what is being
   * served). */
  door?: { endpoints: string[]; write: string[]; select?: string[] };
  url: string;
  host: string;
  port: number;
  authRequired: boolean;
  /** Present when the gate armed from the token file instead of env
   * (W13 / RQ-16c) — feeds the banner's operator line. `keys` is a startup
   * snapshot for visibility only; the live truth is the per-request fresh
   * read (delete a line, next request 401s). */
  tokenFile?: { keys: number };
  /** Present when --allow-http admitted plain http beyond loopback (INV-03
   * override) — feeds the banner's transport warning. Absent on every
   * loopback or TLS door, so the warning line is exactly the override's. */
  insecureHttp?: boolean;
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

/** Servable endpoints of a door (O-2): the LOCAL bindings in the registry
 * the door's width admits — every one of them, or the `select` whitelist's
 * members (ADR-REM-010) — read fresh by the caller per request (new
 * endpoints appear without a restart). Remote bindings are not servable and
 * never make the roster. W13 adds the per-key narrowing axis: `admit` is
 * the matched file key's scope predicate for the route's access level, so
 * the roster a scoped caller can ever see is scope ∩ select ∩ registry. */
function listDoorEndpoints(
  registryPath: string,
  select?: readonly string[],
  admit?: (name: string) => boolean,
): Array<{ name: string; folder: string }> {
  return readRegistry(registryPath)
    .filter((binding) => binding.kind !== "remote")
    .filter((binding) => select === undefined || select.includes(binding.name))
    .filter((binding) => admit === undefined || admit(binding.name))
    .map((binding) => ({ name: binding.name, folder: binding.path! }));
}

/** Startup snapshot of write-capable (propose-declaring) door endpoints —
 * the banner line that makes the opened write face visible (ADR-REM-005
 * verdict C). Subset doors narrow it to the select set (ADR-REM-010).
 * Unreadable/name-drifted Services drop out silently here; they are already
 * reported by the roster/discovery paths. */
function listWriteEndpoints(registryPath: string, select?: readonly string[]): string[] {
  return listDoorEndpoints(registryPath, select).flatMap((endpoint) => {
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
 * broken Service must not take the whole door document down. `admitted`
 * (ADR-REM-014 / INV-23) is the caller's key-echo: omitted entirely for
 * anonymous, invalid, and env-credential fetches, so those responses stay
 * byte-identical to the pre-echo document. */
function buildDoorDocument(
  endpoints: ReadonlyArray<{ name: string; folder: string }>,
  bearerRequired: boolean,
  admitted?: readonly string[],
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
    ...(admitted !== undefined ? { admitted: [...admitted] } : {}),
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
    let server: ReturnType<typeof Bun.serve>;
    try {
      server = Bun.serve({ hostname: options.host, port: options.port ?? 8570, ...tls, fetch });
    } catch (error) {
      // Startup failures are usually a taken port (Bun's own message names
      // it) — teach the escape hatch the walkthrough agent had to recall
      // from --help (2026-11-11 finding 4). Other causes keep the raw
      // reason verbatim.
      const reason = error instanceof Error ? error.message : String(error);
      throw new ServeSetupError(/port|in use|EADDRINUSE/i.test(reason) ? `${reason} - pass --port <n> (or --port 0) to listen elsewhere` : reason);
    }
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
 * (the machine home beside the registry: `~/.ukp/tls/<name>/` in endpoint
 * mode, the home's flat root in door mode — a door has no single Service
 * folder, and endpoint mode converged on the same home 2026-11-01 because
 * the identity is machine-scoped material), explicit certificates
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

/** CHK-01 ruling (D-100 / ADR 0027): the bearer check hashes both sides
 * with SHA-256 and compares the fixed 32-byte digests via
 * `crypto.timingSafeEqual`. Hashing first makes the comparison
 * length-uniform — operator-chosen tokens (`UKP_SERVE_TOKEN`, arbitrary
 * length — not fixed-length hex) and attacker-chosen header values can
 * never reach the raw API's equal-length requirement, and no early exit
 * (length mismatch, first differing byte) shapes the failure timing.
 * Every failure class — missing header, non-Bearer scheme, wrong value —
 * runs this one path and then the single 401 below, so responses stay
 * byte-identical across classes (CHK-02, CWE-204 family: the gate is
 * not a credential oracle). */
export function timingSafeBearerMatch(
  authorization: string | null,
  tokens: readonly string[],
): boolean {
  const presented = createHash("sha256").update(authorization ?? "").digest();
  return tokens.some((token) =>
    timingSafeEqual(createHash("sha256").update(`Bearer ${token}`).digest(), presented)
  );
}

/** What the gate established about the caller (W13 / RQ-16c): an env token
 * is the full-power shortcut form (its scope is the whole door, original
 * RQ-16 semantics); a file key carries its row's scopes into authorization.
 * `undefined` = no gate armed (loopback anonymous serving) — not a failure.
 * The two never mix: env present means the file is not consulted at all. */
type GateCredential =
  | { kind: "env" }
  | { kind: "file"; entry: TokenFileEntry };

/** The single 401 every gate failure class emits (CHK-02 / CWE-204 family:
 * the gate is not a credential oracle) — missing header, wrong scheme,
 * unknown key, wrong secret, out-of-scope key on a single-endpoint gate. */
function authFailureResponse(): Response {
  return jsonResponse(
    errorBody("auth-failure", "missing or invalid bearer token (Authorization: Bearer <token>)"),
    401,
  );
}

/** W13 / RQ-16c: whether ANY auth source is configured — env tokens or the
 * token file. Drives `authRequired` (banner, discovery security.schemes)
 * and the gate itself; with neither, serving is anonymous (the command
 * layer's deny-by-default admission, RQ-18, is what prevents reaching here
 * unarmed on non-loopback binds). */
function gateArmed(config: ServeConfig): boolean {
  return (config.tokens?.length ?? 0) > 0 || config.tokenFilePath !== undefined;
}

/** The file-source half of the gate as a pure credential lookup (no 401):
 * a valid presented key yields its entry; every other shape — no gate
 * armed, env tokens configured (that branch owns verification), missing
 * header, non-Bearer scheme, unknown key, wrong secret, unreadable or
 * malformed file — yields undefined. Shared by the gate (which turns
 * undefined into the uniform 401) and the key-echo (which turns undefined
 * into the anonymous public door document, ADR-REM-014 / INV-23). */
function fileGateCredential(
  request: Request,
  config: ServeConfig,
): { kind: "file"; entry: TokenFileEntry } | undefined {
  if (!gateArmed(config) || (config.tokens?.length ?? 0) > 0) return undefined;
  const loaded = loadTokenFile(config.tokenFilePath!);
  if (!("text" in loaded)) return undefined;
  const parsed = parseTokenFileText(loaded.text);
  if ("error" in parsed) return undefined;
  const authorization = request.headers.get("authorization");
  // Scheme shape is part of the uniform failure path: a non-Bearer header
  // fails exactly like a missing one.
  const match = /^Bearer (.+)$/.exec(authorization ?? "");
  if (match === null) return undefined;
  const entry = authenticateBearerKey(match[1]!, parsed.entries);
  return entry !== undefined ? { kind: "file", entry } : undefined;
}

/** The door gate, both sources (W13): env tokens compare through the
 * CHK-01 digest path unchanged; a token file is fresh-read per request
 * (missing/unreadable/unparseable file ⇒ no key can pass — fail closed)
 * and the presented key is verified against exactly its (label, keyId) row
 * with a timing-safe digest compare inside the plumbing module. */
function bearerGate(
  request: Request,
  config: ServeConfig,
): { credential: GateCredential | undefined } | { response: Response } {
  if (!gateArmed(config)) return { credential: undefined };
  if ((config.tokens?.length ?? 0) > 0) {
    return timingSafeBearerMatch(request.headers.get("authorization"), config.tokens!)
      ? { credential: { kind: "env" } }
      : { response: authFailureResponse() };
  }
  const credential = fileGateCredential(request, config);
  return credential !== undefined ? { credential } : { response: authFailureResponse() };
}

/** Per-request roster admission from the matched key's scopes (rehearsal
 * point E): read routes demand `ro`, the propose route demands `rw`. A
 * `ro`-scoped endpoint is therefore absent from the write face's effective
 * set — and since 2026-11-11 that absence answers as a route denial (the
 * door publicly declares the name, so denying its existence would be a
 * lie), while select-excluded names keep the existence-shaped 404 —
 * still no 403 class either way. Env credentials and anonymous
 * serving return undefined (the door's own width applies). */
function scopeAdmit(
  credential: GateCredential | undefined,
  access: ScopeAccess,
): ((name: string) => boolean) | undefined {
  if (credential?.kind !== "file") return undefined;
  return (name: string) => scopeAllows(credential.entry.scopes, name, access);
}

/** Per-request endpoint resolution for door routing (O-2): the registry is
 * read fresh, the name segment has already passed ENDPOINT_NAME (injection
 * unreachable), unknown and non-servable names get the roster 404, and the
 * RQ-14 binding↔manifest identity check runs per request like the
 * single-mode discovery fetch does. A subset door (ADR-REM-010) routes an
 * excluded name into the SAME roster-404 branch as an unknown one — the
 * response is byte-identical either way, so the roster is the only name
 * list any response ever carries. W13 scopes split the refusal into two
 * tiers (2026-11-11 owner ruling, superseding rehearsal E's single shape):
 * a name the door roster does not carry stays indistinguishable from an
 * unknown one; a name the door publicly declares but the matched key
 * cannot touch gets a route denial — honest about the endpoint's public
 * existence, uniform across ro-scope / absent-scope / undeclared-write-
 * route, so the difference never leaks whether anyone else could write
 * it. The roster either tier carries is the key's own effective set
 * (`admit` = scope ∩ select ∩ registry), never the wider door. */
function resolveDoorRoute(
  registryPath: string,
  name: string,
  select?: readonly string[],
  admit?: (name: string) => boolean,
): { folder: string } | { response: Response } {
  let binding;
  try {
    binding = readRegistry(registryPath).find((entry) => entry.name === name);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { response: jsonResponse(errorBody("provider-unavailable", `Host Registry is not readable: ${reason}`), 503) };
  }
  if (
    binding === undefined
    || binding.kind === "remote"
    || (select !== undefined && !select.includes(name))
  ) {
    const roster = listDoorEndpoints(registryPath, select, admit).map((endpoint) => endpoint.name).join(", ");
    return {
      response: jsonResponse(
        errorBody("not-found", `no such endpoint '${name}' on this host door (available: ${roster})`),
        404,
      ),
    };
  }
  if (admit !== undefined && !admit(name)) {
    // Tier 2 (2026-11-11): the door declares this endpoint but the matched
    // key's effective set does not include it — a route denial, never an
    // existence denial. Roster membership is public discovery, and the
    // uniform shape (ro scope, absent scope, undeclared write route alike)
    // keeps writability-for-others unreadable.
    const roster = listDoorEndpoints(registryPath, select, admit).map((endpoint) => endpoint.name).join(", ");
    return {
      response: jsonResponse(
        errorBody("not-found", `no route for '${name}' under your key on this host door (available: ${roster})`),
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
    // loadManifest messages are self-contained sentences (unreadable /
    // absent / invalid-TOML wording); rendering them verbatim keeps the
    // honest state instead of nesting a second "not readable" prefix.
    const reason = error instanceof Error ? error.message : String(error);
    return { response: jsonResponse(errorBody("provider-unavailable", reason), 503) };
  }
  return { folder };
}

/** Door-mode routing table (ADR-REM-004 / O-2). The door document and the
 * per-endpoint documents stay public (ADR-REM-003 declaration/capability
 * divide); every `/e/<name>/v1/*` route passes the door-level bearer gate.
 * The roster a 404 carries is the door's effective set — on a subset door
 * (ADR-REM-010) that is the select ∩ registry intersection, never the full
 * registry; on an authenticated scoped route (W13) it further intersects
 * with the matched key's scopes via `admit`. */
function doorNotFound(
  name: string | undefined,
  registryPath: string,
  select?: readonly string[],
  admit?: (name: string) => boolean,
): Response {
  if (name !== undefined) {
    const roster = listDoorEndpoints(registryPath, select, admit).map((endpoint) => endpoint.name).join(", ");
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
  // The door's width (ADR-REM-010): undefined = the whole registry, a name
  // list = the subset whitelist. One variable feeds every surface below —
  // door document, per-request routes, 404 rosters — so the subset cannot
  // drift between them.
  const select = config.select;
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === DISCOVERY_PATH) {
      if (request.method !== "GET") {
        return jsonResponse(errorBody("method-not-allowed", `the discovery document is a GET resource`), 405);
      }
      try {
        // Public door document (ADR-REM-003): no key presented, no scope
        // narrowing — the door's own width is what the roster declares.
        // Key-echo (ADR-REM-014 / INV-23): a VALID file key additionally
        // earns its own admission roster — the same scope ∩ select ∩
        // registry set the tier-2 route denial prints as `available:` (the
        // echo aggregates a disclosure that already exists, it opens no new
        // face) — while anonymous, invalid, and env-credential fetches keep
        // the public document byte-identical: no echo, no credential oracle.
        const echo = fileGateCredential(request, config);
        const admitted = echo !== undefined
          ? listDoorEndpoints(config.registryPath, select, scopeAdmit(echo, "ro")).map((endpoint) => endpoint.name)
          : undefined;
        return jsonResponse(
          buildDoorDocument(listDoorEndpoints(config.registryPath, select), gateArmed(config), admitted),
        );
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
        return doorNotFound(name, config.registryPath, select);
      }
      if (rest === DISCOVERY_PATH) {
        if (request.method !== "GET") {
          return jsonResponse(errorBody("method-not-allowed", `the discovery document is a GET resource`), 405);
        }
        const resolved = resolveDoorRoute(config.registryPath, name, select);
        if ("response" in resolved) return resolved.response;
        try {
          const loaded = loadManifest(resolved.folder);
          return jsonResponse(
            buildDiscoveryDocument(loaded, readInstanceUid(resolved.folder), gateArmed(config)),
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return jsonResponse(errorBody("provider-unavailable", reason), 503);
        }
      }
      if (rest.startsWith("/v1/propose/")) {
        const gate = bearerGate(request, config);
        if ("response" in gate) return gate.response;
        // The write face demands the rw bit: a ro-scoped endpoint is not in
        // this key's effective write roster (rehearsal point E).
        const admit = scopeAdmit(gate.credential, "rw");
        const id = rest.slice("/v1/propose/".length);
        if (id.includes("/")) return doorNotFound(undefined, config.registryPath, select, admit);
        const resolved = resolveDoorRoute(config.registryPath, name, select, admit);
        if ("response" in resolved) return resolved.response;
        return await handlePropose(request, config, name, resolved.folder, id);
      }
      if (rest === "/v1/search" || rest === "/v1/read" || rest === "/v1/nav" || rest === "/v1/rg") {
        const gate = bearerGate(request, config);
        if ("response" in gate) return gate.response;
        const admit = scopeAdmit(gate.credential, "ro");
        const resolved = resolveDoorRoute(config.registryPath, name, select, admit);
        if ("response" in resolved) return resolved.response;
        if (rest === "/v1/search") {
          return await handleSearch(request, config, name, resolved.folder);
        }
        if (rest === "/v1/read") {
          return handleRead(url, request, config, name);
        }
        if (rest === "/v1/nav") {
          return await handleNav(url, request, config, name);
        }
        return handleRg(url, request, config, name);
      }
      return doorNotFound(undefined, config.registryPath, select);
    }

    return doorNotFound(undefined, config.registryPath, select);
  };

  const listener = startServeListener(handler, {
    host,
    ...(config.port !== undefined ? { port: config.port } : {}),
    ...(tlsMaterial !== undefined ? { tlsMaterial } : {}),
    ...(config.maxIdleSeconds !== undefined ? { maxIdleSeconds: config.maxIdleSeconds } : {}),
    ...(config.systemdSocket === true ? { systemdSocket: true } : {}),
  });
  const { server } = listener;
  const tokenFile = tokenFileSnapshot(config);

  const info: ServeInfo = {
    mode: "door",
    door: {
      endpoints: listDoorEndpoints(config.registryPath, select).map((endpoint) => endpoint.name),
      write: listWriteEndpoints(config.registryPath, select),
      ...(select !== undefined ? { select: [...select] } : {}),
    },
    url: listener.publicUrl,
    host,
    port: listener.port,
    authRequired: gateArmed(config),
    ...(tokenFile !== undefined ? { tokenFile } : {}),
    ...(config.insecureHttp === true ? { insecureHttp: true } : {}),
    rg: rgExecutableAvailable() ? "ok" : "missing",
    ...(tlsMaterial !== undefined
      ? { tls: { pin: tlsMaterial.pin, san: tlsMaterial.san, source: tlsMaterial.source } }
      : {}),
    ...(config.maxIdleSeconds !== undefined ? { maxIdleSeconds: config.maxIdleSeconds } : {}),
  };
  return { server, info, stopAll: listener.stopAll };
}

/** Startup snapshot of the token file for the banner's operator line
 * (W13): the live gate re-reads per request; this count is visibility, not
 * truth. A parse failure here is cosmetic-zero — the command layer's
 * admission already refused a malformed file, and the gate itself fails
 * closed on any read/parse problem. */
function tokenFileSnapshot(config: ServeConfig): { keys: number } | undefined {
  if (config.tokenFilePath === undefined || (config.tokens?.length ?? 0) > 0) return undefined;
  const loaded = loadTokenFile(config.tokenFilePath);
  if (!("text" in loaded)) return { keys: 0 };
  const parsed = parseTokenFileText(loaded.text);
  return "error" in parsed ? { keys: 0 } : { keys: parsed.entries.length };
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

  // The self-signed identity is machine-scoped material (its SAN coverage
  // names THIS host's interfaces) and lives in the machine home beside the
  // registry — `~/.ukp/tls/<endpoint>/` here, the same home's flat root in
  // door mode (adjudication 2026-11-01, inbox service-dir-layering item 2;
  // endpoint mode converged on the home door mode already used). Keyed by
  // the manifest's effective name: the registry namespace holds one
  // endpoint per name, so a re-cloned folder re-attaches to its pinned
  // identity instead of orphaning every client (INV-04). A pre-2026-11-01
  // `.ukp/tls/` moves in once, keypair untouched; the retired `/tls/`
  // ignore rule swaps out in the same gesture.
  const identityDir = join(dirname(config.registryPath), "tls", startupManifest.effectiveName);
  if (migrateLegacyServiceTlsDir(serviceFolder, identityDir) === "moved") {
    retireTlsIgnoreLine(join(serviceFolder, ".ukp"));
  }
  const tlsMaterial = resolveTlsMaterial(config, identityDir);

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
          buildDiscoveryDocument(loaded, readInstanceUid(serviceFolder), gateArmed(config)),
        );
      } catch (error) {
        return jsonResponse(
          errorBody("provider-unavailable", error instanceof Error ? error.message : String(error)),
          503,
        );
      }
    }

    if (url.pathname.startsWith("/v1/propose/")) {
      const gate = bearerGate(request, config);
      if ("response" in gate) return gate.response;
      // Single-endpoint gates have no roster to hide behind: a key that
      // does not carry this endpoint at rw is simply not valid for this
      // gate's write face — the same uniform 401, no new refusal class.
      if (gate.credential?.kind === "file"
        && !scopeAllows(gate.credential.entry.scopes, binding.name, "rw")) {
        return authFailureResponse();
      }
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
      const gate = bearerGate(request, config);
      if ("response" in gate) return gate.response;
      if (gate.credential?.kind === "file"
        && !scopeAllows(gate.credential.entry.scopes, binding.name, "ro")) {
        return authFailureResponse();
      }
      if (url.pathname === "/v1/search") {
        return await handleSearch(request, config, binding.name, serviceFolder);
      }
      if (url.pathname === "/v1/read") {
        return handleRead(url, request, config, binding.name);
      }
      if (url.pathname === "/v1/nav") {
        return await handleNav(url, request, config, binding.name);
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
  const tokenFile = tokenFileSnapshot(config);

  const info: ServeInfo = {
    mode: "endpoint",
    endpoint: binding.name,
    folder: serviceFolder,
    instanceUid: readInstanceUid(serviceFolder),
    url: listener.publicUrl,
    host,
    port: listener.port,
    authRequired: gateArmed(config),
    ...(tokenFile !== undefined ? { tokenFile } : {}),
    ...(config.insecureHttp === true ? { insecureHttp: true } : {}),
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
async function handleNav(url: URL, request: Request, config: ServeConfig, endpointName: string): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse(errorBody("method-not-allowed", "/v1/nav is a GET route"), 405);
  }
  const parsed = parseNavParams(endpointName, url.searchParams.get("path"), url.searchParams.get("depth"));
  if ("error" in parsed) {
    return jsonResponse(errorBody("usage-error", parsed.error), 400);
  }
  const outcome = await runNav(parsed.request, {
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
    // The door is the executing side: its rg-degradation messages relay to
    // the consumer verbatim, so they must name the door host (walkthrough
    // F4 — "rg executable is not available" did not say whose PATH).
    executionSide: "door",
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
    return jsonResponse(errorBody("provider-unavailable", reason), 503);
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
