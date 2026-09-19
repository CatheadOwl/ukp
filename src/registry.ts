import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { assertRestrictedToml, ENDPOINT_NAME, ManifestError } from "./config/manifest.ts";
import { acquireLock, LockBusyError, releaseLock } from "./fslock.ts";

const bindingSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1).optional(),
  /** Discriminator written only for remote bindings (D-077); absence = local. */
  kind: z.literal("remote").optional(),
  url: z.string().min(1).optional(),
  instance_uid: z.string().min(1).optional(),
  /** Client credential stored in the binding (D-078: plaintext, 0600 file —
   * AWS credentials-file / netrc convention; env override wins at call time). */
  token: z.string().min(1).optional(),
  /** Remote-declared endpoint name snapshotted at registration
   * (ADR-REM-007 / D-086): provenance and expected-assertion target. The
   * binding's `name` is the consumer-chosen handle (defaults to the declared
   * name); service identity stays with instance_uid / TLS pins. The profile
   * check lives in validateBindings, next to `name` itself. */
  declared_name: z.string().min(1).optional(),
  /** TLS trust anchor pinned at registration (W5' / D-079, self-signed
   * servers only — public-CA chains are not pinned): `tls_cert` is the PEM
   * used as the fetch trust anchor, `tls_pin` is the RFC 7469 SPKI pin that
   * survives certificate renewals which keep the key. Both or neither. */
  tls_cert: z.string().min(1).optional(),
  tls_pin: z.string().regex(/^sha256\/[A-Za-z0-9+/]+={0,2}$/).optional(),
}).strict();

const registrySchema = z.object({
  endpoints: z.array(bindingSchema),
}).strict();

/** Binding union over the `kind` axis (D-077). Local bindings keep the
 * historical `{name, path}` shape (no injected `kind` field), so parsed
 * locals stay byte-identical to the pre-remote era; remote bindings carry
 * `kind: "remote"` with `url` and an optional TOFU-pinned `instance_uid`.
 * Field exclusivity is enforced by validateBindings, not the type. */
export interface RegistryBinding {
  name: string;
  /** Local canonical absolute path (local bindings only). */
  path?: string;
  kind?: "remote";
  url?: string;
  instance_uid?: string;
  /** Remote-declared name snapshot (ADR-REM-007 / D-086); see bindingSchema. */
  declared_name?: string;
  /** Remote-only stored credential (plaintext; env takes precedence). */
  token?: string;
  /** Remote-only TLS anchor (W5' / D-079); see bindingSchema. */
  tls_cert?: string;
  tls_pin?: string;
}

export function isRemoteBinding(binding: RegistryBinding): boolean {
  return binding.kind === "remote";
}

/** Local path accessor with a classified error for remote bindings — the
 * single narrowing point local-filesystem consumers route through. */
export function localPathOf(binding: RegistryBinding): string {
  if (binding.kind === "remote" || binding.path === undefined) {
    throw new RegistryError(
      `endpoint '${binding.name}' is a remote binding (${binding.url}); it has no local Service folder`,
    );
  }
  return binding.path;
}

