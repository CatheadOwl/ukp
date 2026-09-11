import { cpSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Per-file private copy of the shared qmd-provider fixture.
 *
 * The fixture provider writes its invocation state
 * (`qmd-fixture-invocation.json` latest-call snapshot and
 * `qmd-fixture-invocations.jsonl` append log) into its cwd, which UKP sets to
 * the registered service folder. Test files that assert on that state
 * (before/after counts, exact invocation fields, existence checks, finally
 * cleanup) must not share one folder: bun runs test files in parallel, so a
 * shared fixture directory races across files — invocations get overwritten
 * or deleted mid-assert, cascading into unrelated failures.
 *
 * Each test file creates exactly one copy at module load and registers it as
 * its own endpoint; assertions keep working unchanged because everything
 * routes through the returned directory path.
 */
export function createQmdFixtureCopy(label: string): string {
  const source = join(import.meta.dir, "..", "fixtures", "qmd-provider");
  const copy = mkdtempSync(join(tmpdir(), `ukp-${label}-`));
  cpSync(source, copy, { recursive: true });
  return copy;
}
