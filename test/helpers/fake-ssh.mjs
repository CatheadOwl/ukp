// Minimal stand-in for the ssh invocations ukp's transparent transport spawns.
// Two forms:
//
//   tunnel-only (pre-W9, kept for direct -L assertions):
//     ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote> <target>
//
//   on-demand wake (W9 / ADR-REM-006): a trailing remote command
//     ssh -L 127.0.0.1:<local>:127.0.0.1:<remote> <target> \
//         "ukp serve --allow-anonymous --host 127.0.0.1 --port <p> --max-idle <n>"
//   asks this fake sshd to EXEC the command: it starts a real door-mode
//   server (ukp/src/server.ts) in-process on the command's port. The Host
//   Registry behind that door comes from this helper's OWN --registry flag —
//   a test-seam knob of the fake sshd, not of the production wake command
//   (which is pinned and carries no such option).
//
// Own flags (consumed from argv; never collide with the ssh args the client
// appends after the injected command): --log <file>, --registry <path>,
// --qmd <fixture.mjs>, --node <executable>.
//
// This helper must run under bun (tests pass process.execPath) so it can
// import ukp/src/server.ts; the qmd fixture still runs under node (--node,
// defaulting to this process's executable).
//
// Serves the LOCAL port of the -L forward as a dumb TCP proxy to the remote
// loopback port and appends one line per invocation to the --log file, so
// tests can count how many tunnels an invocation opened (W7 / O-5 pooling
// assertions).
import { createServer, connect } from "node:net";
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const own = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const logFile = own("--log");
const registryPath = own("--registry");
const qmdFixture = own("--qmd");
const nodeForQmd = own("--node");
const dumpFile = own("--dump");
// Dump every raw argv BEFORE the -L validation below: the Tier-1 mux-master
// invocation carries no -L and exits there — tests still want its shape.
if (dumpFile !== undefined) appendFileSync(dumpFile, `${JSON.stringify(argv)}\n`, "utf8");

const forwardIndex = argv.indexOf("-L");
const forward = forwardIndex >= 0 ? argv[forwardIndex + 1] : undefined;
const match = forward !== undefined ? forward.match(/^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/) : undefined;
if (match === undefined) process.exit(1);

// Wake support: find the trailing "ukp serve …" command and honor it. When
// present, the log line records the RAW wake string so tests can pin the
// operator-facing allowlist contract byte-for-byte (modulo the port).
const wake = argv.find((arg) => arg.startsWith("sh -c ") && arg.includes("ukp serve "));
if (logFile !== undefined) {
  appendFileSync(logFile, `${process.pid} ${forward}${wake !== undefined ? ` wake=${wake}` : ""}\n`, "utf8");
}

const [, localPort, remotePort] = match;

// Safety: never outlive a misbehaving test run — the client's close() is the
// normal exit path; this reaper bounds a leaked helper (and its in-process
// door) to two minutes.
const reaper = setTimeout(() => process.exit(0), 120_000);
reaper.unref?.();

const server = createServer((socket) => {
  const upstream = connect({ host: "127.0.0.1", port: Number(remotePort) });
  socket.pipe(upstream).pipe(socket);
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
});
server.listen(Number(localPort), "127.0.0.1");

// Wake support: honor the trailing "ukp serve …" command (found above, before
// the log line) by starting the real door.
if (wake !== undefined) {
  if (registryPath === undefined || registryPath === "") {
    console.error("fake-ssh: wake command present but --registry is unset");
    process.exit(1);
  }
  const portMatch = wake.match(/--port (\d+)/);
  const idleMatch = wake.match(/--max-idle ([\d.]+)/);
  if (portMatch === null) {
    console.error(`fake-ssh: unparseable wake command: ${wake}`);
    process.exit(1);
  }
  const qmdCommand = qmdFixture === undefined ? undefined : [nodeForQmd ?? Bun.which("node") ?? process.execPath, qmdFixture];
  const { startUkpServer } = await import("../../src/server.ts");
  const { dirname } = await import("node:path");
  startUkpServer({
    currentDirectory: dirname(registryPath),
    registryPath,
    ...(qmdCommand !== undefined ? { qmdCommand } : {}),
    host: "127.0.0.1",
    port: Number(portMatch[1]),
    ...(idleMatch !== null ? { maxIdleSeconds: Number(idleMatch[1]) } : {}),
  });
}

