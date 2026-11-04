// [test] preload entry (wired from ukp/bunfig.toml): wires the commit-msg
// English gate before the test suite runs, so the documented dev loop
// (cd ukp && bun test) self-heals the gate with zero manual steps. Lives
// inside the package so split checkouts (the public repo) stay runnable —
// there the installer target is absent and this skips silently. Neither
// this file nor bunfig.toml is in the package "files" set, so no meta-layer
// path reaches the published manifest. See hooks/README.md for the charter.
import { execFileSync } from "node:child_process";

try {
  // ../../ from ukp/scripts/ = the workspace root that owns hooks/.
  execFileSync("bun", ["hooks/install.mjs"], {
    cwd: new URL("../../", import.meta.url),
    stdio: "inherit",
  });
} catch {
  // Outside a full checkout (hooks/ absent) or outside git: skip silently —
  // tests must never fail because of the gate installer.
}
