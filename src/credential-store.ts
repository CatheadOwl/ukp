/**
 * W14 / ADR-REM-013: the default credential store wiring. The pure module
 * (src/plumbing/credential-store.ts) owns strategy; this file owns the
 * process-level executor — argv commands spawn directly, powershell
 * scripts ride the spawn-relay -EncodedCommand carrier (the bun→powershell
 * direct edge is the Defender-taxed one; same escape as ssh/rg).
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { encodedPowershell } from "./spawn-relay.ts";
import {
  createCredentialStore,
  type CredentialStore,
  type StoreCommand,
} from "./plumbing/credential-store.ts";

export type { CredentialStore } from "./plumbing/credential-store.ts";
export {
  inMemoryCredentialStore,
  unavailableCredentialStore,
} from "./plumbing/credential-store.ts";

let singleton: CredentialStore | undefined;

export function defaultCredentialStore(): CredentialStore {
  singleton ??= createCredentialStore(process.platform, homedir(), executeStoreCommand);
  return singleton;
}

function executeStoreCommand(command: StoreCommand): { status: number; stdout: string } {
  const argv = command.kind === "powershell" ? encodedPowershell(command.script) : command.argv;
  const spawned = spawnSync(argv[0]!, argv.slice(1), {
    input: command.stdin,
    encoding: "utf8",
    windowsHide: true,
  });
  return { status: spawned.status ?? -1, stdout: spawned.stdout ?? "" };
}
