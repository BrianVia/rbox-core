import type { Env } from "./env.js";
import { DIVERGENCE_SAMPLE } from "./commit-delta.js";

/**
 * Server-side observability for the control plane (perf TODO, 2026-06-29).
 *
 * Emits one Workers Analytics Engine data point per server operation so we can
 * answer "what's slow in prod" from aggregates instead of guesswork: per-op /
 * per-route latency (p50/p99), R2-vs-D1 time split, commit body size, blobs per
 * commit, and the missing-blob ratio that drives 422→upload round-trips.
 *
 * PRIVACY (design doc §5 metadata threat model). This is internal Cloudflare
 * telemetry, never shipped to a third party, BUT it still must not become a
 * per-user activity log. The rule enforced here:
 *
 *   - dimensions (`indexes`, `blobs`) carry ONLY low-cardinality operational
 *     labels: op name, a TEMPLATED route (ids/shas/uuids masked — see
 *     worker.ts routeTemplate), and a coarse outcome. NEVER an account/device/
 *     workspace id, a path, a path hash, or a blob/commit hash.
 *   - numeric facts (`doubles`) are raw durations / sizes / counts. They're
 *     aggregate metrics (we compute percentiles at query time), not identifiers,
 *     so they carry no linkability on their own once the dimensions above are
 *     id-free. We deliberately keep them raw rather than pre-bucketed so the
 *     dashboard can compute arbitrary percentiles of commit-body-size etc.
 *
 * AE `writeDataPoint` is synchronous and non-blocking (the runtime buffers and
 * flushes out-of-band), so there's no `waitUntil` to thread and it never adds
 * latency to the request. It's also wrapped so telemetry can never throw into a
 * request path, and is a no-op when the binding is absent (local bun tests, or
 * before the dataset is provisioned).
 */

/** Columns are POSITIONAL in Analytics Engine — keep this map in sync with the
 *  dashboard SQL (see docs/benchmarking-and-observability.md §5.3):
 *    index1 = op            (sampling key)
 *    blob1  = op            (GROUP BY op)
 *    blob2  = route         (templated; "" when N/A)
 *    blob3  = outcome       ("ok" | "conflict" | "unsatisfied_blobs" | "<http>" | ...)
 *    double1 = ms           (primary latency for this op)
 *    double2 = dbMs         (D1 time spent inside the op)
 *    double3 = storeMs      (R2 time spent inside the op)
 *    double4 = doMs         (Durable Object time, e.g. transactionSync hold)
 *    double5 = bytes        (payload size: commit body / blob size)
 *    double6 = count        (blobs per commit, parts, etc.)
 *    double7 = ratio        (0..1, e.g. missingBlobs / referenced)
 *    double8 = dbCalls      (# D1 statements/batches — the §23 success metric)
 *    double9..15 = commit server total/envelope/accounting/sidecar/CAS/mirror/response ms
 *    double16 = earlyReject   (1 only when design-103's commit preflight rejects)
 */
export interface MetricEvent {
  /** Low-cardinality op name, e.g. "request" | "commit" | "blob.put". */
  op: string;
  /** Coarse outcome label (NOT a message). */
  outcome: string;
  /** Templated route, ids/shas masked. Omit for ops without a meaningful route. */
  route?: string;
  /** Primary latency in ms. */
  ms?: number;
  /** D1 time within the op, ms. */
  dbMs?: number;
  /** Number of D1 statements/batches issued within the op (§23's success metric:
   *  ~5 per blob today → ~0 after upload-receipts). */
  dbCalls?: number;
  /** R2 time within the op, ms. */
  storeMs?: number;
  /** Durable Object time within the op, ms (e.g. `transactionSync` hold — the
   *  contention signal). */
  doMs?: number;
  /** Payload size in bytes (commit body, blob bytes). */
  bytes?: number;
  /** Count dimension (blobs/commit, parts). */
  count?: number;
  /** Ratio 0..1 (e.g. missing/referenced). */
  ratio?: number;
  serverTotalMs?: number;
  envelopeMs?: number;
  accountingMs?: number;
  sidecarMs?: number;
  commitMs?: number;
  mirrorMs?: number;
  responseMs?: number;
  /** Design 103 Part A commit preflight fired. Numeric and low-cardinality. */
  earlyReject?: number;
}

export function emit(env: Env, e: MetricEvent): void {
  const ds = env.rbox_metrics;
  if (!ds) return; // binding not configured (tests / not yet provisioned) → no-op
  try {
    ds.writeDataPoint({
      indexes: [e.op],
      blobs: [e.op, e.route ?? "", e.outcome],
      // POSITIONAL — keep docs/observability-server-metrics.md + dashboard SQL in sync.
      doubles: [
        e.ms ?? 0, e.dbMs ?? 0, e.storeMs ?? 0, e.doMs ?? 0,
        e.bytes ?? 0, e.count ?? 0, e.ratio ?? 0, e.dbCalls ?? 0,
        e.serverTotalMs ?? 0, e.envelopeMs ?? 0, e.accountingMs ?? 0,
        e.sidecarMs ?? 0, e.commitMs ?? 0, e.mirrorMs ?? 0, e.responseMs ?? 0,
        e.earlyReject ?? 0,
      ],
    });
  } catch {
    // telemetry must never break the request path
  }
}

