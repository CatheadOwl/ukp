import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendTokenLine,
  authenticateBearerKey,
  formatTokenFileLine,
  loadTokenFile,
  mintTokenFileKey,
  parseTokenFileKey,
  parseTokenFileText,
  parseTokenScopes,
  removeTokenLines,
  scopeAllows,
  storeTokenFile,
  tokenFileModeProblem,
  validateTokenLabel,
  TokenFileUsageError,
} from "../src/plumbing/token-file.ts";

/** W13 / RQ-16c unit tests: the labeled token-file library (mint / verify /
 * scopes / mode enforcement / format-error classification / managed-text
 * rewrites). Serve-side integration (gate chain order, fresh-read
 * revocation, scoped 404s) lives in test/e2e/serve-token-file.test.ts. */

describe("token-file: scopes grammar (Docker-registry-isomorphic, required)", () => {
  test("parses specific names with ro/rw bits", () => {
    expect(parseTokenScopes("notes:ro,cad:rw")).toEqual({ notes: "ro", cad: "rw" });
    expect(parseTokenScopes(" *:rw ")).toEqual({ "*": "rw" });
  });

  test("empty scopes are refused — full power is the explicit '*:rw'", () => {
    expect(() => parseTokenScopes("")).toThrow(TokenFileUsageError);
    expect(() => parseTokenScopes("   ")).toThrow("scopes must not be empty");
  });

  test("malformed entries and duplicate names are refused", () => {
    expect(() => parseTokenScopes("notes")).toThrow("expected <endpoint>:(ro|rw)");
    expect(() => parseTokenScopes("notes:read")).toThrow("expected <endpoint>:(ro|rw)");
    expect(() => parseTokenScopes("Notes:ro")).toThrow("invalid scope name 'Notes'");
    expect(() => parseTokenScopes("not_es:ro")).toThrow("invalid scope name");
    expect(() => parseTokenScopes("notes:ro,notes:rw")).toThrow("duplicate scope name 'notes'");
  });

  test("scopeAllows: specific beats wildcard; rw satisfies ro", () => {
    const scopes = parseTokenScopes("*:ro,cad:rw");
    expect(scopeAllows(scopes, "cad", "rw")).toBe(true);
    expect(scopeAllows(scopes, "cad", "ro")).toBe(true);
    expect(scopeAllows(scopes, "notes", "ro")).toBe(true);
    expect(scopeAllows(scopes, "notes", "rw")).toBe(false);
    expect(scopeAllows(parseTokenScopes("notes:ro"), "cad", "ro")).toBe(false);
    expect(scopeAllows(parseTokenScopes("*:rw"), "anything-here", "rw")).toBe(true);
  });
});

describe("token-file: mint and verify", () => {
  test("minted key round-trips: shape, file line, authentication", () => {
    const minted = mintTokenFileKey("liku", "notes:ro");
    expect(minted.token).toMatch(/^ukp_liku_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    // The minted secret never appears in the file line — hash only.
    expect(minted.line).toMatch(/^liku [0-9a-f]{16} sha256\$[0-9a-f]{64} notes:ro$/);
    const parsed = parseTokenFileText(`${minted.line}\n`);
    expect("error" in parsed && parsed).toBeFalsy();
    if ("error" in parsed) throw new Error("unreachable");
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.label).toBe("liku");
    expect(parsed.entries[0]!.scopes).toEqual({ notes: "ro" });
    expect(authenticateBearerKey(minted.token, parsed.entries)?.label).toBe("liku");
  });

  test("each mint is unique (rotation: several active keys per label)", () => {
    const first = mintTokenFileKey("liku", "notes:ro");
    const second = mintTokenFileKey("liku", "notes:ro");
    expect(first.token).not.toBe(second.token);
    expect(first.keyId).not.toBe(second.keyId);
    const parsed = parseTokenFileText(`${first.line}\n${second.line}\n`);
    if ("error" in parsed) throw new Error(parsed.error.message);
    expect(parsed.entries).toHaveLength(2);
  });

  test("label grammar is enforced at mint time", () => {
    expect(() => mintTokenFileKey("Bad_Label", "notes:ro")).toThrow(TokenFileUsageError);
    expect(() => validateTokenLabel("")).toThrow("invalid label");
    expect(validateTokenLabel("ok-label")).toBeUndefined();
  });

  test("authentication failures are undefined, never exceptions", () => {
    const minted = mintTokenFileKey("liku", "notes:ro");
    const entries = parseTokenFileText(`${minted.line}\n`);
    if ("error" in entries) throw new Error(entries.error.message);
    const wrongSecret = minted.token.slice(0, -1) + (minted.token.endsWith("A") ? "B" : "A");
    expect(authenticateBearerKey(wrongSecret, entries.entries)).toBeUndefined();
    // A different label (valid shape) must not hit the row.
    const relabeled = `ukp_other_${minted.token.split("_").slice(2).join("_")}`;
    expect(authenticateBearerKey(relabeled, entries.entries)).toBeUndefined();
    expect(authenticateBearerKey("ukp_liku_deadbeefdeadbeef_short", entries.entries)).toBeUndefined();
    expect(authenticateBearerKey("not-a-ukp-key", entries.entries)).toBeUndefined();
    expect(authenticateBearerKey("", entries.entries)).toBeUndefined();
  });

  test("bearer key parsing: secret may contain underscores (base64url)", () => {
    const minted = mintTokenFileKey("liku", "notes:rw");
    const parts = minted.token.split("_");
    expect(parts[0]).toBe("ukp");
    // Force an underscore-bearing secret through the parse path.
    const secret = parts.slice(3).join("_");
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const shaped = `ukp_liku_${parts[2]!}_ab${secret}`;
    expect(parseTokenFileKey(shaped)?.secret).toBe(`ab${secret}`);
    expect(parseTokenFileKey("ukp_liku_123")).toBeUndefined();
    expect(parseTokenFileKey("ukp_liku_zzzzzzzzzzzzzzzz_secret")).toBeUndefined();
  });

  test("formatTokenFileLine serializes the canonical single-spaced row", () => {
    expect(
      formatTokenFileLine({
        label: "a",
        keyId: "0000000000000000",
        secretSha256: "0".repeat(64),
        scopes: { "*": "rw" },
      }),
    ).toBe("a 0000000000000000 sha256$" + "0".repeat(64) + " *:rw");
  });
});

