import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Labeled credential file for a self-hosted bearer gate (ukp_remote W13 /
 * RQ-16c). This module is the first resident of the `src/plumbing/` subtree:
 * a purity-tested, zero-UKP-import library (only `node:` builtins and
 * subtree-relative imports are legal — `test/plumbing-purity.test.ts`
 * enforces it mechanically). Every UKP semantic (where the file lives, when
 * the gate consults it, how rosters filter) stays with the callers; what
 * lives here is the credential-file mechanics the mainstream already settled:
 *
 * - Key shape `ukp_<label>_<id>_<secret>` (GitHub-PAT-style self-describing
 *   prefix; the id lets verification hash exactly one row).
 * - Storage keeps a SHA-256 of the secret only, never the raw key
 *   (high-entropy secrets make a fast hash the right trade — no argon2).
 * - One line per key; revocation is deleting (or commenting out) the line.
 * - Scopes are required per line, Docker-registry-grammar
 *   `name:access,name:access` with `*` as the explicit full-power name.
 *
 * Evidence SSOT: workunits/ukp_remote/knowledge/api-key-file-patterns.md. */

/** Column grammar: `<label> <id> sha256$<hex> <scopes>`, whitespace-run
 * separated. `#`-prefixed lines and blanks are comments/spacers (revocation
 * by commenting a line out stays a legal hand edit; the managed rewrites
 * preserve them). The `sha256$` algorithm prefix follows the htpasswd/
 * Authelia line-format lineage so a future algorithm is a new prefix, never
 * an autodetect guess. */
export const TOKEN_HASH_ALGORITHM = "sha256";

/** Label and scope-name grammar — endpoint-name-shaped
 * (`^(?=.{1,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$`). Duplicated from the UKP
 * config layer on purpose: this subtree may not import UKP code, and the
 * key's own segments (label) must be `_`/`:`-free so the bearer string
 * splits unambiguously. */
const NAME_GRAMMAR = /^(?=.{1,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Scope wildcard: `*:rw` is the explicit full-power row (scope column is
 * required — "no scopes listed" never means full power). */
export const SCOPE_WILDCARD = "*";

/** The bearer secret minted per key: 32 random bytes, base64url-unpadded
 * (43 chars). High entropy is the premise of the fast-hash storage and of
 * skipping online-bruteforce hardening. */
const SECRET_BYTES = 32;

/** Key id minted per key: 8 random bytes as lowercase hex (16 chars) —
 * enough to make id collisions a non-event at self-hosted scale while the
 * id stays the audit/display handle. */
const KEY_ID_BYTES = 8;

export type ScopeAccess = "ro" | "rw";

export interface TokenFileEntry {
  label: string;
  keyId: string;
  /** Lowercase hex SHA-256 of the secret — the only secret-derived material
   * the file ever holds. */
  secretSha256: string;
  /** Insertion-ordered scope map: endpoint name (or `*`) → access. */
  scopes: Readonly<Record<string, ScopeAccess>>;
}

export interface MintedTokenKey {
  /** `ukp_<label>_<id>_<secret>` — the raw credential, returned exactly
   * once at mint time; the server stores only `line`'s hash column. */
  token: string;
  label: string;
  keyId: string;
  /** Ready-to-append file line for `storeTokenFileText`. */
  line: string;
}

/** Usage-level failures of the pure helpers (bad label, bad scopes spec,
 * bad file text). IO failures surface as thrown node errors from the file
 * helpers below; classification stops at the grammar boundary. */
export class TokenFileUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenFileUsageError";
  }
}

/** Parse a scopes column: comma-separated `<name>:(ro|rw)`, at least one
 * entry, no duplicates (a repeated name is a declaration conflict, not a
 * merge — the config-layer strictness stance). `*` composes with specific
 * names; the specific name wins (`*:ro,cad:rw` = read-everything plus write
 * on cad). */
