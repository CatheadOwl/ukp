// Binary availability probe for test gating. Bun.spawnSync throws ENOENT
// when the binary is absent from PATH (it does not answer non-zero), so
// every "missing tool skips the suite" guard must route through here — a
// bare `.exitCode === 0` probe crashes the whole test file on restricted
// environments instead of skipping (found by the sandboxed release gate,
// 2026-11-03).
export function binAvailable(bin: string, args: string[] = ["--version"]): boolean {
  try {
    return Bun.spawnSync([bin, ...args], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
}
