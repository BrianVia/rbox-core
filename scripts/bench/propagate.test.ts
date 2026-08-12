import { describe, expect, test } from "bun:test";
import { clockSkewBound, normalizeLogClock, parseArgs, parseHostSpec } from "./propagate.js";

describe("fleet propagation bench", () => {
  test("parses one sender and multiple remote receivers", () => {
    expect(parseArgs(["--ref-only", "LOCAL:/work/a", "mac:/work/b", "via@host:/work/c"])).toEqual({
      sender: { host: "LOCAL", workspace: "/work/a", local: true },
      receivers: [
        { host: "mac", workspace: "/work/b", local: false },
        { host: "via@host", workspace: "/work/c", local: false },
      ],
      refOnly: true,
    });
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
});
