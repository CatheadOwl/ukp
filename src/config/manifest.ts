import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { isFileNativeCapability, normalizeFileNativeFlatKeys } from "./file-native.ts";

export const ENDPOINT_NAME = /^(?=.{1,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

// `provider` is optional at the schema level: file-native capabilities
// (see file-native.ts, ADR 0016) default to `"file"` at load; every other
// capability fails fast with a declaration error when `provider` is missing.
const capabilitySchema = z.object({
  provider: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
}).strict();

const endpointNameSchema = z.string().regex(ENDPOINT_NAME);

const dependencyKindSchema = z.enum(["authority", "context", "implementation", "evidence"]);

const dependencySchema = z.object({
  endpoint: endpointNameSchema,
  kind: dependencyKindSchema,
  reason: z.string().min(1).optional(),
}).strict();

const dependenciesSchema = z.array(dependencySchema).min(1).superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, dependency] of value.entries()) {
    if (seen.has(dependency.endpoint)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate dependency '${dependency.endpoint}'`,
        path: [index],
      });
      continue;
    }
    seen.add(dependency.endpoint);
  }
});

const manifestSchema = z.object({
  name: z.string().optional(),
  description: z.string().min(1).optional(),
  dependencies: dependenciesSchema.optional(),
  capabilities: z.record(z.string(), capabilitySchema),
}).strict();

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestCapability = z.infer<typeof capabilitySchema>;
export type ManifestDependency = z.infer<typeof dependencySchema>;

export class ManifestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManifestError";
  }
}

export function assertRestrictedToml(value: unknown, path = "root"): void {
  if (value === null || value === undefined || value instanceof Date) {
    throw new ManifestError(`${path}: unsupported TOML value`);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new ManifestError(`${path}: only safe integer TOML values are supported`);
    }
    return;
  }
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "bigint") {
    throw new ManifestError(`${path}: integer exceeds JavaScript safe range`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertRestrictedToml(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertRestrictedToml(child, `${path}.${key}`);
    }
    return;
  }
  throw new ManifestError(`${path}: unsupported TOML value`);
}

function parseName(value: string, source: string): string {
  if (!ENDPOINT_NAME.test(value)) {
    throw new ManifestError(`${source}: invalid endpoint name '${value}'`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeLegacyGetCapability(raw: unknown): { normalized: unknown; hadLegacyGet: boolean } {
  if (!isRecord(raw) || !isRecord(raw.capabilities) || !Object.hasOwn(raw.capabilities, "get")) {
    return { normalized: raw, hadLegacyGet: false };
  }

  const { get: _ignoredLegacyGet, ...capabilities } = raw.capabilities;
  return {
    normalized: {
      ...raw,
      capabilities,
    },
    hadLegacyGet: true,
  };
}

export interface LoadedManifest {
  folder: string;
  manifestPath: string;
  manifest: Manifest;
  effectiveName: string;
  nameSource: "manifest" | "folder-name";
}

export function loadManifest(serviceFolder: string): LoadedManifest {
  let folder: string;
  try {
    folder = realpathSync(serviceFolder);
    if (!statSync(folder).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new ManifestError(`Service folder is not accessible: ${serviceFolder}`, { cause: error });
  }

  const manifestPath = join(folder, ".ukp", "service.toml");
  const clientConfigPath = join(folder, ".ukp", "client.toml");
  if (existsSync(manifestPath) && existsSync(clientConfigPath)) {
    throw new ManifestError(
      `Folder role conflict: ${folder} cannot contain both .ukp/service.toml and .ukp/client.toml`,
    );
  }
  let source: string;
  try {
    source = readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw new ManifestError(`Service Manifest is not readable: ${manifestPath}`, { cause: error });
  }

  let raw: unknown;
  try {
    raw = parse(source);
  } catch (error) {
    throw new ManifestError(`Service Manifest TOML is invalid: ${manifestPath}`, { cause: error });
  }
  assertRestrictedToml(raw);

  const { normalized: withoutLegacyGet, hadLegacyGet } = removeLegacyGetCapability(raw);
  // Flat file-native declaration keys (table-driven, ADR 0016) fold into
  // `config` before the strict schema parse.
  const normalized = normalizeFileNativeFlatKeys(withoutLegacyGet, (message) => {
    throw new ManifestError(message);
  });
  const result = manifestSchema.safeParse(normalized);
  if (!result.success) {
    throw new ManifestError(`Service Manifest schema is invalid: ${result.error.message}`);
  }
  const manifest = result.data;
  if (Object.keys(manifest.capabilities).length === 0 && !hadLegacyGet) {
    throw new ManifestError("Service Manifest must declare at least one capability");
  }

  const nameSource = manifest.name === undefined ? "folder-name" : "manifest";
  const effectiveName = parseName(manifest.name ?? basename(folder), nameSource);
  if (manifest.dependencies?.some((dependency) => dependency.endpoint === effectiveName)) {
    throw new ManifestError(`Service Manifest dependency cannot target the Service itself: '${effectiveName}'`);
  }
  // Capability-level provider defaults (ADR 0016 rule 1): a bare
  // `[capabilities.<name>]` declaration for a file-native capability means
  // the UKP-native file provider — the common case needs zero configuration.
  // Every other capability still fails fast at load when `provider` is
  // missing (a typo must not degrade into a runtime "(none)" warning).
  for (const [name, declaration] of Object.entries(manifest.capabilities)) {
    if (declaration.provider === undefined) {
      if (isFileNativeCapability(name)) {
        manifest.capabilities[name] = { ...declaration, provider: "file" };
      } else {
        throw new ManifestError(`[capabilities.${name}] must declare a provider`);
      }
    }
  }
  return { folder, manifestPath, manifest, effectiveName, nameSource };
}
