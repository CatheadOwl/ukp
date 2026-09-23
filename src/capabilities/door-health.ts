/** Windows resident-door health model (O-020 ruling B2): the read-only
 * checks behind `ukp diagnose --door`. A "door" here is what
 * `ukp serve --print-task` sets up: a scheduled task whose action runs
 * wscript.exe on a hidden launcher (start-*-hidden.vbs) under
 * %USERPROFILE%\.ukp, which runs the start script (start-*.cmd, carrying
 * the serve line and the token) and owns door.log. Multi-door hosts rename
 * the trio per door (field shape: ukp-door / ukp-door-agent-eval), so
 * discovery matches the task ACTION (wscript + a .vbs under .ukp), never a
 * fixed task name.
 *
 * Read-only by construction: the system facts arrive as one PowerShell
 * snapshot (task roster, process table, LISTEN sockets) - no process is
 * killed, no file written, no task registered or unregistered, and the
 * "port bind dry-run" is a listener-table lookup, not a real bind (a real
 * listen could pop a firewall prompt and race the launcher's crash retry).
 * The start script is read but only the serve line's --endpoint/--host/
 * --port values are ever echoed; the UKP_SERVE_TOKEN line stays in the
 * file (secret-free output, D-090 convention). Repair knowledge is
 * pointers only: `ukp serve --print-task` section 5 and the deployment
 * handbook - diagnose says what is wrong, never fixes it. */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// System snapshot (injectable in full for tests)
// ---------------------------------------------------------------------------

export interface DoorTaskRow {
  name: string;
  state: string;
  execute: string;
  arguments: string;
}

export interface DoorProcessRow {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string;
}

export interface DoorListenerRow {
  address: string;
  port: number;
  pid: number;
}

export interface DoorSystemSnapshot {
  tasks: DoorTaskRow[];
  processes: DoorProcessRow[];
  listeners: DoorListenerRow[];
}

export type DoorSystemProbe = () => DoorSystemSnapshot;

/** Default file reader for the operator-authored door files. */
export function defaultReadDoorFile(path: string): string {
  return readFileSync(path, "utf8");
}

/** The one-shot PowerShell collector. Everything diagnose needs about
 * tasks, processes, and listeners rides in a single spawn (each direct
 * bun->tool edge is Defender-taxed on win32; powershell as the carrier is
 * the measured-fast shape, see spawn-relay.ts) and comes back as JSON.
 * `[Console]::OutputEncoding` is set so non-ASCII task names survive the
 * pipe as UTF-8. */
