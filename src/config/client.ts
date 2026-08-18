import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { assertRestrictedToml, ENDPOINT_NAME, ManifestError } from "./manifest.ts";

const clientConfigSchema = z.object({
  default_endpoints: z.array(z.string().min(1)).min(1),
}).strict();

export interface ClientConfig {
  default_endpoints: string[];
}

export function loadClientConfig(path: string): ClientConfig {
  const serviceManifestPath = join(dirname(path), "service.toml");
  if (existsSync(serviceManifestPath)) {
    throw new ManifestError(
      `Folder role conflict: ${dirname(dirname(path))} cannot contain both .ukp/client.toml and .ukp/service.toml`,
    );
  }
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new ManifestError(`Client Config is not readable: ${path}`, { cause: error });
  }

  let raw: unknown;
  try {
    raw = parse(source);
    assertRestrictedToml(raw);
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    throw new ManifestError(`Client Config TOML is invalid: ${path}`, { cause: error });
  }

  const result = clientConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ManifestError(`Client Config schema is invalid: ${result.error.message}`);
  }
  const names = result.data.default_endpoints;
  if (names.some((name) => !ENDPOINT_NAME.test(name))) {
    throw new ManifestError(`${path}: default_endpoints contains an invalid endpoint name`);
  }
  if (new Set(names).size !== names.length) {
    throw new ManifestError(`${path}: default_endpoints contains duplicate endpoint names`);
  }
  return result.data;
}

export function findNearestClientConfig(currentDirectory: string): string | undefined {
  let directory = currentDirectory;
  while (true) {
    const candidate = join(directory, ".ukp", "client.toml");
    if (existsSync(candidate)) return candidate;
    const parent = join(directory, "..");
    if (parent === directory) return undefined;
    directory = parent;
  }
}
