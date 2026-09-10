import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildQmdInvocation, defaultQmdCommand, providerTimeoutMs } from "./qmd.ts";
import { endpointRelativePathOf, providerLocationOf } from "./search.ts";

// ADR 0020 / D-066: read-time layered rename recovery. This module owns the
// miss-path descent (L1 git-derived -> L2 search re-anchor -> exhausted) and
// the ukp-pin three-valued verification. It never resolves a read by itself —
// the caller (read capability) still owns the final file read and the miss
// wording; this module only proposes a recovered route (plus verification
// metadata) or reports exhaustion with whatever candidates L2 collected.
//
// Guaranteed contract (spec: read-rename-recovery): exact path / L1 git
// derivation / classified failure. L2 is opportunistic — its absence (no
// search capability, provider spawn failure, zero recall) is silent and never
// an error. `ukp move` is retired (Q4): no dedicated moves-log surface exists.

export interface RecoveryRequest {
  /** Endpoint-relative route that missed (the slot the caller addressed). */
  route: string;
  endpointName: string;
  /** Service folder (git repo root candidate, qmd cwd). */
  serviceFolder: string;
  /** Consumer-pinned content hash (`sha256-<64 hex>`), from --pin or the
   * --from source document's ukp-pin annotation. Absent = stale-unknown. */
  pin?: string;
  /** QMD command when the endpoint declares a qmd search capability. */
  qmdCommand?: readonly string[];
}

export interface RecoveryCandidate {
  path: string;
  verified: "match" | "mismatch" | "unverified";
}

export interface RecoveryOutcome {
  status: "recovered" | "exhausted";
  /** Endpoint-relative route to read instead (status "recovered" only). */
  recoveredRoute?: string;
  layer?: "git-history" | "search-reanchor";
  verification: "match" | "mismatch" | "stale-unknown" | "unverified";
  /** Human/stderr lines beyond the echo (stale warnings). */
  warnings: string[];
  /** L2-collected candidates for the exhaustion message (advisory). */
  candidates: RecoveryCandidate[];
  /** Layer names attempted, for the JSON envelope. */
  attempted: string[];
}

/** sha256 over the LF-normalized UTF-8 content (Q7: pin contract normalizes
 * CRLF -> LF so a pin computed on any platform verifies on any other; the
 * autocrlf drift trap was demonstrated by the w2 seed dogfood). */
