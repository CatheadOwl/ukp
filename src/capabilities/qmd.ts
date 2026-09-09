/**
 * Shared QMD provider helpers for UKP adapters.
 *
 * QMD owns collection, index, ranking, ignore, and config. UKP only locates the
 * executable, invokes provider-owned commands, and normalizes output to UKP's
 * output discipline. These helpers are the single place for that plumbing.
 */

/**
 * A bare docid handoff key is a 6-hex content fingerprint — the first 6 chars of
 * QMD's content SHA-256 — optionally carrying a `:line` suffix (ADR 0011). QMD
 * emits the fingerprint with a leading `#` (`#abc123`); `search` strips it on
 * the surface so the token is verbatim-copyable, and `read` re-adds it before
 * constructing `qmd get #docid[:line]`. A leading `#` is a shell comment and
 * would silently truncate the reference (ISSUE-008), so it never appears on the
 * UKP surface.
 */
export function isBareDocidReference(reference: string): boolean {
  return /^[a-f0-9]{6}(:\d+)?$/.test(reference);
}

/** Strip QMD's leading `#` from a docid token (`#abc123` → `abc123`). */
export function stripDocidHash(docid: string): string {
  return docid.startsWith("#") ? docid.slice(1) : docid;
}

/** Test whether a token is a bare 6-hex QMD docid body (`[a-f0-9]{6}`, ADR 0011). */
export function isDocidBody(token: string): boolean {
  return /^[a-f0-9]{6}$/.test(token);
}

/**
 * Build the `qmd get` argument for a reference.
 *
 * A bare docid handoff key has its `#` re-added so QMD resolves it by content
 * fingerprint exactly. Any other reference — a weak name/path suffix or a
 * `qmd://` provider reference — is forwarded verbatim. An optional line range is
 * appended as `:start[:count]`, matching QMD's `path:from:count` suffix.
 */
export function toQmdGetArgument(
  reference: string,
  lines?: { start: number; count?: number },
): string {
  const base = isBareDocidReference(reference) ? `#${reference}` : reference;
  if (!lines) return base;
  return lines.count === undefined
    ? `${base}:${lines.start}`
    : `${base}:${lines.start}:${lines.count}`;
}

export function defaultQmdCommand(): string[] | undefined {
  const executable = Bun.which("qmd") ?? Bun.which("qmd.ps1") ?? Bun.which("qmd.cmd");
  if (!executable) return undefined;
  const lower = executable.toLowerCase();
  if (lower.endsWith(".ps1")) {
    return [Bun.which("powershell.exe") ?? "powershell.exe", "-NoProfile", "-File", executable];
  }
  // ISSUE-011: npm's global bin shims on Windows (qmd.cmd) are batch scripts,
  // not executable images — CreateProcess cannot start them directly and
  // spawnSync returns result.error. Route them through cmd.exe, same wrapper
  // precedent as the .ps1 branch above. The wrapper prefix is detected by
  // buildQmdInvocation, which re-assembles the whole provider call as one
  // cmd-escaped /c payload — callers must never append raw arguments after a
  // cmd.exe wrapper themselves (cmd re-parses the joined command line: an
  // unquoted `&` in a search query would split the command).
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    return [Bun.which("cmd.exe") ?? "cmd.exe", "/d", "/s", "/c", executable];
  }
  return [executable];
}

/** Detect a defaultQmdCommand cmd.exe wrapper prefix (…, "/c", <exe>). */
function isCmdWrapper(command: readonly string[]): boolean {
  if (command.length < 5) return false;
  const first = command[0]!.toLowerCase();
  return (first.endsWith("cmd.exe") || first === "cmd")
    && command.slice(1, -1).includes("/c");
}

/**
 * Build the spawn file/args (and Windows quoting mode) for one provider
 * invocation.
 *
 * For a plain command the provider arguments are appended verbatim. For a
 * cmd.exe wrapper (ISSUE-011) the whole call after `/c` must become ONE argv
 * entry carrying the canonical cmd pattern: every element quoted with
 * internal quotes doubled, the whole payload wrapped in one extra outer
 * quote pair, spawned with `windowsVerbatimArguments: true` so the runtime
 * does not re-quote/re-escape it. With `/s`, cmd strips exactly the first and
 * last (outer) quote, leaving `"exe" "arg1" "arg2"…` — metacharacters
 * (`& | < > ^ ( )`), spaces, and quotes in arbitrary arguments (search
 * queries carry user text) are neutralized. Verified empirically against the
 * real npm shim: without verbatim mode Bun re-quotes the payload and cmd
 * sees a mangled command name.
 *
 * Known residual: cmd expands `%VAR%` for existing variables even inside
 * double quotes; a literal percent query on a machine defining that variable
 * is altered — accepted edge, no reliable cmd escaping exists for it.
 */
export function buildQmdInvocation(
  command: readonly string[],
  providerArgs: readonly string[],
): { file: string; args: string[]; verbatim: boolean } {
  if (!isCmdWrapper(command)) {
    return { file: command[0]!, args: [...command.slice(1), ...providerArgs], verbatim: false };
  }
  const cIndex = command.lastIndexOf("/c");
  const inner = [command[cIndex + 1]!, ...providerArgs]
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join(" ");
  return {
    file: command[0]!,
    args: [...command.slice(1, cIndex + 1), `"${inner}"`],
    verbatim: true,
  };
}

/**
 * Strip QMD `get` provider header so `ukp read` stdout starts at the body.
 *
 * QMD prints a provider location header (first line, `qmd://<collection>/<path>`),
 * zero or more metadata lines, a `---` separator, then the body. The adapter
 * strips that prefix only when the leading region really is a QMD header — the
 * first non-empty line before the separator starts with `qmd://`. A body-only
 * output that merely contains a `---` divider is left intact. CRLF line endings
 * are normalized to LF so `ukp read` stdout is line-ending-stable.
 */
export function stripQmdHeader(output: string): string {
  const normalized = output.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let sepIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      sepIndex = i;
      break;
    }
  }
  if (sepIndex <= 0) return normalized;
  const firstLine = lines.slice(0, sepIndex).find((line) => line.trim() !== "");
  if (!firstLine?.trimStart().startsWith("qmd://")) return normalized;
  let start = sepIndex + 1;
  while (start < lines.length && lines[start]!.trim() === "") start++;
  const body = lines.slice(start).join("\n").replace(/\s+$/, "");
  if (!body) return "";
  return `${body}\n`;
}
