import { findNearestClientConfig, loadClientConfig } from "./config/client.ts";

export interface RegistryBinding {
  name: string;
  path: string;
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
    return { source: "explicit", bindings, warnings: [] };
  }

  if (input.global) {
    return { source: "global", bindings: [...input.registry], warnings: [] };
  }

  const configPath = findNearestClientConfig(input.currentDirectory);
  if (!configPath) {
    return { source: "registry-fallback", bindings: [...input.registry], warnings: [] };
  }

  const config = loadClientConfig(configPath);
  const warnings: string[] = [];
  const bindings: RegistryBinding[] = [];
  for (const name of config.default_endpoints) {
    const binding = byName.get(name);
    if (binding) bindings.push(binding);
    else warnings.push(`dangling endpoint '${name}' from ${configPath}`);
  }
  if (bindings.length === 0) {
    throw new ScopeError("Client Config does not resolve to any registered endpoint");
  }
  return { source: "client-config", bindings, warnings, configPath };
}