export function isLoopbackHttpUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** Remote url decomposition (D-078 + W7 / ADR-REM-004 O-3): every admissible
 * remote url is `scheme://[user@]host[:port][/endpoint]` — the optional
 * single path segment is the door-endpoint selector (`ssh://ali/notes`,
 * git's `ssh://[user@]host[:port]/<path>` shape). `origin` is the canonical
 * door address (default port absorbed, userinfo preserved) that grouping,
 * drift notes, and re-registration are keyed on. Multi-segment or
 * invalid-name paths make the whole url inadmissible. */
export interface RemoteUrlParts {
  scheme: "ssh" | "https" | "http";
  /** ssh userinfo (`ssh://user@host`), preserved in `origin` and the tunnel target. */
  user?: string;
  host: string;
  /** Explicit or scheme default (ssh 8570, https 443, http 80). */
  port: number;
  /** Present when the url carries the single door-endpoint path segment. */
  endpointName?: string;
  /** Canonical origin string (`ssh://ali`, `https://kb.example.com:8570`). */
  origin: string;
}

const REMOTE_DEFAULT_PORTS: Record<RemoteUrlParts["scheme"], number> = { ssh: 8570, https: 443, http: 80 };

export function parseRemoteUrl(raw: string): RemoteUrlParts | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  const scheme = parsed.protocol.replace(/:$/, "");
  if (scheme !== "ssh" && scheme !== "https" && scheme !== "http") return undefined;
  if (scheme === "http" && !isLoopbackHttpUrl(raw)) return undefined;
  const host = parsed.hostname;
  if (host.length === 0) return undefined;
  const port = parsed.port === "" ? REMOTE_DEFAULT_PORTS[scheme] : Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined;
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path.includes("//")) return undefined;
  let endpointName: string | undefined;
  if (path !== "") {
    const segment = path.replace(/^\//, "");
    if (segment.includes("/") || !ENDPOINT_NAME.test(segment)) return undefined;
    endpointName = segment;
  }
  const user = scheme === "ssh" && parsed.username !== "" ? parsed.username : undefined;
  const origin =
    `${scheme}://${user !== undefined ? `${user}@` : ""}${host}${port !== REMOTE_DEFAULT_PORTS[scheme] ? `:${port}` : ""}`;
  return {
    scheme,
    ...(user !== undefined ? { user } : {}),
    host,
    port,
    ...(endpointName !== undefined ? { endpointName } : {}),
    origin,
  };
}

/** `ssh://[user@]host[:port][/endpoint]` transport scheme (D-078; path
 * segment since W7): the client tunnels to the remote host's loopback over
 * SSH — encryption + host auth come from SSH, so the scheme is admissible
 * wherever https is. */
export function parseSshUrl(raw: string): { user?: string; host: string; port: number; endpointName?: string } | undefined {
  const parts = parseRemoteUrl(raw);
  if (parts === undefined || parts.scheme !== "ssh") return undefined;
  return {
    ...(parts.user !== undefined ? { user: parts.user } : {}),
    host: parts.host,
    port: parts.port,
    ...(parts.endpointName !== undefined ? { endpointName: parts.endpointName } : {}),
  };
}

/** Remote URL admission (ADR-REM-003 §7 + D-078; path semantics W7): https
 * always; plain http only on loopback (local dogfood); ssh://[user@]host[:port]
 * tunnels via SSH; the path, if any, must be a single endpoint name.
 * Enforced at registration AND at call time. */
export function assertRemoteUrlAllowed(raw: string): void {
  if (parseRemoteUrl(raw) !== undefined) return;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RegistryError(`remote endpoint url is not a valid absolute URL: ${raw}`);
  }
  const scheme = parsed.protocol.replace(/:$/, "");
  const schemeAdmitted =
    scheme === "https" || scheme === "ssh" || (scheme === "http" && isLoopbackHttpUrl(raw));
  if (schemeAdmitted) {
    const path = parsed.pathname.replace(/\/+$/, "");
    const segment = path.replace(/^\//, "");
    if (path !== "" && (segment.includes("/") || !ENDPOINT_NAME.test(segment))) {
      throw new RegistryError(
        `remote endpoint url path must be a single endpoint name ([a-z0-9-], one segment): ${raw}`,
      );
    }
    // Admitted scheme, well-formed (empty) path: the failure is structural
    // (empty host and the like) — the admission line names the valid shape.
  }
  throw new RegistryError(
    `remote endpoint url must be https, ssh://host[:port], or loopback http: ${raw} (bare-IP https: 'ukp serve --tls')`,
  );
}

export class RegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryError";
  }
}

