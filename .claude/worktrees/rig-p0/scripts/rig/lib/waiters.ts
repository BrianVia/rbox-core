/**
 * Convergence + path waiters (design 56 §9). A scenario asserts "did the change
 * PROPAGATE?" — not "did a specific mechanism fire" — so these poll the observable
 * end state (a file's contents, two trees' fingerprints) until it settles or a
 * per-tier timeout elapses.
 *
 * The control flow lives in {@link pollUntil}, which is PURE over injected
 * `now`/`sleep`/`probe` — so the timeout math (always probes once; stops the instant
 * the predicate holds; returns the LAST probed value on timeout) is unit-tested
 * without a container or a real clock. {@link waitForPath}/{@link waitForConvergence}
 * are thin device-bound wrappers.
 */
import type { Device } from "./device.js";
import { compareFingerprints, fingerprintTree, type Divergence } from "./convergence.js";

export interface PollOutcome<T> {
  /** Did `done(value)` hold before the timeout? */
  ok: boolean;
  /** The last probed value (the settling state on success, the stale state on timeout). */
  value: T;
  /** How many times `probe` ran. */
  attempts: number;
  /** Wall time consumed (per the injected clock). */
  elapsedMs: number;
}

export interface PollClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function realClock(): PollClock {
  return { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
}

/**
 * Poll `probe` on `intervalMs` until `done` holds or `timeoutMs` elapses. ALWAYS
 * probes at least once (a zero/elapsed timeout still yields one observation, so a
 * fast-settling state is never missed). Between probes it sleeps `intervalMs`, but
 * never past the deadline: once elapsed ≥ timeout it returns the last value with
 * `ok:false`. PURE over the injected clock.
 */
export async function pollUntil<T>(
  opts: { probe: () => Promise<T>; done: (v: T) => boolean; timeoutMs: number; intervalMs: number },
  clock: PollClock = realClock()
): Promise<PollOutcome<T>> {
  const start = clock.now();
  let attempts = 0;
  for (;;) {
    const value = await opts.probe();
    attempts++;
    const elapsedMs = clock.now() - start;
    if (opts.done(value)) return { ok: true, value, attempts, elapsedMs };
    if (elapsedMs >= opts.timeoutMs) return { ok: false, value, attempts, elapsedMs };
    await clock.sleep(opts.intervalMs);
  }
}

/** Default poll cadences. Path checks are cheap (one `cat`), convergence a full
 *  fingerprint sweep — so it polls a touch slower to stay off the guests' backs. */
export const PATH_POLL_MS = 1000;
export const CONVERGENCE_POLL_MS = 2000;

/**
 * Poll `device`'s file at `path` until `predicate(contents)` holds or `timeoutMs`
 * elapses. `contents` is `undefined` when the file is absent (so a predicate can wait
 * for either APPEARANCE or a specific body). Never throws.
 */
export async function waitForPath(
  device: Device,
  path: string,
  predicate: (contents: string | undefined) => boolean,
  timeoutMs: number,
  clock?: PollClock
): Promise<PollOutcome<string | undefined>> {
  return pollUntil<string | undefined>(
    {
      probe: () => device.readFileIfExists(path),
      done: predicate,
      timeoutMs,
      intervalMs: PATH_POLL_MS,
    },
    clock
  );
}

/**
 * Poll both devices' fingerprints of `dir` until byte-identical (excl. `.rbox`) or
 * `timeoutMs` elapses. Each probe re-fingerprints BOTH trees IN-GUEST and compares on
 * the host; the outcome carries the final {@link Divergence} (identical on success, the
 * residual drift on timeout — the scenario logs `onlyInA/onlyInB/differing`).
 */
export async function waitForConvergence(
  a: Device,
  b: Device,
  dir: string,
  timeoutMs: number,
  clock?: PollClock
): Promise<PollOutcome<Divergence>> {
  return pollUntil<Divergence>(
    {
      probe: async () => {
        const [fa, fb] = await Promise.all([fingerprintTree(a, dir), fingerprintTree(b, dir)]);
        return compareFingerprints(fa, fb);
      },
      done: (div) => div.identical,
      timeoutMs,
      intervalMs: CONVERGENCE_POLL_MS,
    },
    clock
  );
}

/** One-line divergence summary for logs/assertion detail. PURE. */
export function divergenceDetail(div: Divergence): string {
  if (div.identical) return "identical";
  const sample = [...div.onlyInA.map((p) => `A:${p}`), ...div.onlyInB.map((p) => `B:${p}`), ...div.differing.map((p) => `≠:${p}`)].slice(0, 5);
  return `onlyA=${div.onlyInA.length} onlyB=${div.onlyInB.length} diff=${div.differing.length} (${sample.join(", ")})`;
}