export function parseTokenScopes(spec: string): Record<string, ScopeAccess> {
  const scopes: Record<string, ScopeAccess> = {};
  const trimmed = spec.trim();
  if (trimmed === "") {
    throw new TokenFileUsageError("scopes must not be empty (full access is the explicit '*:rw')");
  }
  for (const part of trimmed.split(",")) {
    const match = /^(.+):(ro|rw)$/.exec(part.trim());
    if (match === null) {
      throw new TokenFileUsageError(
        `invalid scope '${part.trim()}': expected <endpoint>:(ro|rw) entries, comma-separated (e.g. notes:ro,cad:rw; full access is '*:rw')`,
      );
    }
    const name = match[1]!;
    if (name !== SCOPE_WILDCARD && !NAME_GRAMMAR.test(name)) {
      throw new TokenFileUsageError(
        `invalid scope name '${name}': lowercase letters, digits, single hyphens, 1-63 chars (or '*')`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(scopes, name)) {
      throw new TokenFileUsageError(`duplicate scope name '${name}' in '${spec}'`);
    }
    scopes[name] = match[2] as ScopeAccess;
  }
  return scopes;
}

/** Scope judgment: the specific row wins over `*`, and `rw` satisfies `ro`
 * demands. Used per request by the gate's authorization step. */
export function scopeAllows(
  scopes: Readonly<Record<string, ScopeAccess>>,
  endpoint: string,
  access: ScopeAccess,
): boolean {
  const specific = scopes[endpoint] ?? scopes[SCOPE_WILDCARD];
  if (specific === undefined) return false;
  return access === "ro" || specific === "rw";
}

/** Validate a label (client handle burned into the key string and the file
 * line; revoke removes every line carrying it, so multiple active keys per
 * label are the zero-downtime rotation shape). */
export function validateTokenLabel(label: string): void {
  if (!NAME_GRAMMAR.test(label)) {
    throw new TokenFileUsageError(
      `invalid label '${label}': lowercase letters, digits, single hyphens, 1-63 chars`,
    );
  }
}

/** Mint a key: fresh id + secret, hash the secret, format the file line.
 * Deterministic except through `randomBytes` (injected for tests). */
export function mintTokenFileKey(
  label: string,
  scopesSpec: string,
): MintedTokenKey {
  validateTokenLabel(label);
  const scopes = parseTokenScopes(scopesSpec);
  const keyId = randomBytes(KEY_ID_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const token = `ukp_${label}_${keyId}_${secret}`;
  return {
    token,
    label,
    keyId,
    line: formatTokenFileLine({ label, keyId, secretSha256: sha256Hex(secret), scopes }),
  };
}

function sha256Hex(value: string): string {
  return createHash(TOKEN_HASH_ALGORITHM).update(value, "utf8").digest("hex");
}

/** Serialize one entry as the canonical single-spaced line. */
export function formatTokenFileLine(entry: Omit<TokenFileEntry, "secretSha256"> & { secretSha256: string }): string {
  const scopes = Object.entries(entry.scopes).map(([name, access]) => `${name}:${access}`).join(",");
  return `${entry.label} ${entry.keyId} ${TOKEN_HASH_ALGORITHM}$${entry.secretSha256} ${scopes}`;
}

export interface TokenFileParseError {
  /** 1-based line number in the file text. */
  line: number;
  message: string;
}

export type TokenFileParseResult =
  | { entries: TokenFileEntry[] }
  | { error: TokenFileParseError };

/** Parse the whole file text. Comment (`#`-prefixed) and blank lines are
 * structurally legal and carry no entry; every other line must be a valid
 * four-column row. Duplicate key ids are a format error (verification looks
 * up by id — an ambiguous row must not half-authorize). Duplicate labels
 * are legal (rotation keeps several active keys per client). */
export function parseTokenFileText(text: string): TokenFileParseResult {
  const entries: TokenFileEntry[] = [];
  const seenKeyIds = new Set<string>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const columns = line.split(/\s+/);
    if (columns.length !== 4) {
      return {
        error: {
          line: index + 1,
          message: `expected 4 columns '<label> <id> ${TOKEN_HASH_ALGORITHM}$<hash> <scopes>', got ${columns.length}: '${line}'`,
        },
      };
    }
    const [label, keyId, hashColumn, scopesColumn] = columns as [string, string, string, string];
    if (!NAME_GRAMMAR.test(label)) {
      return { error: { line: index + 1, message: `invalid label '${label}'` } };
    }
    if (!/^[0-9a-f]{16}$/.test(keyId)) {
      return { error: { line: index + 1, message: `invalid key id '${keyId}' (expected 16 lowercase hex chars)` } };
    }
    const hashMatch = new RegExp(`^${TOKEN_HASH_ALGORITHM}\\$([0-9a-f]{64})$`).exec(hashColumn);
    if (hashMatch === null) {
      return {
        error: {
          line: index + 1,
          message: `invalid hash column '${hashColumn}' (expected ${TOKEN_HASH_ALGORITHM}$<64 lowercase hex chars>)`,
        },
      };
    }
    if (seenKeyIds.has(keyId)) {
      return { error: { line: index + 1, message: `duplicate key id '${keyId}'` } };
    }
    let scopes: Record<string, ScopeAccess>;
    try {
      scopes = parseTokenScopes(scopesColumn);
    } catch (error) {
      if (error instanceof TokenFileUsageError) {
        return { error: { line: index + 1, message: error.message } };
      }
      throw error;
    }
    seenKeyIds.add(keyId);
    entries.push({ label, keyId, secretSha256: hashMatch[1]!, scopes });
  }
  return { entries };
}

/** Parse the bearer key shape `ukp_<label>_<id>_<secret>`: label and id are
 * `_`-free by grammar, so the secret is everything after the third `_`
 * (base64url may itself contain `_`). Returns undefined on any shape
 * mismatch — authentication failures are data, not exceptions. */
export function parseTokenFileKey(token: string): { label: string; keyId: string; secret: string } | undefined {
  const parts = token.split("_");
  if (parts.length < 4 || parts[0] !== "ukp") return undefined;
  const label = parts[1]!;
  const keyId = parts[2]!;
  const secret = parts.slice(3).join("_");
  if (!NAME_GRAMMAR.test(label)) return undefined;
  if (!/^[0-9a-f]{16}$/.test(keyId)) return undefined;
  if (secret === "") return undefined;
  return { label, keyId, secret };
}

/** Verify a presented bearer key against the parsed entries: look the row
 * up by (label, keyId), then compare SHA-256 digests with
 * `timingSafeEqual`. Digest lengths are fixed by the parse-time hash-column
 * validation, so the comparison cannot throw on crafted input. Returns the
 * matched entry (authorization data rides on it) or undefined. */
export function authenticateBearerKey(
  presented: string,
  entries: readonly TokenFileEntry[],
): TokenFileEntry | undefined {
  const parsed = parseTokenFileKey(presented);
  if (parsed === undefined) return undefined;
  const presentedDigest = createHash(TOKEN_HASH_ALGORITHM).update(parsed.secret, "utf8").digest();
  for (const entry of entries) {
    if (entry.keyId !== parsed.keyId || entry.label !== parsed.label) continue;
    const storedDigest = Buffer.from(entry.secretSha256, "hex");
    // Same-length by construction; timing-safe on the secret material only.
    if (timingSafeEqual(storedDigest, presentedDigest)) return entry;
  }
  return undefined;
}

/** Permission enforcement for the credential file, OpenSSH-style: on POSIX,
 * group/other read or write bits make the file unusable (machine refusal,
 * not advice). Windows carries no group/other bits on `stat().mode` (the
 * ACLs under %USERPROFILE% are the mechanism there), so the check is
 * skipped rather than guaranteed-false. Returns the refusal message or
 * undefined when the mode is acceptable. */
export function tokenFileModeProblem(mode: number, platform: string): string | undefined {
  if (platform === "win32") return undefined;
  const openBits = mode & 0o077;
  if (openBits !== 0) {
    return `permissions ${(mode & 0o777).toString(8).padStart(3, "0")} are too open: group/other must not read or write the token file (chmod 600)`;
  }
  return undefined;
}

// ---- file IO (node:fs is in-bounds for this subtree) ----------------------

export type TokenFileLoad =
  | { text: string }
  | { missing: true }
  | { error: string };

/** Read the token file for verification or management. A missing file is
 * the "no keys issued" state, not an error; a permission problem is the
 * OpenSSH-shaped refusal; anything else is a classified read error. */
export function loadTokenFile(path: string): TokenFileLoad {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { missing: true };
    if (code === "EACCES" || code === "EPERM") {
      return { error: `cannot read token file ${path}: permission denied` };
    }
    return { error: `cannot read token file ${path}: ${code ?? String(error)}` };
  }
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return { text };
  }
  const refusal = tokenFileModeProblem(mode, process.platform);
  if (refusal !== undefined) return { error: `${path}: ${refusal}` };
  return { text };
}

