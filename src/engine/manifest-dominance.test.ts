import { describe, expect, test } from "bun:test";
import type { FileEntry } from "./types.js";
import { dominatingDir, dominatingDirHint, dominatingNewDir, isDominant, DOMINANT_NEW_ENTRIES } from "./manifest-dominance.js";

const entry = (path: string): FileEntry => ({ path, sha256: "a".repeat(64), size: 1, mode: 0o644, mtimeMs: 0, type: "file" });
const under = (dir: string, count: number): FileEntry[] =>
  Array.from({ length: count }, (_, index) => entry(`${dir}/f${index}.txt`));

describe("dominatingDir", () => {
  test("buckets two segments deep so the blame lands on the build dir, not the checkout", () => {
    const files = [...under("chromium/src", 30), ...under("chromium/docs", 5)];
    expect(dominatingDir(files)).toEqual({ dir: "chromium/src", count: 30 });
  });

  test("a one-segment path is its own bucket", () => {
    expect(dominatingDir(under("target", 4))).toEqual({ dir: "target", count: 4 });
  });

  test("root-level files belong to no directory", () => {
    expect(dominatingDir([entry("README.md"), entry("LICENSE")])).toBeUndefined();
  });

  test("ties break on name so the message is stable across runs", () => {
    const files = [...under("zzz/x", 3), ...under("aaa/x", 3)];
    expect(dominatingDir(files)?.dir).toBe("aaa/x");
  });
});

describe("isDominant", () => {
  test("100k new entries alone is enough, whatever the manifest total", () => {
    const dir = { dir: "build", count: DOMINANT_NEW_ENTRIES };
    expect(isDominant(dir, 10_000_000)).toBe(true);
  });

  test("just under the absolute floor, with a small share, is not dominant", () => {
    const dir = { dir: "build", count: DOMINANT_NEW_ENTRIES - 1 };
    expect(isDominant(dir, 10_000_000)).toBe(false);
  });

  test("owning more than half the manifest is enough on its own", () => {
    expect(isDominant({ dir: "build", count: 51 }, 100)).toBe(true);
    expect(isDominant({ dir: "build", count: 50 }, 100)).toBe(false);
  });

  test("a balanced manifest volunteers no hint", () => {
    const files = [...under("src", 30), ...under("docs", 30), ...under("tests", 30)];
    const top = dominatingDir(files)!;
    expect(isDominant(top, files.length)).toBe(false);
  });
});

/** #810 proactive half: the acceptance cases the hint has to get right. */
describe("dominatingNewDir", () => {
  test("a build tree that lands in one scan is named", () => {
    const added = under("build", 120_000);
    expect(dominatingNewDir(added, 150_000, true)).toEqual({ dir: "build", count: 120_000 });
  });

  test("a balanced add across many directories volunteers nothing", () => {
    const added = Array.from({ length: 40 }, (_, index) => under(`pkg${index}`, 125)).flat();
    expect(dominatingNewDir(added, 35_000, true)).toBeUndefined();
  });

  test("a first scan with no prior base accuses nobody — everything is new then", () => {
    expect(dominatingNewDir(under("build", 120_000), 120_000, false)).toBeUndefined();
  });

  test("nothing added means nothing to say, so a later scan clears the hint", () => {
    expect(dominatingNewDir([], 150_000, true)).toBeUndefined();
  });
});

/** The same sentence is used for a tree that landed in this scan AND for one
 *  carried from base, so it must not claim the files just arrived. */
test("the hint names the directory, the count, and that files stay on disk", () => {
  expect(dominatingDirHint({ dir: "chromium/src", count: 180_000 })).toBe(
    "chromium/src accounts for 180,000 files — looks like build output; `rbox ignore chromium/src/` skips it (files stay on disk)"
  );
});