export function defaultDoorSystemProbe(): DoorSystemSnapshot {
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object {",
    "  $a = @($_.Actions)[0]",
    '  [pscustomobject]@{ name = $_.TaskName; state = [string]$_.State; execute = [string]$a.Execute; arguments = [string]$a.Arguments }',
    "})",
    "$processes = @(Get-CimInstance Win32_Process | ForEach-Object {",
    '  [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; commandLine = [string]$_.CommandLine }',
    "})",
    "$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {",
    '  [pscustomobject]@{ address = [string]$_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess }',
    "})",
    '[pscustomobject]@{ tasks = $tasks; processes = $processes; listeners = $listeners } | ConvertTo-Json -Depth 4 -Compress',
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  if (result.error) {
    throw new Error(`could not run powershell for the door snapshot: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`the door snapshot query failed (powershell exit ${result.status})`);
  }
  const raw = (result.stdout ?? "").replace(/^\uFEFF/, "").trim();
  if (raw.length === 0) {
    throw new Error("the door snapshot query returned nothing");
  }
  const parsed = JSON.parse(raw) as Partial<DoorSystemSnapshot>;
  return {
    tasks: (parsed.tasks ?? []).map((row) => ({ ...row, arguments: row.arguments ?? "" })),
    processes: (parsed.processes ?? []).map((row) => ({
      pid: Number(row.pid),
      ppid: Number(row.ppid),
      name: row.name ?? "",
      commandLine: row.commandLine ?? "",
    })),
    listeners: (parsed.listeners ?? []).map((row) => ({
      address: row.address ?? "",
      port: Number(row.port),
      pid: Number(row.pid),
    })),
  };
}

// ---------------------------------------------------------------------------
// Door discovery and per-door evaluation
// ---------------------------------------------------------------------------

export interface DoorReport {
  taskName: string;
  taskState: string;
  /** Resolved launcher (.vbs) path; absent when the action path could not
   * be resolved (task is then structurally failed). */
  launcherPath?: string;
  scriptPath?: string;
  serve?: { endpoint?: string; host?: string; port?: number };
  /** Main root-to-leaf chain (wscript -> cmd -> ... -> bun); absent when no
   * launcher process was found. */
  tree?: Array<{ pid: number; name: string }>;
  port?: {
    port: number;
    listening: boolean;
    holderPid?: number;
    holderName?: string;
    inTree?: boolean;
  };
  log?: {
    path: string;
    banner: boolean;
    lastListening?: string;
    eaddrinuse: boolean;
    sharingViolation: boolean;
  };
  warnings: string[];
  status: "ok" | "warning" | "failed";
}

export interface DoorEvaluationEnv {
  homeDir: string;
  readTextFile: (path: string) => string;
}

function normalizeKeyPath(path: string): string {
  return path.replaceAll("/", "\\").toLowerCase();
}

function stripSurroundingQuotes(value: string): string {
  return value.trim().replace(/^"+/, "").replace(/"+$/, "");
}

/** A door task = an action running wscript.exe on a .vbs under a `.ukp`
 * directory (the print-task launcher shape, rename-tolerant: any task/vbs
 * name qualifies as long as the shape holds). */
export function isDoorTaskAction(execute: string, args: string): boolean {
  if (!/wscript\.exe$/i.test(execute.trim())) return false;
  const clean = stripSurroundingQuotes(args).replaceAll("/", "\\");
  return /\\.ukp\\.*\.vbs$/i.test(clean);
}

/** Task action argument -> launcher path. Only %USERPROFILE% (the
 * template's variable) is expanded; any other %VAR% marks the action
 * unresolvable from userland. */
export function resolveDoorLauncherPath(
  args: string,
  homeDir: string,
): { path: string; resolved: boolean } {
  const clean = stripSurroundingQuotes(args);
  const expanded = clean.replace(/%USERPROFILE%/gi, homeDir);
  return { path: expanded, resolved: !expanded.includes("%") };
}

/** The .vbs path from a live wscript command line (last quoted .vbs token). */
function vbsPathFromCommandLine(commandLine: string): string | undefined {
  const matches = [...commandLine.matchAll(/"([^"]+\.vbs)"/gi)].map((m) => m[1]!);
  return matches.at(-1);
}

/** The serve line's flags from the start script text; undefined pieces are
 * simply absent. Only these three values are ever echoed - the token line
 * in the same file is never reproduced. */
export function parseServeLine(scriptText: string): { endpoint?: string; host?: string; port?: number } | undefined {
  const line = scriptText
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => /^ukp\s+serve(\s|$)/.test(entry));
  if (line === undefined) return undefined;
  const endpoint = /--endpoint\s+(\S+)/.exec(line)?.[1];
  const host = /--host\s+(\S+)/.exec(line)?.[1];
  const portRaw = /--port\s+(\d+)/.exec(line)?.[1];
  return {
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(portRaw !== undefined ? { port: Number(portRaw) } : {}),
  };
}

/** door.log path: the live cmd process carries the full redirect target;
 * statically, the vbs names the log file fragment under .ukp. */
function findLogPath(liveCmdCommandLine: string | undefined, vbsText: string | undefined, launcherPath: string): string | undefined {
  const live = liveCmdCommandLine !== undefined ? />>\s*"([^"]+)"/.exec(liveCmdCommandLine)?.[1] : undefined;
  if (live !== undefined) return live;
  const fragment = vbsText !== undefined ? /\\\.ukp\\([^\r\n"']+?\.log)/i.exec(vbsText)?.[1] : undefined;
  if (fragment !== undefined) {
    const dir = launcherPath.slice(0, Math.max(launcherPath.lastIndexOf("\\"), launcherPath.lastIndexOf("/")));
    return `${dir}\\${fragment.replaceAll("/", "\\")}`;
  }
  return undefined;
}

function evaluateDoor(report: DoorReport, snapshot: DoorSystemSnapshot, env: DoorEvaluationEnv): DoorReport {
  const warnings = report.warnings;
  const failed = report.status === "failed";

  // Launcher script readability (operator-authored; tolerance, not failure).
  let vbsText: string | undefined;
  if (report.launcherPath !== undefined) {
    try {
      vbsText = env.readTextFile(report.launcherPath);
    } catch {
      warnings.push(
        `launcher script not found at ${report.launcherPath} - the task references a deleted file; remove the task ('ukp serve --print-task' section 5, level 2) or restore the file`,
      );
    }
  }

  // Start script (the -hidden.vbs -> .cmd naming convention) and its serve line.
  let scriptText: string | undefined;
  if (report.scriptPath !== undefined) {
    try {
      scriptText = env.readTextFile(report.scriptPath);
    } catch {
      warnings.push(
        `start script not found at ${report.scriptPath} - the door's port cannot be determined; restore it or remove the door ('ukp serve --print-task' section 5)`,
      );
    }
  }
  if (scriptText !== undefined) {
    const serve = parseServeLine(scriptText);
    if (serve === undefined) {
      warnings.push(
        `no 'ukp serve' line found in ${report.scriptPath} - the door's port cannot be determined from the script`,
      );
    } else {
      report.serve = serve;
      if (serve.port === undefined) {
        warnings.push(`the serve line in ${report.scriptPath} carries no --port - the door's port cannot be determined`);
      }
    }
  }

  // Process tree: the wscript whose command line names this door's vbs.
  const launcherKey = report.launcherPath !== undefined ? normalizeKeyPath(report.launcherPath) : undefined;
  const root = snapshot.processes.find((proc) => {
    if (!/^wscript\.exe$/i.test(proc.name)) return false;
    const vbs = vbsPathFromCommandLine(proc.commandLine);
    return vbs !== undefined && launcherKey !== undefined && normalizeKeyPath(vbs) === launcherKey;
  });
  let treePidSet: Set<number> | undefined;
  if (root !== undefined) {
    const children = new Map<number, DoorProcessRow[]>();
    for (const proc of snapshot.processes) {
      const list = children.get(proc.ppid) ?? [];
      list.push(proc);
      children.set(proc.ppid, list);
    }
    const treePids = new Set<number>([root.pid]);
    const chain: Array<{ pid: number; name: string }> = [{ pid: root.pid, name: root.name.replace(/\.exe$/i, "") }];
    let frontier: DoorProcessRow[] = [root];
    while (frontier.length > 0) {
      // Main chain = first child per level; siblings only join the pid set.
      const next: DoorProcessRow[] = [];
      for (const parent of frontier) {
        for (const child of children.get(parent.pid) ?? []) {
          treePids.add(child.pid);
          next.push(child);
        }
      }
      if (next.length > 0) {
        chain.push({ pid: next[0]!.pid, name: next[0]!.name.replace(/\.exe$/i, "") });
      }
      frontier = next;
    }
    treePidSet = treePids;
    report.tree = chain;
  }

  // Port cross-check: the listener table decides, never a real bind.
  const port = report.serve?.port;
  if (port !== undefined) {
    const holder = snapshot.listeners.find((entry) => entry.port === port);
    if (holder === undefined) {
      report.port = { port, listening: false };
    } else {
      const holderName = snapshot.processes.find((proc) => proc.pid === holder.pid)?.name ?? "(unknown)";
      const inTree = treePidSet?.has(holder.pid) ?? false;
      report.port = {
        port,
        listening: true,
        holderPid: holder.pid,
        holderName: holderName.replace(/\.exe$/i, ""),
        inTree,
      };
      if (!inTree) {
        warnings.push(
          `port ${port} is held by ${holderName.replace(/\.exe$/i, "")}(${holder.pid}) OUTSIDE this door's process tree - a leftover listener the door cannot bind past (its log would carry EADDRINUSE); find it with netstat -ano | findstr :${port}`,
        );
      }
    }
  }

  // door.log tail triage (ISSUE-016 vocabulary made actionable).
  if (report.launcherPath !== undefined) {
    const liveCmd =
      root !== undefined
        ? snapshot.processes.find((proc) => proc.ppid === root!.pid && /^cmd\.exe$/i.test(proc.name))
        : undefined;
    const logPath = findLogPath(liveCmd?.commandLine, vbsText, report.launcherPath);
    if (logPath === undefined) {
      warnings.push("the door.log path could not be determined (neither the live launcher nor the vbs names it)");
    } else {
      try {
        const tail = env.readTextFile(logPath).slice(-8192);
        // Latest-evidence triage: the log is append-only, so a failure
        // signature only counts when it lands AFTER the newest serving
        // banner (a banner that follows supersedes the failure - the door
        // restarted or the artifacts were regenerated; field door 8570
        // carries ISSUE-016-era scar lines under a healthy banner).
        const lastBanner = Math.max(
          tail.lastIndexOf("serving endpoint '"),
          tail.lastIndexOf("serving host door"),
        );
        const lastEaddrinuse = tail.lastIndexOf("EADDRINUSE");
        const lastSharingViolation = tail.lastIndexOf("being used by another process");
        const banner = lastBanner !== -1;
        const lastListening = [...tail.matchAll(/listening: (\S+)/g)].map((m) => m[1]!).at(-1);
        const eaddrinuse = lastEaddrinuse > lastBanner;
        const sharingViolation = lastSharingViolation > lastBanner;
        report.log = { path: logPath, banner, lastListening, eaddrinuse, sharingViolation };
        if (!banner) {
          warnings.push(
            `no serving banner in the tail of ${logPath} - the door never reached serving in what the log remembers`,
          );
        }
        if (eaddrinuse) {
          warnings.push(
            `door.log tail carries EADDRINUSE as its latest evidence - the port was already taken when the door last tried to bind; see the port row above, then restart the door by killing the launcher root (taskkill /PID <wscript-pid> /T /F) and Start-ScheduledTask -TaskName ${report.taskName}`,
          );
        }
        if (sharingViolation) {
          warnings.push(
            "door.log carries 'being used by another process' as its latest evidence - the double-redirect deadlock shape (a redirect on the serve line inside the start script while the hidden launcher also redirects); regenerate the artifacts with a current ukp ('ukp serve --print-task') - the serve line must carry no redirect",
          );
        }
      } catch {
        warnings.push(`no readable door.log at ${logPath} - the door has not logged a start here`);
      }
    }
  }

  // Door-level findings.
  if (report.tree === undefined) {
    if (/^running$/i.test(report.taskState)) {
      warnings.push(
        `the task state says Running but no launcher process exists - the door crashed past the launcher's bounded retries or was killed; start it again (Start-ScheduledTask -TaskName ${report.taskName})`,
      );
    } else {
      warnings.push(
        `door not running - the task is registered but nothing holds the process tree; start it with Start-ScheduledTask -TaskName ${report.taskName}, or remove it ('ukp serve --print-task' section 5)`,
      );
    }
  } else if (report.port?.listening === false) {
    warnings.push(
      `the door's process tree is alive but nothing listens on port ${port} - the serve process may be mid-retry or failed to bind; check the log tail above`,
    );
  }

  report.status = failed ? "failed" : warnings.length > 0 ? "warning" : "ok";
  return report;
}

