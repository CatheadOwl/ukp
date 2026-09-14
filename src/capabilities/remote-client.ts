import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { X509Certificate } from "node:crypto";
import { DISCOVERY_PATH, PROTOCOL_NAME, type DiscoveryDocument } from "../server.ts";
import { assertRemoteUrlAllowed, parseSshUrl, refreshRemoteTlsCert, type RegistryBinding } from "../registry.ts";
import { spkiPinOf } from "./tls-identity.ts";
import type { SearchEndpointOutcome } from "./search.ts";
import type { NavEnvelope } from "./nav.ts";
import { EXTERNAL_PROVIDER } from "../config/external-tool.ts";
import type { RgEndpointOutcome, RgMatch, RgCountEntry } from "./rg.ts";

/** Remote transport for the client side (ukp-remote wire v1, ADR-REM-002/003;
 * ukp_remote W2). All calls fetch fresh (no cross-invocation cache), carry the
 * endpoint token when configured, and map transport failures onto the
 * existing capability failure vocabulary. */

export class RemoteTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteTransportError";
  }
}

/** `UKP_ENDPOINT_<NAME>_TOKEN` (name upper-cased, `-` → `_`): D-077 / ADR-REM-003. */
export function remoteTokenFor(endpointName: string): string | undefined {
  return process.env[`UKP_ENDPOINT_${endpointName.toUpperCase().replace(/-/g, "_")}_TOKEN`];
}

/** Credential resolution (D-078): env wins, the stored binding token is the
 * fallback — injected credentials (CI/agent env) never get shadowed by the
 * file, while the file keeps interactive use zero-ceremony. */
export function resolveRemoteToken(binding: RegistryBinding): string | undefined {
  return remoteTokenFor(binding.name) ?? binding.token;
}

/** `UKP_REMOTE_TIMEOUT_MS` mirrors `UKP_PROVIDER_TIMEOUT_MS` (60s default). */
function remoteTimeoutMs(): number {
  const raw = process.env.UKP_REMOTE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return 60_000;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1000 ? value : 60_000;
}

/** TOFU mismatch policy (RQ-17): `warn` (default) appends a warning and
 * continues; `block` refuses the endpoint until it is explicitly
 * re-registered. */
function tofuMode(): "warn" | "block" {
  return process.env.UKP_TOFU === "block" ? "block" : "warn";
}

export interface RemoteTransportHandle {
  /** Wire base the client actually fetches (tunnel endpoint or the url itself). */
  base: string;
  /** Releases per-invocation resources (kills an ephemeral tunnel); noop for
   * direct connections. */
  close: () => void;
  /** TLS anchor for https bases (W5' / D-079): present when the binding
   * carries a pinned certificate; all fetches on this handle verify against
   * it. Mutated in place by the renewal re-anchor. */
  tls?: RemoteTlsAnchor;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: () => {}, open: () => {}, close: () => {}, drain: () => {}, error: () => {} },
    });
    const port = listener.port;
    listener.stop(true);
    if (port > 0) resolve(port);
    else reject(new RemoteTransportError("unable to allocate a local tunnel port"));
  });
}

function portAccepts(hostname: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = netConnect({ host: hostname, port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 120);
      });
    };
    attempt();
  });
}

/** TLS trust state for one invocation (W5' / D-079): `ca` is the pinned
 * certificate PEM handed to fetch as the trust anchor; `pin` is the RFC 7469
 * SPKI pin used to distinguish "server renewed its certificate, same key"
 * (re-anchor and continue) from "identity changed" (hard block). */
export interface RemoteTlsAnchor {
  ca: string;
  pin?: string;
  /** Endpoint label for the identity-changed error; absent at registration
   * (the name is not known yet — it comes from the discovery document). */
  name?: string;
  /** When set, a successful re-anchor persists the new PEM into the binding. */
  registryPath?: string;
}

export interface RemoteTlsProbe {
  /** Verified against the system trust store + hostname (public-CA path). */
  authorized: boolean;
  certPem: string;
  spkiPin: string;
}

