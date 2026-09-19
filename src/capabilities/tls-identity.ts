import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hostname, networkInterfaces } from "node:os";
import { X509Certificate, createHash } from "node:crypto";
import { isIP } from "node:net";

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
  if (/^[A-Za-z0-9.-]+$/.test(host) && !host.includes("_")) entries.add(`DNS:${host.toLowerCase()}`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal) entries.add(`IP:${address.address.toLowerCase()}`);
    }
  }
  return [...entries];
}

const DNS_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** One `--tls-san <ip|dns>` value → its canonical openssl SAN form
 * (`IP:<addr>` / `DNS:<name>`, lowercased — SAN IP/DNS matching is
 * case-insensitive, so the whole SAN pipeline compares on folded keys),
 * classifying by shape: a bare IP becomes an IP SAN, anything else must be a
 * legal DNS name. The classification is what lets a cloud NAT/EIP host add
 * its public address — it is on no NIC, so the automatic coverage above can
 * never see it. Throws on values that are neither. */
export function normalizeTlsSanEntry(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("--tls-san entry must not be empty");
  if (isIP(trimmed) !== 0) return `IP:${trimmed.toLowerCase()}`;
  if (DNS_NAME.test(trimmed) && trimmed.length <= 253) return `DNS:${trimmed.toLowerCase()}`;
  throw new Error(`--tls-san entry '${value}' is neither an IP address nor a DNS name`);
}

/** The SAN entries a certificate actually carries, as case-folded
 * `IP:x`/`DNS:y` keys (X509Certificate renders "IP Address:x", and openssl
 * may case an IPv6 literal differently than the requester did — SAN IP/DNS
 * matching is case-insensitive, so coverage comparison folds case too). */
export function certSanEntriesOf(cert: string | Buffer): Set<string> {
  const raw = new X509Certificate(cert).subjectAltName ?? "";
  const entries = new Set<string>();
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry.startsWith("IP Address:")) entries.add(`IP:${entry.slice("IP Address:".length)}`.toLowerCase());
    else if (entry.startsWith("DNS:")) entries.add(entry.toLowerCase());
  }
  return entries;
}

export interface SelfSignedIdentity {
  certPath: string;
  keyPath: string;
  /** What this call did to the identity: `generated` = fresh keypair (first
   * `--tls`), `re-signed` = new certificate over the existing key (coverage
   * grew — `--tls-san` added an entry the persisted certificate lacked; the
   * pin is unchanged and pinned clients re-anchor transparently), `persisted`
   * = both files reused untouched. */
  source: "generated" | "re-signed" | "persisted";
}

/** Idempotent self-signed identity for `ukp serve --tls`: persisted under
 * `<serviceFolder>/.ukp/tls/` (machine-local, gitignored — the instance-uid
 * posture). openssl signs it because node:crypto cannot issue X.509; the
 * identity is the keypair, so losing the key loses the identity (clients
 * re-register). `extraSanEntries` (the `--tls-san` flag, already normalized
 * `IP:x`/`DNS:y`) merges into the SAN coverage; when a persisted certificate
 * lacks requested entries it is re-signed over the SAME key — the SPKI pin
 * survives, which is exactly the renewal semantics pinned clients already
 * handle. Coverage only ever grows: dropping a flag entry never re-signs.
 * `opensslCommand` is a test injection point. */
export function ensureSelfSignedTlsFiles(
  tlsDir: string,
  options: { opensslCommand?: readonly string[]; extraSanEntries?: readonly string[] } = {},
): SelfSignedIdentity {
  const certPath = join(tlsDir, "cert.pem");
  const keyPath = join(tlsDir, "key.pem");
  const extra = options.extraSanEntries ?? [];
  if (existsSync(certPath) && existsSync(keyPath)) {
    const covered = certSanEntriesOf(readFileSync(certPath, "utf8"));
    const requestedButMissing = extra.filter((entry) => !covered.has(entry.toLowerCase()));
    if (requestedButMissing.length === 0) return { certPath, keyPath, source: "persisted" };
    const san = mergedSanEntries(extra);
    runOpenssl(
      [
        ...(options.opensslCommand ?? ["openssl"]),
        "req", "-x509",
        "-key", keyPath,
        "-out", certPath,
        "-days", "3650",
        "-subj", "/CN=ukp serve self-signed",
        "-addext", `subjectAltName=${san.join(",")}`,
      ],
      [certPath],
    );
    return { certPath, keyPath, source: "re-signed" };
  }
  mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
  const san = mergedSanEntries(extra);
  runOpenssl(
    [
      ...(options.opensslCommand ?? ["openssl"]),
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "3650",
      "-nodes",
      "-subj", "/CN=ukp serve self-signed",
      "-addext", `subjectAltName=${san.join(",")}`,
    ],
    [certPath, keyPath],
  );
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // best-effort on platforms without POSIX modes
  }
  return { certPath, keyPath, source: "generated" };
}

/** Automatic coverage plus the requested extras, deduplicated — the SAN list
 * handed to openssl's subjectAltName extension. */
function mergedSanEntries(extra: readonly string[]): string[] {
  return [...new Set([...selfSignedSanEntries(), ...extra])];
}

/** Run one openssl signing command; every declared output must appear. */
function runOpenssl(args: readonly string[], outputs: readonly string[]): void {
  const proc = Bun.spawnSync([...args], { stdout: "ignore", stderr: "pipe" });
  const failed = proc.exitCode !== 0 || outputs.some((path) => !existsSync(path));
  if (failed) {
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    throw new Error(
      `unable to generate a self-signed TLS identity with openssl (exit ${proc.exitCode}): ${stderr || "is openssl installed and on PATH? 'ukp serve --tls' self-signs through the local openssl"}`,
    );
  }
}
