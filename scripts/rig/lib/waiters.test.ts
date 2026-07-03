import { expect, test } from "bun:test";
import { divergenceDetail, pollUntil, type PollClock } from "./waiters.js";
import type { Divergence } from "./convergence.js";

/** Virtual clock: `sleep` advances a counter `now` reads back — no wall time. */
function fakeClock(): PollClock {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

test("pollUntil returns on the first probe that satisfies done", async () => {
  const seq = ["a", "b", "DONE", "after"];
  let i = 0;
  const out = await pollUntil({ probe: async () => seq[i++]!, done: (v) => v === "DONE", timeoutMs: 60_000, intervalMs: 1000 }, fakeClock());
  expect(out.ok).toBe(true);
  expect(out.value).toBe("DONE");
  expect(out.attempts).toBe(3);
});

test("pollUntil always probes at least once, even at timeout 0", async () => {
  let calls = 0;
  const hit = await pollUntil({ probe: async () => { calls++; return "x"; }, done: () => true, timeoutMs: 0, intervalMs: 1000 }, fakeClock());
  expect(hit.ok).toBe(true);
  expect(calls).toBe(1);

  calls = 0;
  const miss = await pollUntil({ probe: async () => { calls++; return "x"; }, done: () => false, timeoutMs: 0, intervalMs: 1000 }, fakeClock());
  expect(miss.ok).toBe(false);
  expect(calls).toBe(1);
});

test("pollUntil returns the LAST probed value with ok:false on timeout", async () => {
  let n = 0;
  const out = await pollUntil({ probe: async () => `v${n++}`, done: () => false, timeoutMs: 5000, intervalMs: 1000 }, fakeClock());
  expect(out.ok).toBe(false);
  // Probes at elapsed 0,1000,2000,3000,4000,5000 → 6 attempts; 5000 ≥ timeout stops it.
  expect(out.attempts).toBe(6);
  expect(out.elapsedMs).toBe(5000);
  expect(out.value).toBe("v5");
});

test("pollUntil never sleeps past the deadline (no extra probe after the boundary)", async () => {
  // timeout not a multiple of interval: 2500ms / 700ms → probes at 0,700,1400,2100,2800(≥2500 stop).
  let n = 0;
  const out = await pollUntil({ probe: async () => n++, done: () => false, timeoutMs: 2500, intervalMs: 700 }, fakeClock());
  expect(out.attempts).toBe(5);
  expect(out.elapsedMs).toBe(2800);
});

test("divergenceDetail summarizes an identical vs a divergent tree", () => {
  const identical: Divergence = { identical: true, onlyInA: [], onlyInB: [], differing: [] };
  expect(divergenceDetail(identical)).toBe("identical");
  const diverged: Divergence = { identical: false, onlyInA: ["./a"], onlyInB: ["./b", "./c"], differing: ["./d"] };
  const s = divergenceDetail(diverged);
  expect(s).toContain("onlyA=1");
  expect(s).toContain("onlyB=2");
  expect(s).toContain("diff=1");
  expect(s).toContain("A:./a");
});
