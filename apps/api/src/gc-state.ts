import { errClass } from "./util.js";

export const PURGE_LEASE_TTL_MS = 20 * 60 * 1000;
export const TAKEOVER_QUIESCENCE_MS = 30 * 60 * 1000;

export interface PurgeLease {
  owner: string;
  acquired: number;
  expires: number;
}
export async function readState<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT v FROM gc_state WHERE k = ?").bind(key).first<{ v: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.v) as T;
  } catch {
    return null;
  }
}

export async function writeState(db: D1Database, key: string, value: unknown): Promise<void> {
  await db.prepare("INSERT INTO gc_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(key, JSON.stringify(value)).run();
}

export type LeaseAcquisition = { lease: PurgeLease; retryAfterMs: 0 } | { lease: null; retryAfterMs: number };

export async function acquireLease(
  db: D1Database,
  nowMs: number,
  owner = crypto.randomUUID(),
  stateKey = "purge_lease",
): Promise<LeaseAcquisition> {
  const lease: PurgeLease = { owner, acquired: nowMs, expires: nowMs + PURGE_LEASE_TTL_MS };
  const inserted = await db.prepare(`INSERT OR IGNORE INTO gc_state (k, v) VALUES ('${leaseStateKey(stateKey)}', ?)`).bind(JSON.stringify(lease)).run();
  if ((inserted.meta.changes ?? 0) === 1) return { lease, retryAfterMs: 0 };
  const prior = await db.prepare(`SELECT v FROM gc_state WHERE k='${leaseStateKey(stateKey)}'`).first<{ v: string }>();
  if (!prior) return { lease: null, retryAfterMs: PURGE_LEASE_TTL_MS + TAKEOVER_QUIESCENCE_MS };
  let parsed: PurgeLease;
  try {
    parsed = JSON.parse(prior.v) as PurgeLease;
  } catch {
    return { lease: null, retryAfterMs: PURGE_LEASE_TTL_MS + TAKEOVER_QUIESCENCE_MS }; // malformed durable state fails closed
  }
  const retryAfterMs = Math.max(1, Number(parsed.expires) + TAKEOVER_QUIESCENCE_MS - nowMs + 1);
  if (nowMs <= Number(parsed.expires) + TAKEOVER_QUIESCENCE_MS) return { lease: null, retryAfterMs };
  const taken = await db.prepare(`UPDATE gc_state SET v=? WHERE k='${leaseStateKey(stateKey)}' AND v=?`).bind(JSON.stringify(lease), prior.v).run();
  return (taken.meta.changes ?? 0) === 1
    ? { lease, retryAfterMs: 0 }
    : { lease: null, retryAfterMs: PURGE_LEASE_TTL_MS + TAKEOVER_QUIESCENCE_MS };
}

export async function renewLease(db: D1Database, lease: PurgeLease, nowMs: number, stateKey = "purge_lease"): Promise<boolean> {
  const renewed = { ...lease, expires: nowMs + PURGE_LEASE_TTL_MS };
  const r = await db
    .prepare(`UPDATE gc_state SET v=? WHERE k='${leaseStateKey(stateKey)}' AND json_extract(v, '$.owner')=?`)
    .bind(JSON.stringify(renewed), lease.owner)
    .run();
  if ((r.meta.changes ?? 0) === 1) {
    lease.expires = renewed.expires;
    return true;
  }
  return false;
}

export async function releaseLease(db: D1Database, owner: string, stateKey = "purge_lease"): Promise<void> {
  await db.prepare(`DELETE FROM gc_state WHERE k='${leaseStateKey(stateKey)}' AND json_extract(v, '$.owner')=?`).bind(owner).run();
}

export type LeaseReleaseResult = { ok: true } | { ok: false; errorClass: string };

export async function releaseLeaseWithRetry(db: D1Database, owner: string, stateKey = "purge_lease"): Promise<LeaseReleaseResult> {
  const backoffs = [250, 1000];
  let failureClass = "unknown";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await releaseLease(db, owner, stateKey);
      return { ok: true };
    } catch (e) {
      failureClass = errClass(e);
      if (attempt < backoffs.length) await new Promise((resolve) => setTimeout(resolve, backoffs[attempt]));
    }
  }
  return { ok: false, errorClass: failureClass };
}

function leaseStateKey(stateKey: string): string {
  if (stateKey !== "purge_lease" && stateKey !== "pack_purge_lease") throw new Error("invalid purge lease state key");
  return stateKey;
}

export function leaseGuard(stateKey = "purge_lease"): string {
  return `EXISTS (SELECT 1 FROM gc_state WHERE k='${leaseStateKey(stateKey)}' AND json_extract(v, '$.owner')=? AND CAST(json_extract(v, '$.expires') AS INTEGER)>=?)`;
}