/** Registration-time TLS probe (W5'): for https urls, capture the peer
 * certificate before the first fetch. authorized=true means a public CA
 * chain validates (no pinning); false means self-signed/private — the client
 * TOFU-pins the certificate as trust anchor plus its SPKI as identity.
 * Non-https urls (ssh:// tunnel, loopback http) return undefined: transport
 * security comes from SSH or locality, not TLS. */
export async function probeRemoteTls(url: string): Promise<RemoteTlsProbe | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RemoteTransportError(`remote endpoint url is not a valid absolute URL: ${url}`);
  }
  if (parsed.protocol !== "https:") return undefined;
  const port = parsed.port === "" ? 443 : Number(parsed.port);
  const host = parsed.hostname;
  return await new Promise<RemoteTlsProbe>((resolve, reject) => {
    const socket = tlsConnect(
      {
        host,
        port,
        // SNI must be a name, not an IP (node:tls rejects IP servernames);
        // IP-addressed certificates verify through the SAN, not SNI.
        ...(isIP(host) === 0 ? { servername: host } : {}),
        rejectUnauthorized: false,
      },
      () => {
        const peer = socket.getPeerCertificate();
        socket.destroy();
        if (peer === undefined || peer.raw === undefined || peer.raw.length === 0) {
          reject(new RemoteTransportError(`remote endpoint presented no TLS certificate: ${url}`));
          return;
        }
        resolve({
          authorized: socket.authorized === true,
          certPem: new X509Certificate(peer.raw).toString(),
          spkiPin: spkiPinOf(peer.raw),
        });
      },
    );
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new RemoteTransportError(`TLS probe timed out: ${url}`));
    });
    socket.on("error", (error) => {
      reject(new RemoteTransportError(`TLS probe failed: ${url} (${error instanceof Error ? error.message : String(error)})`));
    });
  });
}

/** Ensure a usable wire base for one invocation (D-078 transparent ssh):
 * http/https urls are used directly; `ssh://host[:port]` opens an ephemeral
 * local forward over SSH (encryption + host auth come from the user's SSH
 * config/keys), waits for readiness, and returns the tunnel endpoint.
 * https bindings with a pinned certificate carry their TLS anchor on the
 * handle. `sshCommand` is a test injection point for the ssh binary
 * invocation; `registryPath` lets the renewal re-anchor persist. */
export async function openRemoteTransport(
  binding: RegistryBinding,
  options: { sshCommand?: readonly string[]; registryPath?: string } = {},
): Promise<RemoteTransportHandle> {
  if (binding.kind !== "remote" || binding.url === undefined) {
    throw new RemoteTransportError(`endpoint '${binding.name}' is not a remote binding`);
  }
  assertRemoteUrlAllowed(binding.url);
  const ssh = parseSshUrl(binding.url);
  if (ssh === undefined) {
    const tls = binding.url.startsWith("https://") && binding.tls_cert !== undefined
      ? {
          ca: binding.tls_cert,
          ...(binding.tls_pin !== undefined ? { pin: binding.tls_pin } : {}),
          name: binding.name,
          ...(options.registryPath !== undefined ? { registryPath: options.registryPath } : {}),
        }
      : undefined;
    return {
      base: binding.url.replace(/\/+$/, ""),
      close: () => {},
      ...(tls !== undefined ? { tls } : {}),
    };
  }
  const localPort = await freePort();
  const argv = [
    ...(options.sshCommand ?? ["ssh"]),
    "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "BatchMode=yes",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${ssh.port}`,
    ssh.host,
  ];
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  const ready = await portAccepts("127.0.0.1", localPort, 15_000);
  if (!ready) {
    proc.kill();
    throw new RemoteTransportError(
      `ssh tunnel to '${ssh.host}:${ssh.port}' (endpoint '${binding.name}') did not become ready; check the host alias and key auth (BatchMode)`,
    );
  }
  return {
    base: `http://127.0.0.1:${localPort}`,
    close: () => proc.kill(),
  };
}

function authorizationHeaders(token: string | undefined): Record<string, string> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function unreachableError(url: string, error: unknown): RemoteTransportError {
  const code = (error as { code?: unknown }).code;
  const detail = error instanceof Error ? error.message : String(error);
  return new RemoteTransportError(
    `remote endpoint unreachable: ${url} (${detail}${typeof code === "string" && code !== "" ? ` [${code}]` : ""})`,
  );
}

