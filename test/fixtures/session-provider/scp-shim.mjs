// Fake scp for the ukp remote session tests (ukp_session_remote W2):
// accepts every brief upload (exit 0), recording each argv as JSON lines
// via SCP_SHIM_ARGV_LOG (append).
import { appendFileSync } from "node:fs";

if (process.env.SCP_SHIM_ARGV_LOG !== undefined) {
  appendFileSync(process.env.SCP_SHIM_ARGV_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
}
process.exit(0);
