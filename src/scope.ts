import { findNearestClientConfig, loadClientConfig } from "./config/client.ts";

export interface RegistryBinding {
  name: string;
  path: string;
}

export interface DanglingEndpoint {
  name: string;
  configPath: string;
  /** Position in `default_endpoints` declaration order, so consumers can interleave
   *  dangling entries with resolved bindings at their declared position. */
  index: number;
}

export interface ScopeInput {
  currentDirectory: string;
  registry: readonly RegistryBinding[];
  explicitEndpoints?: readonly string[];
  global?: boolean;
}

export interface ResolvedScope {
  source: "explicit" | "global" | "client-config" | "registry-fallback";
  bindings: RegistryBinding[];
  /** Unresolved `default_endpoints` references, in declaration order (client-config source only). */
  dangling: DanglingEndpoint[];
  warnings: string[];
  configPath?: string;
}

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

export function resolveScope(input: ScopeInput): ResolvedScope {
  const explicit = input.explicitEndpoints;
  if (input.global && explicit !== undefined) {
    throw new ScopeError("explicit endpoint scope and global scope cannot be used together");
  }

  const byName = new Map(input.registry.map((binding) => [binding.name, binding]));
  if (explicit !== undefined) {
    const bindings = explicit.map((name) => {
      const binding = byName.get(name);
      if (!binding) throw new ScopeError(`unknown endpoint '${name}'`);
      return binding;
    });
    return { source: "explicit", bindings, dangling: [], warnings: [] };
  }

  if (input.global) {
    return { source: "global", bindings: [...input.registry], dangling: [], warnings: [] };
  }

  const configPath = findNearestClientConfig(input.currentDirectory);
  if (!configPath) {
    return { source: "registry-fallback", bindings: [...input.registry], dangling: [], warnings: [] };
  }

  const config = loadClientConfig(configPath);
  const warnings: string[] = [];
  const dangling: DanglingEndpoint[] = [];
  const bindings: RegistryBinding[] = [];
  config.default_endpoints.forEach((name, index) => {
    const binding = byName.get(name);
    if (binding) bindings.push(binding);
    else {
      dangling.push({ name, configPath, index });
      warnings.push(`'${name}' is not registered (from ${configPath})`);
    }
  });
  if (bindings.length === 0) {
    throw new ScopeError("Client Config does not resolve to any registered endpoint");
  }
  return { source: "client-config", bindings, dangling, warnings, configPath };
}
