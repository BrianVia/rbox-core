// Server-side per-account/device latency rollup (SPEC-PER-ACCOUNT-LATENCY).
//
// The request already carries an authenticated account/device (from authenticate() or a
// verified grant). The AE metrics path deliberately DROPS that identity (privacy: counts/
// timings/enums only). This rollup instead retains it in OUR OWN D1 — never AE, never the
// wire — so the operator cockpit can answer "how has THIS customer's sync experience been"
// (mean/worst latency, error rate, throughput, D1-vs-R2 split) per account and device.
//
// Server-observable latency only: the client-local phases (scan/encrypt/decrypt/git-apply)
// are invisible here by construction — which is the point, it isolates the part we own.
//
// Best-effort and gated: a failed rollup NEVER touches the response (fire-and-forget on
// waitUntil, all errors swallowed) and the whole write is dark unless RBOX_ACCOUNT_LATENCY=1.
import { dbFor } from "./db.js";
import type { Env } from "./env.js";

const HOUR_MS = 3_600_000;
const RETENTION_DAYS = 30;
/** Prune old buckets on ~1% of writes rather than every request or a dedicated cron. */
const PRUNE_PROBABILITY = 0.01;

export interface LatencySample {
  accountId: string;
  deviceId: string;
  /** Route template, e.g. 'GET /v1/blobs/:sha' — bounded cardinality, single-sourced. */
  route: string;
  ms: number;
  dbMs: number;
  storeMs: number;
  bytes: number;
  ok: boolean;
  nowMs: number;
}

export function accountLatencyEnabled(env: Env): boolean {
  return env.RBOX_ACCOUNT_LATENCY === "1";
}

const BUCKET_COLS = ["b0", "b1", "b2", "b3", "b4", "b5"] as const;

/** Six log-spaced buckets → approximate p50/p95 without storing per-sample rows. */
function bucketIndex(ms: number): number {
  if (ms < 100) return 0;
  if (ms < 300) return 1;
  if (ms < 1_000) return 2;
  if (ms < 3_000) return 3;
  if (ms < 10_000) return 4;
  return 5;
}

const int = (n: number): number => Math.max(0, Math.round(Number.isFinite(n) ? n : 0));

/**
 * Enqueue one rollup upsert. Fire-and-forget: returns immediately, never throws, and does
 * nothing when disabled or when the request had no resolved account (e.g. public routes).
 */
export function recordAccountLatency(env: Env, ctx: ExecutionContext, sample: LatencySample): void {
  if (!accountLatencyEnabled(env) || !sample.accountId) return;
  ctx.waitUntil(
    writeRollup(env, sample).catch((error) => {
      console.error(
        JSON.stringify({
          event: "account_latency_write_failed",
          errorClass: error instanceof Error ? error.name : typeof error,
        }),
      );
    }),
  );
}

async function writeRollup(env: Env, s: LatencySample): Promise<void> {
  const db = dbFor(env, s.accountId);
  const hourBucket = Math.floor(s.nowMs / HOUR_MS);
  const ms = int(s.ms);
  // Both interpolations are from fixed constant arrays — never user input — so they are
  // safe to splice into the statement (D1 has no bound-identifier form for columns).
  const idx = bucketIndex(ms);
  const bucketValues = BUCKET_COLS.map((_, i) => (i === idx ? 1 : 0)).join(", ");
  const col = BUCKET_COLS[idx]!;
  await db
    .prepare(
      `INSERT INTO account_op_latency
         (account_id, device_id, route, hour_bucket, count, err_count, sum_ms, max_ms, sum_db_ms, sum_store_ms, sum_bytes, b0, b1, b2, b3, b4, b5)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ${bucketValues})
       ON CONFLICT(account_id, device_id, route, hour_bucket) DO UPDATE SET
         count = count + 1,
         err_count = err_count + excluded.err_count,
         sum_ms = sum_ms + excluded.sum_ms,
         max_ms = max(max_ms, excluded.max_ms),
         sum_db_ms = sum_db_ms + excluded.sum_db_ms,
         sum_store_ms = sum_store_ms + excluded.sum_store_ms,
         sum_bytes = sum_bytes + excluded.sum_bytes,
         ${col} = ${col} + 1`,
    )
    .bind(s.accountId, s.deviceId, s.route, hourBucket, s.ok ? 0 : 1, ms, ms, int(s.dbMs), int(s.storeMs), int(s.bytes))
    .run();

  if (Math.random() < PRUNE_PROBABILITY) {
    await db
      .prepare(`DELETE FROM account_op_latency WHERE hour_bucket < ?`)
      .bind(hourBucket - RETENTION_DAYS * 24)
      .run();
  }
}
