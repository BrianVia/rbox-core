import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { blobsCheck } from "../src/blobs.js";
import type { Env } from "../src/env.js";

// §30 — the push preflight (POST /v1/blobs/check) batches its per-80-sha IN-list D1
// reads via db.batch() (see src/d1-batch.ts) instead of one serial round-trip per chunk.
// This proves the batched DISPATCH preserves the exact semantics of the old serial loop
// AND that it correctly crosses db.batch() GROUP boundaries: with chunk=80 and
// STMTS_PER_BATCH=34 one group covers 2720 shas, so a request of N shas spans
// ceil(N/2720) groups. We use 5600 → 3 groups, and plant labelled shas inside each group
// so the have/missing sets are assembled across group boundaries, not just within one.
//
// Efficiency: only a SMALL labelled subset gets DB rows; the thousands of "absent" shas
// simply match nothing (they are all correctly reported missing). That forces multi-group
// batching without seeding thousands of rows.

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const BASE = "https://example.com";
const RCPT = { "x-rbox-protocol": "upload-receipts-v1" };
const db = () => env.rbox_dev_db;

const N = 5600; // 3 db.batch() groups (2720 shas each) — spans ≥3 group boundaries
// A distinct sha per index (valid 64-hex). Same array is reused as the request `shas`.
const ALL: string[] = Array.from({ length: N }, (_, i) => sha(`blob-check-batch-${i}`));

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await db().batch([
    db().prepare("DELETE FROM blob_ref_candidates"),
    db().prepare("DELETE FROM gc_candidates"),
    db().prepare("DELETE FROM blob_refs"),
    db().prepare("DELETE FROM blobs"),
  ]);
});

async function bootstrap(name: string) {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: name }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; accountId: string };
}
const authed = (t: string, x: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, "content-type": "application/json", ...x });

// Seed a physically-present + entitled ref for this account (the non-candidate "have it" case).
async function seedPresentEntitled(acct: string, s: string) {
  await db().prepare("INSERT OR IGNORE INTO blobs(sha256, size_bytes, present) VALUES (?, 1, 1)").bind(s).run();
  await db().prepare("INSERT OR IGNORE INTO blob_refs(account_id, sha256, granted_at) VALUES (?, ?, 1)").bind(acct, s).run();
}
const markCandidate = (acct: string, s: string) =>
  db().prepare("INSERT OR IGNORE INTO blob_ref_candidates(account_id, sha256, marked_at) VALUES (?, ?, 1)").bind(acct, s).run();
const condemn = (s: string) => db().prepare("INSERT OR IGNORE INTO gc_candidates(sha256, kind, marked_at) VALUES (?, 'blob', 1)").bind(s).run();

