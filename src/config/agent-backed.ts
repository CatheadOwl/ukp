// ukp_session (ADR-SESSION-001): agent-backed capability tier — the table
// governing capabilities whose substrate is an external agent harness
// declared in the Host Registry. Mirrors the file-native (ADR 0016) and
// external-tool (ADR-RG-003) tables: set membership, the provider marker,
// and flat declaration keys live here and nowhere else. Unlike those tiers
// an agent-backed capability is never derived — absence of the declaration
// means the endpoint explicitly does not host sessions, and spawn treats
// that as a hard stop, not a warning (line spec §1 / §5).

import type { ManifestCapability } from "./manifest.ts";

/** Provider marker for the agent-backed tier. A bare
 * `[capabilities.<name>]` declaration defaults to this value; any other
 * provider is a hard error (the tier does not plugin alternative bases). */
export const AGENT_PROVIDER = "agent";

export type AgentBackedCapabilityName = "session";

/** Write permission tier for a hosted session (owner ruling 2026-10-18: the
 * grant lives in the endpoint's own declaration, not in the adapter default
 * and not in runtime approval). `read-only` is the scout default; `workspace`
 * maps to the substrate's workspace-write sandbox (writes confined to the
 * endpoint folder). */
export type SessionWriteTier = "read-only" | "workspace";

interface AgentBackedCapabilitySpec {
  /** Always false: hosting is opt-in per endpoint (ADR-SESSION-001). */
  readonly derived: false;
  /** Flat keys accepted directly under `[capabilities.<name>]`. */
  readonly flatConfigKeys: readonly string[];
}

export const AGENT_BACKED_CAPABILITIES: Readonly<
  Record<AgentBackedCapabilityName, AgentBackedCapabilitySpec>
> = {
  session: { derived: false, flatConfigKeys: ["agents", "write"] },
};

export function isAgentBackedCapability(name: string): name is AgentBackedCapabilityName {
  return Object.hasOwn(AGENT_BACKED_CAPABILITIES, name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Load-time normalization of flat declaration keys into `config`, the
 * same discipline as the file-native pass (flat UX without the `.config`
 * hop; the same key both places is a declaration conflict). Pure. */
export function normalizeAgentBackedFlatKeys(
  raw: unknown,
  fail: (message: string) => never,
): unknown {
  if (!isRecord(raw) || !isRecord(raw.capabilities)) return raw;
  const output: Record<string, unknown> = { ...raw.capabilities };
  let changed = false;
  for (const [name, declaration] of Object.entries(raw.capabilities)) {
    if (!isAgentBackedCapability(name) || !isRecord(declaration)) continue;
    const flatKeys = AGENT_BACKED_CAPABILITIES[name].flatConfigKeys;
    if (!flatKeys.some((key) => Object.hasOwn(declaration, key))) continue;
    const config = isRecord(declaration.config) ? { ...declaration.config } : {};
    const next: Record<string, unknown> = { ...declaration };
    for (const key of flatKeys) {
      if (!Object.hasOwn(next, key)) continue;
      if (Object.hasOwn(config, key)) {
        fail(`[capabilities.${name}] '${key}' is declared both directly and under [capabilities.${name}.config]`);
      }
      config[key] = next[key];
      delete next[key];
    }
    next.config = config;
    output[name] = next;
    changed = true;
  }
  return changed ? { ...raw, capabilities: output } : raw;
}

/** Handle grammar for agent handles and allowlist entries — the full
 * ENDPOINT_NAME constraint (manifest.ts), length bound included, kept
 * textual here so the governance table owns its own surface. */
export const AGENT_HANDLE = /^(?=.{1,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Declaration-level validation of the allowlist (shape only — whether a
 * handle has a Host Registry substrate is use-time, spec §2). An empty
 * allowlist is a valid "off" declaration (spec §1). */
export function validateAgentBackedDeclaration(
  name: AgentBackedCapabilityName,
  declaration: ManifestCapability,
  fail: (message: string) => never,
): void {
  if (name !== "session") return;
  const agents = declaration.config?.agents;
  if (agents === undefined) {
    fail(`[capabilities.session] must declare 'agents' (an allowlist of agent handles; empty = hosting off)`);
  }
  if (!Array.isArray(agents)) {
    fail("[capabilities.session] 'agents' must be an array of agent handles");
  }
  const seen = new Set<string>();
  for (const item of agents) {
    if (typeof item !== "string" || !AGENT_HANDLE.test(item)) {
      fail(`[capabilities.session] 'agents' contains an invalid handle: ${JSON.stringify(item)}`);
    }
    if (seen.has(item)) {
      fail(`[capabilities.session] 'agents' lists handle '${item}' more than once`);
    }
    seen.add(item);
  }
  const write = declaration.config?.write;
  if (write !== undefined && write !== "workspace") {
    fail(`[capabilities.session] 'write' must be "workspace" when declared (got ${JSON.stringify(write)}); absent = read-only`);
  }
}

/** The effective hosting allowlist: handles declared under
 * `[capabilities.session]`. Absent declaration or empty list = hosting
 * off (spawn refuses; never a warning). */
export function resolveSessionAgents(manifest: {
  capabilities: Record<string, ManifestCapability>;
}): readonly string[] {
  const declaration = manifest.capabilities.session;
  if (declaration === undefined) return [];
  const agents = declaration.config?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.filter((item): item is string => typeof item === "string");
}

/** The effective write tier: `workspace` only when the endpoint declared it;
 * anything else (absent declaration included) is the read-only scout default.
 * Load-time validation already rejected foreign values — this reads what
 * passed, it does not re-decide. */
export function resolveSessionWriteTier(manifest: {
  capabilities: Record<string, ManifestCapability>;
}): SessionWriteTier {
  return manifest.capabilities.session?.config?.write === "workspace" ? "workspace" : "read-only";
}