/** Snapshot -> per-door reports. Pure apart from the injected file reader. */
export function evaluateDoorSnapshot(snapshot: DoorSystemSnapshot, env: DoorEvaluationEnv): DoorReport[] {
  const reports: DoorReport[] = [];
  for (const task of snapshot.tasks) {
    if (!isDoorTaskAction(task.execute, task.arguments)) continue;
    const report: DoorReport = { taskName: task.name, taskState: task.state, warnings: [], status: "ok" };
    const resolved = resolveDoorLauncherPath(task.arguments, env.homeDir);
    if (!resolved.resolved) {
      report.status = "failed";
      report.warnings.push(
        `the task action could not be resolved to a launcher path: ${task.arguments} (only %USERPROFILE% is expanded)`,
      );
    } else {
      report.launcherPath = resolved.path;
      if (/-hidden\.vbs$/i.test(resolved.path)) {
        report.scriptPath = resolved.path.replace(/-hidden\.vbs$/i, ".cmd");
      }
    }
    reports.push(evaluateDoor(report, snapshot, env));
  }
  return reports.sort((a, b) => a.taskName.localeCompare(b.taskName));
}

// ---------------------------------------------------------------------------
// Rendering (diagnose wire vocabulary: key: value rows, status:, warning:)
// ---------------------------------------------------------------------------