/** Renewal re-anchor attempt (W5' / D-079, 裁决点 B): after a fetch-phase
 * failure with an anchor present, probe the CURRENT peer certificate.
 * Same SPKI pin → server renewed its certificate keeping the key: swap the
 * anchor (and persist) and let the caller retry once, invisibly. Different
 * pin → identity change (reinstall or MITM): hard block. Unreachable probe
 * → the original failure stands. */
async function reanchorFromProbe(url: string, anchor: RemoteTlsAnchor): Promise<boolean> {
  const probe = await probeRemoteTls(url).catch(() => undefined);
  if (probe === undefined) return false;
  if (anchor.pin !== undefined && probe.spkiPin !== anchor.pin) {
    throw new RemoteTransportError(
      `remote '${anchor.name ?? "endpoint"}' TLS identity changed — pinned ${anchor.pin}, got ${probe.spkiPin}; if the server was reinstalled this is expected: refresh trust with 'ukp register --url <url> --token <token>'`,
    );
  }
  anchor.ca = probe.certPem;
  if (anchor.registryPath !== undefined && anchor.name !== undefined) {
    try {
      refreshRemoteTlsCert(anchor.registryPath, anchor.name, probe.certPem);
    } catch {
      // persistence is best-effort: the in-memory anchor already unblocks
      // this invocation; the next renewal re-anchors again.
    }
  }
  return true;
}

/** Fetch + JSON-decode with one transparent renewal re-anchor: a pinned
 * https anchor turns a certificate-verification fetch failure into a probe —
 * same SPKI keeps going (anchor swapped in place), a different SPKI blocks. */
async function fetchJson(
  url: string,
  init: RequestInit,
  anchor?: RemoteTlsAnchor,
): Promise<{ status: number; body: unknown }> {
  const attempt = async (ca?: string, wrap = true): Promise<{ status: number; body: unknown }> => {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(remoteTimeoutMs()),
        ...(ca !== undefined ? { tls: { ca } } : {}),
      } as RequestInit);
    } catch (error) {
      // wrap=false keeps the raw error so the anchored caller can classify
      // it (TLS verification failure → re-anchor probe) before wrapping.
      if (!wrap) throw error;
      throw unreachableError(url, error);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new RemoteTransportError(`remote endpoint returned a non-JSON body (status ${response.status}): ${url}`);
    }
    return { status: response.status, body };
  };

  if (anchor === undefined) return await attempt();
  try {
    return await attempt(anchor.ca, false);
  } catch (error) {
    if (error instanceof RemoteTransportError) throw error; // non-JSON body: not a TLS event
    if (isTimeoutError(error)) throw unreachableError(url, error);
    // Re-anchoring needs a pinned identity: only the SPKI pin distinguishes
    // "renewed certificate, same key" from "different identity".
    if (anchor.pin !== undefined && await reanchorFromProbe(url, anchor)) return await attempt(anchor.ca);
    throw unreachableError(url, error);
  }
}

function asRecord(body: unknown, url: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RemoteTransportError(`remote endpoint returned an unexpected payload shape: ${url}`);
  }
  return body as Record<string, unknown>;
}

export interface DiscoveryFetch {
  doc: DiscoveryDocument;
  /** TOFU observations (caller renders as warnings; mismatch never blocks). */
  warnings: string[];
  bearerRequired: boolean;
}

