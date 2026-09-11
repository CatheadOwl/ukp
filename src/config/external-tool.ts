// ADR-RG-003: external-tool base tier — the table governing capabilities
// backed by a ubiquitous external tool with graceful degradation. Mirrors
// the file-native table (ADR 0016): the set membership, the base-tier rule
// (available on every registered local Service; a declaration only
// overrides), and the provider marker live here and nowhere else.
//
// Tier criteria (stricter than file-native): the capability semantics must
// be fully defined by UKP (thin shaping, no tool-semantic wrap), read-only,
// dependent on a *ubiquitous* base tool (ripgrep-class), and degrade to an
// availability classification when the tool is missing — never a fault.

import type { Manifest, ManifestCapability } from "./manifest.ts";

/** Provider marker for the external-tool base tier. Manifest load defaults a
 * bare `[capabilities.<name>]` declaration to this value; any other provider
 * is a hard error (the tier does not plugin alternative tools). */
export const EXTERNAL_PROVIDER = "external";

export type ExternalToolCapabilityName = "rg";

export interface ExternalToolCapabilitySpec {
  /** Base tier (ADR-RG-003 rule): available on every registered local
   * Service without declaration; a declaration only overrides config. */
  readonly baseTier: boolean;
  /** Flat keys accepted directly under `[capabilities.<name>]`. */
  readonly flatConfigKeys: readonly string[];
}

export const EXTERNAL_TOOL_CAPABILITIES: Readonly<
  Record<ExternalToolCapabilityName, ExternalToolCapabilitySpec>
> = {
  rg: { baseTier: true, flatConfigKeys: [] },
};

export function isExternalToolCapability(name: string): name is ExternalToolCapabilityName {
  return Object.hasOwn(EXTERNAL_TOOL_CAPABILITIES, name);
}

export interface ExternalToolResolution {
  readonly capability: ManifestCapability;
  readonly source: "manifest" | "base-tier";
}

/** Resolves the effective external-tool capability declaration for a
 * Service: the Manifest declaration when present, otherwise the base-tier
 * default (`{ provider: "external" }`). Never `undefined` for base-tier
 * members — unlike the file-native set there is no write-side member that
 * requires explicit declaration. */
export function resolveExternalToolCapability(
  manifest: Manifest,
  name: ExternalToolCapabilityName,
): ExternalToolResolution {
  const declared = manifest.capabilities[name];
  if (declared !== undefined) {
    return { capability: declared, source: "manifest" };
  }
  return { capability: { provider: EXTERNAL_PROVIDER }, source: "base-tier" };
}