export function renderDoorReport(report: DoorReport): string[] {
  const lines = [
    `== door: ${report.taskName} ==`,
    `task: ${report.taskState}`,
    ...(report.launcherPath !== undefined ? [`launcher: ${report.launcherPath}`] : []),
  ];
  if (report.scriptPath !== undefined) {
    lines.push(`script: ${report.scriptPath}`);
  }
  if (report.serve !== undefined) {
    const shape = report.serve.endpoint !== undefined
      ? `endpoint ${report.serve.endpoint}`
      : "host door";
    const host = report.serve.host !== undefined ? `, host ${report.serve.host}` : "";
    const port = report.serve.port !== undefined ? `, port ${report.serve.port}` : "";
    lines.push(`serve: ${shape}${host}${port}`);
  }
  lines.push(
    report.tree !== undefined
      ? `tree: ${report.tree.map((node) => `${node.name}(${node.pid})`).join(" > ")}`
      : "tree: (no launcher process)",
  );
  if (report.port !== undefined) {
    if (!report.port.listening) {
      lines.push(`port: ${report.port.port} free (nothing listens)`);
    } else if (report.port.inTree) {
      lines.push(`port: ${report.port.port} listening (pid ${report.port.holderPid}, inside the door tree)`);
    } else {
      lines.push(`port: ${report.port.port} listening (pid ${report.port.holderPid}, OUTSIDE the door tree)`);
    }
  }
  if (report.log !== undefined) {
    const tail = report.log.banner
      ? report.log.lastListening !== undefined
        ? `banner present (last: listening: ${report.log.lastListening})`
        : "banner present"
      : "no serving banner in the tail";
    lines.push(`log: ${report.log.path}`, `log_tail: ${tail}`);
  }
  for (const warning of report.warnings) {
    lines.push(`warning: ${warning}`);
  }
  lines.push(`status: ${report.status}`);
  return lines;
}

export function renderDoorHealthReport(reports: readonly DoorReport[]): string {
  if (reports.length === 0) {
    return [
      "no resident doors found on this host (no scheduled task launches a .ukp",
      "hidden launcher). This is not an error - doors exist only where",
      "'ukp serve --print-task' was applied; the ssh:// path runs none.",
      "",
    ].join("\n");
  }
  return `${reports.map((report) => renderDoorReport(report).join("\n")).join("\n\n")}\n`;
}