/** Fetch + validate the discovery document, run the TOFU pin comparison. */
export async function fetchDiscoveryDocument(
  binding: RegistryBinding,
  transport: RemoteTransportHandle,
  token?: string,
): Promise<DiscoveryFetch> {
  return fetchDiscoveryDocumentAt(transport.base, {
    name: binding.name,
    ...(binding.instance_uid !== undefined ? { pinnedUid: binding.instance_uid } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(transport.tls !== undefined ? { tlsAnchor: transport.tls } : {}),
  });
}

/** URL-addressed variant for registration (the name is not known yet — it
 * comes FROM this document per RQ-14). `tlsAnchor` carries the registration
 * probe's captured certificate for self-signed servers (W5'). */
export async function fetchDiscoveryDocumentAt(
  url: string,
  options: { name?: string; pinnedUid?: string; token?: string; tlsAnchor?: RemoteTlsAnchor } = {},
): Promise<DiscoveryFetch> {
  const base = url.replace(/\/+$/, "");
  const label = options.name ?? base;
  const { body } = await fetchJson(`${base}${DISCOVERY_PATH}`, { headers: authorizationHeaders(options.token) }, options.tlsAnchor);
  const record = asRecord(body, `${base}${DISCOVERY_PATH}`);
  if (record.protocol !== PROTOCOL_NAME) {
    throw new RemoteTransportError(`endpoint '${label}' at ${base} is not a ukp-remote service (protocol: ${String(record.protocol)})`);
  }
  if (record.protocol_version !== "1") {
    throw new RemoteTransportError(`endpoint '${label}' speaks ukp-remote protocol version ${String(record.protocol_version)}; this client supports 1`);
  }
  const warnings: string[] = [];
  if (options.pinnedUid !== undefined && record.instance_uid !== options.pinnedUid) {
    // TOFU (ADR-REM-003, RQ-17): warn by default, refuse under UKP_TOFU=block —
    // never silently trust the new identity.
    const detail = `endpoint '${label}' identity changed (pinned ${options.pinnedUid}, served ${String(record.instance_uid)}); re-register with 'ukp register --url' if this replacement is intended`;
    if (tofuMode() === "block") {
      throw new RemoteTransportError(`${detail} (refused: UKP_TOFU=block)`);
    }
    warnings.push(detail);
  }
  const schemes = (record.security as { schemes?: unknown } | undefined)?.schemes;
  return {
    doc: record as unknown as DiscoveryDocument,
    warnings,
    bearerRequired: Array.isArray(schemes) && schemes.includes("bearer"),
  };
}

export interface RemoteSearchExecution {
  outcome: SearchEndpointOutcome;
  /** Provider-native results array (wire `results`): the render source for
   * human result units, replacing local providerOutput's role. */
  results: unknown[];
  /** Inline references (wire `references`, RQ-07): per-result handoff keys
   * with server-declared `ukp_uri`. */
  references: Array<{ ukp_uri?: string }> | undefined;
}

/** POST /v1/search → endpoint outcome in the local SearchEndpointOutcome
 * vocabulary (status/message/envelope-compatible fields). */
export async function remoteSearch(
  binding: RegistryBinding,
  transport: RemoteTransportHandle,
  token: string | undefined,
  query: string,
  limit: number,
): Promise<RemoteSearchExecution> {
  const base = transport.base;
  const { status, body } = await fetchJson(`${base}/v1/search`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authorizationHeaders(token) },
    body: JSON.stringify({ query, limit }),
  }, transport.tls);
  const record = asRecord(body, `${base}/v1/search`);
  const envelope = record.endpoints as Array<Record<string, unknown>> | undefined;
  const entry = Array.isArray(envelope) ? envelope[0] : undefined;

  if (status === 401) {
    return { outcome: failedOutcome(binding.name, authMessage(token)), results: [], references: undefined };
  }
  if (entry === undefined) {
    return { outcome: failedOutcome(binding.name, `remote search returned no endpoint result (status ${status})`), results: [], references: undefined };
  }
  const entryStatus = entry.status;
  if (entryStatus !== "succeeded" && entryStatus !== "no_matches") {
    const message = typeof entry.message === "string" ? entry.message : `remote endpoint status '${String(entryStatus)}'`;
    return { outcome: { name: binding.name, provider: providerOf(record), status: "failed", message }, results: [], references: undefined };
  }
  const referencesRecord = record.references as { results?: unknown } | undefined;
  const references = referencesRecord !== undefined && Array.isArray(referencesRecord.results)
    ? referencesRecord.results as Array<{ ukp_uri?: string }>
    : undefined;
  return {
    outcome: {
      name: binding.name,
      provider: providerOf(record),
      status: entryStatus,
      ...(typeof entry.message === "string" ? { message: entry.message } : {}),
    },
    results: Array.isArray(record.results) ? record.results : [],
    references,
  };
}

