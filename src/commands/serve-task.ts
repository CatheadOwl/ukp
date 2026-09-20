/** Windows resident-door artifact generator (W12): `ukp serve --print-task`
 * renders the process-manager artifacts for an https door on a Windows host
 * — the start script, the hidden launcher (vbs), the Task Scheduler command,
 * the firewall rule — as text the operator reviews and applies. Print-only
 * by construction: UKP installs nothing, starts nothing, and never sees the
 * real token (the script line carries a placeholder; the operator pastes the
 * token into the file they save, under their own permission regime).
 *
 * The emitted shapes mirror the machine-verified liku recipe (deployment
 * handbook, Windows section): a bare `ukp` resolves through the logged-on
 * task's per-user PATH and the self-locating launcher finds bun itself, so
 * no PATH export is emitted. The hidden launcher is the product default
 * (owner ruling 2026-09-21: a visibly popping cmd window is not a correct
 * product form): zero flash (hidden at process creation), door.log capture,
 * exit-code propagation, bounded crash retry — Task Scheduler's own
 * restart-on-failure does not fire on exit codes (disproven on liku). */

export interface ServeTaskTlsSelfSigned {
  mode: "self-signed";
  sanEntries: string[];
}

export interface ServeTaskTlsCertificates {
  mode: "certificates";
  certPath: string;
  keyPath: string;
}

export type ServeTaskTls = ServeTaskTlsSelfSigned | ServeTaskTlsCertificates;

export interface ServeTaskInput {
  /** Present = single-endpoint mode; absent = host door mode. */
  endpoint?: string;
  host: string;
  port: number;
  tls?: ServeTaskTls;
}

/** Door-shape guards the command layer runs before printing. Pure so both
 * platforms are testable: `platform` is `process.platform` in production.
 * These mirror what serve itself would refuse at task start — they never
 * widen admission, and the TLS one stops a dead-end artifact before it is
 * applied (clients refuse to register plain-http urls off loopback). */
export function printTaskPreflightError(input: {
  platform: string;
  host: string;
  hasTls: boolean;
  allowAnonymous: boolean;
}): string | undefined {
  if (input.platform !== "win32") {
    return "--print-task is Windows-only; on Linux prefer systemd socket activation (ukp serve --systemd-socket) — the deployment handbook carries that recipe";
  }
  const loopback =
    input.host === "127.0.0.1" || input.host === "localhost" || input.host === "::1" || input.host === "[::1]";
  if (!loopback && !input.hasTls) {
    return "refusing to print an off-loopback door without TLS: clients refuse to register plain-http urls — pass --tls (self-signed, pinned at registration) or --tls-cert/--tls-key, or bind loopback behind a TLS-terminating proxy";
  }
  if (input.allowAnonymous && !loopback) {
    return "refusing to print this shape: --allow-anonymous is loopback-only and serve would refuse it at task start — set the token in the generated script instead";
  }
  return undefined;
}

function serveCommandLine(input: ServeTaskInput): string {
  const tls =
    input.tls === undefined
      ? []
      : input.tls.mode === "self-signed"
        ? ["--tls", ...input.tls.sanEntries.map((entry) => `--tls-san ${entry}`)]
        : [`--tls-cert "${input.tls.certPath}"`, `--tls-key "${input.tls.keyPath}"`];
  return [
    "ukp serve",
    ...(input.endpoint !== undefined ? [`--endpoint ${input.endpoint}`] : []),
    `--host ${input.host}`,
    `--port ${input.port}`,
    ...tls,
  ].join(" ");
}

/** Parent directory of a path string, or undefined for a bare filename. */
function parentDirOf(path: string): string | undefined {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut > 0 ? path.slice(0, cut) : undefined;
}

