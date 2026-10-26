// Fake ssh for the ukp remote session tests (ukp_session_remote W2):
// stands in for the per-verb ssh exec — records every invocation's argv
// as JSON lines via SSH_SHIM_ARGV_LOG (append), answers the amux exec form
// with a canned AG-UI stream (thread id via SSH_SHIM_REPORT /
// SSH_SHIM_THREAD_ID), and exits 0 for the trailing best-effort `del`
// cleanup invocation.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.SSH_SHIM_ARGV_LOG !== undefined) {
  appendFileSync(process.env.SSH_SHIM_ARGV_LOG, `${JSON.stringify(args)}\n`);
}
if (args.includes("del")) process.exit(0);

const threadId = process.env.SSH_SHIM_THREAD_ID ?? "fix-remote-thread-1";
const runId = "run-1";
const lines = [
  { type: "RUN_STARTED", threadId, runId },
  { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", content: process.env.SSH_SHIM_REPORT ?? "remote report" },
  { type: "TEXT_MESSAGE_END", messageId: "m1" },
  { type: "RUN_FINISHED", threadId, runId },
];
process.stdout.write(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
process.exit(0);
