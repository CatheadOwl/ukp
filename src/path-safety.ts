import { isAbsolute, relative, win32 } from "node:path";

// Path-safety primitives (ADR 0023 / D-073, promoted spec
// `path-safety-primitives`): three pure, error-class-neutral checks shared
// by the file-facing capabilities. The module owns the *verdicts* only —
// failure semantics (usage error vs silent drop), root semantics
// (`allowRoot`), realpath fallbacks and existence checks are per-capability
// policy and stay at the call sites. Primitives never throw and never do
// I/O: containment receives already-realpathed paths; lexical checks are
// the advisory tier, realpath containment is the authority.

/** True for every input shape the file-facing capabilities reject as an
 * endpoint-relative reference: absolute on either platform's view, a drive
 * prefix (including drive-relative `C:foo`), or a UNC/`//` root. */
export function isAbsoluteShapedPath(reference: string): boolean {
  return (
    isAbsolute(reference)
    || win32.isAbsolute(reference)
    || /^[A-Za-z]:/.test(reference)
    || reference.startsWith("//")
    || reference.startsWith("\\\\")
  );
}

export type EndpointRelativeSegments =
  | { ok: true; segments: string[] }
  | { ok: false; reason: "absolute" | "empty-segment" | "dot-segment" };

/** Segment-level validation of an endpoint-relative reference: rejects
 * absolute shapes, empty segments (`a//b`), and `.`/`..` segments. Accepts
 * both `/` and `\` separators; callers own separator normalization. The
 * reason field lets each capability map its own error wording. */
export function splitEndpointRelativeSegments(reference: string): EndpointRelativeSegments {
  if (isAbsoluteShapedPath(reference)) {
    return { ok: false, reason: "absolute" };
  }
  const segments = reference.split(/[\\/]/);
  if (segments.some((segment) => segment.length === 0)) {
    return { ok: false, reason: "empty-segment" };
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { ok: false, reason: "dot-segment" };
  }
  return { ok: true, segments };
}

/** Realpath containment authority (ADR 0023): true when `targetReal` stays
 * strictly inside `rootReal`, or is `rootReal` itself with `allowRoot`.
 * Inputs must already be realpathed — lexical checks, realpath calls and
 * stat checks are caller policy. Cross-drive/UNC↔drive `relative()` results
 * come back absolute and are rejected explicitly. */
export function isInsideRealRoot(
  rootReal: string,
  targetReal: string,
  options?: { allowRoot?: boolean },
): boolean {
  const rel = relative(rootReal, targetReal);
  if (isAbsolute(rel) || win32.isAbsolute(rel)) return false;
  // Plain `..` prefix guard — read's historical stance, kept verbatim for the
  // zero-behavior-change acceptance line. Conservative: a sibling named
  // `..literal` is rejected too; boundary refinement is a separate change.
  if (rel.startsWith("..")) return false;
  if (rel === "") return options?.allowRoot === true;
  return true;
}
