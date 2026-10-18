// Fake codex-exec-shaped agent substrate for ukp session tests (spec §4
// baseline: `exec --experimental-json` JSONL on stdout). The scenario is
// selected via AGENT_FIXTURE_SCENARIO (inherited env, spec §7.2); the thread
// id via AGENT_FIXTURE_THREAD_ID.
//
// argv contract (asserted by the tests): exec --experimental-json --cd
// <folder> [resume <id>] <prompt>
const args = process.argv.slice(2);
const resumeIndex = args.indexOf("resume");
const resumeId = resumeIndex === -1 ? null : args[resumeIndex + 1];
const prompt = args[args.length - 1] ?? "";
const scenario = process.env.AGENT_FIXTURE_SCENARIO ?? "ok";
const threadId = process.env.AGENT_FIXTURE_THREAD_ID ?? "fix-thread-1";

const lines = [];
const emit = (item) => lines.push(JSON.stringify(item));

if (scenario === "ok" || scenario === "failed" || scenario === "no-terminal" || scenario === "finish-exit-1") {
  emit({ type: "thread.started", thread_id: threadId });
}
// "no-events" prints literally nothing (spec §5: zero events = substrate
// failure, not a run failure).
if (scenario !== "no-events") {
  emit({ type: "turn.started" });
}

if (scenario === "ok") {
  emit({ type: "item.completed", item: { id: "m1", type: "agent_message", text: `echo:${prompt}` } });
  emit({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "echo hi", aggregated_output: "hi", exit_code: 0 } });
  emit({ type: "turn.completed", usage: { input_tokens: 1 } });
} else if (scenario === "resume-ok") {
  // Resume streams may omit thread.started — spec §4 synthesis rule 1.
  emit({ type: "item.completed", item: { id: "m2", type: "agent_message", text: `resume:${resumeId} echo:${prompt}` } });
  emit({ type: "turn.completed", usage: { input_tokens: 1 } });
} else if (scenario === "failed") {
  emit({ type: "item.completed", item: { id: "m3", type: "agent_message", text: "about to fail" } });
  emit({ type: "turn.failed", error: { message: "fixture boom" } });
  // Trailing stream error after a terminal event: must be suppressed (the
  // exactly-one-pair invariant is the W1 test anchor).
  emit({ type: "error", message: "trailing stream error" });
} else if (scenario === "no-terminal") {
  emit({ type: "item.completed", item: { id: "m4", type: "agent_message", text: "no terminal event follows" } });
} else if (scenario === "finish-exit-1") {
  emit({ type: "turn.completed", usage: { input_tokens: 1 } });
}
// scenario "no-events": prints nothing, exits 1.

if (lines.length > 0) {
  process.stdout.write(`${lines.join("\n")}\n`);
}
process.exit(scenario === "no-events" || scenario === "finish-exit-1" ? 1 : 0);
