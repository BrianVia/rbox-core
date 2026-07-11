import { describe, expect, it } from "vitest";
import { classifyShadow, compare32, DIVERGENCE_SAMPLE, divergenceDigest, mergeAddedShas, mergeSortedUnique } from "../src/commit-delta.js";
import { loadSidecarRaw } from "../src/sidecar.js";
import { sha256Hex } from "../src/util.js";
import { REFSET_HEADER, REFSET_REC, serializeRefset } from "../../../src/engine/refset.js";

const sha = (n: number) => n.toString(16).padStart(64, "0");
const buf = (...ns: number[]) => serializeRefset(ns.map((n) => ({ encSha: sha(n), size: n + 1 })));

describe("commit delta pure logic", () => {
  it("compare32 orders equal and unequal slices", () => {
    const a = new Uint8Array(64);
    const b = new Uint8Array(64);
    a[31] = 1;
    b[31] = 2;
    expect(compare32(a, 0, b, 0)).toBeLessThan(0);
    expect(compare32(b, 0, a, 0)).toBeGreaterThan(0);
    expect(compare32(a, 0, a, 0)).toBe(0);
  });

  it.each([
    [[], [1, 2], [sha(1), sha(2)], 0, 0],
    [[1, 2], [1, 2], [], 2, 0],
    [[1], [1, 2, 3], [sha(2), sha(3)], 1, 0],
    [[1, 2, 3], [1], [], 1, 2],
    [[1, 3, 5], [2, 3, 4], [sha(2), sha(4)], 1, 2],
  ])("merges parent %j and child %j", (parent, child, added, carried, removed) => {
    const got = mergeAddedShas(buf(...parent), buf(...child), new Set(), new Set());
    expect(got.added).toEqual(added);
    expect(got.carriedCount).toBe(carried);
    expect(got.removedCount).toBe(removed);
  });

  it("detects marked and active-intent carried refs", () => {
    const got = mergeAddedShas(buf(1, 2), buf(1, 2), new Set([sha(1)]), new Set([sha(2)]));
    expect(got.markedCarried).toEqual([sha(1)]);
    expect(got.intentCarriedHit).toBe(true);
  });

  it("merges disjoint ascending SHA lists", () => {
    expect(mergeSortedUnique([sha(1), sha(3)], [sha(2), sha(4)])).toEqual([sha(1), sha(2), sha(3), sha(4)]);
  });

  it("deduplicates overlapping ascending SHA lists", () => {
    expect(mergeSortedUnique([sha(1), sha(2)], [sha(2), sha(3)])).toEqual([sha(1), sha(2), sha(3)]);
  });

  it("fails closed on a duplicate/unsorted child", async () => {
    const child = buf(1, 2);
    child.copyWithin(REFSET_HEADER + REFSET_REC, REFSET_HEADER, REFSET_HEADER + 32);
    expect(() => mergeAddedShas(buf(), child, new Set(), new Set())).toThrow("delta: child not strictly ascending");
    const digest = await sha256Hex(child);
    const fakeEnv = {
      rbox_dev_blobs: { get: async () => ({ size: child.length, arrayBuffer: async () => child.buffer.slice(child.byteOffset, child.byteOffset + child.byteLength) }) },
    } as unknown as Parameters<typeof loadSidecarRaw>[0];
    const loaded = await loadSidecarRaw(fakeEnv, digest, 2);
    expect(loaded).toEqual({ ok: false, reason: "refset: not strictly ascending / duplicate sha" });
    const hidden = buf(1, 2);
    hidden.copyWithin(REFSET_HEADER + REFSET_REC, REFSET_HEADER, REFSET_HEADER + 32);
    expect(() => mergeAddedShas(buf(1), hidden, new Set(), new Set())).toThrow("delta: child not strictly ascending");
  });

  const flags = (entries: Array<[number, Partial<{ present: boolean; entitled: boolean; marked: boolean; activeIntent: boolean }>]>) =>
    new Map(entries.map(([n, f]) => [sha(n), { present: false, entitled: false, marked: false, activeIntent: false, ...f }]));
  const classify = (f: ReturnType<typeof flags>, opts: { added?: number[]; marked?: number[]; receipts?: number[] } = {}) => classifyShadow({
    childShas: [sha(1), sha(2)], carriers: [], addedSet: new Set((opts.added ?? [2]).map(sha)),
    markedCarriedSet: new Set((opts.marked ?? []).map(sha)), flags: f,
    receiptKeys: new Set((opts.receipts ?? [2]).map(sha)),
  });

  it("classifies clean and benign carried refs", () => {
    expect(classify(flags([[1, { present: true, entitled: true }], [2, {}]]))).toEqual({ harmful: [], benign: [], divergent: false });
    expect(classify(flags([[1, { present: true, entitled: true, marked: true }], [2, {}]]), { marked: [1] })).toEqual({ harmful: [], benign: [sha(1)], divergent: false });
  });

  it.each([
    [{ entitled: true }, "not present"],
    [{ present: true }, "not entitled"],
    [{ present: true, entitled: true, activeIntent: true }, "active intent"],
  ])("classifies harmful carried ref: %s", (bad) => {
    const got = classify(flags([[1, bad], [2, {}]]));
    expect(got.harmful).toEqual([sha(1)]);
    expect(got.divergent).toBe(true);
  });

  it("detects newRefs identity mismatch", () => {
    const got = classify(flags([[1, { present: true, entitled: true }], [2, {}]]), { added: [], receipts: [2] });
    expect(got.divergent).toBe(true);
  });

  it("bounds and stabilizes divergence telemetry", () => {
    const xs = Array.from({ length: DIVERGENCE_SAMPLE + 10 }, (_, i) => sha(DIVERGENCE_SAMPLE + 10 - i));
    const a = divergenceDigest(xs);
    const b = divergenceDigest([...xs].reverse());
    expect(a.digest).toBe(b.digest);
    expect(a.sample).toHaveLength(DIVERGENCE_SAMPLE);
    expect(a.sample).toEqual([...xs].sort().slice(0, DIVERGENCE_SAMPLE));
  });
});
