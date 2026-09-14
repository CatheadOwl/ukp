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
  /** Remote-only stored credential (plaintext; env takes precedence). */
  token?: string;
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

/** `ssh://host[:port]` transport scheme (D-078): the client tunnels to the
 * remote host's loopback over SSH — encryption + host auth come from SSH,
 * so the scheme is admissible wherever https is. */
export function parseSshUrl(raw: string): { host: string; port: number } | undefined {
  if (!/^ssh:\/\/[^\/]+/.test(raw)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "ssh:" || parsed.pathname !== "/" && parsed.pathname !== "") return undefined;
  const host = parsed.hostname;
  if (host.length === 0) return undefined;
  const port = parsed.port === "" ? 8570 : Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined;
  return { host, port };
}

/** Remote URL admission (ADR-REM-003 §7 + D-078): https always; plain http
 * only on loopback (local dogfood); ssh://host[:port] tunnels via SSH.
 * Enforced at registration AND at call time. */
export function assertRemoteUrlAllowed(raw: string): void {
  const ssh = parseSshUrl(raw);
  if (ssh !== undefined) return;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RegistryError(`remote endpoint url is not a valid absolute URL: ${raw}`);
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && isLoopbackHttpUrl(raw)) return;
  throw new RegistryError(
    `remote endpoint url must be https, ssh://host[:port], or loopback http: ${raw}`,
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
      assertRemoteUrlAllowed(endpoint.url);
      if (urls.has(endpoint.url)) throw new RegistryError(`duplicate remote endpoint url '${endpoint.url}'`);
      urls.add(endpoint.url);
    } else {
      if (endpoint.url !== undefined || endpoint.instance_uid !== undefined || endpoint.token !== undefined) {
        throw new RegistryError(`local binding '${endpoint.name}' must not carry remote fields (url/instance_uid/token)`);
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

/** Canonical serialization (configuration-contracts 规范序列化): local rows
 * `{name, path}`, remote rows `{name, kind, url, instance_uid?}` — key order
 * is insertion order, so build plain ordered objects before stringify. */
function toSerializableBinding(binding: RegistryBinding): Record<string, string> {
  if (binding.kind === "remote") {
    return {
      name: binding.name,
      kind: "remote",
      url: binding.url!,
      ...(binding.instance_uid !== undefined ? { instance_uid: binding.instance_uid } : {}),
      ...(binding.token !== undefined ? { token: binding.token } : {}),
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

/** Remote registration (D-077): name comes from the discovery document
 * (RQ-14), instance_uid is the TOFU pin. Idempotent on same name+url. */
export function registerRemoteBinding(
  endpoints: readonly RegistryBinding[],
  binding: RegistryBinding,
): RegistryBinding[] {
  const canonical: RegistryBinding = {
    name: binding.name,
    kind: "remote",
    url: binding.url!,
    ...(binding.instance_uid !== undefined ? { instance_uid: binding.instance_uid } : {}),
    ...(binding.token !== undefined ? { token: binding.token } : {}),
  };
  const sameName = endpoints.find((endpoint) => endpoint.name === canonical.name);
  if (sameName) {
    if (sameName.kind === "remote" && sameName.url === canonical.url) {
      // Same name+url re-registration refreshes the TOFU pin (service
      // replacement is an explicit re-register, ADR-REM-003).
      return validateBindings([...endpoints.filter((e) => e.name !== canonical.name), canonical]);
    }
    throw new RegistryError(
      `endpoint name '${canonical.name}' is already bound to ${sameName.kind === "remote" ? sameName.url : sameName.path}`,
    );
  }
  const sameUrl = endpoints.find((endpoint) => endpoint.kind === "remote" && endpoint.url === canonical.url);
  if (sameUrl) {
    throw new RegistryError(`remote endpoint url is already bound to '${sameUrl.name}'`);
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
  binding: { name: string; url: string; instance_uid?: string; token?: string },
): RegistryBinding[] {
  return mutateRegistry(registryPath, (current) => registerRemoteBinding(current, binding));
}

export function unregisterAt(registryPath: string, name: string): RegistryBinding[] {
  return mutateRegistry(registryPath, (current) => unregisterBinding(current, name));
}
