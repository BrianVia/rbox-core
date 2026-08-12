import { describe, expect, test } from "bun:test";
import { clockSkewBound, normalizeLogClock, parseArgs, parseHostSpec, renderAttemptSummary, renderMeasurement, WITNESS_POLL_DEADLINE_SECONDS } from "./propagate.js";
import type { HopReport } from "../propagation-report.js";

describe("fleet propagation bench", () => {
  test("parses one sender and multiple remote receivers", () => {
    expect(parseArgs(["--attempts", "30", "--ref-only", "LOCAL:/work/a", "mac:/work/b", "via@host:/work/c"])).toEqual({
      sender: { host: "LOCAL", workspace: "/work/a", local: true },
      receivers: [
        { host: "mac", workspace: "/work/b", local: false },
        { host: "via@host", workspace: "/work/c", local: false },
      ],
      refOnly: true,
      attempts: 30,
    });
    expect(parseArgs(["host:/a", "peer:/b"]).attempts).toBe(1);
    expect(() => parseArgs(["--attempts", "0", "host:/a", "peer:/b"])).toThrow("usage:");
  });

  test("rejects LOCAL receivers and unsafe hosts", () => {
    expect(() => parseArgs(["host:/a", "LOCAL:/b"])).toThrow("sender");
    expect(() => parseHostSpec("bad host:/a", true)).toThrow("usage:");
    expect(() => parseHostSpec("host:relative", true)).toThrow("usage:");
    expect(() => parseHostSpec("-oProxyCommand=nope:/a", true)).toThrow("usage:");
  });

  test("combines host-pair uncertainty and invalidates excessive drift", () => {
    const stable = clockSkewBound(
      { offset: 10, width: 4 }, { offset: 11, width: 3 },
      { offset: 20, width: 5 }, { offset: 22, width: 6 },
    );
    expect(stable).toEqual({ boundMs: 10, driftMs: 1 });
    expect(clockSkewBound(
      { offset: 0, width: 1 }, { offset: 0, width: 1 },
      { offset: 0, width: 1 }, { offset: 101, width: 1 },
    ).boundMs).toBe(251);
  });

  test("maps remote daemon stamps into the sender clock domain", () => {
    const log = "2026-08-11T12:00:00.000Z propagation_receive {}\nheader";
    expect(normalizeLogClock(log, -250)).toBe("2026-08-11T11:59:59.750Z propagation_receive {}\nheader");
  });

  test("keeps one attempt non-authoritative and gates only 30 exact samples", () => {
    const report = (verdict: HopReport["verdict"], correlation: HopReport["correlation"] = "exact"): HopReport => ({
      attempt: "a",
      classification: "file",
      sequence: 1,
      correlation,
      clockSkewBoundMs: 5,
      witnessMatched: true,
      budgetMs: 10_000,
      verdict,
      stamps: { write: 0, applyComplete: verdict === "FAIL" ? 10_001 : 9_000 },
    });
    const one = renderMeasurement(report("PASS"));
    expect(one).toContain("MEASUREMENT (n=1, non-authoritative) outcome=WITHIN-BUDGET");
    expect(one).not.toContain("budget <=10000ms PASS");
    expect(renderMeasurement(report("FAIL"))).toContain("outcome=OVER-BUDGET");
    expect(renderMeasurement(report("INVALID", "unmatched"))).toContain("outcome=INVALID");

    expect(renderAttemptSummary("peer", [report("PASS")]).text).toContain("MEASUREMENT (n=1, non-authoritative)");
    expect(renderAttemptSummary("peer", Array.from({ length: 30 }, () => report("PASS"))).text).toContain("PASS (n=30, authoritative)");
    expect(renderAttemptSummary("peer", Array.from({ length: 30 }, (_, index) => report(index === 0 ? "FAIL" : "PASS"))).text)
      .toContain("OVER-BUDGET (n=30, authoritative)");
    expect(WITNESS_POLL_DEADLINE_SECONDS).toBeGreaterThanOrEqual(180);
  });
});