export class RegistryBusyError extends RegistryError {
  constructor(path: string) {
    super(
      `registry_busy: ${path} (another ukp process holds the registry lock; ` +
        `stale locks are reclaimed automatically — close other ukp commands or retry shortly)`,
    );
    this.name = "RegistryBusyError";
  }
}
function validateBindings(endpoints: readonly RegistryBinding[]): RegistryBinding[] {
  const names = new Set<string>();
  const paths = new Set<string>();
  const urls = new Set<string>();
  for (const endpoint of endpoints) {
    if (!ENDPOINT_NAME.test(endpoint.name)) {
      throw new RegistryError(`invalid endpoint name '${endpoint.name}'`);
    }
    if (endpoint.kind === "remote") {
      if (endpoint.path !== undefined) {
        throw new RegistryError(`remote binding '${endpoint.name}' must not carry a local path`);
      }
      if (endpoint.url === undefined) {
        throw new RegistryError(`remote binding '${endpoint.name}' requires a url`);
      }
      if (endpoint.declared_name !== undefined && !ENDPOINT_NAME.test(endpoint.declared_name)) {
        throw new RegistryError(`remote binding '${endpoint.name}' carries an invalid declared name '${endpoint.declared_name}'`);
      }
      if ((endpoint.tls_cert !== undefined) !== (endpoint.tls_pin !== undefined)) {
        throw new RegistryError(`remote binding '${endpoint.name}' must carry tls_cert and tls_pin together`);
      }
      assertRemoteUrlAllowed(endpoint.url);
      if (urls.has(endpoint.url)) throw new RegistryError(`duplicate remote endpoint url '${endpoint.url}'`);
      urls.add(endpoint.url);
    } else {
      if (
        endpoint.url !== undefined || endpoint.instance_uid !== undefined || endpoint.token !== undefined
        || endpoint.declared_name !== undefined
        || endpoint.tls_cert !== undefined || endpoint.tls_pin !== undefined
      ) {
        throw new RegistryError(`local binding '${endpoint.name}' must not carry remote fields (url/instance_uid/token/declared_name/tls)`);
      }
      if (endpoint.path === undefined || !isAbsolute(endpoint.path)) {
        throw new RegistryError(`registry path must be absolute: ${endpoint.path ?? "(missing)"}`);
      }
      if (paths.has(endpoint.path)) throw new RegistryError(`duplicate endpoint location '${endpoint.path}'`);
      paths.add(endpoint.path);
    }
    if (names.has(endpoint.name)) throw new RegistryError(`duplicate endpoint name '${endpoint.name}'`);
    names.add(endpoint.name);
  }
  return [...endpoints].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

export function parseRegistry(source: string, path = "registry.toml"): RegistryBinding[] {
  if (source.trim().length === 0) throw new RegistryError(`Registry is empty: ${path}`);
  let raw: unknown;
  try {
    raw = parse(source);
    assertRestrictedToml(raw);
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    if (error instanceof ManifestError) throw new RegistryError(error.message, { cause: error });
    throw new RegistryError(`Registry TOML is invalid: ${path}`, { cause: error });
  }
  const result = registrySchema.safeParse(raw);
  if (!result.success) throw new RegistryError(`Registry schema is invalid: ${result.error.message}`);
  return validateBindings(result.data.endpoints);
}

export function readRegistry(registryPath: string): RegistryBinding[] {
  if (!existsSync(registryPath)) return [];
  try {
    return parseRegistry(readFileSync(registryPath, "utf8"), registryPath);
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError(`Registry is not readable: ${registryPath}`, { cause: error });
  }
}

/** Canonical serialization (configuration-contracts canonical form): local rows
 * `{name, path}`, remote rows `{name, kind, url, declared_name?, instance_uid?}`
 * (plus credentials/pins when present) — key order is insertion order, so
 * build plain ordered objects before stringify. */
function toSerializableBinding(binding: RegistryBinding): Record<string, string> {
  if (binding.kind === "remote") {
    return {
      name: binding.name,
      kind: "remote",
      url: binding.url!,
      ...(binding.declared_name !== undefined ? { declared_name: binding.declared_name } : {}),
      ...(binding.instance_uid !== undefined ? { instance_uid: binding.instance_uid } : {}),
      ...(binding.token !== undefined ? { token: binding.token } : {}),
      ...(binding.tls_cert !== undefined ? { tls_cert: binding.tls_cert } : {}),
      ...(binding.tls_pin !== undefined ? { tls_pin: binding.tls_pin } : {}),
    };
  }
  return { name: binding.name, path: binding.path! };
}

export function serializeRegistry(endpoints: readonly RegistryBinding[]): string {
  const sorted = validateBindings(endpoints);
  const value = { endpoints: sorted.map(toSerializableBinding) };
  const encoded = stringify(value);
  // Re-parse serializer output through the same validation pipeline.
  parseRegistry(encoded, "serialized registry");
  return encoded.endsWith("\n") ? encoded : `${encoded}\n`;
}

export function registerBinding(endpoints: readonly RegistryBinding[], binding: RegistryBinding): RegistryBinding[] {
  if (binding.kind === "remote") return registerRemoteBinding(endpoints, binding);
  const canonical: RegistryBinding = { name: binding.name, path: realpathSync(binding.path!) };
  const sameName = endpoints.find((endpoint) => endpoint.name === canonical.name);
  if (sameName) {
    if (sameName.kind !== "remote" && sameName.path === canonical.path) return validateBindings(endpoints);
    throw new RegistryError(
      `endpoint name '${canonical.name}' is already bound to ${sameName.kind === "remote" ? sameName.url : sameName.path}`,
    );
  }
  const samePath = endpoints.find((endpoint) => endpoint.kind !== "remote" && endpoint.path === canonical.path);
  if (samePath) {
    throw new RegistryError(`Service location is already bound to '${samePath.name}'`);
  }
  return validateBindings([...endpoints, canonical]);
}

/** Remote registration (D-077; naming residence ADR-REM-007 / D-086): the
 * binding `name` is the consumer-chosen handle (defaults to the declared
 * name), `declared_name` is the registration-time provenance snapshot.
 * Idempotency keys on url+declared name → refresh under the EXISTING handle
 * (N-2): one url, one handle; a second handle for the same instance goes
 * through a different url and warns at list time, never here. */
export function registerRemoteBinding(
  endpoints: readonly RegistryBinding[],
  binding: RegistryBinding,
): RegistryBinding[] {
  const canonical: RegistryBinding = {
    name: binding.name,
    kind: "remote",
    url: binding.url!,
    ...(binding.declared_name !== undefined ? { declared_name: binding.declared_name } : {}),
    ...(binding.instance_uid !== undefined ? { instance_uid: binding.instance_uid } : {}),
    ...(binding.token !== undefined ? { token: binding.token } : {}),
    ...(binding.tls_cert !== undefined ? { tls_cert: binding.tls_cert } : {}),
    ...(binding.tls_pin !== undefined ? { tls_pin: binding.tls_pin } : {}),
  };
  const sameUrl = endpoints.find((endpoint) => endpoint.kind === "remote" && endpoint.url === canonical.url);
  if (sameUrl) {
    // Legacy bindings (pre-ADR-REM-007) carry no declared_name; their handle
    // WAS the declared name under RQ-14, so the name stands in for it.
    const existingDeclared = sameUrl.declared_name ?? sameUrl.name;
    const incomingDeclared = canonical.declared_name ?? canonical.name;
    if (existingDeclared !== incomingDeclared) {
      throw new RegistryError(
        `remote endpoint at ${canonical.url} now declares '${incomingDeclared}', but binding '${sameUrl.name}' was registered for '${existingDeclared}'; unregister '${sameUrl.name}' and re-register`,
      );
    }
    if (canonical.name !== sameUrl.name && canonical.name !== incomingDeclared) {
      // An explicitly different handle for an instance already tracked under
      // this url: one url, one handle (rename = unregister + register).
      throw new RegistryError(
        `remote endpoint ${canonical.url} is already registered as '${sameUrl.name}'; unregister it first to change the handle`,
      );
    }
    // Default gesture (handle = declared name) or matching handle: the
    // idempotent refresh of the TOFU pin and credentials lands under the
    // EXISTING handle (N-2 — service replacement stays an explicit
    // unregister + re-register, ADR-REM-003). Direct-API callers that omit
    // declared_name must not erase the stored snapshot (the CLI always
    // passes it; the skip/refusal wording that mirrors this branch lives in
    // importDoorEndpoints).
    const refreshed: RegistryBinding = {
      ...canonical,
      ...(canonical.name !== sameUrl.name ? { name: sameUrl.name } : {}),
      ...(canonical.declared_name === undefined && sameUrl.declared_name !== undefined
        ? { declared_name: sameUrl.declared_name }
        : {}),
    };
    return validateBindings([...endpoints.filter((e) => e.name !== sameUrl.name), refreshed]);
  }
  const sameName = endpoints.find((endpoint) => endpoint.name === canonical.name);
  if (sameName) {
    throw new RegistryError(
      `endpoint name '${canonical.name}' is already bound to ${sameName.kind === "remote" ? sameName.url : sameName.path}; `
        + `register this endpoint under another handle with --name <handle>`,
    );
  }
  return validateBindings([...endpoints, canonical]);
}

export function unregisterBinding(endpoints: readonly RegistryBinding[], name: string): RegistryBinding[] {
  const index = endpoints.findIndex((endpoint) => endpoint.name === name);
  if (index < 0) throw new RegistryError(`endpoint not found: ${name}`);
  return validateBindings(endpoints.filter((_, candidateIndex) => candidateIndex !== index));
}

export function mutateRegistry(
  registryPath: string,
  mutation: (current: RegistryBinding[]) => RegistryBinding[],
): RegistryBinding[] {
  const directory = dirname(registryPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${registryPath}.lock`;
  let lockDescriptor: number;
  try {
    lockDescriptor = acquireLock(lockPath);
  } catch (error) {
    if (error instanceof LockBusyError) throw new RegistryBusyError(lockPath);
    throw new RegistryError(`cannot acquire Registry lock: ${lockPath}`, { cause: error });
  }
  let tempPath: string | undefined;
  let backupTempPath: string | undefined;
  try {
    const current = readRegistry(registryPath);
    const next = validateBindings(mutation(current));
    const encoded = serializeRegistry(next);
    tempPath = `${registryPath}.tmp.${randomUUID()}`;
    const tempDescriptor = openSync(tempPath, "wx", 0o600);
    try {
      writeFileSync(tempDescriptor, encoded, "utf8");
      fsyncSync(tempDescriptor);
    } finally {
      closeSync(tempDescriptor);
    }

    if (existsSync(registryPath)) {
      backupTempPath = `${registryPath}.bak.tmp.${randomUUID()}`;
      copyFileSync(registryPath, backupTempPath);
      const backupDescriptor = openSync(backupTempPath, "r+");
      try { fsyncSync(backupDescriptor); } finally { closeSync(backupDescriptor); }
      renameSync(backupTempPath, `${registryPath}.bak`);
      backupTempPath = undefined;
    }
    renameSync(tempPath, registryPath);
    tempPath = undefined;
    return next;
  } finally {
    if (tempPath && existsSync(tempPath)) unlinkSync(tempPath);
    if (backupTempPath && existsSync(backupTempPath)) unlinkSync(backupTempPath);
    releaseLock(lockPath, lockDescriptor);
  }
}

export function registerAt(registryPath: string, name: string, servicePath: string): RegistryBinding[] {
  const canonicalPath = realpathSync(servicePath);
  if (!statSync(canonicalPath).isDirectory()) throw new RegistryError(`Service location is not a directory: ${servicePath}`);
  return mutateRegistry(registryPath, (current) => registerBinding(current, { name, path: canonicalPath }));
}

export function registerRemoteAt(
  registryPath: string,
  binding: {
    name: string;
    url: string;
    declared_name?: string;
    instance_uid?: string;
    token?: string;
    tls_cert?: string;
    tls_pin?: string;
  },
): RegistryBinding[] {
  return mutateRegistry(registryPath, (current) => registerRemoteBinding(current, binding));
}

/** Renewal re-anchor (W5' / D-079): swap a pinned binding's stored trust
 * anchor PEM after the server renewed its certificate with the same key
 * (SPKI pin unchanged — that is the identity). Called from the read path,
 * where persistence is best-effort: the in-memory anchor already unblocks
 * the invocation, so lock contention must not fail the user-facing call. */
export function refreshRemoteTlsCert(registryPath: string, name: string, tls_cert: string): RegistryBinding[] {
  return mutateRegistry(registryPath, (current) => {
    const binding = current.find((endpoint) => endpoint.name === name && endpoint.kind === "remote");
    if (binding === undefined) throw new RegistryError(`endpoint not found: ${name}`);
    if (binding.tls_pin === undefined) {
      throw new RegistryError(`remote binding '${name}' carries no TLS pin; re-register instead of re-anchoring`);
    }
    return current.map((endpoint) => endpoint.name === name && endpoint.kind === "remote" ? { ...endpoint, tls_cert } : endpoint);
  });
}

export function unregisterAt(registryPath: string, name: string): RegistryBinding[] {
  return mutateRegistry(registryPath, (current) => unregisterBinding(current, name));
}
