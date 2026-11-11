import { describe, expect, test } from "bun:test";
import { resolveRemoteToken } from "../src/capabilities/remote-client.ts";
import { defaultCredentialStore } from "../src/credential-store.ts";
import {
  createCredentialStore,
  inMemoryCredentialStore,
  unavailableCredentialStore,
  type StoreCommand,
  type StoreExecutor,
} from "../src/plumbing/credential-store.ts";
import type { RegistryBinding } from "../src/registry.ts";

/** ADR-REM-013 / W14: the consumer-side credential store and the widened
 * residence resolution (env > store > inline). */

function remoteBinding(fields: Partial<RegistryBinding>): RegistryBinding {
  return { name: "ep", kind: "remote", url: "https://door.example/ep", ...fields };
}

describe("credential store (ADR-REM-013 / W14)", () => {
  test("resolution order: env wins, the store backs the pointer, inline is the fallback", () => {
    const store = inMemoryCredentialStore(new Map([["ep", "store-secret"]]));
    process.env.UKP_ENDPOINT_EP_TOKEN = "env-secret";
    try {
      expect(resolveRemoteToken(remoteBinding({ token: "inline" }), store)).toBe("env-secret");
    } finally {
      delete process.env.UKP_ENDPOINT_EP_TOKEN;
    }
    expect(resolveRemoteToken(remoteBinding({ token_ref: "os-store" }), store)).toBe("store-secret");
    expect(resolveRemoteToken(remoteBinding({ token: "inline" }), store)).toBe("inline");
    // A pointer whose store entry is gone resolves to nothing on the store
    // tier — no silent inline substitution (there is no inline to read).
    expect(resolveRemoteToken(remoteBinding({ token_ref: "os-store" }), unavailableCredentialStore()))
      .toBeUndefined();
  });

  test("a missing binary means unavailable, never a throw (linux probe shape)", () => {
    const missingTool: StoreExecutor = () => ({ status: 127, stdout: "" });
    const linux = createCredentialStore("linux", "/home/x", missingTool);
    expect(linux.available()).toBe(false);
    expect(linux.put("ep", "raw")).toBe(false);
    expect(linux.get("ep")).toBeUndefined();
  });

  test("hostile handle names are refused before any command runs", () => {
    const commands: StoreCommand[] = [];
    const recorder: StoreExecutor = (command) => {
      commands.push(command);
      return { status: 0, stdout: "" };
    };
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const store = createCredentialStore(platform, "/home/x", recorder);
      expect(store.put("../escape", "raw")).toBe(false);
      expect(store.get("bad/name")).toBeUndefined();
    }
    expect(commands).toHaveLength(0);
  });

  test.skipIf(process.platform !== "win32")(
    "win32 DPAPI roundtrip through the real relay carrier",
    () => {
      const store = defaultCredentialStore();
      expect(store.available()).toBe(true);
      expect(store.put("w14-roundtrip", "raw-secret-1")).toBe(true);
      expect(store.get("w14-roundtrip")).toBe("raw-secret-1");
      store.remove("w14-roundtrip");
      expect(store.get("w14-roundtrip")).toBeUndefined();
    },
    30_000,
  );
});
