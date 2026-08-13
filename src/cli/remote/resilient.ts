/**
 * Network resilience for the sync-path transport (design 45 → extended to push/pull).
 *
 * Two production incidents motivated this seam (docs/backlog.md):
 *   1. A 140-repo push died wholesale on ONE transient socket close near the end —
 *      no retry anywhere discarded ~35 min of work.
 *   2. A blob/commit fetch black-holed for 110 minutes at 0 CPU — sync-path fetches
 *      had no timeout/abort at all (the STATUS probe got one in design 45; sync never did).
 *
 * The fix is ONE shared helper, not scattered try/catch:
 *   - {@link isTransientNetworkError} classifies a THROWN fetch fault (socket close,
 *     ECONNRESET, DNS blip, connect refused, our own timeout) as retryable. An HTTP
 *     Response of ANY status is NOT ours — it is returned to the caller untouched so
 *     translateRemoteError and the typed error classes keep owning 4xx/5xx.
 *   - {@link fetchResilient} wraps a single fetch with a size-aware abort deadline and a
 *     bounded retry-on-transient loop, honoring a caller AbortSignal for cancellation.
 *   - On exhaustion it throws a {@link NetworkError} whose message is human — Bun's raw
 *     "pass `verbose: true` in the second argument to fetch()" never reaches a user.
 *
 * Retry is only ever ENABLED by the caller per endpoint (see the call sites); this module
 * just provides the mechanism. The commit POST is safe to retry because the server sequences
 * commits with a strict `parentSequence === head` compare-and-swap (apps/api workspace-sync.ts):
 * a duplicate POST after a socket close carries the now-stale parent, so it 409s as a benign
 * conflict the push loop already absorbs (pull → reconcile → no-op) rather than double-applying.
 */
import { NetworkError } from "./errors.js";

// Real Bun fetch-fault shapes (empirically confirmed against Bun 1.3.5):
//   - socket closed mid-request/response → Error, code "ECONNRESET",
//     message "The socket connection was closed unexpectedly. ... pass `verbose: true` ..."
//   - connect refused / DNS failure       → Error, code "ConnectionRefused"
//   - AbortSignal.timeout fired           → DOMException, name "TimeoutError"
//   - caller-cancelled AbortController    → DOMException, name "AbortError" (NOT transient)
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "EADDRNOTAVAIL",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "ERR_SOCKET_CONNECTION_CLOSED",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const TRANSIENT_MESSAGE_MARKERS = [
  "socket connection was closed",
  "connection closed",
  "connection reset",
  "the socket",
  "unable to connect",
  "failed to fetch",
  "fetch failed",
  "other side closed",
  "econnreset",
  "network connection was lost",
];

/**
 * Is `e` a TRANSIENT network fault worth retrying? True for thrown socket/DNS/connect
 * faults and for our own request-deadline timeout (a DOMException `TimeoutError`). False
 * for a caller cancellation (`AbortError`) and — crucially — for everything that isn't a
 * thrown network exception: an HTTP Response never reaches this predicate, and the typed
 * errors (QuotaExceededError, BlobShaMismatchError, NeedsRebaselineError, …) are constructed
 * from Responses downstream, so they pass through retry loops untouched.
 */
export function isTransientNetworkError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  // Our own already-translated, retry-exhausted error. Return false BEFORE the cause-unwrap
  // below, or its transient `cause` would make an outer loop re-drive a call we already gave up on.
  if (e instanceof NetworkError) return false;
  const err = e as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  // Our request-deadline abort (AbortSignal.timeout) surfaces as a TimeoutError → transient.
  if (err.name === "TimeoutError") return true;
  // A bare AbortError is a caller cancellation, NOT a fault — never retry it.
  if (err.name === "AbortError") return false;
  // NB: our own NetworkError also has name "NetworkError"; we deliberately do NOT classify by
  // that name (it would make an already-translated, retry-exhausted error look retryable again).
  // Real fetch faults are matched by `.code` / message below.
  const code = typeof err.code === "string" ? err.code : undefined;
  if (code && TRANSIENT_CODES.has(code)) return true;
  const msg = typeof err.message === "string" ? err.message.toLowerCase() : "";
  if (msg && TRANSIENT_MESSAGE_MARKERS.some((m) => msg.includes(m))) return true;
  // Undici-style wrapped faults carry the real cause one level down.
  if (err.cause && err.cause !== e) return isTransientNetworkError(err.cause);
  return false;
}

