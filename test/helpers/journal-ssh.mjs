// Concurrency-journal shim for the sshCommand test seam. Configuration rides
// in this command's own argv (NOT env: on win32 Bun.spawn children do not
// inherit runtime mutations of process.env, verified live), consumed from the
// front before delegating — the same own-flags idiom as fake-ssh.mjs:
//
//   bun journal-ssh.mjs --journal <file> --inner <JSON> <ssh args…>
//
//   --journal  JSON-lines journal; append order = real time. Every
//              invocation appends {pid, phase: "start"|"end", target, argv}.
//   --inner    JSON object keyed by ssh target (the host arg present in the
//              invocation's argv) whose values are the inner command argv.
//
// Tests use the journal to prove invocations overlapped in time — the W1
// fan-out anchor (remote origins start together, not serially): a serial
// caller's journal reads start/end/start/end, a concurrent one's
// start/start/end/end. Must run under bun (tests pass process.execPath).
import { appendFileSync } from "node:fs";

const raw = process.argv.slice(2);
const own = (flag) => {
  const index = raw.indexOf(flag);
  return index >= 0 ? raw[index + 1] : undefined;
};
const journal = own("--journal");
const inners = JSON.parse(own("--inner") ?? "{}");
const argv = raw.filter((_, index) =>
  !(raw[index - 1] === "--journal" || raw[index - 1] === "--inner" || raw[index] === "--journal" || raw[index] === "--inner"),
);
const target = argv.find((arg) => Object.hasOwn(inners, arg));
const inner = inners[target ?? ""] ?? Object.values(inners)[0] ?? [];
if (journal !== undefined) {
  appendFileSync(journal, `${JSON.stringify({ pid: process.pid, phase: "start", target, argv })}\n`, "utf8");
}
const child = Bun.spawn([...inner, ...argv], { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
await child.exited;
if (journal !== undefined) {
  appendFileSync(journal, `${JSON.stringify({ pid: process.pid, phase: "end", target, exitCode: child.exitCode })}\n`, "utf8");
}
process.exit(child.exitCode ?? 0);
