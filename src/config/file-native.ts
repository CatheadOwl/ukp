// ADR 0016: file-native capability set — the single table governing every
// file-native capability. Three rules live here and nowhere else:
//
// 1. the set membership (`read`, `nav`, `propose`);
// 2. which members are derived defaults of every registered local Service
//    (read-only, exposure within the read/file baseline) vs. which still
//    require an explicit declaration (write-side: `propose`);
// 3. which flat declaration keys each capability accepts directly under
//    `[capabilities.<name>]` (normalized into `config` at Manifest load).
//
// Capability implementations and command surfaces resolve their declaration
// through this module instead of re-implementing per-capability fallbacks,
// so a new file-native capability joins by editing this table only.

import type { Manifest, ManifestCapability } from "./manifest.ts";

export type FileNativeCapabilityName = "read" | "nav" | "propose";

export interface FileNativeCapabilitySpec {
  /** Derived default of every registered local Service (ADR 0016 rule 2):
   * present without any declaration; a declaration only overrides defaults. */
  readonly derived: boolean;
  /** Flat keys accepted directly under `[capabilities.<name>]` (flat UX, no
   * `.config` hop). Normalized into `config` at load; a key present both
   * flat and under `.config` is a declaration conflict. */
  readonly flatConfigKeys: readonly string[];
}

export const FILE_NATIVE_CAPABILITIES: Readonly<Record<FileNativeCapabilityName, FileNativeCapabilitySpec>> = {
  // `read` is in the set for uniformity (rule 1); its bare-declaration arm is
  // unreachable in practice because a declared [capabilities.get] is stripped
  // as legacy before provider defaulting — read's derived baseline has no
  // Manifest override surface at all (ADR 0007 / ADR 0016).
  read: { derived: true, flatConfigKeys: [] },
  nav: { derived: true, flatConfigKeys: ["exclude_files", "exclude_dirs"] },
  propose: { derived: false, flatConfigKeys: [] },
};

export function isFileNativeCapability(name: string): name is FileNativeCapabilityName {
  return Object.hasOwn(FILE_NATIVE_CAPABILITIES, name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Load-time normalization of flat declaration keys into `config`, driven by
 * the table above. `fail` lets the Manifest loader keep its own error type
 * (single ManifestError surface); the message text is owned here. Pure: does
 * not mutate the input. */
export function normalizeFileNativeFlatKeys(
  raw: unknown,
  fail: (message: string) => never,
): unknown {
  if (!isRecord(raw) || !isRecord(raw.capabilities)) return raw;
  const output: Record<string, unknown> = { ...raw.capabilities };
  let changed = false;
  for (const [name, declaration] of Object.entries(raw.capabilities)) {
    if (!isFileNativeCapability(name) || !isRecord(declaration)) continue;
    const flatKeys = FILE_NATIVE_CAPABILITIES[name].flatConfigKeys;
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

export interface FileNativeResolution {
  readonly capability: ManifestCapability;
  readonly source: "manifest" | "derived-local";
}

/** Resolves the effective file-native capability declaration for a Service:
 * the Manifest declaration when present, otherwise the derived default
 * (`{ provider: "file" }`) for derived members. `undefined` means the
 * capability is not effectively present — today only an undeclared write-side
 * capability (`propose`), whose caller reports the missing declaration. */
export function resolveFileNativeCapability(
  manifest: Manifest,
  name: FileNativeCapabilityName,
): FileNativeResolution | undefined {
  const declared = manifest.capabilities[name];
  if (declared !== undefined) {
    return { capability: declared, source: "manifest" };
  }
  return FILE_NATIVE_CAPABILITIES[name].derived
    ? { capability: { provider: "file" }, source: "derived-local" }
    : undefined;
}

/** Uniform unsupported-provider message for every file-native capability
 * (only the `file` provider exists; a different provider is a hard error at
 * every surface). The `(none)` arm is defensive depth only — Manifest load
 * already defaults a bare declaration to `"file"` and fails fast elsewhere. */
export function unsupportedFileNativeProviderMessage(
  name: FileNativeCapabilityName,
  provider: string | undefined,
): string {
  return `unsupported ${name} provider '${provider ?? "(none)"}' (supported: file)`;
}
