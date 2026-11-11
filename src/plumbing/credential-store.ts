/**
 * W14 / ADR-REM-013: the consumer-side credential store — a PURE plumbing
 * module (purity-tested: node builtins and intra-plumbing imports only).
 * Platform mechanics arrive as injected commands (argv for macOS/Linux
 * tools, a powershell script for the win32 DPAPI path whose carrier lives
 * at the wiring layer), so this file owns strategy and encoding decisions
 * while staying free of UKP imports.
 *
 * Residence model (INV-10): env > store > inline registry token. The store
 * is keyed by binding handle; a binding points at it via token_ref
 * ("os-store"). When no store is available the CALLER falls back to the
 * inline token and must say so loudly (never a silent downgrade).
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** The surface every consumer (register, resolveRemoteToken, diagnose,
 * unregister) talks to. Injected as `context.credentialStore` in tests;
 * the default instance is built at the wiring layer. */
export interface CredentialStore {
  /** Probed once per process; false means callers use the plaintext path. */
  available(): boolean;
  /** Store a secret under the binding handle. false = write failed (the
   * caller falls back to the inline token for THIS handle). */
  put(name: string, raw: string): boolean;
  get(name: string): string | undefined;
  remove(name: string): void;
}

/** A command the executor runs: either a plain argv (macOS `security`,
 * Linux `secret-tool`) or a powershell script riding the encoded carrier
 * (win32 DPAPI — the executor encodes; this module never spawns). */
export type StoreCommand =
  | { kind: "argv"; argv: readonly string[]; stdin?: string }
  | { kind: "powershell"; script: string; stdin?: string };

export interface StoreRunResult {
  status: number;
  stdout: string;
}

export type StoreExecutor = (command: StoreCommand) => StoreRunResult;

/** Handles are ENDPOINT_NAME-shaped upstream; the store still refuses
 * anything outside [A-Za-z0-9._-] so a hostile name can never traverse. */
function safeHandle(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes("..");
}

function psSingleQuoted(arg: string): string {
  return `'${arg.replaceAll("'", "''")}'`;
}

/* ---------------------------------------------------------- win32: DPAPI */

/** DPAPI scripts (CurrentUser scope): the secret rides stdin and never
 * argv; the protected blob lands at ~/.ukp/secrets/<handle>.bin. */
function dpapiPutScript(file: string): string {
  return (
    "$ProgressPreference = 'SilentlyContinue'; "
    + "Add-Type -AssemblyName System.Security; "
    + "$in = [Console]::In.ReadToEnd(); "
    + "$bytes = [System.Text.Encoding]::UTF8.GetBytes($in); "
    + "$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, "
    + "[System.Security.Cryptography.DataProtectionScope]::CurrentUser); "
    + `[System.IO.File]::WriteAllBytes(${psSingleQuoted(file)}, $enc)`
  );
}

function dpapiGetScript(file: string): string {
  return (
    "$ProgressPreference = 'SilentlyContinue'; "
    + "Add-Type -AssemblyName System.Security; "
    + `$enc = [System.IO.File]::ReadAllBytes(${psSingleQuoted(file)}); `
    + "$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, "
    + "[System.Security.Cryptography.DataProtectionScope]::CurrentUser); "
    + "[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))"
  );
}

/* ------------------------------------------------- platform store builder */