function authMessage(token: string | undefined): string {
  return token === undefined
    ? "remote endpoint requires a bearer token; set UKP_ENDPOINT_<NAME>_TOKEN (NAME upper-cased, '-' → '_')"
    : "remote endpoint rejected the bearer token (401)";
}

function providerOf(record: Record<string, unknown>): string | null {
  const endpoints = record.endpoints as Array<Record<string, unknown>> | undefined;
  const provider = Array.isArray(endpoints) ? endpoints[0]?.provider : undefined;
  return typeof provider === "string" ? provider : null;
}

function failedOutcome(name: string, message: string): SearchEndpointOutcome {
  return { name, provider: null, status: "failed", message };
}

export interface RemoteReadResult {
  status: number;
  ok: boolean;
  content: string;
  /** Envelope error fields for failures (class/message). */
  errorClass?: string;
  errorMessage?: string;
  reference: string;
}

/** GET /v1/read — raw transport; classification into ReadOutcome happens in
 * the read adapter (commands/read.ts) where the local vocabulary lives. */
export async function remoteRead(
  transport: RemoteTransportHandle,
  token: string | undefined,
  params: { ref?: string; uri?: string; lines?: string; pin?: string },
): Promise<RemoteReadResult> {
  const base = transport.base;
  const search = new URLSearchParams();
  if (params.ref !== undefined) search.set("ref", params.ref);
  if (params.uri !== undefined) search.set("uri", params.uri);
  if (params.lines !== undefined) search.set("lines", params.lines);
  if (params.pin !== undefined) search.set("pin", params.pin);
  const { status, body } = await fetchJson(`${base}/v1/read?${search.toString()}`, {
    headers: authorizationHeaders(token),
  }, transport.tls);
  const record = asRecord(body, `${base}/v1/read`);
  const error = record.error as { class?: unknown; message?: unknown } | undefined;
  return {
    status,
    ok: record.ok === true,
    content: typeof record.content === "string" ? record.content : "",
    ...(error !== undefined && typeof error.class === "string" ? { errorClass: error.class } : {}),
    ...(error !== undefined && typeof error.message === "string" ? { errorMessage: error.message } : {}),
    reference: typeof record.reference === "string" ? record.reference : (params.ref ?? params.uri ?? ""),
  };
}

export interface RemoteNavResult {
  status: number;
  /** Success marker: the nav envelope itself (ukp.nav.v1) — it has no `ok`
   * field, so schema presence is the verdict. */
  ok: boolean;
  envelope?: NavEnvelope;
  /** Transport-shape error fields for failures (class/message). */
  errorClass?: string;
  errorMessage?: string;
}

/** GET /v1/nav — raw transport; classification into NavFailure happens in
 * the nav adapter (commands/nav.ts) where the local vocabulary lives. */
export async function remoteNav(
  transport: RemoteTransportHandle,
  token: string | undefined,
  params: { path?: string; depth?: number },
): Promise<RemoteNavResult> {
  const base = transport.base;
  const search = new URLSearchParams();
  if (params.path !== undefined) search.set("path", params.path);
  if (params.depth !== undefined) search.set("depth", String(params.depth));
  const query = search.size > 0 ? `?${search.toString()}` : "";
  const { status, body } = await fetchJson(`${base}/v1/nav${query}`, {
    headers: authorizationHeaders(token),
  }, transport.tls);
  const record = asRecord(body, `${base}/v1/nav`);
  const error = record.error as { class?: unknown; message?: unknown } | undefined;
  // Shape gate (read precedent validates what it consumes): a body claiming
  // the schema but missing the rendered fields would crash the shared
  // renderers downstream — treat it as a failed call, not a success.
  const ok = record.schema === "ukp.nav.v1"
    && Array.isArray(record.entries)
    && Array.isArray(record.diagnostics);
  return {
    status,
    ok,
    ...(ok ? { envelope: record as unknown as NavEnvelope } : {}),
    ...(!ok && error !== undefined && typeof error.class === "string" ? { errorClass: error.class } : {}),
    ...(!ok && error !== undefined && typeof error.message === "string" ? { errorMessage: error.message } : {}),
  };
}

