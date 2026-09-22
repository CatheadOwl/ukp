/**
 * Win32 tool-spawn relay (2026-09-22 finding, ukp_remote TODO
 * 20260922-win32-ssh-spawn-tax): Windows Defender holds the DIRECT
 * bun-to-<tool>.exe child edge for seconds per spawn — measured 9.7-10.7s for
 * ssh.exe and ~5.4s for rg.exe across stdio modes, windowsHide, and absolute
 * paths, while the same binaries start in 0.16-0.26s from bash and in
 * 0.55-0.8s from bun through ANY intermediary parent (cmd, node, powershell).
 * The inspection keys on the parent-child edge, so routing the spawn through
 * a one-level intermediary escapes it.
 *
 * The intermediary is powershell.exe driven by -EncodedCommand: the script
 * rides as one base64 token (no quoting stress from the spawning side), and
 * the script splats a single-quoted array so argv reaches the tool
 * byte-identical — the only escape in a PS single-quoted literal is doubling
 * inner single quotes; double quotes, backslashes, and cmd metacharacters
 * are all literal (verified E2E: the pinned wake command's load-bearing
 * quotes survive, door READY ~1.4s). powershell.exe ships with every
 * Windows; no extra prerequisite is imposed.
 *
 * Exit-code contract: the script exits with the tool's own exit status. With
 * the not-found guard requested, a tool that does not resolve on PATH exits
 * TOOL_NOT_FOUND_EXIT before any invocation — distinct from every real tool
 * exit, so callers can keep treating "tool missing" as a degradation instead
 * of a fault.
 */

/** Distinct not-found sentinel: no real tool invocation ran when this is the
 * exit status (ripgrep itself only ever exits 0/1/2; ssh diagnostics arrive
 * via stderr instead). */
export const TOOL_NOT_FOUND_EXIT = 127;

/** PS single-quote literal: the only escape is doubling inner single quotes. */
function psSingleQuoted(arg: string): string {
  return `'${arg.replaceAll("'", "''")}'`;
}

/** The relay script. `notFoundGuard` adds a Get-Command pre-check that exits
 * TOOL_NOT_FOUND_EXIT when argv[0] does not resolve — for callers that must
 * distinguish a missing tool from a tool's own failure exit. */
export function toolRelayScript(argv: readonly string[], options: { notFoundGuard?: boolean } = {}): string {
  const guard = options.notFoundGuard === true
    ? " if (-not (Get-Command -LiteralName $a[0] -ErrorAction SilentlyContinue)) { exit 127 };"
    : "";
  return `$a = @(${argv.map(psSingleQuoted).join(",")});${guard} & $a[0] $a[1..($a.Count-1)]; exit $LASTEXITCODE`;
}

/** The powershell carrier argv for a tool invocation: spawn THIS instead of
 * the tool when the direct bun-to-tool edge is taxed (win32 real-tool
 * spawns). Test-injected commands must not be wrapped. */
export function toolRelayArgv(argv: readonly string[], options: { notFoundGuard?: boolean } = {}): string[] {
  return [
    "powershell",
    "-NoProfile",
    "-EncodedCommand",
    Buffer.from(toolRelayScript(argv, options), "utf16le").toString("base64"),
  ];
}
