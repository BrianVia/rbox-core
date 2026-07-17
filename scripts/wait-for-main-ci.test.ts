import { describe, expect, test } from "bun:test";
import {
  classifyRuns,
  fetchMainCiRuns,
  TransientGitHubApiError,
  waitForMainCi,
  type WorkflowRun,
  type WorkflowRunPage,
} from "./wait-for-main-ci.js";

const SHA = "a".repeat(40);
const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 1,
  event: "push",
  head_branch: "main",
  head_sha: SHA,
  status: "completed",
  conclusion: "success",
  ...overrides,
});
const page = (...runs: WorkflowRun[]): WorkflowRunPage => ({ total_count: runs.length, workflow_runs: runs });

describe("classifyRuns", () => {
  test("accepts only exact-SHA successful main push CI", () => {
    expect(classifyRuns(page(run()), SHA).kind).toBe("success");
    expect(classifyRuns(page(run({ event: "pull_request" })), SHA).kind).toBe("none");
    expect(classifyRuns(page(run({ head_sha: "b".repeat(40) })), SHA).kind).toBe("none");
    expect(classifyRuns(page(run({ head_branch: "feature" })), SHA).kind).toBe("none");
  });

  test("treats every non-completed status as active", () => {
    for (const status of ["requested", "waiting", "pending", "queued", "in_progress", "future-status"]) {
      expect(classifyRuns(page(run({ status, conclusion: null })), SHA).kind).toBe("active");
    }
  });

  test("prefers a successful rerun over prior terminal failure", () => {
    const state = classifyRuns(page(run({ id: 1, conclusion: "failure" }), run({ id: 2 })), SHA);
    expect(state.kind).toBe("success");
  });

  test("refuses an incomplete page", () => {
    expect(() => classifyRuns({ total_count: 101, workflow_runs: [run()] }, SHA)).toThrow("incomplete verdict");
  });
});

describe("waitForMainCi", () => {
  test("polls a direct-main run from pending to success", async () => {
    let calls = 0;
    let clock = 0;
    const result = await waitForMainCi({
      sha: SHA,
      fetchRuns: async () => ++calls === 1 ? page(run({ status: "queued", conclusion: null })) : page(run()),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      log: () => {},
    });
    expect(result.conclusion).toBe("success");
    expect(calls).toBe(2);
  });

  test("fails closed on terminal CI failure", async () => {
    await expect(waitForMainCi({ sha: SHA, fetchRuns: async () => page(run({ conclusion: "failure" })), log: () => {} }))
      .rejects.toThrow("completed without success");
  });

  test("times out when only a PR run exists", async () => {
    let clock = 0;
    await expect(waitForMainCi({
      sha: SHA,
      fetchRuns: async () => page(run({ event: "pull_request" })),
      timeoutMs: 20,
      pollMs: 10,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      log: () => {},
    })).rejects.toThrow("timed out");
  });

  test("retries transient API errors within the same deadline", async () => {
    let calls = 0;
    let clock = 0;
    const result = await waitForMainCi({
      sha: SHA,
      fetchRuns: async () => {
        if (++calls === 1) throw new TransientGitHubApiError("GitHub 503", 5);
        return page(run());
      },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      log: () => {},
    });
    expect(result.id).toBe(1);
    expect(clock).toBe(5);
  });

  test("rejects success that arrives only after the absolute deadline", async () => {
    let calls = 0;
    let clock = 0;
    await expect(waitForMainCi({
      sha: SHA,
      fetchRuns: async () => ++calls === 1 ? page() : page(run()),
      timeoutMs: 10,
      pollMs: 10,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      log: () => {},
    })).rejects.toThrow("timed out");
    expect(calls).toBe(1);
  });

  test("aborts a request that outlives the deadline", async () => {
    await expect(waitForMainCi({
      sha: SHA,
      timeoutMs: 10,
      fetchRuns: (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })),
      log: () => {},
    })).rejects.toThrow("timed out");
  });
});

test("fetchMainCiRuns pins filters, headers, and permanent failures", async () => {
  let requested = "";
  const ok = await fetchMainCiRuns({
    repository: "BrianVia/rbox-core",
    sha: SHA,
    token: "secret",
    fetchImpl: async (input, init) => {
      requested = String(input);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      expect(new Headers(init?.headers).get("x-github-api-version")).toBe("2022-11-28");
      return Response.json(page(run()));
    },
  });
  expect(ok.total_count).toBe(1);
  expect(requested).toContain("head_sha=" + SHA);
  expect(requested).toContain("event=push");
  expect(requested).toContain("branch=main");

  await expect(fetchMainCiRuns({
    repository: "BrianVia/rbox-core",
    sha: SHA,
    token: "secret",
    fetchImpl: async () => new Response("forbidden", { status: 403 }),
  })).rejects.toThrow("403");
});

test("fetchMainCiRuns parses Retry-After without turning absence into a tight loop", async () => {
  const request = (headers?: HeadersInit) => fetchMainCiRuns({
    repository: "BrianVia/rbox-core",
    sha: SHA,
    token: "secret",
    fetchImpl: async () => new Response("unavailable", { status: 503, headers }),
  });
  try {
    await request();
    throw new Error("expected transient failure");
  } catch (error) {
    expect(error).toBeInstanceOf(TransientGitHubApiError);
    expect((error as TransientGitHubApiError).retryAfterMs).toBeUndefined();
  }
  try {
    await request({ "Retry-After": "7" });
    throw new Error("expected transient failure");
  } catch (error) {
    expect((error as TransientGitHubApiError).retryAfterMs).toBe(7000);
  }
  try {
    await request({ "Retry-After": "not-a-number" });
    throw new Error("expected transient failure");
  } catch (error) {
    expect((error as TransientGitHubApiError).retryAfterMs).toBeUndefined();
  }
});
