import { describe, expect, test } from "bun:test";
import { isAbsoluteShapedPath, isInsideRealRoot, splitEndpointRelativeSegments } from "../src/path-safety.ts";

// ADR 0023 / D-073, spec product/specs/path-safety-primitives.md §4 T1-T3.
// Primitives are error-class-neutral: verdicts only, no throwing, no I/O.

describe("isAbsoluteShapedPath (T1)", () => {
  test("rejects absolute shapes on either platform view", () => {
    expect(isAbsoluteShapedPath("C:\\docs\\a.md")).toBe(true);
    expect(isAbsoluteShapedPath("C:/docs/a.md")).toBe(true);
    // Drive-relative (no separator) is not absolute, but is rejected as an
    // endpoint-relative reference shape (read precedent).
    expect(isAbsoluteShapedPath("C:foo")).toBe(true);
    expect(isAbsoluteShapedPath("\\\\server\\share\\a.md")).toBe(true);
    expect(isAbsoluteShapedPath("//server/share/a.md")).toBe(true);
    expect(isAbsoluteShapedPath("/docs/a.md")).toBe(true);
  });

  test("accepts plain endpoint-relative references", () => {
    expect(isAbsoluteShapedPath("docs/a.md")).toBe(false);
    expect(isAbsoluteShapedPath("a\\b\\c.md")).toBe(false);
    expect(isAbsoluteShapedPath("README.md")).toBe(false);
  });
});

describe("splitEndpointRelativeSegments (T2)", () => {
  test("rejects absolute shapes with reason", () => {
    expect(splitEndpointRelativeSegments("/a.md")).toEqual({ ok: false, reason: "absolute" });
    expect(splitEndpointRelativeSegments("C:\\a.md")).toEqual({ ok: false, reason: "absolute" });
  });

  test("rejects empty, dot, and dotdot segments with reason", () => {
    expect(splitEndpointRelativeSegments("a//b")).toEqual({ ok: false, reason: "empty-segment" });
    expect(splitEndpointRelativeSegments("./a")).toEqual({ ok: false, reason: "dot-segment" });
    expect(splitEndpointRelativeSegments("a/../b")).toEqual({ ok: false, reason: "dot-segment" });
  });

  test("passes clean references and splits both separators", () => {
    expect(splitEndpointRelativeSegments("a/b.md")).toEqual({ ok: true, segments: ["a", "b.md"] });
    expect(splitEndpointRelativeSegments("a\\b.md")).toEqual({ ok: true, segments: ["a", "b.md"] });
    expect(splitEndpointRelativeSegments("README.md")).toEqual({ ok: true, segments: ["README.md"] });
  });
});

describe("isInsideRealRoot (T3)", () => {
  test("accepts a strictly-inside target", () => {
    expect(isInsideRealRoot("C:\\svc", "C:\\svc\\docs\\a.md")).toBe(true);
    expect(isInsideRealRoot("/svc", "/svc/docs/a.md")).toBe(true);
  });

  test("rejects escape and sibling-dotdot lookalikes (prefix guard, read stance)", () => {
    expect(isInsideRealRoot("C:\\svc", "C:\\other\\a.md")).toBe(false);
    // `..literal` is a sibling name, not an escape — but read's historical
    // guard is the plain `rel.startsWith("..")` prefix, so it is conservatively
    // rejected too. The primitive keeps that exact stance (zero behavior
    // change acceptance line); boundary refinement would be a separate,
    // deliberate change.
    expect(isInsideRealRoot("C:\\svc", "C:\\..literal\\a.md")).toBe(false);
  });

  test("root itself is governed by allowRoot", () => {
    expect(isInsideRealRoot("C:\\svc", "C:\\svc")).toBe(false);
    expect(isInsideRealRoot("C:\\svc", "C:\\svc", { allowRoot: true })).toBe(true);
  });

  test("rejects cross-drive relative() results (absolute rel)", () => {
    // Different drives: relative() returns the absolute target.
    expect(isInsideRealRoot("C:\\svc", "D:\\x\\a.md")).toBe(false);
  });
});