export interface DeltaMetricFields {
  count?: number;
  ratio?: number;
  bytes?: number;
  dbCalls?: number;
  reason?: string;
  digest?: string;
  sample?: string[];
}

/** Design 102 telemetry is a separate AE point: blobs are
 * [op,outcome,reason,digest], doubles reuse [bytes,count,ratio,dbCalls]. Phase
 * timings use `count` as milliseconds; sizes use count=added, ratio=carried,
 * bytes=removed. This does
 * not alter the frozen positional layout of the existing commit MetricEvent. */
export function emitDelta(env: Env, outcome: string, fields: DeltaMetricFields = {}): void {
  const ds = env.rbox_metrics;
  try {
    ds?.writeDataPoint({
      indexes: ["commit.delta"],
      blobs: ["commit.delta", outcome, fields.reason ?? "", fields.digest ?? ""],
      doubles: [fields.bytes ?? 0, fields.count ?? 0, fields.ratio ?? 0, fields.dbCalls ?? 0],
    });
    if (fields.sample?.length) console.error(JSON.stringify({ event: "commit.delta.divergence", outcome, digest: fields.digest, sample: fields.sample.slice(0, DIVERGENCE_SAMPLE) }));
  } catch {
    // telemetry must never break commit admission
  }
}

/**
 * Per-op span collector. Accumulates D1 / R2 / DO sub-timings (and D1 call count)
 * across nested or FAILING calls, so the one emitted metric attributes time
 * correctly instead of dropping it on a throw. Wrap each backend call:
 *   await span.d1(() => stmt.run())      // times + counts a D1 statement/batch
 *   await span.r2(() => bucket.put(...))  // times an R2 op
 *   await span.durable(() => doStub.fetch(...))  // times a DO call
 * Then `emit(env, { ...span.fields(), op, outcome, ms })`.
 */
export class OpSpan {
  private readonly t0 = performance.now();
  dbMs = 0;
  dbCalls = 0;
  storeMs = 0;
  doMs = 0;
  /** Wall time (ms) since the span began. */
  get ms(): number {
    return performance.now() - this.t0;
  }
  async d1<T>(fn: () => Promise<T>): Promise<T> {
    const t = performance.now();
    this.dbCalls++;
    try {
      return await fn();
    } finally {
      this.dbMs += performance.now() - t;
    }
  }
  async r2<T>(fn: () => Promise<T>): Promise<T> {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      this.storeMs += performance.now() - t;
    }
  }
  /** The accumulated sub-timings, spread into a MetricEvent. (DO time, `doMs`, is
   *  set directly — the only DO timing is the synchronous `transactionSync`.) */
  fields(): Pick<MetricEvent, "dbMs" | "dbCalls" | "storeMs" | "doMs"> {
    return { dbMs: this.dbMs, dbCalls: this.dbCalls, storeMs: this.storeMs, doMs: this.doMs };
  }

  /** Wrap a D1 binding so EVERY statement/batch run through it (including ones
   *  hidden inside billing/authz helpers) is timed + counted into this span. Pass
   *  the result as `env.rbox_dev_db` (via a shallow env clone) for the op's scope —
   *  no need to thread the span through business logic. */
  db(d1: D1Database): D1Database {
    const span = this;
    const wrapStmt = (s: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(s, {
        get(t, p, r) {
          if (p === "bind") return (...a: unknown[]) => wrapStmt((t.bind as (...x: unknown[]) => D1PreparedStatement)(...a));
          if (p === "run" || p === "first" || p === "all" || p === "raw") {
            return (...a: unknown[]) => span.d1(() => (t[p as "run"] as (...x: unknown[]) => Promise<unknown>)(...a));
          }
          return Reflect.get(t, p, r);
        },
      });
    return new Proxy(d1, {
      get(t, p, r) {
        if (p === "prepare") return (q: string) => wrapStmt(t.prepare(q));
        if (p === "batch") return (stmts: D1PreparedStatement[]) => span.d1(() => t.batch(stmts));
        return Reflect.get(t, p, r);
      },
    });
  }
}

/** A started operation: its span, an env whose D1 is timed+counted into that span,
 *  and a `done()` that emits ONE metric (ms from the span, plus its sub-timings). */
export interface Op {
  span: OpSpan;
  /** Use for ALL the op's D1 (incl. via billing/authz helpers) so it's attributed. */
  env: Env;
  /** Emit the op's single metric. Call once on every exit path. */
  done(outcome: string, extra?: Partial<MetricEvent>): void;
}

/** Begin an instrumented op: collapses the per-handler `t0 + new OpSpan() + env-clone
 *  + bespoke emit closure` boilerplate into one call so the AE schema (ms + sub-timings)
 *  is single-sourced. `op.env` is `env` with its D1 binding proxied into `op.span`. */
export function startOp(env: Env, op: string, route?: string): Op {
  const span = new OpSpan();
  const env2: Env = { ...env, rbox_dev_db: span.db(env.rbox_dev_db) };
  return {
    span,
    env: env2,
    done: (outcome, extra = {}) => emit(env, { op, route, outcome, ms: span.ms, ...span.fields(), ...extra }),
  };
}
