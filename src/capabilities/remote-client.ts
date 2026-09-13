import { DISCOVERY_PATH, PROTOCOL_NAME, type DiscoveryDocument } from "../server.ts";
import { assertRemoteUrlAllowed, type RegistryBinding } from "../registry.ts";
import type { SearchEndpointOutcome } from "./search.ts";

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

/** `UKP_REMOTE_TIMEOUT_MS` mirrors `UKP_PROVIDER_TIMEOUT_MS` (60s default). */
function remoteTimeoutMs(): number {
  const raw = process.env.UKP_REMOTE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return 60_000;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1000 ? value : 60_000;
}

export function remoteBaseOf(binding: RegistryBinding): string {
  if (binding.kind !== "remote" || binding.url === undefined) {
    throw new RemoteTransportError(`endpoint '${binding.name}' is not a remote binding`);
  }
  assertRemoteUrlAllowed(binding.url);
  return binding.url.replace(/\/+$/, "");
}

function authorizationHeaders(token: string | undefined): Record<string, string> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

async function fetchJson(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(remoteTimeoutMs()) });
  } catch (error) {
    throw new RemoteTransportError(
      `remote endpoint unreachable: ${url} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RemoteTransportError(`remote endpoint returned a non-JSON body (status ${response.status}): ${url}`);
  }
  return { status: response.status, body };
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
  token?: string,
): Promise<DiscoveryFetch> {
  return fetchDiscoveryDocumentAt(binding.url!, {
    name: binding.name,
    ...(binding.instance_uid !== undefined ? { pinnedUid: binding.instance_uid } : {}),
    ...(token !== undefined ? { token } : {}),
  });
}

/** URL-addressed variant for registration (the name is not known yet — it
 * comes FROM this document per RQ-14). */
export async function fetchDiscoveryDocumentAt(
  url: string,
  options: { name?: string; pinnedUid?: string; token?: string } = {},
): Promise<DiscoveryFetch> {
  const base = url.replace(/\/+$/, "");
  const label = options.name ?? base;
  const { body } = await fetchJson(`${base}${DISCOVERY_PATH}`, { headers: authorizationHeaders(options.token) });
  const record = asRecord(body, `${base}${DISCOVERY_PATH}`);
  if (record.protocol !== PROTOCOL_NAME) {
    throw new RemoteTransportError(`endpoint '${label}' at ${base} is not a ukp-remote service (protocol: ${String(record.protocol)})`);
  }
  if (record.protocol_version !== "1") {
    throw new RemoteTransportError(`endpoint '${label}' speaks ukp-remote protocol version ${String(record.protocol_version)}; this client supports 1`);
  }
  const warnings: string[] = [];
  if (options.pinnedUid !== undefined && record.instance_uid !== options.pinnedUid) {
    // TOFU: warn loudly, never silently trust the new identity (ADR-REM-003).
    warnings.push(
      `endpoint '${label}' identity changed (pinned ${options.pinnedUid}, served ${String(record.instance_uid)}); re-register with 'ukp register --url' if this replacement is intended`,
    );
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
  token: string | undefined,
  query: string,
  limit: number,
): Promise<RemoteSearchExecution> {
  const base = remoteBaseOf(binding);
  const { status, body } = await fetchJson(`${base}/v1/search`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authorizationHeaders(token) },
    body: JSON.stringify({ query, limit }),
  });
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
  binding: RegistryBinding,
  token: string | undefined,
  params: { ref?: string; uri?: string; lines?: string; pin?: string },
): Promise<RemoteReadResult> {
  const base = remoteBaseOf(binding);
  const search = new URLSearchParams();
  if (params.ref !== undefined) search.set("ref", params.ref);
  if (params.uri !== undefined) search.set("uri", params.uri);
  if (params.lines !== undefined) search.set("lines", params.lines);
  if (params.pin !== undefined) search.set("pin", params.pin);
  const { status, body } = await fetchJson(`${base}/v1/read?${search.toString()}`, {
    headers: authorizationHeaders(token),
  });
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
