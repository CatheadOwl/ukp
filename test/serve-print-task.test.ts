import { describe, test, expect } from "bun:test";
import {
  printTaskPreflightError,
  renderServeTaskArtifacts,
} from "../src/commands/serve-task.ts";
import {
  parseServeArgs,
  executeServeCommand,
  renderServeHelp,
} from "../src/commands/serve.ts";
import { KitUsageError } from "../src/commands/kit.ts";

const hostDoorSelfSigned = renderServeTaskArtifacts({
  host: "0.0.0.0",
  port: 8570,
  tls: { mode: "self-signed", sanEntries: ["IP:139.0.0.1"] },
});

describe("serve --print-task rendering (W12)", () => {
  test("host door + self-signed TLS: the four artifacts, hidden form default", () => {
    expect(hostDoorSelfSigned).toContain(
      "ukp serve --host 0.0.0.0 --port 8570 --tls --tls-san IP:139.0.0.1",
    );
    expect(hostDoorSelfSigned).toContain("set \"UKP_SERVE_TOKEN=<paste-your-token>\"");
    // The task runs the hidden launcher (owner ruling 2026-09-21: a visibly
    // popping cmd window is not a correct product form). Recipe flip
    // 2026-09-23 (provider round): an unelevated per-user logon trigger
    // registers from a plain shell via Register-ScheduledTask - the old
    // "elevated schtasks" claim was too broad (only the schtasks ONLOGON
    // form needs elevation). PT0S rides along: the Task Scheduler default
    // stops a task 72 hours after it starts, silently killing a door.
    expect(hostDoorSelfSigned).toContain(
      "New-ScheduledTaskTrigger -AtLogOn -User \"$env:USERDOMAIN\\$env:USERNAME\"",
    );
    expect(hostDoorSelfSigned).toContain("-AllowStartIfOnBatteries");
    expect(hostDoorSelfSigned).toContain("-DontStopIfGoingOnBatteries");
    expect(hostDoorSelfSigned).toContain("-MultipleInstances IgnoreNew");
    expect(hostDoorSelfSigned).toContain("-ExecutionTimeLimit ([TimeSpan]::Zero)");
    expect(hostDoorSelfSigned).toContain("Register-ScheduledTask -TaskName 'ukp-door'");
    expect(hostDoorSelfSigned).toContain(
      "-Execute 'wscript.exe' -Argument '\"%USERPROFILE%\\.ukp\\start-door-hidden.vbs\"'",
    );
    expect(hostDoorSelfSigned).toContain("Start-ScheduledTask -TaskName ukp-door");
    expect(hostDoorSelfSigned).toContain(
      "2) Hidden launcher - save as %USERPROFILE%\\.ukp\\start-door-hidden.vbs",
    );
    // The launcher's contract, all four load-bearing lines: environment
    // expansion (not baked paths), hidden + waiting run, bounded crash
    // retry, exit-code propagation.
    expect(hostDoorSelfSigned).toContain("shell.ExpandEnvironmentStrings(\"%USERPROFILE%\")");
    expect(hostDoorSelfSigned).toContain("rc = shell.Run(cmdline, 0, True)");
    expect(hostDoorSelfSigned).toContain("WScript.Sleep 30000");
    expect(hostDoorSelfSigned).toContain("WScript.Quit rc");
    // Elevation honesty, now scoped to what still needs it: only the
    // firewall rule claims an elevated shell (the task recipe above
    // registers unelevated - a per-user logon trigger from a plain shell).
    expect(hostDoorSelfSigned).toContain(
      "4) Firewall rule for the port (from an elevated shell)",
    );
    expect(hostDoorSelfSigned).toContain(
      'netsh advfirewall firewall add rule name="ukp-door" dir=in action=allow protocol=TCP localport=8570',
    );
    // Log single ownership (ISSUE-016, provider round 2026-09-23): exactly
    // one append redirect and one 2>&1 in the whole artifact - the vbs
    // launcher's outer redirect. A redirect on the cmd's serve line too
    // deadlocks the nested append-open (sharing violation) and the door
    // never starts.
    expect(hostDoorSelfSigned.match(/>>/g)).toHaveLength(1);
    expect(hostDoorSelfSigned.match(/2>&1/g)).toHaveLength(1);
    expect(hostDoorSelfSigned).toContain(
      '" >> " & q & home & "\\.ukp\\door.log" & q & " 2>&1"',
    );
    // The cmd states the ownership split so nobody re-adds a redirect.
    expect(hostDoorSelfSigned).toContain(
      "logging is owned by start-door-hidden.vbs",
    );
    expect(hostDoorSelfSigned).toContain("LOGON, not boot");
    expect(hostDoorSelfSigned).toContain("CRLF");
    // The door.log directory is guaranteed by the script itself.
    expect(hostDoorSelfSigned).toContain('if not exist "%USERPROFILE%\\.ukp" mkdir "%USERPROFILE%\\.ukp"');
    // Self-signed mode states its first-start openssl dependency and the
    // pre-generated alternative (the blind re-run caught the two artifacts
    // disagreeing on this).
    expect(hostDoorSelfSigned).toContain("openssl on PATH");
    expect(hostDoorSelfSigned).toContain("--tls-cert/--tls-key");
  });

  test("hidden-form lifecycle notes: bounded retry honesty and the restart recipe", () => {
    // The disproven native primitive is named so nobody re-trusts it
    // (drills 2026-09-20: restart-on-failure does not fire on exit codes).
    expect(hostDoorSelfSigned).toContain("does not fire on");
    expect(hostDoorSelfSigned).toContain("exit codes");
    // The manual restart recipe replaces End-Task (does not kill the
    // tree — the liku orphan lesson) and pins the kill target to the
    // LAUNCHER root: a serve-leaf-only kill leaves the vbs retry loop
    // to re-grab the port within 30s, racing the manual Start (which
    // IgnoreNew no-ops while the old launcher lives) — retest race,
    // 2026-09-23. The start command stays the PowerShell form so no
    // schtasks slash-arguments remain anywhere in the recipe.
    expect(hostDoorSelfSigned).toContain("taskkill /PID <wscript-pid> /T /F");
    expect(hostDoorSelfSigned).toContain(
      "wscript.exe running start-door-hidden.vbs",
    );
    expect(hostDoorSelfSigned).not.toContain("<door-pid>");
    // Unattended boot stays honestly out of the recipe.
    expect(hostDoorSelfSigned).toContain("nobody");
    expect(hostDoorSelfSigned).toContain("logged on means no door");
  });

  test("resident-door Notes: 72h trap named, Git Bash conversion noted, one task recipe only", () => {
    // The Task Scheduler default execution limit (72h) would silently
    // stop the door; the Notes must say why the recipe pins PT0S.
    expect(hostDoorSelfSigned).toContain("72 hours");
    // Git Bash rewrites slash-style arguments into Git paths (observed
    // live on the provider: schtasks /Query became .../Git/Query); the
    // note names the prefix that keeps taskkill honest from Git Bash.
    expect(hostDoorSelfSigned).toContain("MSYS_NO_PATHCONV=1");
    // Exactly one task-creation recipe: the elevated schtasks route is
    // demoted to prose, never reprinted as a runnable command.
    expect(hostDoorSelfSigned).not.toContain("schtasks /");
    expect(hostDoorSelfSigned).not.toContain("/SC ONLOGON");
  });

  test("teardown section 5 (O-020 ruling B1): three levels, reverse erase checklist, no End-Task route", () => {
    // Stopping != disabling != erasing (teardown FR; the systemd
    // stop/disable/purge taxonomy). Level 1 reuses the Notes'
    // launcher-root kill verbatim - the same command, not a new one.
    expect(hostDoorSelfSigned).toContain("5) To remove the door");
    expect(hostDoorSelfSigned).toContain("taskkill /PID <wscript-pid> /T /F");
    // Level 2: the cmdlet confirms by default (Microsoft Learn) and does
    // not stop the running instance - both facts stated, kill not optional.
    expect(hostDoorSelfSigned).toContain(
      "Unregister-ScheduledTask -TaskName ukp-door -Confirm:$false",
    );
    expect(hostDoorSelfSigned).toContain("not optional");
    // Level 3 is the reverse of 4 -> 0: the firewall rule first (the §4
    // mirror - the original checklist gap), then the by-name files.
    expect(hostDoorSelfSigned).toContain(
      'netsh advfirewall firewall delete rule name="ukp-door"',
    );
    // Comma-separated paths: space-separated del binds only the first
    // path in PowerShell (positional-parameter error, caught live in the
    // 2026-09-23 drill) - the comma form runs in both shells.
    expect(hostDoorSelfSigned).toContain(
      'del "%USERPROFILE%\\.ukp\\start-door.cmd", "%USERPROFILE%\\.ukp\\door.log"',
    );
    expect(hostDoorSelfSigned).toContain('del "%USERPROFILE%\\.ukp\\start-door-hidden.vbs"');
    // The token callout: the file IS the local copy; one that ever left
    // the machine burns the token.
    expect(hostDoorSelfSigned).toContain("carries the token in plaintext");
    expect(hostDoorSelfSigned).toContain("burned");
    // Both registries named: host-side (opt-in - local use survives) and
    // every consumer (token sits there in plaintext).
    expect(hostDoorSelfSigned).toContain("ukp unregister --endpoint <name>");
    // Absence lock: the scheduler's Stop/End-Task route does not kill the
    // wscript tree (disproven in the field 2026-09-23) - the generic
    // tutorial recipe must not creep into the removal advice.
    expect(hostDoorSelfSigned).not.toContain("Stop-ScheduledTask");
  });

  test("teardown section 5: certificate erasure matches the door's TLS shape", () => {
    // Explicit certificates: the del line names exactly the paths step 0
    // printed (generator knows its own outputs).
    const certOut = renderServeTaskArtifacts({
      host: "0.0.0.0",
      port: 9000,
      tls: {
        mode: "certificates",
        certPath: "%USERPROFILE%\\.ukp\\tls\\cert.pem",
        keyPath: "%USERPROFILE%\\.ukp\\tls\\key.pem",
      },
    });
    expect(certOut).toContain('del "%USERPROFILE%\\.ukp\\tls\\key.pem" "%USERPROFILE%\\.ukp\\tls\\cert.pem"');
    expect(certOut).toContain("the certificate paths step 0 printed");
    // Self-signed single-endpoint door: the identity sits INSIDE the
    // served folder - the sync-carries-the-private-key-out warning and
    // the init-service self-ignore pointer are the load-bearing lines.
    const single = renderServeTaskArtifacts({
      endpoint: "notes",
      host: "0.0.0.0",
      port: 8570,
      tls: { mode: "self-signed", sanEntries: [] },
    });
    expect(single).toContain("served folder's .ukp\\tls\\");
    expect(single).toContain("carries the private key out");
    expect(single).toContain("self-ignoring");
    // Host door instead: the identity is host-local - no
    // inside-the-KB-folder warning for this shape.
    expect(hostDoorSelfSigned).toContain("host-local");
    expect(hostDoorSelfSigned).not.toContain("carries the private key out");
  });

  test("door-family riders (O-020 ruling A): topology hint, task-PATH openssl gap, edit hazard", () => {
    const single = renderServeTaskArtifacts({
      endpoint: "notes",
      host: "0.0.0.0",
      port: 8570,
      tls: { mode: "self-signed", sanEntries: [] },
    });
    // Subset FR candidate c: an operator copying this once per endpoint
    // proliferates ports - the note surfaces the whole-registry
    // alternative in serve-help wording. Host-door prints must not
    // carry it (the sentence is meaningless once --endpoint is gone).
    expect(single).toContain("omit --endpoint to serve the whole registry as one host door");
    expect(hostDoorSelfSigned).not.toContain("omit --endpoint");
    // Frictionless FR new-observation 1: the logged-on task's PATH may
    // lack the openssl source the interactive shell has (provider
    // round: --tls re-sign failed until PATH was extended). The note
    // names the common source without hardcoding a path.
    expect(single).toContain("The task's PATH is not your shell's");
    expect(single).toContain('set "PATH=%PATH%;<git>\\mingw64\\bin"');
    // Explicit certificates have no runtime openssl dependency (the
    // once-step runs interactively), so the note stays self-signed-only.
    const certOut = renderServeTaskArtifacts({
      host: "0.0.0.0",
      port: 9000,
      tls: {
        mode: "certificates",
        certPath: "%USERPROFILE%\\.ukp\\tls\\cert.pem",
        keyPath: "%USERPROFILE%\\.ukp\\tls\\key.pem",
      },
    });
    expect(certOut).not.toContain("mingw64");
    // Frictionless FR new-observation 2, promoted one sentence from the
    // handbook pitfall: a running cmd re-reads the script at a stale
    // byte offset, so an in-place edit above can execute torn fragments.
    expect(single).toContain("Stop the door before editing start-door.cmd");
    expect(single).toContain("stale byte offset");
  });

  test("single-endpoint mode carries --endpoint into the serve line", () => {
    const out = renderServeTaskArtifacts({
      endpoint: "notes",
      host: "0.0.0.0",
      port: 8570,
      tls: { mode: "self-signed", sanEntries: [] },
    });
    expect(out).toContain("ukp serve --endpoint notes --host 0.0.0.0 --port 8570 --tls");
  });

  test("explicit certificates: quoted paths, openssl once-step, mkdir guard", () => {
    const out = renderServeTaskArtifacts({
      host: "0.0.0.0",
      port: 9000,
      tls: {
        mode: "certificates",
        certPath: "%USERPROFILE%\\.ukp\\tls\\cert.pem",
        keyPath: "%USERPROFILE%\\.ukp\\tls\\key.pem",
      },
    });
    expect(out).toContain('ukp serve --host 0.0.0.0 --port 9000 --tls-cert "%USERPROFILE%\\.ukp\\tls\\cert.pem" --tls-key "%USERPROFILE%\\.ukp\\tls\\key.pem"');
    expect(out).toContain("openssl req -x509 -newkey rsa:2048");
    expect(out).toContain("-keyout");
    expect(out).toContain('if not exist "%USERPROFILE%\\.ukp\\tls"');
    // The token minting hint closes the replay's "how do I make a token" gap.
    expect(out).toContain("openssl rand -hex 32");
  });

  test("output never contains a literal tab (the handbook defect class)", () => {
    expect(hostDoorSelfSigned).not.toMatch(/\t/);
  });

  test("static template text stays free of drive letters and handbook locator points at the package", () => {
    // The template's own lines must use %USERPROFILE% (no machine-absolute
    // paths); user-supplied cert paths are echoed as given, so assert on the
    // self-signed shape where every path is template-owned.
    expect(hostDoorSelfSigned).not.toMatch(/[A-Z]:\\/);
    expect(hostDoorSelfSigned).toContain("docs/remote-deployment.md");
  });
});

