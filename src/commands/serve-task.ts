/** Windows resident-door artifact generator (W12): `ukp serve --print-task`
 * renders the process-manager artifacts for an https door on a Windows host
 * — the start script, the hidden launcher (vbs), the Task Scheduler command,
 * the firewall rule — as text the operator reviews and applies. Print-only
 * by construction: UKP installs nothing, starts nothing, and never sees the
 * real token (the script line carries a placeholder; the operator pastes the
 * token into the file they save, under their own permission regime).
 *
 * The emitted shapes mirror the field-verified recipes (deployment
 * handbook, Windows section; provider round 2026-09-23): a bare `ukp`
 * resolves through the logged-on task's per-user PATH and the
 * self-locating launcher finds bun itself, so no PATH export is emitted.
 * The hidden launcher is the product default (owner ruling 2026-09-21: a
 * visibly popping cmd window is not a correct product form): zero flash
 * (hidden at process creation), sole door.log capture (ISSUE-016: a
 * redirect on the cmd's serve line too deadlocks the nested append-open),
 * exit-code propagation, bounded crash retry — Task Scheduler's own
 * restart-on-failure does not fire on exit codes (disproven on liku). The
 * scheduled task registers unelevated via a per-user logon trigger with
 * no execution time limit (the scheduler's 72h default silently kills
 * resident doors).
 *
 * Riders 2026-09-23 (O-020 ruling A, copy-only): single-endpoint prints
 * name the whole-registry host-door alternative (one door instead of one
 * port per endpoint), the self-signed notes add the task-PATH openssl gap
 * (the logged-on task may lack the shell's openssl source; Git for
 * Windows' mingw64\bin is named as the common remedy, no hardcoded path),
 * and every print carries the stop-before-editing hazard (a running cmd
 * re-reads the script at a stale byte offset).
 *
 * §5 "To remove the door" (2026-09-23, O-020 ruling B1 / teardown FR):
 * the print's own inverse, three levels — stop now (the same launcher-root
 * kill as the restart note), stop for good (Unregister-ScheduledTask:
 * confirms by default, and does NOT stop the running instance), erase
 * everything (the reverse of steps 4→0, firewall rule included, the
 * token-bearing cmd named, self-signed identity located by door shape —
 * the single-endpoint identity sits INSIDE the served folder, so sync
 * carries the private key out). The scheduler's own End/Stop task route
 * is deliberately absent: it does not kill the tree (disproven in the
 * field). Print-only as ever — the removal advice documents, never
 * executes. */

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
    return "--print-task is Windows-only; on Linux prefer systemd socket activation (ukp serve --systemd-socket) - the deployment handbook carries that recipe";
  }
  const loopback =
    input.host === "127.0.0.1" || input.host === "localhost" || input.host === "::1" || input.host === "[::1]";
  if (!loopback && !input.hasTls) {
    return "refusing to print an off-loopback door without TLS: clients refuse to register plain-http urls - pass --tls (self-signed, pinned at registration) or --tls-cert/--tls-key, or bind loopback behind a TLS-terminating proxy";
  }
  if (input.allowAnonymous && !loopback) {
    return "refusing to print this shape: --allow-anonymous is loopback-only and serve would refuse it at task start - set the token in the generated script instead";
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
    "ukp serve --print-task - Windows resident-door artifacts",
    "",
    "Print-only: review these, then apply them yourself. UKP installs nothing,",
    "starts nothing, and supervises nothing - the door's lifecycle belongs to",
    "you and your process manager.",
    "",
  ];

  if (input.tls?.mode === "certificates") {
    const certDir = parentDirOf(input.tls.certPath);
    out.push(
      "0) Certificate - generate ONCE (Git for Windows' openssl works; this",
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
    "1) Start script - save as %USERPROFILE%\\.ukp\\start-door.cmd",
    "   (write it with a real editor and CRLF line endings; writing cmd",
    "   files over ssh echo mangles % escaping)",
    "",
    "   @echo off",
    "   rem UKP resident door (generated by ukp serve --print-task)",
    "   rem The token line is the only secret: mint a long random string",
    "   rem (e.g. openssl rand -hex 32), paste it in, keep this file private.",
    "   set \"UKP_SERVE_TOKEN=<paste-your-token>\"",
    "   rem ukp resolves through the logged-on task's per-user PATH; the",
    "   rem launcher finds bun itself - no PATH export needed.",
    "   if not exist \"%USERPROFILE%\\.ukp\" mkdir \"%USERPROFILE%\\.ukp\"",
    "   rem logging is owned by start-door-hidden.vbs (outer redirect) - a",
    "   rem second redirect to the same file here deadlocks the append open",
    `   ${serveLine}`,
    "",
    "2) Hidden launcher - save as %USERPROFILE%\\.ukp\\start-door-hidden.vbs",
    "   (CRLF and a real editor again: the vbs carries literal % signs that",
    "   ssh echo would expand - copy the file instead)",
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
    "3) Scheduled task - starts the door at LOGON, hidden",
    "   (run this block in PowerShell; no elevation needed: this per-user",
    "   logon trigger registers from a plain shell. A machine-level logon",
    "   trigger or another user's session still needs the elevated",
    "   schtasks route)",
    "",
    "   $t = New-ScheduledTaskTrigger -AtLogOn -User \"$env:USERDOMAIN\\$env:USERNAME\"",
    "   $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `",
    "   -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `",
    "   -ExecutionTimeLimit ([TimeSpan]::Zero)",
    "   Register-ScheduledTask -TaskName 'ukp-door' -Action (New-ScheduledTaskAction `",
    "   -Execute 'wscript.exe' -Argument '\"%USERPROFILE%\\.ukp\\start-door-hidden.vbs\"') `",
    "   -Trigger $t -Settings $s -Force",
    "   Start-ScheduledTask -TaskName ukp-door",
    "",
    "4) Firewall rule for the port (from an elevated shell)",
    "",
    `   netsh advfirewall firewall add rule name="ukp-door" dir=in action=allow protocol=TCP localport=${input.port}`,
    "",
    "5) To remove the door - stopping it is not disabling it, and",
    "   disabling it is not erasing it. Three levels; go as far as you",
    "   mean to.",
    "",
    "   Stop it NOW: kill the LAUNCHER root - the same command as the",
    "   restart note in the Notes below:",
    "   taskkill /PID <wscript-pid> /T /F",
    "   The door stays down until the next logon or a manual Start; with",
    "   the task still registered, the next logon brings it back.",
    "",
    "   Stop it FOR GOOD: delete the scheduled task step 3 registered",
    "   (ukp-door in this printout - a renamed second door has its own",
    "   name), from a plain shell, the same zero-elevation path as",
    "   registering it:",
    "   Unregister-ScheduledTask -TaskName ukp-door -Confirm:$false",
    "   The cmdlet asks for confirmation by default; unregistering does",
    "   NOT kill a running door - the kill above is not optional.",
    "",
    "   Erase EVERYTHING - the reverse of steps 4 -> 0 (the firewall",
    "   delete needs the elevated shell again):",
    '   netsh advfirewall firewall delete rule name="ukp-door"',
    // Comma-separated paths: cmd's native delimiter AND PowerShell's
    // array argument (a space-separated del line binds only the first
    // path in PowerShell - caught live in the 2026-09-23 drill).
    '   del "%USERPROFILE%\\.ukp\\start-door.cmd", "%USERPROFILE%\\.ukp\\door.log"',
    '   del "%USERPROFILE%\\.ukp\\start-door-hidden.vbs"',
    "   start-door.cmd carries the token in plaintext: deleting it",
    "   destroys this copy, but if it ever left this machine (a backup,",
    "   a copy), treat the token as burned and mint a fresh one for any",
    "   future door.",
    ...(input.tls?.mode === "certificates"
      ? [
          `   del "${input.tls.keyPath}" "${input.tls.certPath}"`,
          "   (the certificate paths step 0 printed)",
        ]
      : []),
    ...(input.tls?.mode === "self-signed" && input.endpoint !== undefined
      ? [
          "   The --tls identity lives in the served folder's .ukp\\tls\\ -",
          "   INSIDE the knowledge folder. Git or cloud sync",
          "   carries the private key out with it. Delete it when the folder",
          "   leaves this machine; ukp init service drops a self-ignoring",
          "   .ukp\\.gitignore there for exactly this reason.",
        ]
      : []),
    ...(input.tls?.mode === "self-signed" && input.endpoint === undefined
      ? [
          "   The --tls identity is host-local: the tls\\ folder beside the",
          "   host registry - delete it with the door if you are done.",
        ]
      : []),
    "   The endpoints stay registered on the host for local use;",
    "   unregister them too only if you are done with them, one per",
    "   endpoint: ukp unregister --endpoint <name>. Every consumer that",
    "   ran ukp register --url holds the token in plaintext in its own",
    "   registry - run ukp unregister --endpoint <name> there as well.",
    "",
    "Notes:",
    ...(input.endpoint !== undefined
      ? [
          "- Single-endpoint door (one port, task, and token per endpoint):",
          "  omit --endpoint to serve the whole registry as one host door",
          "  (/e/<name>/ routing, all endpoints, one port).",
        ]
      : []),
    ...(input.tls?.mode === "self-signed"
      ? [
          "- --tls self-signs at first start using an openssl on PATH (Git",
          "  for Windows' openssl qualifies). On a host with no openssl",
          "  anywhere, pre-generate the certificate once instead: re-run with",
          "  --tls-cert/--tls-key - the handbook's Windows section carries",
          "  that recipe.",
          "- The task's PATH is not your shell's: the logged-on task",
          "  environment may lack the openssl source your interactive shell",
          "  sees (--tls then fails to self-sign or re-sign). The common",
          "  source is Git for Windows' mingw64\\bin - extend PATH inside",
          "  start-door.cmd: set \"PATH=%PATH%;<git>\\mingw64\\bin\".",
        ]
      : []),
    "- No visible window, by design: the hidden launcher starts the console",
    "  hidden at process creation (nothing ever flashes on the desktop) and",
    "  captures everything to door.log - that redirect is the paper trail (a",
    "  silent EADDRINUSE exit leaves a line).",
    "- Crash self-recovery is the launcher's bounded retry: a non-zero exit",
    "  is retried up to 3 times, 30s apart; exhausted retries leave the",
    "  failure visible (non-zero task result + door.log). Do not rely on",
    "  Task Scheduler's restart-on-failure setting - it does not fire on",
    "  exit codes.",
    "- The task recipe pins no execution time limit on purpose: the Task",
    "  Scheduler default stops a task 72 hours after it starts, which",
    "  would silently kill a resident door (no window, no log line).",
    "- To restart the door by hand (new token, ukp upgrade, new cert):",
    "  kill the LAUNCHER root, not just the serve leaf. The kill command:",
    "  taskkill /PID <wscript-pid> /T /F - where <wscript-pid> is the",
    "  wscript.exe running start-door-hidden.vbs; then",
    "  Start-ScheduledTask -TaskName ukp-door. A leaf-only kill lets",
    "  the launcher's bounded retry re-grab the port within 30s, racing",
    "  your Start (which IgnoreNew no-ops while the old launcher lives);",
    "  the scheduler's End-Task does not kill the tree either. Each door",
    "  has its own wscript - in PowerShell, list them and match the vbs",
    "  name: Get-CimInstance Win32_Process -Filter \"Name='wscript.exe'\"",
    "  | Select-Object ProcessId,CommandLine",
    "- Git Bash users: prefix slash-style commands with MSYS_NO_PATHCONV=1",
    "  (e.g. MSYS_NO_PATHCONV=1 taskkill /PID <pid> /T /F), or MSYS rewrites",
    "  the slash arguments into Git paths and the command fails with a",
    "  misleading Invalid-argument error.",
    "- LOGON, not boot: the door starts when someone logs on - nobody",
    "  logged on means no door. Unattended-boot always-on needs a service",
    "  wrapper (WinSW-class) - deliberately outside this recipe; prefer the",
    "  ssh:// path or a Linux host (systemd socket activation) for that.",
    "- Stop the door before editing start-door.cmd: a running cmd",
    "  re-reads the script from a stale byte offset when the current",
    "  line's child exits, so editing lines above can make it execute",
    "  torn fragments of the edit.",
    "- Re-run ukp serve --print-task with different flags to regenerate;",
    "  edits land by saving the files and starting the task again",
    "  (Start-ScheduledTask -TaskName ukp-door).",
    "- Full recipes and hardening: the deployment handbook -",
    "  docs/remote-deployment.md in this package, or",
    "  https://github.com/CatheadOwl/ukp/blob/main/docs/remote-deployment.md",
    "",
  );
  return out.join("\n");
}
