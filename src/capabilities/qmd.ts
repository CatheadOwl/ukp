/**
 * Shared QMD provider helpers for UKP adapters.
 *
 * QMD owns collection, index, ranking, ignore, and config. UKP only locates the
 * executable, invokes provider-owned commands, and normalizes output to UKP's
 * output discipline. These helpers are the single place for that plumbing.
 */

export function defaultQmdCommand(): string[] | undefined {
  const executable = Bun.which("qmd") ?? Bun.which("qmd.ps1") ?? Bun.which("qmd.cmd");
  if (!executable) return undefined;
  return executable.toLowerCase().endsWith(".ps1")
    ? [Bun.which("powershell.exe") ?? "powershell.exe", "-NoProfile", "-File", executable]
    : [executable];
}

/**
 * Strip QMD `get` provider header so `ukp get` stdout starts at the body.
 *
 * QMD prints a provider location header (first line, `qmd://<collection>/<path>`),
 * zero or more metadata lines, a `---` separator, then the body. The adapter
 * strips that prefix only when the leading region really is a QMD header — the
 * first non-empty line before the separator starts with `qmd://`. A body-only
 * output that merely contains a `---` divider is left intact. CRLF line endings
 * are normalized to LF so `ukp get` stdout is line-ending-stable.
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
