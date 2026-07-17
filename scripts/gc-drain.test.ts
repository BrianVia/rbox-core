import { describe, expect, test } from "bun:test";
import { runGcDrainMode, type GcDrainDependencies } from "./gc-drain.js";

function harness(responses: Response[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sleeps: number[] = [];
  let calls = 0;
  const dependencies: Partial<GcDrainDependencies> = {
    fetch: (async () => {
      const response = responses[calls++];
      if (!response) throw new Error("unexpected fetch");
      return response;
    }) as typeof fetch,
    sleep: async (ms) => { sleeps.push(ms); },
    stdout: (line) => { stdout.push(line); },
    stderr: (line) => { stderr.push(line); },
  };
  return { dependencies, stdout, stderr, sleeps, calls: () => calls };
}

const ok = (body: unknown, status = 200) => Response.json(body, { status });

describe("gc-drain", () => {
  test("execute accepts a legacy-compatible successful body", async () => {
    const h = harness([ok({ purged: 2, opened: 1 })]);
    await runGcDrainMode("execute", "https://api.test", "secret", h.dependencies);
    expect(h.calls()).toBe(1);
    expect(JSON.parse(h.stdout[0]!)).toEqual({ purged: 2, opened: 1 });
  });

  test("drain totals progress and stops on the first zero pass", async () => {
    const h = harness([ok({ purged: 2, opened: 1, bytes: 9 }), ok({ purged: 0, opened: 0 })]);
    await runGcDrainMode("drain", "https://api.test", "secret", h.dependencies);
    expect(h.sleeps).toEqual([60_000]);
    expect(JSON.parse(h.stdout[0]!)).toEqual({ passes: 2, opened: 1, purged: 2, bytes: 9 });
  });

  test("drain retries a busy lease and an HTTP 500", async () => {
    const h = harness([
      ok({ retryAfterMs: 12 }, 409),
      ok({ error: "gc_purge_failed" }, 500),
      ok({ purged: 0, opened: 0 }),
    ]);
    await runGcDrainMode("drain", "https://api.test", "secret", h.dependencies);
    expect(h.sleeps).toEqual([12, 90_000]);
    expect(h.calls()).toBe(3);
  });

  test("drain reports a non-JSON 409 as a drain failure", async () => {
    const h = harness([new Response("lease conflict", { status: 409 })]);
    await expect(runGcDrainMode("drain", "https://api.test", "secret", h.dependencies))
      .rejects.toThrow("drain failed (409): lease conflict");
    expect(h.sleeps).toEqual([]);
  });

  for (const [mode, terminal] of [
    ["execute", { ok: false, purged: 0, opened: 0 }],
    ["execute", { budgetExceeded: true, purged: 0, opened: 0 }],
    ["drain", { ok: false, purged: 0, opened: 0 }],
    ["drain", { budgetExceeded: true, purged: 0, opened: 0 }],
  ] as const) {
    test(`${mode} terminates immediately on ${"ok" in terminal ? "ok false" : "budgetExceeded"}`, async () => {
      const h = harness([ok(terminal)]);
      await expect(runGcDrainMode(mode, "https://api.test", "secret", h.dependencies)).rejects.toThrow("budget exceeded");
      expect(h.calls()).toBe(1);
      expect(h.sleeps).toEqual([]);
      expect(h.stdout).toEqual([]);
      expect(h.stderr).toEqual([]);
    });
  }

  test("a terminal typed body outranks retryable HTTP status", async () => {
    const h = harness([ok({ budgetExceeded: true }, 409)]);
    await expect(runGcDrainMode("drain", "https://api.test", "secret", h.dependencies)).rejects.toThrow("budget exceeded");
    expect(h.sleeps).toEqual([]);
  });
});