export function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^-?\d+$/.test(raw)) return fallback;
  try {
    const n = BigInt(raw);
    if (n < BigInt(min)) return min;
    if (n > BigInt(max)) return max;
    return Number(n);
  } catch {
    return fallback;
  }
}

const ONE_SECOND_MS = 1000;
const FIVE_SECONDS_MS = 5000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_RETRIES = 10;

/** Flat deadline for small control round-trips (JSON POST/GET, byte blobs, multipart init/complete). */
export const SMALL_CONTROL_TIMEOUT_MS = envInt("RBOX_NET_CONTROL_TIMEOUT_MS", 60_000, ONE_SECOND_MS, ONE_HOUR_MS);
/** Idle (no-progress) watchdog for streaming blob downloads — resets on every chunk. */
export const DOWNLOAD_IDLE_MS = envInt("RBOX_NET_DOWNLOAD_IDLE_MS", 60_000, FIVE_SECONDS_MS, ONE_HOUR_MS);
/** Generous flat cap for buffered (in-memory) blob GETs, which can't observe progress. */
export const BUFFERED_GET_TIMEOUT_MS = envInt("RBOX_NET_BUFFERED_GET_TIMEOUT_MS", 120_000, ONE_SECOND_MS, ONE_HOUR_MS);
/** Additional attempts after the first (3 total by default). */
export const DEFAULT_RETRIES = envInt("RBOX_NET_RETRIES", 2, 0, MAX_RETRIES);

const XFER_BASE_MS = 30_000;
const XFER_FLOOR_BPS = 512 * 1024; // deliberately pessimistic: a healthy link is 20–200× faster
const BLOB_DOWNLOAD_MIN_TIMEOUT_MS = 120_000;
const BLOB_DOWNLOAD_FLOOR_BPS = 256 * 1024;

/**
 * Size-aware deadline for a blob upload/download (send + response). A flat cap would kill a
 * legitimately slow multi-GB transfer, so we scale by size against a conservative floor
 * throughput — the deadline only trips a genuinely stuck socket, never a slow-but-moving one.
 */
export function transferTimeoutMs(sizeBytes: number): number {
  return XFER_BASE_MS + Math.ceil((Math.max(0, sizeBytes) / XFER_FLOOR_BPS) * 1000);
}

/**
 * Total deadline for blob downloads, including the response body. It is deliberately
 * looser than the upload/send deadline: a dogfood populate can include large blobs
 * on ordinary residential links, but anything slower than 256 KiB/s for a single
 * ciphertext blob is no longer useful foreground progress. The idle watchdog still
 * catches black holes faster; this cap bounds slow-drip forever hangs.
 */
export function blobDownloadTimeoutMs(sizeBytes: number | undefined): number {
  const minMs = envInt("RBOX_NET_BLOB_MIN_TIMEOUT_MS", BLOB_DOWNLOAD_MIN_TIMEOUT_MS, ONE_SECOND_MS, ONE_HOUR_MS);
  const maxMs = envInt("RBOX_NET_BLOB_MAX_TIMEOUT_MS", ONE_HOUR_MS, minMs, ONE_HOUR_MS);
  const size = typeof sizeBytes === "number" && Number.isFinite(sizeBytes) ? Math.max(0, sizeBytes) : 0;
  return Math.min(maxMs, Math.max(minMs, Math.ceil((size / BLOB_DOWNLOAD_FLOOR_BPS) * 1000)));
}

export interface ResilientOpts {
  /** Abort deadline for the whole fetch (connect + send + response headers). */
  timeoutMs?: number;
  /** Additional attempts after the first. Pass 0 to disable retry (non-idempotent calls). */
  retries?: number;
  /** Per-retry backoff in ms; the last value repeats if there are more retries than entries. */
  backoffMs?: number[];
  /** Caller cancellation — aborts the fetch AND breaks the backoff; never treated as transient. */
  signal?: AbortSignal;
  /** Human label for the friendly error, e.g. "uploading data". */
  op?: string;
  /** Human rerun guidance appended to the retry-exhausted NetworkError. */
  rerunHint?: string;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Called only when a transient failure will actually be retried. */
  onRetry?: (attempt: number) => void;
}

