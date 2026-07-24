import { afterEach, describe, expect, test } from "bun:test";
import { NetworkError } from "./errors.js";
import { fetchResilient, isTransientNetworkError, retryTransient, SMALL_CONTROL_TIMEOUT_MS, transferTimeoutMs } from "./resilient.js";

// A deterministic, instant sleep so backoff never adds real wall-clock to the suite.
const noSleep = () => Promise.resolve();
const ENV_KEYS = ["RBOX_NET_CONTROL_TIMEOUT_MS", "RBOX_NET_DOWNLOAD_IDLE_MS", "RBOX_NET_BUFFERED_GET_TIMEOUT_MS", "RBOX_NET_RETRIES"] as const;

async function importFreshResilient(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): Promise<typeof import("./resilient.js")> {
  const saved = new Map<(typeof ENV_KEYS)[number], string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k as (typeof ENV_KEYS)[number]] = v;
  try {
    return (await import(`./resilient.ts?env-test=${Date.now()}-${Math.random()}`)) as typeof import("./resilient.js");
  } finally {
    for (const k of ENV_KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The exact Bun 1.3.5 shape for a socket dropped mid-request/response. */
const socketClosed = () =>
  Object.assign(new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"), {
    code: "ECONNRESET",
  });

describe("isTransientNetworkError — real Bun fault shapes", () => {
  test("socket-closed-unexpectedly (ECONNRESET) is transient", () => {
    expect(isTransientNetworkError(socketClosed())).toBe(true);
  });

  test("connect-refused / DNS (Bun collapses both to code ConnectionRefused) is transient", () => {
    expect(isTransientNetworkError(Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" }))).toBe(true);
  });

  test("our request-deadline abort (DOMException TimeoutError) is transient", () => {
    expect(isTransientNetworkError(new DOMException("The operation timed out.", "TimeoutError"))).toBe(true);
  });

  test("a caller cancellation (DOMException AbortError) is NOT transient", () => {
    expect(isTransientNetworkError(new DOMException("The operation was aborted.", "AbortError"))).toBe(false);
  });

  test("our own already-translated NetworkError is NOT re-classified as transient", () => {
    // Guards against an infinite/duplicate retry: NetworkError.name === "NetworkError".
    expect(isTransientNetworkError(new NetworkError("uploading data", socketClosed()))).toBe(false);
  });

  test("a plain bug (TypeError with no network marker) passes through as non-transient", () => {
    expect(isTransientNetworkError(new TypeError("x.y is not a function"))).toBe(false);
    expect(isTransientNetworkError(new Error("boom"))).toBe(false);
  });

  test("a wrapped cause is unwrapped one level", () => {
    expect(isTransientNetworkError(Object.assign(new Error("fetch failed"), { cause: socketClosed() }))).toBe(true);
  });
});

describe("retryTransient — bounded retry with idempotency discipline", () => {
  test("a transient that clears on attempt N returns the value (no throw)", async () => {
    let calls = 0;
    const out = await retryTransient(
      async () => {
        calls++;
        if (calls < 3) throw socketClosed();
        return "ok";
      },
      { retries: 2, sleep: noSleep }
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3); // 2 failures + 1 success
  });

  test("a persistent transient exhausts the budget and throws a friendly NetworkError", async () => {
    let calls = 0;
    const err = await retryTransient(
      async () => {
        calls++;
        throw socketClosed();
      },
      { retries: 2, sleep: noSleep, op: "uploading data" }
    ).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(calls).toBe(3); // 1 + 2 retries
    // The raw Bun string is GONE; the message states drop + operation + safe-to-re-run.
    expect((err as Error).message).not.toContain("verbose: true");
    expect((err as Error).message.toLowerCase()).toContain("uploading data");
    expect((err as Error).message.toLowerCase()).toContain("safe to re-run");
  });

  test("a NON-transient error passes through untouched with ZERO retries", async () => {
    let calls = 0;
    const boom = new Error("business rule violated");
    const err = await retryTransient(
      async () => {
        calls++;
        throw boom;
      },
      { retries: 5, sleep: noSleep }
    ).catch((e) => e);
    expect(err).toBe(boom); // same instance, not wrapped
    expect(calls).toBe(1); // never retried
  });

  test("a timeout cause yields the 'timed out' phrasing (vs 'dropped')", async () => {
    const err = await retryTransient(async () => { throw new DOMException("timed out", "TimeoutError"); }, { retries: 0, sleep: noSleep, op: "downloading data" }).catch((e) => e);
    expect((err as Error).message.toLowerCase()).toContain("timed out");
  });

  test("abort mid-backoff aborts the retry (cancellation, not a NetworkError)", async () => {
    const ctrl = new AbortController();
    let calls = 0;
    let announceSleep!: () => void;
    const sleepEntered = new Promise<void>((resolve) => { announceSleep = resolve; });
    // Stay pending without leaving a real timer behind after abort wins the race.
    const controllableSleep = () => {
      announceSleep();
      return new Promise<void>(() => {});
    };
    const p = retryTransient(
      async () => {
        calls++;
        throw socketClosed();
      },
      { retries: 5, sleep: controllableSleep, signal: ctrl.signal }
    ).catch((e) => e);
    await sleepEntered;
    ctrl.abort();
    const err = await p;
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
    expect(calls).toBe(1); // aborted before the second attempt
  });
});

describe("transferTimeoutMs — size-aware deadline", () => {
  test("scales with size and is never below the base", () => {
    const small = transferTimeoutMs(0);
    const big = transferTimeoutMs(1024 * 1024 * 1024); // 1 GiB
    expect(small).toBeGreaterThanOrEqual(30_000);
    expect(big).toBeGreaterThan(small);
    // A GB gets minutes, not seconds — a slow-but-moving transfer is never killed.
    expect(big).toBeGreaterThan(10 * 60 * 1000);
  });
});

describe("RBOX_NET_* env overrides — strict parse and bounded timers", () => {
  test("rejects partial garbage and clamps high values", async () => {
    const mod = await importFreshResilient({
      RBOX_NET_CONTROL_TIMEOUT_MS: "1500ms",
      RBOX_NET_DOWNLOAD_IDLE_MS: "1",
      RBOX_NET_BUFFERED_GET_TIMEOUT_MS: "999999999999999999999",
      RBOX_NET_RETRIES: "999",
    });
    expect(mod.SMALL_CONTROL_TIMEOUT_MS).toBe(60_000); // partial integer garbage falls back
    expect(mod.DOWNLOAD_IDLE_MS).toBe(5_000); // idle watchdog floor
    expect(mod.BUFFERED_GET_TIMEOUT_MS).toBe(60 * 60 * 1000); // deadline ceiling
    expect(mod.DEFAULT_RETRIES).toBe(10); // retry ceiling
    expect(() => AbortSignal.timeout(mod.BUFFERED_GET_TIMEOUT_MS)).not.toThrow();
  });

  test("clamps low strict integers to sane minimums", async () => {
    const mod = await importFreshResilient({
      RBOX_NET_CONTROL_TIMEOUT_MS: "0",
      RBOX_NET_DOWNLOAD_IDLE_MS: "100",
      RBOX_NET_BUFFERED_GET_TIMEOUT_MS: "-5",
      RBOX_NET_RETRIES: "-5",
    });
    expect(mod.SMALL_CONTROL_TIMEOUT_MS).toBe(1_000);
    expect(mod.DOWNLOAD_IDLE_MS).toBe(5_000);
    expect(mod.BUFFERED_GET_TIMEOUT_MS).toBe(1_000);
    expect(mod.DEFAULT_RETRIES).toBe(0);
    expect(() => AbortSignal.timeout(mod.SMALL_CONTROL_TIMEOUT_MS)).not.toThrow();
  });
});

describe("fetchResilient — Response pass-through vs thrown-fault retry", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("an HTTP Response of ANY status is returned untouched — NEVER retried (the commit-409 guard)", async () => {
    // A 409 (a duplicate commit after a socket-close-post-apply) must reach the caller so the
    // push loop can absorb it as a conflict — the network layer must not swallow or retry it.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ head: 7 }), { status: 409 });
    }) as unknown as typeof fetch;
    const res = await fetchResilient("https://api.test/manifests", { method: "POST" }, { retries: 3, sleep: noSleep });
    expect(res.status).toBe(409);
    expect(calls).toBe(1); // a Response is not a fault → no retry
  });

  test("a thrown transient is retried then, on success, returns the Response", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw socketClosed();
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await fetchResilient("https://api.test/blobs/x", { method: "PUT" }, { retries: 2, sleep: noSleep });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("a black-holed fetch is aborted by the control deadline and retried per policy", async () => {
    const origFetch = globalThis.fetch;
    const origTimeout = AbortSignal.timeout;
    let calls = 0;
    const timeoutBudgets: number[] = [];
    try {
      (AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = ((ms: number) => {
        timeoutBudgets.push(ms);
        const ctrl = new AbortController();
        queueMicrotask(() => ctrl.abort(new DOMException("control request black-holed", "TimeoutError")));
        return ctrl.signal;
      }) as typeof AbortSignal.timeout;
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        calls++;
        if (calls <= 2) {
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal as AbortSignal | undefined;
            if (!signal) return;
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return new Response("ok", { status: 200 });
      }) as unknown as typeof fetch;

      const res = await fetchResilient("https://api.test/manifests", { method: "POST" }, { retries: 2, sleep: noSleep, op: "publishing your changes" });

      expect(res.status).toBe(200);
      expect(calls).toBe(3);
      expect(timeoutBudgets).toEqual([SMALL_CONTROL_TIMEOUT_MS, SMALL_CONTROL_TIMEOUT_MS, SMALL_CONTROL_TIMEOUT_MS]);
    } finally {
      globalThis.fetch = origFetch;
      (AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = origTimeout;
    }
  });

  test("retries: 0 makes exactly one attempt then translates (the multipart-complete contract)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw socketClosed();
    }) as unknown as typeof fetch;
    const err = await fetchResilient("https://api.test/complete", { method: "POST" }, { retries: 0, sleep: noSleep, op: "finalizing upload" }).catch((e) => e);
    expect(calls).toBe(1); // no retry
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message.toLowerCase()).toContain("finalizing upload");
  });
});

