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
    // popping cmd window is not a correct product form) — /TR points at
    // wscript + vbs, with escaped inner quotes so USERPROFILE paths with
    // spaces survive.
    expect(hostDoorSelfSigned).toContain(
      "schtasks /Create /TN ukp-door /TR \"wscript.exe \\\"%USERPROFILE%\\.ukp\\start-door-hidden.vbs\\\"\" /SC ONLOGON /F",
    );
    expect(hostDoorSelfSigned).toContain(
      "2) Hidden launcher — save as %USERPROFILE%\\.ukp\\start-door-hidden.vbs",
    );
    // The launcher's contract, all four load-bearing lines: environment
    // expansion (not baked paths), hidden + waiting run, bounded crash
    // retry, exit-code propagation.
    expect(hostDoorSelfSigned).toContain("shell.ExpandEnvironmentStrings(\"%USERPROFILE%\")");
    expect(hostDoorSelfSigned).toContain("rc = shell.Run(cmdline, 0, True)");
    expect(hostDoorSelfSigned).toContain("WScript.Sleep 30000");
    expect(hostDoorSelfSigned).toContain("WScript.Quit rc");
    // Elevation honesty (2026-09-20 real-machine probe: creating an ONLOGON
    // task from a plain shell fails with Access denied; a ONCE task does
    // not — the ONLOGON trigger class is what needs the elevated shell).
    expect(hostDoorSelfSigned).toContain("elevated shell");
    expect(hostDoorSelfSigned).toContain(
      'netsh advfirewall firewall add rule name="ukp-door" dir=in action=allow protocol=TCP localport=8570',
    );
    // Paper trail (the silent-EADDRINUSE lesson) and the honest lifecycle
    // statements ride along.
    expect(hostDoorSelfSigned).toContain(">> \"%USERPROFILE%\\.ukp\\door.log\" 2>&1");
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
    // The manual restart recipe replaces schtasks /End (does not kill the
    // tree — the liku orphan lesson).
    expect(hostDoorSelfSigned).toContain("taskkill /PID <door-pid> /T /F");
    // Unattended boot stays honestly out of the recipe.
    expect(hostDoorSelfSigned).toContain("nobody");
    expect(hostDoorSelfSigned).toContain("logged on means no door");
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
    expect(help).not.toMatch(/ADR-|RQ-\d/);
  });
});
