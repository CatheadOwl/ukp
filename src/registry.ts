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
import { hostname } from "node:os";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { assertRestrictedToml, ENDPOINT_NAME, ManifestError } from "./config/manifest.ts";

const bindingSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
}).strict();

const registrySchema = z.object({
  endpoints: z.array(bindingSchema),
}).strict();

export type RegistryBinding = z.infer<typeof bindingSchema>;

export class RegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryError";
  }
}

export class RegistryBusyError extends RegistryError {
  constructor(path: string) {
    super(`registry_busy: ${path}`);
    this.name = "RegistryBusyError";
  }
}

function validateBindings(endpoints: readonly RegistryBinding[]): RegistryBinding[] {
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const endpoint of endpoints) {
    if (!ENDPOINT_NAME.test(endpoint.name)) {
      throw new RegistryError(`invalid endpoint name '${endpoint.name}'`);
    }
    if (!isAbsolute(endpoint.path)) {
      throw new RegistryError(`registry path must be absolute: ${endpoint.path}`);
    }
    if (names.has(endpoint.name)) throw new RegistryError(`duplicate endpoint name '${endpoint.name}'`);
    if (paths.has(endpoint.path)) throw new RegistryError(`duplicate endpoint location '${endpoint.path}'`);
    names.add(endpoint.name);
    paths.add(endpoint.path);
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

export function serializeRegistry(endpoints: readonly RegistryBinding[]): string {
  const sorted = validateBindings(endpoints);
  const value = { endpoints: sorted };
  const encoded = stringify(value);
  // Re-parse serializer output through the same validation pipeline.
  parseRegistry(encoded, "serialized registry");
  return encoded.endsWith("\n") ? encoded : `${encoded}\n`;
}

export function registerBinding(endpoints: readonly RegistryBinding[], binding: RegistryBinding): RegistryBinding[] {
  const canonical: RegistryBinding = { name: binding.name, path: realpathSync(binding.path) };
  const sameName = endpoints.find((endpoint) => endpoint.name === canonical.name);
  if (sameName) {
    if (sameName.path === canonical.path) return validateBindings(endpoints);
    throw new RegistryError(`endpoint name '${canonical.name}' is already bound to ${sameName.path}`);
  }
  const samePath = endpoints.find((endpoint) => endpoint.path === canonical.path);
  if (samePath) {
    throw new RegistryError(`Service location is already bound to '${samePath.name}'`);
  }
  return validateBindings([...endpoints, canonical]);
}

export function unregisterBinding(endpoints: readonly RegistryBinding[], name: string): RegistryBinding[] {
  const index = endpoints.findIndex((endpoint) => endpoint.name === name);
  if (index < 0) throw new RegistryError(`endpoint not found: ${name}`);
  return validateBindings(endpoints.filter((_, candidateIndex) => candidateIndex !== index));
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processExists(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return undefined;
  }
}

function reclaimStaleLock(lockPath: string): boolean {
  try {
    const metadata = parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    if (metadata.hostname !== hostname()) return false;
    if (typeof metadata.pid !== "number" || !Number.isSafeInteger(metadata.pid)) return false;
    if (typeof metadata.created_at !== "string") return false;
    const createdAt = Date.parse(metadata.created_at);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt <= 10 * 60 * 1000) return false;
    if (processExists(metadata.pid) !== false) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lockPath: string): number {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(
          descriptor,
          `pid = ${process.pid}\nhostname = ${JSON.stringify(hostname())}\ncreated_at = ${JSON.stringify(new Date().toISOString())}\ntoken = ${JSON.stringify(randomUUID())}\n`,
          "utf8",
        );
        fsyncSync(descriptor);
        return descriptor;
      } catch (error) {
        closeSync(descriptor);
        if (existsSync(lockPath)) unlinkSync(lockPath);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && reclaimStaleLock(lockPath)) {
        continue;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RegistryBusyError(lockPath);
        throw new RegistryError(`cannot acquire Registry lock: ${lockPath}`, { cause: error });
      }
      sleep(25);
    }
  }
}

export function mutateRegistry(
  registryPath: string,
  mutation: (current: RegistryBinding[]) => RegistryBinding[],
): RegistryBinding[] {
  const directory = dirname(registryPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${registryPath}.lock`;
  const lockDescriptor = acquireLock(lockPath);
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
    closeSync(lockDescriptor);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
}

export function registerAt(registryPath: string, name: string, servicePath: string): RegistryBinding[] {
  const canonicalPath = realpathSync(servicePath);
  if (!statSync(canonicalPath).isDirectory()) throw new RegistryError(`Service location is not a directory: ${servicePath}`);
  return mutateRegistry(registryPath, (current) => registerBinding(current, { name, path: canonicalPath }));
}

export function unregisterAt(registryPath: string, name: string): RegistryBinding[] {
  return mutateRegistry(registryPath, (current) => unregisterBinding(current, name));
}
