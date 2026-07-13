import { test, expect } from "bun:test";
import { diffRefLines, parseForEachRef, refDiffDetail } from "./git-refs.js";

test("parseForEachRef splits on first space, trims, drops blanks, sorts by refname", () => {
  const out = [
    "aaaa1111 refs/heads/main",
    "",
    "  bbbb2222 refs/heads/feature  ",
    "cccc3333 refs/tags/v1",
    "   ",
  ].join("\n");
  expect(parseForEachRef(out)).toEqual([
    { objectname: "bbbb2222", refname: "refs/heads/feature" },
    { objectname: "aaaa1111", refname: "refs/heads/main" },
    { objectname: "cccc3333", refname: "refs/tags/v1" },
  ]);
});

test("parseForEachRef skips malformed lines with no space", () => {
  expect(parseForEachRef("deadbeef\nfeed0000 refs/heads/main")).toEqual([
    { objectname: "feed0000", refname: "refs/heads/main" },
  ]);
});

test("diffRefLines: identical sets converge", () => {
  const a = parseForEachRef("a1 refs/heads/main\nt1 refs/tags/v1");
  const b = parseForEachRef("t1 refs/tags/v1\na1 refs/heads/main"); // emit order differs
  const d = diffRefLines(a, b);
  expect(d.identical).toBe(true);
  expect(d.onlyA).toEqual([]);
  expect(d.onlyB).toEqual([]);
  expect(d.differing).toEqual([]);
});

test("diffRefLines: a dropped tag surfaces as onlyA (the entanglement failure)", () => {
  const a = parseForEachRef("a1 refs/heads/main\nt1 refs/tags/v1");
  const b = parseForEachRef("a1 refs/heads/main");
  const d = diffRefLines(a, b);
  expect(d.identical).toBe(false);
  expect(d.onlyA).toEqual(["refs/tags/v1"]);
});

test("diffRefLines: a ref pointing at the wrong sha surfaces as differing", () => {
  const a = parseForEachRef("a1 refs/heads/main");
  const b = parseForEachRef("b2 refs/heads/main");
  const d = diffRefLines(a, b);
  expect(d.identical).toBe(false);
  expect(d.differing).toEqual(["refs/heads/main"]);
  expect(d.onlyA).toEqual([]);
  expect(d.onlyB).toEqual([]);
});

test("diffRefLines: extra ref on B surfaces as onlyB", () => {
  const a = parseForEachRef("a1 refs/heads/main");
  const b = parseForEachRef("a1 refs/heads/main\nx9 refs/heads/rogue");
  const d = diffRefLines(a, b);
  expect(d.onlyB).toEqual(["refs/heads/rogue"]);
});

test("refDiffDetail summarizes counts + samples both directions", () => {
  const d = { identical: false, onlyA: ["refs/tags/v1"], onlyB: ["refs/heads/rogue"], differing: ["refs/heads/main"] };
  const s = refDiffDetail(d);
  expect(s).toContain("onlyA=1");
  expect(s).toContain("onlyB=1");
  expect(s).toContain("diff=1");
  expect(s).toContain("A:refs/tags/v1");
  expect(s).toContain("≠:refs/heads/main");
});