const DEFAULT_BACKOFF_MS = [1000, 4000];

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("aborted", "AbortError");
}

/** Sleep that settles early (rejecting with the abort reason) if `signal` fires mid-backoff. */
async function backoffSleep(ms: number, sleep: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void sleep(ms).then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/**
 * Run `fn` with bounded retry-on-transient. Non-transient throws (and HTTP Responses, which
 * never throw) propagate immediately with ZERO retries. When the transient budget is spent,
 * throws a {@link NetworkError} carrying the friendly `op` label and the last cause.
 */
export async function retryTransient<T>(fn: () => Promise<T>, opts: ResilientOpts = {}): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw abortError(opts.signal);
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!isTransientNetworkError(e)) throw e; // typed/HTTP errors and real bugs pass straight through
      if (attempt === retries) break;
      opts.onRetry?.(attempt + 1);
      const wait = backoff[Math.min(attempt, backoff.length - 1)] ?? DEFAULT_BACKOFF_MS[DEFAULT_BACKOFF_MS.length - 1]!;
      await backoffSleep(wait, sleep, opts.signal);
    }
  }
  throw new NetworkError(opts.op ?? "contacting rbox", lastError, opts.rerunHint);
}

/** Compose the caller signal, any pre-existing init signal, and a fresh timeout into one signal. */
function withDeadline(init: RequestInit, timeoutMs: number | undefined, outer: AbortSignal | undefined): RequestInit {
  const signals: AbortSignal[] = [];
  if (outer) signals.push(outer);
  if (init.signal) signals.push(init.signal);
  if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return init;
  const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
  return { ...init, signal };
}

export type BufferedGetResult =
  | { ok: true; response: Response; body: ArrayBuffer }
  | { ok: false; response: Response };

/**
 * Buffered binary GET helper. For OK responses, the body read is part of the same
 * retried+deadlined closure as the fetch so a headers-then-stalled body can time out and
 * retry. Non-OK Responses are returned untouched for the typed HTTP layer. This is for
 * blob/manifest-style payloads whose body can be large or unbounded; small control JSON
 * readers deliberately stay at their call sites.
 */
export function fetchBufferedGet(url: string, init: RequestInit = {}, opts: ResilientOpts = {}): Promise<BufferedGetResult> {
  const method = init.method?.toUpperCase();
  if (method && method !== "GET") throw new TypeError("fetchBufferedGet only supports GET requests");
  const timeoutMs = opts.timeoutMs ?? BUFFERED_GET_TIMEOUT_MS;
  const getInit = method ? init : { ...init, method: "GET" };
  return retryTransient(async () => {
    const res = await fetch(url, withDeadline(getInit, timeoutMs, opts.signal));
    if (!res.ok) return { ok: false, response: res };
    return { ok: true, response: res, body: await res.arrayBuffer() };
  }, opts);
}

/**
 * A single fetch with an abort deadline but NO retry — it throws the RAW transport fault. Use
 * this when the request body is single-use (a file ReadableStream) and the retry must live one
 * level up, re-creating a fresh body per attempt: `retryTransient(() => fetchWithDeadline(...))`.
 */
export function fetchWithDeadline(url: string, init: RequestInit = {}, timeoutMs?: number, signal?: AbortSignal): Promise<Response> {
  return fetch(url, withDeadline(init, timeoutMs ?? SMALL_CONTROL_TIMEOUT_MS, signal));
}

/**
 * A single fetch wrapped with an abort deadline and bounded transient retry. Returns the
 * Response for the caller's existing status handling (409/422/402/…) — retry fires ONLY when
 * fetch itself throws (no response arrived), so no successful commit/upload is ever re-driven
 * on the strength of a Response the caller hasn't seen.
 */
export function fetchResilient(url: string, init: RequestInit | (() => RequestInit) = {}, opts: ResilientOpts = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? SMALL_CONTROL_TIMEOUT_MS;
  return retryTransient(() => {
    const attemptInit = typeof init === "function" ? init() : init;
    return fetch(url, withDeadline(attemptInit, timeoutMs, opts.signal));
  }, opts);
}
