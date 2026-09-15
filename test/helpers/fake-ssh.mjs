// Minimal stand-in for `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote>`
// (the only ssh form ukp's transparent transport spawns). Serves the LOCAL
// port of the -L forward as a dumb TCP proxy to the remote loopback port and
// appends one line per invocation to the --log file, so tests can count how
// many tunnels an invocation opened (W7 / O-5 pooling assertions).
import { createServer, connect } from "node:net";
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const logIndex = argv.indexOf("--log");
const logFile = logIndex >= 0 ? argv[logIndex + 1] : undefined;
const forwardIndex = argv.indexOf("-L");
const forward = forwardIndex >= 0 ? argv[forwardIndex + 1] : undefined;
const match = forward !== undefined ? forward.match(/^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/) : undefined;
if (match === undefined) process.exit(1);
if (logFile !== undefined) appendFileSync(logFile, `${process.pid} ${forward}\n`, "utf8");

const [, localPort, remotePort] = match;
const server = createServer((socket) => {
  const upstream = connect({ host: "127.0.0.1", port: Number(remotePort) });
  socket.pipe(upstream).pipe(socket);
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
});
server.listen(Number(localPort), "127.0.0.1");