async function check(token: string, shas: string[], headers: Record<string, string> = {}): Promise<string[]> {
  const res = await SELF.fetch(`${BASE}/v1/blobs/check`, { method: "POST", headers: authed(token, headers), body: JSON.stringify({ shas }) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { missing: string[] }).missing;
}

// Indices chosen to land one labelled sha in EACH of the 3 db.batch() groups
// (group boundaries at 2720 and 5440), so the have-set is built across group boundaries.
const HAVE_IDX = [100, 3000, 5500]; // group 0, 1, 2 — present+entitled, non-candidate → NOT missing
const CAND_IDX = [200, 3100, 5550]; // group 0, 1, 2 — present+entitled BUT prune-marked → missing

describe("§30 blobsCheck batched dispatch — receipts path", () => {
  test("accepts 250,000 items below 16 MiB, rejects 250,001 and invalid items", async () => {
    const a = await bootstrap("bcb-unit2-boundary");
    const repeated = sha("unit2-boundary");
    const atLimit = Array(250_000).fill(repeated) as string[];
    const wire = JSON.stringify({ shas: atLimit });
    expect(new TextEncoder().encode(wire).byteLength).toBe(16_750_010);
    expect(await check(a.token, atLimit, RCPT)).toEqual([repeated]);

    const tooMany = await SELF.fetch(`${BASE}/v1/blobs/check`, {
      method: "POST",
      headers: authed(a.token, RCPT),
      body: JSON.stringify({ shas: Array(250_001).fill(repeated) }),
    });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toEqual({ error: "bad_request_shape" });

    const invalid = await SELF.fetch(`${BASE}/v1/blobs/check`, {
      method: "POST",
      headers: authed(a.token, RCPT),
      body: JSON.stringify({ shas: [repeated, "not-a-sha"] }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "bad_request_shape" });
  });

  test("preserves ordered `missing` across ≥3 db.batch() groups, with the candidate NOT-EXISTS barrier intact", async () => {
    const a = await bootstrap("bcb-rcpt");
    for (const i of HAVE_IDX) await seedPresentEntitled(a.accountId, ALL[i]);
    for (const i of CAND_IDX) {
      await seedPresentEntitled(a.accountId, ALL[i]); // present+entitled …
      await markCandidate(a.accountId, ALL[i]); // … but Phase-1 prune-marked → must read as missing
    }

    const missing = await check(a.token, ALL, RCPT);

    // Exact ORDERED expectation: everything except the non-candidate present+entitled shas,
    // in request order (proves we build from the ordered request array, not DB row order).
    const have = new Set(HAVE_IDX.map((i) => ALL[i]));
    const expected = ALL.filter((s) => !have.has(s));
    expect(missing).toEqual(expected);
    // Spot-checks of the intent behind the ordered array:
    for (const i of HAVE_IDX) expect(missing).not.toContain(ALL[i]); // (a) have it
    for (const i of CAND_IDX) expect(missing).toContain(ALL[i]); // (b) candidate barrier survives batching
    expect(missing).toContain(ALL[0]); // (c) no rows → missing
  });

  test("empty shas request → empty missing (batchedInLookup no-ops, never flushes)", async () => {
    const a = await bootstrap("bcb-rcpt-empty");
    expect(await check(a.token, [], RCPT)).toEqual([]);
  });

  test("an entitled ref whose blob is present=0 (crashed prior promote) still reads missing", async () => {
    const a = await bootstrap("bcb-rcpt-present0");
    const s = ALL[42];
    await db().prepare("INSERT OR IGNORE INTO blobs(sha256, size_bytes, present) VALUES (?, 1, 0)").bind(s).run();
    await db().prepare("INSERT OR IGNORE INTO blob_refs(account_id, sha256, granted_at) VALUES (?, ?, 1)").bind(a.accountId, s).run();
    const missing = await check(a.token, [s], RCPT);
    expect(missing).toEqual([s]); // present=1 required by the JOIN → missing
  });
});

describe("§30 blobsCheck batched dispatch — legacy (non-receipts) path", () => {
  test("gc_candidates exclusion + entitlement + ordered `missing` survive batching across groups", async () => {
    const a = await bootstrap("bcb-legacy");
    // (a) present + entitled + NOT condemned → have it (absent from missing)
    for (const i of HAVE_IDX) await seedPresentEntitled(a.accountId, ALL[i]);
    // (b) present + entitled BUT gc-condemned → missing (proves gc_candidates exclusion under batching)
    const CONDEMNED_IDX = [300, 3200, 5560];
    for (const i of CONDEMNED_IDX) {
      await seedPresentEntitled(a.accountId, ALL[i]);
      await condemn(ALL[i]);
    }
    // (d) present + entitled BUT prune-marked (blob_ref_candidates, folded NOT EXISTS) → missing
    const PRUNE_IDX = [400, 3300, 5570];
    for (const i of PRUNE_IDX) {
      await seedPresentEntitled(a.accountId, ALL[i]);
      await markCandidate(a.accountId, ALL[i]);
    }
    // (e) present but NOT entitled (no blob_ref for this account) → missing (entitledSubset gate)
    const UNENTITLED_IDX = [500, 3400, 5580];
    for (const i of UNENTITLED_IDX) await db().prepare("INSERT OR IGNORE INTO blobs(sha256, size_bytes, present) VALUES (?, 1, 1)").bind(ALL[i]).run();

    const missing = await check(a.token, ALL); // no receipts header → legacy path

    const have = new Set(HAVE_IDX.map((i) => ALL[i]));
    const expected = ALL.filter((s) => !have.has(s));
    expect(missing).toEqual(expected);
    for (const i of CONDEMNED_IDX) expect(missing).toContain(ALL[i]);
    for (const i of PRUNE_IDX) expect(missing).toContain(ALL[i]);
    for (const i of UNENTITLED_IDX) expect(missing).toContain(ALL[i]);
  });

  test("duplicate amplification uses the same legacy D1 statement count as one occurrence", async () => {
    const a = await bootstrap("bcb-legacy-dedup");
    const missingSha = sha("duplicate-amplification");
    const run = async (shas: string[]) => {
      let statements = 0;
      const countedDb = new Proxy(env.rbox_dev_db, {
        get(target, property, receiver) {
          if (property === "batch") {
            return async (batch: D1PreparedStatement[]) => {
              statements += batch.length;
              return target.batch(batch);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const handlerEnv = { ...env, rbox_dev_db: countedDb } as Env;
      const response = await blobsCheck(
        new Request(`${BASE}/v1/blobs/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shas }) }),
        handlerEnv,
        a.accountId,
      );
      expect(response.status).toBe(200);
      return { statements, body: await response.json() };
    };

    const one = await run([missingSha]);
    const many = await run(Array(10_000).fill(missingSha));
    expect(many.statements).toBe(one.statements);
    expect(many.body).toEqual(one.body);
    expect(many.body).toEqual({ missing: [missingSha] });
  });
});