/** Persist the managed text: parent directories created on demand, written
 * 0600 (best-effort on Windows), atomically replaced via temp+rename so a
 * concurrently fresh-reading gate never observes a partial file. Comments
 * and blank lines survive because callers pass the full managed text. */
export function storeTokenFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tempPath, text, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(tempPath, path);
  } catch (error) {
    if (existsSync(tempPath)) unlinkQuietly(tempPath);
    throw error;
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort cleanup of our own temp file
  }
}

/** Append one entry line to the managed text (newline discipline: text
 * either is empty or already ends with exactly one newline). */
export function appendTokenLine(text: string, line: string): string {
  const base = text === "" ? "" : (text.endsWith("\n") ? text : `${text}\n`);
  return `${base}${line}\n`;
}

/** Remove every entry line whose label matches (revoke = the client, all
 * its active keys). Comment/blank lines are preserved verbatim. Returns
 * the rewritten text and how many lines were removed. */
export function removeTokenLines(text: string, label: string): { text: string; removed: number } {
  let removed = 0;
  const kept: string[] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed !== "" && !trimmed.startsWith("#") && trimmed.split(/\s+/)[0] === label) {
      removed++;
      continue;
    }
    kept.push(raw);
  }
  // Drop one trailing separator run left by the removal so the file never
  // accumulates blank tails across revoke cycles.
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return { text: kept.length === 0 ? "" : `${kept.join("\n")}\n`, removed };
}
