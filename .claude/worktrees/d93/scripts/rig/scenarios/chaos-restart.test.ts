import { expect, test } from "bun:test";
import { hasGuardRefusal, pushUnderway } from "./chaos-restart.js";

test("pushUnderway: true once an upload tick has landed (done >= 1)", () => {
  // The first upload tick renders `uploading 0% (1/400)` — percent is 0 but a blob is
  // in flight, so this MUST count as underway (keying off percent would miss it).
  const log = ["pushing…", "  encrypting 100% (400/400)", "  uploading 0% (1/400)"].join("\n");
  expect(pushUnderway(log)).toBe(true);
});

test("pushUnderway: true mid-upload with a comma-grouped count", () => {
  expect(pushUnderway("  uploading 42% (3,612/8,603)")).toBe(true);
});

test("pushUnderway: false before upload — only the launch line + encrypt phase", () => {
  const log = ["pushing…", "  encrypting 12% (48/400)", "  encrypting 88% (352/400)"].join("\n");
  expect(pushUnderway(log)).toBe(false);
});

test("pushUnderway: false on an empty / not-yet-started log", () => {
  expect(pushUnderway("")).toBe(false);
  expect(pushUnderway("pushing…")).toBe(false);
});

test("pushUnderway: a `(0/N)` upload line does NOT count (no blob in flight yet)", () => {
  expect(pushUnderway("  uploading 0% (0/400)")).toBe(false);
});

test("hasGuardRefusal: matches mass-delete / mass-reconcile guard text, not clean output", () => {
  expect(hasGuardRefusal("mass-delete guard: refusing to apply 120 deletions")).toBe(true);
  expect(hasGuardRefusal("re-run with --allow-mass-delete to proceed")).toBe(true);
  expect(hasGuardRefusal("pass --allow-mass-reconcile")).toBe(true);
  expect(hasGuardRefusal("pushed /work/ws → sequence 3")).toBe(false);
});
