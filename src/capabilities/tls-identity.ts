import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { hostname, networkInterfaces } from "node:os";
import { X509Certificate, createHash } from "node:crypto";

/** TLS transport identity (ukp_remote W5' / D-079): the self-signed + TOFU
 * pinning path for serving over bare IPs without a public CA. Shared by the
 * serve side (identity generation, banner fingerprint) and the client side
 * (registration-time pinning, renewal re-anchor). The identity convention is
 * the RFC 7469 SPKI pin — `sha256/<base64 of the DER SubjectPublicKeyInfo>`
 * — so a certificate renewal that keeps the key keeps the identity. */

export function spkiPinOf(cert: string | Buffer): string {
  const x509 = new X509Certificate(cert);
  const spkiDer = x509.publicKey.export({ type: "spki", format: "der" });
  return `sha256/${createHash("sha256").update(spkiDer).digest("base64")}`;
}

/** SAN list for display (X509Certificate.subjectAltName form, e.g.
 * "IP Address:127.0.0.1, DNS:localhost"). */
export function certSanOf(cert: string | Buffer): string {
  return new X509Certificate(cert).subjectAltName ?? "(no subjectAltName)";
}

/** SAN coverage for a self-signed identity: every non-internal interface
 * address plus loopback and the hostname — a bare-IP deployment is reachable
 * under any of them, and clients verify the url host against the SAN. */
export function selfSignedSanEntries(): string[] {
  const entries = new Set<string>(["IP:127.0.0.1", "IP:::1", "DNS:localhost"]);
  const host = hostname();
  if (/^[A-Za-z0-9.-]+$/.test(host) && !host.includes("_")) entries.add(`DNS:${host}`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal) entries.add(`IP:${address.address}`);
    }
  }
  return [...entries];
}

export interface SelfSignedIdentity {
  certPath: string;
  keyPath: string;
  /** true when this call generated the pair; false when reusing the persisted one. */
  created: boolean;
}

/** Idempotent self-signed identity for `ukp serve --tls`: persisted under
 * `<serviceFolder>/.ukp/tls/` (machine-local, gitignored — the instance-uid
 * posture). openssl signs it because node:crypto cannot issue X.509; the
 * identity is the keypair, so losing the key loses the identity (clients
 * re-register). `opensslCommand` is a test injection point. */
export function ensureSelfSignedTlsFiles(
  tlsDir: string,
  options: { opensslCommand?: readonly string[] } = {},
): SelfSignedIdentity {
  const certPath = join(tlsDir, "cert.pem");
  const keyPath = join(tlsDir, "key.pem");
  if (existsSync(certPath) && existsSync(keyPath)) {
    return { certPath, keyPath, created: false };
  }
  mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
  const proc = Bun.spawnSync(
    [
      ...(options.opensslCommand ?? ["openssl"]),
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "3650",
      "-nodes",
      "-subj", "/CN=ukp serve self-signed",
      "-addext", `subjectAltName=${selfSignedSanEntries().join(",")}`,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (proc.exitCode !== 0 || !existsSync(certPath) || !existsSync(keyPath)) {
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    throw new Error(
      `unable to generate a self-signed TLS identity with openssl (exit ${proc.exitCode}): ${stderr || "is openssl installed and on PATH? 'ukp serve --tls' self-signs through the local openssl"}`,
    );
  }
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // best-effort on platforms without POSIX modes
  }
  return { certPath, keyPath, created: true };
}