export function createCredentialStore(
  platform: NodeJS.Platform,
  homeDir: string,
  run: StoreExecutor,
): CredentialStore {
  const secretsDir = join(homeDir, ".ukp", "secrets");

  if (platform === "win32") {
    const fileFor = (name: string) => join(secretsDir, `${name}.bin`);
    let probed: boolean | undefined;
    const probe = (): boolean => {
      if (probed !== undefined) return probed;
      const probeFile = join(secretsDir, "__ukp_probe__.bin");
      mkdirSync(secretsDir, { recursive: true });
      const putOk = run({
        kind: "powershell",
        script: dpapiPutScript(probeFile),
        stdin: "ukp-store-probe",
      }).status === 0;
      let ok = false;
      if (putOk) {
        const back = run({ kind: "powershell", script: dpapiGetScript(probeFile) });
        ok = back.status === 0 && back.stdout === "ukp-store-probe";
      }
      try {
        unlinkSync(probeFile);
      } catch {
        ok = false;
      }
      probed = ok;
      return ok;
    };
    return {
      available: probe,
      put(name, raw) {
        if (!safeHandle(name)) return false;
        mkdirSync(secretsDir, { recursive: true });
        return run({ kind: "powershell", script: dpapiPutScript(fileFor(name)), stdin: raw }).status === 0;
      },
      get(name) {
        if (!safeHandle(name)) return undefined;
        const file = fileFor(name);
        if (!existsSync(file)) return undefined;
        const back = run({ kind: "powershell", script: dpapiGetScript(file) });
        return back.status === 0 ? back.stdout : undefined;
      },
      remove(name) {
        if (!safeHandle(name)) return;
        try {
          unlinkSync(fileFor(name));
        } catch {
          // absent entry is a no-op removal
        }
      },
    };
  }

  if (platform === "darwin") {
    // Residual (ADR-REM-013): `security -w` has no stdin form, so the raw
    // secret flashes through argv for the moment of the call.
    let probed: boolean | undefined;
    const probe = (): boolean => {
      if (probed !== undefined) return probed;
      const ok =
        run({ kind: "argv", argv: ["security", "add-generic-password", "-U", "-s", "ukp", "-a", "__ukp_probe__", "-w", "ukp-store-probe"] }).status === 0
        && run({ kind: "argv", argv: ["security", "find-generic-password", "-s", "ukp", "-a", "__ukp_probe__", "-w"] }).stdout.trim() === "ukp-store-probe";
      if (ok) run({ kind: "argv", argv: ["security", "delete-generic-password", "-s", "ukp", "-a", "__ukp_probe__"] });
      probed = ok;
      return ok;
    };
    return {
      available: probe,
      put(name, raw) {
        if (!safeHandle(name)) return false;
        return run({ kind: "argv", argv: ["security", "add-generic-password", "-U", "-s", "ukp", "-a", name, "-w", raw] }).status === 0;
      },
      get(name) {
        if (!safeHandle(name)) return undefined;
        const back = run({ kind: "argv", argv: ["security", "find-generic-password", "-s", "ukp", "-a", name, "-w"] });
        return back.status === 0 ? back.stdout.trim() : undefined;
      },
      remove(name) {
        if (!safeHandle(name)) return;
        run({ kind: "argv", argv: ["security", "delete-generic-password", "-s", "ukp", "-a", name] });
      },
    };
  }

  // linux (and everything else): secret-tool; binary presence is the probe
  // (a reachable daemon only proves itself on the first real put, whose
  // failure falls back inline for that handle). Residual (ADR-REM-013):
  // secret-tool has no delete — remove() is a tombstone overwrite.
  let probed: boolean | undefined;
  return {
    available() {
      if (probed === undefined) probed = run({ kind: "argv", argv: ["secret-tool", "--version"] }).status === 0;
      return probed;
    },
    put(name, raw) {
      if (!safeHandle(name)) return false;
      return run({
        kind: "argv",
        argv: ["secret-tool", "store", "--label=ukp endpoint token", "service", "ukp", "account", name],
        stdin: raw,
      }).status === 0;
    },
    get(name) {
      if (!safeHandle(name)) return undefined;
      const back = run({ kind: "argv", argv: ["secret-tool", "lookup", "service", "ukp", "account", name] });
      return back.status === 0 && back.stdout.length > 0 ? back.stdout.trim() : undefined;
    },
    remove(name) {
      if (!safeHandle(name)) return;
      run({
        kind: "argv",
        argv: ["secret-tool", "store", "--label=ukp endpoint token", "service", "ukp", "account", name],
        stdin: "",
      });
    },
  };
}

/** In-memory store for tests and for wiring that must not touch the OS. */
export function inMemoryCredentialStore(map = new Map<string, string>()): CredentialStore {
  return {
    available: () => true,
    put(name, raw) {
      map.set(name, raw);
      return true;
    },
    get: (name) => map.get(name),
    remove(name) {
      map.delete(name);
    },
  };
}

/** Deterministic "no store on this machine" for tests and loud fallbacks. */
export function unavailableCredentialStore(): CredentialStore {
  return {
    available: () => false,
    put: () => false,
    get: () => undefined,
    remove: () => {},
  };
}