describe("live socket-close (real Bun fault, not a stub)", () => {
  test("a server that drops the connection surfaces a transient fault that fetchResilient translates", async () => {
    // Gold-standard: exercise the REAL Bun error path, not a hand-built shape. A raw TCP server
    // that closes the socket the moment it accepts reproduces the production incident verbatim.
    let server: ReturnType<typeof Bun.listen>;
    try {
      server = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { open: (sock) => sock.end(), data: () => {}, close: () => {}, error: () => {} },
      });
    } catch (e) {
      if ((e as { code?: unknown }).code === "EPERM") return; // local TCP listen denied by the sandbox
      throw e;
    }
    const port = (server as unknown as { port: number }).port;
    try {
      // First: confirm the predicate matches the genuine thrown error.
      const raw = await fetch(`http://127.0.0.1:${port}/`).catch((e) => e);
      expect(isTransientNetworkError(raw)).toBe(true);

      // Then: fetchResilient retries it and, when it never recovers, throws the friendly message.
      const err = await fetchResilient(`http://127.0.0.1:${port}/`, {}, { retries: 2, sleep: noSleep, op: "uploading data" }).catch((e) => e);
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as Error).message).not.toContain("verbose: true");
      expect((err as Error).message.toLowerCase()).toContain("safe to re-run");
    } finally {
      server.stop(true);
    }
  });
});