describe("serve --print-task guards", () => {
  test("platform: Windows-only, with the Linux remedy", () => {
    const linux = printTaskPreflightError({
      platform: "linux",
      host: "0.0.0.0",
      hasTls: true,
      allowAnonymous: false,
    });
    expect(linux).toContain("--print-task is Windows-only");
    expect(linux).toContain("--systemd-socket");
    expect(
      printTaskPreflightError({ platform: "win32", host: "0.0.0.0", hasTls: true, allowAnonymous: false }),
    ).toBeUndefined();
  });

  test("off-loopback without TLS is refused (clients refuse plain-http registration)", () => {
    const error = printTaskPreflightError({
      platform: "win32",
      host: "0.0.0.0",
      hasTls: false,
      allowAnonymous: false,
    });
    expect(error).toContain("without TLS");
    // Loopback without TLS stays printable: the reverse-proxy shape.
    expect(
      printTaskPreflightError({ platform: "win32", host: "127.0.0.1", hasTls: false, allowAnonymous: false }),
    ).toBeUndefined();
  });

  test("--allow-anonymous off loopback is refused (serve would refuse it at task start)", () => {
    const error = printTaskPreflightError({
      platform: "win32",
      host: "0.0.0.0",
      hasTls: true,
      allowAnonymous: true,
    });
    expect(error).toContain("--allow-anonymous is loopback-only");
  });

  test("parse: --print-task refuses the self-reap timer and the Linux socket form", () => {
    expect(() => parseServeArgs(["--print-task", "--host", "0.0.0.0", "--tls", "--max-idle", "60"])).toThrow(
      KitUsageError,
    );
    expect(() => parseServeArgs(["--print-task", "--systemd-socket"])).toThrow(KitUsageError);
  });

  test("execute: the env token never reaches the printed artifacts", () => {
    process.env.UKP_SERVE_TOKEN = "super-secret-do-not-print";
    try {
      const result = executeServeCommand(["--print-task", "--host", "0.0.0.0", "--tls"], {
        currentDirectory: process.cwd(),
        registryPath: "unused-for-print",
      });
      if (process.platform === "win32") {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("<paste-your-token>");
      } else {
        // Windows-only generator: the Linux leg hits the platform refusal —
        // the secret guard below still runs on every platform.
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Windows-only");
      }
      expect(result.stdout).not.toContain("super-secret-do-not-print");
      expect(result.stderr).not.toContain("super-secret-do-not-print");
    } finally {
      delete process.env.UKP_SERVE_TOKEN;
    }
  });

  test("execute on win32: off-loopback without TLS exits 1 with the remedy", () => {
    if (process.platform !== "win32") return; // the Linux CI leg hits the platform guard instead
    const result = executeServeCommand(["--print-task", "--host", "0.0.0.0"], {
      currentDirectory: process.cwd(),
      registryPath: "unused-for-print",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("without TLS");
  });

  test("help declares the flag without leaking internal tracking IDs", () => {
    const help = renderServeHelp();
    expect(help).toContain("--print-task");
    expect(help).not.toMatch(/ADR-|RQ-\d|\bW\d+\b/);
  });
});