export function renderServeTaskArtifacts(input: ServeTaskInput): string {
  const serveLine = serveCommandLine(input);
  const out: string[] = [
    "ukp serve --print-task — Windows resident-door artifacts",
    "",
    "Print-only: review these, then apply them yourself. UKP installs nothing,",
    "starts nothing, and supervises nothing — the door's lifecycle belongs to",
    "you and your process manager.",
    "",
  ];

  if (input.tls?.mode === "certificates") {
    const certDir = parentDirOf(input.tls.certPath);
    out.push(
      "0) Certificate — generate ONCE (Git for Windows' openssl works; this",
      "   avoids any runtime openssl dependency of --tls):",
      "",
      "   openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout",
      `   ${input.tls.keyPath} -out ${input.tls.certPath}`,
      "   -subj \"/CN=ukp\" -addext \"subjectAltName=IP:<lan-ip>,DNS:localhost\"",
      "",
      "   The SAN must carry the address consumers dial (find <lan-ip> with",
      "   ipconfig); a mismatch fails registration with a certificate name",
      "   error. Renewing over the same key keeps client pins valid.",
      "",
    );
    if (certDir !== undefined) {
      out.push(`   (openssl will not create the directory: if not exist "${certDir}" mkdir "${certDir}" first)`, "");
    }
  }

  out.push(
    "1) Start script — save as %USERPROFILE%\\.ukp\\start-door.cmd",
    "   (write it with a real editor and CRLF line endings; writing cmd",
    "   files over ssh echo mangles % escaping)",
    "",
    "   @echo off",
    "   rem UKP resident door (generated by ukp serve --print-task)",
    "   rem The token line is the only secret: mint a long random string",
    "   rem (e.g. openssl rand -hex 32), paste it in, keep this file private.",
    "   set \"UKP_SERVE_TOKEN=<paste-your-token>\"",
    "   rem ukp resolves through the logged-on task's per-user PATH; the",
    "   rem launcher finds bun itself — no PATH export needed.",
    "   if not exist \"%USERPROFILE%\\.ukp\" mkdir \"%USERPROFILE%\\.ukp\"",
    `   ${serveLine} >> "%USERPROFILE%\\.ukp\\door.log" 2>&1`,
    "",
    "2) Hidden launcher — save as %USERPROFILE%\\.ukp\\start-door-hidden.vbs",
    "   (CRLF and a real editor again: the vbs carries literal % signs that",
    "   ssh echo would expand — copy the file instead)",
    "",
    "   ' UKP door hidden launcher: runs start-door.cmd with NO visible",
    "   ' window (hidden at process creation - nothing flashes), captures",
    "   ' everything to door.log, waits out the door's lifetime, propagates",
    "   ' its exit code, and retries a crashed door 3 times, 30s apart.",
    "   Dim shell : Set shell = CreateObject(\"WScript.Shell\")",
    "   Dim q : q = Chr(34)",
    "   Dim home : home = shell.ExpandEnvironmentStrings(\"%USERPROFILE%\")",
    "   Dim cmdline : cmdline = \"cmd /c \" & q & q & home & \"\\.ukp\\start-door.cmd\" & q & \" >> \" & q & home & \"\\.ukp\\door.log\" & q & \" 2>&1\" & q",
    "   Dim rc : rc = 0",
    "   Dim attempt",
    "   For attempt = 1 To 3",
    "     rc = shell.Run(cmdline, 0, True)",
    "     If rc = 0 Then Exit For",
    "     If attempt < 3 Then WScript.Sleep 30000",
    "   Next",
    "   WScript.Quit rc",
    "",
    "3) Scheduled task — starts the door at LOGON, hidden",
    "   (create it from an elevated shell: creating an ONLOGON task from a",
    "    plain shell fails with Access denied)",
    "",
    "   schtasks /Create /TN ukp-door /TR \"wscript.exe \\\"%USERPROFILE%\\.ukp\\start-door-hidden.vbs\\\"\" /SC ONLOGON /F",
    "   schtasks /Run /TN ukp-door",
    "",
    "4) Firewall rule for the port (from an elevated shell)",
    "",
    `   netsh advfirewall firewall add rule name="ukp-door" dir=in action=allow protocol=TCP localport=${input.port}`,
    "",
    "Notes:",
    ...(input.tls?.mode === "self-signed"
      ? [
          "- --tls self-signs at first start using an openssl on PATH (Git",
          "  for Windows' openssl qualifies). On a host with no openssl",
          "  anywhere, pre-generate the certificate once instead: re-run with",
          "  --tls-cert/--tls-key — the handbook's Windows section carries",
          "  that recipe.",
        ]
      : []),
    "- No visible window, by design: the hidden launcher starts the console",
    "  hidden at process creation (nothing ever flashes on the desktop) and",
    "  captures everything to door.log — that redirect is the paper trail (a",
    "  silent EADDRINUSE exit leaves a line).",
    "- Crash self-recovery is the launcher's bounded retry: a non-zero exit",
    "  is retried up to 3 times, 30s apart; exhausted retries leave the",
    "  failure visible (non-zero task result + door.log). Do not rely on",
    "  Task Scheduler's restart-on-failure setting — it does not fire on",
    "  exit codes.",
    "- To restart the door by hand (new token, ukp upgrade, new cert):",
    "  taskkill /PID <door-pid> /T /F, then schtasks /Run /TN ukp-door",
    "  (schtasks /End does not reliably kill the process tree).",
    "- LOGON, not boot: the door starts when someone logs on — nobody",
    "  logged on means no door. Unattended-boot always-on needs a service",
    "  wrapper (WinSW-class) — deliberately outside this recipe; prefer the",
    "  ssh:// path or a Linux host (systemd socket activation) for that.",
    "- Re-run ukp serve --print-task with different flags to regenerate;",
    "  edits land by saving the files and re-running schtasks /Run.",
    "- Full recipes and hardening: the deployment handbook —",
    "  docs/remote-deployment.md in this package, or",
    "  https://github.com/CatheadOwl/ukp/blob/main/docs/remote-deployment.md",
    "",
  );
  return out.join("\n");
}
