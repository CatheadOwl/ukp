// Fake amux binary for ukp session wrapper tests (W2/G3): speaks amux's
// --events face — AG-UI JSONL on stdout, human notes on stderr, amux exit
// discipline (usage = 2, runtime = 1 with an `amux: <label>:` classified
// line). The scenario is selected via AMUX_SHIM_SCENARIO; the thread id
// via AMUX_SHIM_THREAD_ID.
//
// The "echo-argv" scenario reflects ukp's argv back as the final message
// so tests can pin the wrapper→amux contract (`amux <folder> <command...>
// --events --sandbox <tier> --text <prompt>` / the send form).
const args = process.argv.slice(2);
const isSend = args[0] === "send";
const sessionId = isSend ? args[1] ?? null : null;
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
};
const prompt = flag("--text") ?? "";
const scenario = process.env.AMUX_SHIM_SCENARIO ?? "ok";
const threadId = isSend && sessionId !== null ? sessionId : process.env.AMUX_SHIM_THREAD_ID ?? "fix-thread-1";
const runId = "run-1";

const lines = [];
const note = (text) => process.stderr.write(`${text}\n`);
const emit = (event) => lines.push(JSON.stringify({ threadId, runId, ...event }));
const flush = () => {
  if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
};
const finalReport = (content) => {
  emit({ type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" });
  emit({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", content });
  emit({ type: "TEXT_MESSAGE_END", messageId: "m1" });
};

if (scenario === "usage-error") {
  note("amux: usage error: --sandbox must be read-only or workspace-write (got 'bogus')");
  process.exit(2);
}
if (scenario === "substrate-error") {
  note("amux: agent substrate unavailable: agent command 'fake-agent' failed to start (spawn ENOENT)");
  process.exit(1);
}
if (scenario === "run-failed-error") {
  note("amux: run failed: fixture boom");
  process.exit(1);
}

// Every remaining scenario emits an event stream (amux closes the run pair
// itself; the notes below mirror the stderr face ukp must suppress).
emit({ type: "RUN_STARTED" });
note(`session ${threadId} started (agent fake-agent, path ${isSend ? "<book>" : args[0]})`);

if (scenario === "ok") {
  finalReport(`echo:${prompt}`);
  emit({ type: "RUN_FINISHED" });
  flush();
  note(`session ${threadId} finished`);
  process.exit(0);
}
if (scenario === "resume-ok") {
  finalReport(`resume:${threadId} echo:${prompt}`);
  emit({ type: "RUN_FINISHED" });
  flush();
  note(`session ${threadId} finished`);
  process.exit(0);
}
if (scenario === "echo-argv") {
  finalReport(JSON.stringify({ args, isSend }));
  emit({ type: "RUN_FINISHED" });
  flush();
  note(`session ${threadId} finished`);
  process.exit(0);
}
if (scenario === "failed") {
  finalReport("about to fail");
  emit({ type: "RUN_ERROR", message: "fixture boom" });
  flush();
  note(`session ${threadId} failed — see RUN_ERROR on run ${runId}`);
  process.exit(1);
}
if (scenario === "finish-exit-1") {
  emit({ type: "RUN_FINISHED" });
  flush();
  note(`session ${threadId} failed — see RUN_ERROR on run ${runId}`);
  process.exit(1);
}
if (scenario === "no-terminal") {
  finalReport("no terminal event follows");
  flush();
  note(`session ${threadId} finished`);
  process.exit(0);
}

note(`amux-shim: unknown scenario '${scenario}'`);
process.exit(1);