/** One shared minted key for the parse/rewrite describes. */
const goodKey = mintTokenFileKey("liku", "notes:ro");

describe("token-file: format-error classification", () => {
  test("comments and blank lines are structurally legal", () => {
    const parsed = parseTokenFileText(`# issued for liku\n\n${goodKey.line}\n# revoked soon\n`);
    if ("error" in parsed) throw new Error(parsed.error.message);
    expect(parsed.entries).toHaveLength(1);
  });

  test("wrong column count, with line number", () => {
    const parsed = parseTokenFileText(`# header\nbad-line\n`);
    expect("error" in parsed && parsed.error.line).toBe(2);
    expect("error" in parsed && parsed.error.message).toContain("expected 4 columns");
  });

  test("bad hash column and bad scopes column, with line numbers", () => {
    const noPrefix = parseTokenFileText(`a 0000000000000000 ${"0".repeat(64)} notes:ro\n`);
    expect("error" in noPrefix && noPrefix.error.message).toContain("invalid hash column");
    const badScopes = parseTokenFileText(`a 0000000000000000 sha256$${"0".repeat(64)} notes\n`);
    expect("error" in badScopes && badScopes.error.message).toContain("expected <endpoint>:(ro|rw)");
    const dupId = parseTokenFileText(`${goodKey.line}\n${goodKey.line}\n`);
    expect("error" in dupId && dupId.error.message).toContain("duplicate key id");
    expect("error" in dupId && dupId.error.line).toBe(2);
  });
});

describe("token-file: mode enforcement (OpenSSH-shaped, POSIX)", () => {
  test("group/other bits refuse on POSIX; win32 mode bits carry no such meaning", () => {
    expect(tokenFileModeProblem(0o600, "linux")).toBeUndefined();
    expect(tokenFileModeProblem(0o400, "darwin")).toBeUndefined();
    expect(tokenFileModeProblem(0o644, "linux")).toContain("too open");
    expect(tokenFileModeProblem(0o660, "linux")).toContain("too open");
    expect(tokenFileModeProblem(0o666, "win32")).toBeUndefined();
  });
});

describe("token-file: managed-text rewrites", () => {
  test("appendTokenLine keeps newline discipline", () => {
    expect(appendTokenLine("", "line-a")).toBe("line-a\n");
    expect(appendTokenLine("line-a", "line-b")).toBe("line-a\nline-b\n");
    expect(appendTokenLine("line-a\n", "line-b")).toBe("line-a\nline-b\n");
  });

  test("removeTokenLines drops the whole label, preserves comments", () => {
    const other = mintTokenFileKey("someone-else", "*:rw");
    const text = `# operators\n${goodKey.line}\n\n${other.line}\n`;
    const result = removeTokenLines(text, "liku");
    expect(result.removed).toBe(1);
    // The vacated line's surrounding structure stays as-is (only the
    // trailing separator run is cleaned so revoke cycles do not grow a
    // blank tail).
    expect(result.text).toBe(`# operators\n\n${other.line}\n`);
    const again = removeTokenLines(result.text, "liku");
    expect(again.removed).toBe(0);
    expect(again.text).toBe(result.text);
    expect(removeTokenLines(`${goodKey.line}\n`, "liku").text).toBe("");
  });
});

describe("token-file: load/store", () => {
  const root = mkdtempSync(join(tmpdir(), "ukp-token-file-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("store is atomic-shaped, 0600, reloadable; missing file is a state, not an error", () => {
    const path = join(root, "nested", "tokens");
    const minted = mintTokenFileKey("liku", "notes:ro,cad:rw");
    storeTokenFile(path, appendTokenLine("", minted.line));
    const stored = readFileSync(path, "utf8");
    expect(stored).toBe(`${minted.line}\n`);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const loaded = loadTokenFile(path);
    if (!("text" in loaded)) throw new Error("expected text");
    expect(loaded.text).toBe(stored);
    const missing = loadTokenFile(join(root, "absent"));
    expect("missing" in missing && missing.missing).toBe(true);
  });

  test("load refuses an over-open file on POSIX (machine refusal)", () => {
    const path = join(root, "open-tokens");
    const minted = mintTokenFileKey("liku", "notes:ro");
    writeFileSync(path, `${minted.line}\n`, { mode: 0o644 });
    const loaded = loadTokenFile(path);
    if (process.platform === "win32") {
      expect("text" in loaded || "error" in loaded).toBe(true);
    } else {
      expect("error" in loaded && loaded.error).toContain("too open");
    }
  });

  test("store→revoke→store round-trips through parse", () => {
    const path = join(root, "roundtrip-tokens");
    const first = mintTokenFileKey("liku", "notes:ro");
    const second = mintTokenFileKey("ali", "*:rw");
    let text = appendTokenLine("", first.line);
    text = appendTokenLine(text, second.line);
    storeTokenFile(path, text);
    const removed = removeTokenLines(text, "liku");
    storeTokenFile(path, removed.text);
    const parsed = parseTokenFileText(removed.text);
    if ("error" in parsed) throw new Error(parsed.error.message);
    expect(parsed.entries.map((entry) => entry.label)).toEqual(["ali"]);
  });
});