export interface RemoteRgExecution {
  outcome: RgEndpointOutcome;
  /** Envelope-level warnings from the server run (scope/duplicate notes —
   * usually empty server-side; endpoint failures live in the outcome). */
  warnings: string[];
}

function remoteRgMatches(raw: unknown): RgMatch[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((entry): RgMatch[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const match = entry as Record<string, unknown>;
    if (typeof match.path !== "string") return [];
    return [{
      path: match.path,
      ...(typeof match.line === "number" ? { line: match.line } : {}),
      ...(typeof match.text === "string" ? { text: match.text } : {}),
      ...(typeof match.ukp_uri === "string" ? { ukp_uri: match.ukp_uri } : {}),
    }];
  });
}

function remoteRgCounts(raw: unknown): RgCountEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((entry): RgCountEntry[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const count = entry as Record<string, unknown>;
    if (typeof count.path !== "string" || typeof count.count !== "number") return [];
    return [{ path: count.path, count: count.count }];
  });
}

const RG_WIRE_STATUSES = new Set(["succeeded", "no_matches", "skipped", "failed", "interrupted", "cancelled"]);

/** GET /v1/rg — single-endpoint outcome in the local RgEndpointOutcome
 * vocabulary (provider is rg's external tier regardless of transport). */
export async function remoteRg(
  binding: RegistryBinding,
  transport: RemoteTransportHandle,
  token: string | undefined,
  params: {
    query: string;
    limit: number;
    glob?: string;
    type?: string;
    ignoreCase?: boolean;
    count?: boolean;
    passthrough: readonly string[];
  },
): Promise<RemoteRgExecution> {
  const base = transport.base;
  const search = new URLSearchParams({ query: params.query, limit: String(params.limit) });
  if (params.glob !== undefined) search.set("glob", params.glob);
  if (params.type !== undefined) search.set("type", params.type);
  if (params.ignoreCase === true) search.set("i", "1");
  if (params.count === true) search.set("count", "1");
  for (const arg of params.passthrough) search.append("passthrough", arg);
  const { status, body } = await fetchJson(`${base}/v1/rg?${search.toString()}`, {
    headers: authorizationHeaders(token),
  }, transport.tls);
  const record = asRecord(body, `${base}/v1/rg`);
  const error = record.error as { class?: unknown; message?: unknown } | undefined;

  if (status === 401) {
    return { outcome: { name: binding.name, provider: EXTERNAL_PROVIDER, status: "failed", message: authMessage(token) }, warnings: [] };
  }
  if (error !== undefined) {
    // Route-level failure: an older serve without /v1/rg answers 404
    // not-found; anything else keeps the server's message.
    const message = typeof error.message === "string"
      ? error.message
      : `remote rg failed (status ${status})`;
    return { outcome: { name: binding.name, provider: EXTERNAL_PROVIDER, status: "failed", message }, warnings: [] };
  }
  const envelope = record.endpoints as Array<Record<string, unknown>> | undefined;
  const entry = Array.isArray(envelope) ? envelope[0] : undefined;
  if (entry === undefined) {
    return {
      outcome: { name: binding.name, provider: EXTERNAL_PROVIDER, status: "failed", message: `remote rg returned no endpoint result (status ${status})` },
      warnings: [],
    };
  }
  const wireStatus = typeof entry.status === "string" && RG_WIRE_STATUSES.has(entry.status) ? entry.status : "failed";
  const matches = remoteRgMatches(entry.matches);
  const counts = remoteRgCounts(entry.counts);
  const warnings = Array.isArray(record.warnings) ? record.warnings.filter((item): item is string => typeof item === "string") : [];
  return {
    outcome: {
      name: binding.name,
      provider: EXTERNAL_PROVIDER,
      status: wireStatus as RgEndpointOutcome["status"],
      ...(typeof entry.message === "string" ? { message: entry.message } : {}),
      ...(matches !== undefined ? { matches } : {}),
      ...(counts !== undefined ? { counts } : {}),
      ...(entry.truncated === true ? { truncated: true } : {}),
    },
    warnings,
  };
}
