import { describe, expect, test } from "bun:test";
import { classifyHealthProbe, normalizeGuestHex, renderGitShapeFindings, settleSequenceFixedPoint, type SettlementRound } from "./git-shapes.js";

describe("git-shapes pure scenario helpers", () => {
  test("normalizes guest-emitted hex and rejects decoded text", () => {
    expect(normalizeGuestHex("63 61 66 c3 a9 0a")).toBe("636166c3a90a");
    expect(() => normalizeGuestHex("café")).toThrow("invalid guest hex");
  });

  test("health probe detects current halt and future recovering shapes", () => {
    expect(classifyHealthProbe("A", JSON.stringify({ health: "ok" }), JSON.stringify({ at: "now" })).unhealthy).toBe(false);
    expect(classifyHealthProbe("A", JSON.stringify({ health: "halt" }), JSON.stringify({ halt: { reason: "boom" } })).reasons).toEqual(["status halted", "activity halt"]);
    expect(classifyHealthProbe("B", JSON.stringify({ health: { state: "recovering" } })).reasons).toEqual(["status recovering"]);
    expect(classifyHealthProbe("B", "{}", undefined, "halt evidence").reasons).toEqual(["health-halt side-file present"]);
    expect(classifyHealthProbe("A", "not json", undefined, undefined, 1).reasons).toEqual(["status probe failed"]);
  });

  test("renders the required findings without suppression semantics", () => {
    const markdown = renderGitShapeFindings([
      { slug: "engine-gap: bisect-invisible", cell: "s5-bisect", summary: "metadata persisted", evidence: ["no deferral"] },
      { slug: "engine-gap: rebase-post-abort-epipe", cell: "s5-rebase", summary: "follow deferred", evidence: ["EPIPE"] },
    ]);
    expect(markdown).toContain("# Git-shapes findings");
    expect(markdown).toContain("## engine-gap: bisect-invisible");
    expect(markdown).toContain("## engine-gap: rebase-post-abort-epipe");
    expect(markdown).toContain("do not suppress assertions");
  });

  test("settles a later B publish before pinning a stable full cycle", async () => {
    const samples: SettlementRound[] = [
      { exitA: 0, exitB: 0, sequenceA: 5, sequenceB: 6 },
      { exitA: 0, exitB: 0, sequenceA: 6, sequenceB: 6 },
      { exitA: 0, exitB: 0, sequenceA: 6, sequenceB: 6 },
    ];
    const result = await settleSequenceFixedPoint(async () => samples.shift()!);
    expect(result).toMatchObject({ accepted: 6, exitsZero: true, converged: true, stable: true });
    expect(result.rounds).toHaveLength(3);
  });

  test("settlement fails closed on a nonzero sync", async () => {
    const result = await settleSequenceFixedPoint(async () => ({ exitA: 0, exitB: 1, sequenceA: 5, sequenceB: 5 }));
    expect(result).toMatchObject({ exitsZero: false, converged: false, stable: false });
  });
});