export function pinHashOf(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function readPinVerified(route: string, request: RecoveryRequest): "match" | "mismatch" | "unverified" {
  if (request.pin === undefined) return "unverified";
  let content: string;
  try {
    content = readFileSync(join(request.serviceFolder, ...route.split("/")), "utf8");
  } catch {
    return "unverified";
  }
  return pinHashOf(content) === request.pin.slice("sha256-".length) ? "match" : "mismatch";
}

/** L1: derive old->new from git rename records. Repo-wide recent renames are
 * listed (no path filter — a path filter breaks on renamed-away old paths),
 * then matched against the missed route. Bounded to recent history: recovery
 * targets living documents, not archaeology. Any git failure (missing git,
 * not a repo, corrupted) means the layer is absent — silent, per spec. */
function spawnGit(serviceFolder: string, args: readonly string[]): ReturnType<typeof spawnSync> {
  // Read-only git queries; one retry absorbs transient spawn failures
  // (sandboxed environments intermittently deny piped stdio). A persistent
  // failure still means silent layer absence, per the L1 contract.
  let result = spawnSync("git", args, {
    cwd: serviceFolder,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0 || result.error) {
    result = spawnSync("git", args, {
      cwd: serviceFolder,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
  }
  return result;
}

function deriveFromGit(request: RecoveryRequest): {
  newRoute?: string;
  editedAfterMove?: boolean;
} {
  // Cheap presence guard before any spawn: a folder without `.git` (dir or
  // worktree file) is L1-absent with zero process cost — a miss must never
  // pay a git round-trip on non-git endpoints.
  if (!existsSync(join(request.serviceFolder, ".git"))) return {};
  const result = spawnGit(request.serviceFolder, ["log", "-M", "--name-status", "--diff-filter=R", "--format=%H", "-n", "500"]);
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return {};
  const lines = result.stdout.split(/\r?\n/);
  let commit = "";
  // Known limitation (review 2026-09-10, accepted): chained renames (A→B→C)
  // recover A only to B (the newest record naming A as old), git-quoted paths
  // and merge-commit renames are silently missed — all covered by the L1
  // silent-absence contract; a follow-up read of B misses again and would
  // recover B→C on the next call, but the single-call chain is not folded.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[0-9a-f]{40}$/.test(line)) {
      commit = line;
      continue;
    }
    // R100\told\tnew  (tab-separated, per git name-status)
    const rename = /^R\d+\t(.+)\t(.+)$/.exec(line);
    if (rename && rename[1].replace(/\\/g, "/") === request.route) {
      const newRoute = rename[2].replace(/\\/g, "/");
      // Edited after the move? A later commit touching the new route means the
      // pinned hash (if any) is expected to drift — stale, not a mismatch.
      const later = spawnGit(request.serviceFolder, ["log", "--oneline", `${commit}..HEAD`, "--", newRoute]);
      const editedAfterMove = !later.error
        && later.status === 0
        && typeof later.stdout === "string"
        && later.stdout.trim().length > 0;
      return { newRoute, editedAfterMove };
    }
  }
  return {};
}

/** L2: opportunistic re-anchor through the QMD index. Recall by the missed
 * route's basename, filter to endpoint-local files with an equal basename.
 * Provider stdout is a JSON array of result objects (same shape search
 * consumes); failure of any kind (spawn, unparseable output) is silent layer
 * absence. */
function reanchorViaSearch(request: RecoveryRequest): string[] {
  if (!request.qmdCommand) return [];
  const basename = request.route.split("/").pop() ?? request.route;
  // --format json matches the search capability's provider contract: the
  // recall layer consumes the same JSON array shape search renders from.
  const invocation = buildQmdInvocation(request.qmdCommand, ["search", basename, "--format", "json"]);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: request.serviceFolder,
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: invocation.verbatim,
    maxBuffer: 16 * 1024 * 1024,
    timeout: providerTimeoutMs(),
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return [];
  let nativeResults: unknown;
  try {
    nativeResults = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(nativeResults)) return [];
  const routes = new Set<string>();
  for (const item of nativeResults) {
    const location = providerLocationOf(item);
    if (!location) continue;
    const route = endpointRelativePathOf(location, request.serviceFolder);
    if (route && route.split("/").pop() === basename && route !== request.route) {
      routes.add(route);
    }
  }
  return [...routes].sort();
}

/** Run the miss-path descent for a slot miss. Pure orchestration: file reads
 * happen only for pin verification of an already-proposed candidate. */
export function recoverRenamedResource(request: RecoveryRequest): RecoveryOutcome {
  const attempted: string[] = [];
  const warnings: string[] = [];
  const candidates: RecoveryCandidate[] = [];

  // L1 — git-derived (primary, guaranteed-stack member).
  const git = deriveFromGit(request);
  if (git.newRoute !== undefined) {
    attempted.push("git-derived");
    const verified = readPinVerified(git.newRoute, request);
    if (verified === "match" || request.pin === undefined) {
      if (request.pin === undefined) {
        warnings.push("recovered without verification (no ukp-pin for this reference)");
      } else if (git.editedAfterMove) {
        warnings.push("content changed after the move (pin stale); trusting the git rename mapping");
      }
      return {
        status: "recovered",
        recoveredRoute: git.newRoute,
        layer: "git-history",
        verification: request.pin === undefined ? "stale-unknown" : "match",
        warnings,
        candidates,
        attempted,
      };
    }
    if (git.editedAfterMove) {
      // Three-valued check, third value: pin drifted because the target was
      // edited after the rename — the mapping itself is authoritative.
      warnings.push("content changed after the move (pin stale); trusting the git rename mapping");
      return {
        status: "recovered",
        recoveredRoute: git.newRoute,
        layer: "git-history",
        verification: "stale-unknown",
        warnings,
        candidates,
        attempted,
      };
    }
    // Clean mismatch: the git-mapped candidate is NOT the pinned content —
    // block it (path recycling guard) and keep descending.
    candidates.push({ path: git.newRoute, verified: "mismatch" });
  }

  // L2 — search re-anchor (opportunistic; absence is silent).
  const recalled = reanchorViaSearch(request);
  if (recalled.length > 0) {
    attempted.push("search-reanchor");
    const verifiedOnes = recalled.map((route) => ({ route, verified: readPinVerified(route, request) }));
    for (const { route, verified } of verifiedOnes) {
      if (verified === "match") {
        return {
          status: "recovered",
          recoveredRoute: route,
          layer: "search-reanchor",
          verification: "match",
          warnings: [...warnings, "recovered via search re-anchor (advisory); update the embedded reference"],
          candidates,
          attempted,
        };
      }
    }
    // No pin-verified unique hit: multiple or unverified candidates never
    // auto-recover (spec: recall is advisory).
    for (const { route, verified } of verifiedOnes) {
      candidates.push({
        path: route,
        verified: verified === "mismatch" ? "mismatch" : "unverified",
      });
    }
  }

  return { status: "exhausted", verification: "unverified", warnings, candidates, attempted };
}

/** `--pin` flag validation (spec: only `sha256-<64 lowercase hex>` is legal —
 * SRI-narrowed, no multi-algorithm negotiation). */
export function isValidPin(value: string): boolean {
  return /^sha256-[0-9a-f]{64}$/.test(value);
}

/** Extract a same-line ukp-pin from a --from source document: the line that
 * carries the original reference also carrying `ukp-pin: sha256-…` (Q1
 * spelling). Absent line or absent pin → undefined (stale-unknown path). */
export function pinFromSourceDocument(
  sourceRoute: string,
  originalReference: string,
  serviceFolder: string,
): string | undefined {
  let content: string;
  try {
    content = readFileSync(join(serviceFolder, ...sourceRoute.split("/")), "utf8");
  } catch {
    return undefined;
  }
  for (const line of content.split(/\r?\n/)) {
    if (!line.includes(originalReference)) continue;
    const pin = /ukp-pin:\s*(sha256-[0-9a-f]{64})/.exec(line);
    if (pin) return pin[1];
  }
  return undefined;
}

/** Default qmd command accessor re-exported for callers wiring RecoveryRequest
 * from a manifest-derived search provider. */
export { defaultQmdCommand };
