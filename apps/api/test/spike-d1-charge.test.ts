import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { commitAccounting } from "../src/commit-accounting.js";
import { RECEIPT_TTL_MS } from "../src/receipts.js";

// §23.6 D1 SPIKE — the load-bearing assumptions the whole §23 accounting rests on,
// exercised against the real D1 binding (workerd SQLite) through `.batch()`:
//   (a) the in-SQL NOT-EXISTS charge is exactly-once (no double-charge on shared
//       refs across serialized same-account batches), and
//   (b) an over-cap statement FAILS (the accounts_cap_guard trigger RAISE(ABORT)s)
//       and rolls back the WHOLE batch() — catalog + grant + charge all revert.
// (Miniflare's D1 is real SQLite; a one-shot confirmation on rbox-dev-api should
//  follow before merge, but this is the tight loop.)

const db = () => env.rbox_dev_db;
const NOW = 1_700_000_000_000;

// The §23.4 commit accounting batch for one account + ref set, as the design spells
// it: catalog(present=0) → charge(NOT-EXISTS) → grant(refresh granted_at).
function commitBatch(acct: string, refs: { sha: string; size: number }[], now = NOW) {
  const shas = refs.map((r) => r.sha);
  const inList = shas.map(() => "?").join(",");
  return [
    db()
      .prepare(
        `INSERT OR IGNORE INTO blobs(sha256, size_bytes, present) VALUES ${refs
          .map(() => "(?,?,0)")
          .join(",")}`,
      )
      .bind(...refs.flatMap((r) => [r.sha, r.size])),
    db()
      .prepare(
        `UPDATE accounts SET used_bytes = used_bytes + (
           SELECT COALESCE(SUM(b.size_bytes),0) FROM blobs b
            WHERE b.sha256 IN (${inList})
              AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.account_id=? AND r.sha256=b.sha256))
         WHERE id = ?`,
      )
      .bind(...shas, acct, acct),
    db()
      .prepare(
        `INSERT INTO blob_refs(account_id, sha256, granted_at) VALUES ${refs
          .map(() => "(?,?,?)")
          .join(",")}
         ON CONFLICT(account_id, sha256) DO UPDATE SET granted_at=excluded.granted_at`,
      )
      .bind(...refs.flatMap((r) => [acct, r.sha, now])),
  ];
}

async function mkAccount(id: string, capBytes: number) {
  await db()
    .prepare(
      `INSERT INTO accounts(id, plan, created_at, used_bytes, extra_storage_bytes, cap_bytes)
       VALUES (?, 'pro', ?, 0, 0, ?)`,
    )
    .bind(id, NOW, capBytes)
    .run();
}
const used = async (id: string) =>
  Number((await db().prepare("SELECT used_bytes FROM accounts WHERE id=?").bind(id).first())!.used_bytes);
const refCount = async (id: string) =>
  Number(
    (await db().prepare("SELECT COUNT(*) c FROM blob_refs WHERE account_id=?").bind(id).first())!.c,
  );

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await db().batch([
    db().prepare("DELETE FROM blob_refs"),
    db().prepare("DELETE FROM blobs"),
    db().prepare("DELETE FROM accounts"),
  ]);
});

describe("§23.6 spike (a): in-SQL NOT-EXISTS charge is exactly-once", () => {
  it("two sequential commits sharing a ref charge the shared ref once", async () => {
    await mkAccount("acc", 1_000_000);
    await db().batch(commitBatch("acc", [{ sha: "x", size: 10 }, { sha: "y", size: 20 }]));
    expect(await used("acc")).toBe(30);
    // commit 2 re-references x (already entitled) + new z → only z charged
    await db().batch(commitBatch("acc", [{ sha: "x", size: 10 }, { sha: "z", size: 30 }]));
    expect(await used("acc")).toBe(60); // 30 + 30, NOT 70
    expect(await refCount("acc")).toBe(3); // x,y,z once each
  });

  it("re-committing the exact same refs charges zero (idempotent retry)", async () => {
    await mkAccount("acc", 1_000_000);
    const refs = [{ sha: "x", size: 10 }, { sha: "y", size: 20 }];
    await db().batch(commitBatch("acc", refs));
    await db().batch(commitBatch("acc", refs)); // retry
    expect(await used("acc")).toBe(30);
    expect(await refCount("acc")).toBe(2);
  });

  it("concurrent same-account batches sharing a ref serialize → charged once", async () => {
    await mkAccount("acc", 1_000_000);
    // A:{x,y}  B:{x,z}  fired together. D1 serializes per-DB, so the union is
    // charged exactly once: 10+20+30 = 60, never 70.
    await Promise.all([
      db().batch(commitBatch("acc", [{ sha: "x", size: 10 }, { sha: "y", size: 20 }])),
      db().batch(commitBatch("acc", [{ sha: "x", size: 10 }, { sha: "z", size: 30 }])),
    ]);
    expect(await used("acc")).toBe(60);
    expect(await refCount("acc")).toBe(3);
  });

  it("the granted_at lease is refreshed on a re-grant", async () => {
    await mkAccount("acc", 1_000_000);
    await db().batch(commitBatch("acc", [{ sha: "x", size: 10 }], NOW));
    await db().batch(commitBatch("acc", [{ sha: "x", size: 10 }], NOW + 5000));
    const g = Number(
      (await db().prepare("SELECT granted_at FROM blob_refs WHERE sha256='x'").first())!.granted_at,
    );
    expect(g).toBe(NOW + 5000);
    expect(await used("acc")).toBe(10); // still charged once
  });
});

describe("§23.6 spike (b): over-cap trigger aborts the WHOLE batch", () => {
  it("an over-cap charge fails the statement and rolls back catalog + grant + charge", async () => {
    await mkAccount("acc", 25); // cap 25; the commit wants 30 → must abort
    await expect(
      db().batch(commitBatch("acc", [{ sha: "x", size: 10 }, { sha: "y", size: 20 }])),
    ).rejects.toThrow(/over_cap|ABORT|constraint/i);
    // NOTHING persisted — the batch is atomic.
    expect(await used("acc")).toBe(0);
    expect(await refCount("acc")).toBe(0);
    const blobs = Number((await db().prepare("SELECT COUNT(*) c FROM blobs").first())!.c);
    expect(blobs).toBe(0);
  });

  it("a commit that exactly fits the cap succeeds", async () => {
    await mkAccount("acc", 30);
    await db().batch(commitBatch("acc", [{ sha: "x", size: 10 }, { sha: "y", size: 20 }]));
    expect(await used("acc")).toBe(30);
  });

  it("an all-already-entitled commit (0 new bytes) on an at-cap account still succeeds", async () => {
    await mkAccount("acc", 30);
    await db().batch(commitBatch("acc", [{ sha: "x", size: 30 }]));
    expect(await used("acc")).toBe(30); // at cap
    // re-commit same ref → newBytes=0 → no-op UPDATE must NOT trip the guard
    await db().batch(commitBatch("acc", [{ sha: "x", size: 30 }]));
    expect(await used("acc")).toBe(30);
  });

  it("a refund (decrease) on an over-cap account is allowed (guard only blocks increases)", async () => {
    await mkAccount("acc", 100);
    await db().batch(commitBatch("acc", [{ sha: "x", size: 80 }]));
    // simulate the cap being lowered below usage, then a reconcile refund
    await db().prepare("UPDATE accounts SET cap_bytes=50 WHERE id='acc'").run();
    await db().prepare("UPDATE accounts SET used_bytes = used_bytes - 30 WHERE id='acc'").run();
    expect(await used("acc")).toBe(50);
  });
});

// §30: the REAL commitAccounting (not the inline helper) across MORE refs than fit in one
// atomic super-batch (MAX_REFS_PER_TXN=3000). Proves the multi-batch loop charges/grants
// every ref exactly once, is idempotent on retry, and — over cap — keeps the completed
// super-batches charged (codex-endorsed "no compensation; idempotent retry") instead of
// rolling the whole commit back.
describe("§30 large-ref multi-batch accounting (real commitAccounting)", () => {
  const refs = (n: number, size = 10, off = 0) =>
    Array.from({ length: n }, (_, i) => ({ sha: `r${off + i}`, size, receiptExpiresAt: Date.now() + RECEIPT_TTL_MS }));

  it("charges/grants every ref across 3+ super-batches, exactly once", async () => {
    await mkAccount("acc", 10_000_000);
    const N = 6500; // > 2·MAX_REFS_PER_TXN → 3 super-batches
    const res = await commitAccounting(db(), "acc", refs(N), NOW);
    expect(res).toEqual({ ok: true });
    expect(await used("acc")).toBe(N * 10);
    expect(await refCount("acc")).toBe(N);
  });

  it("is idempotent: re-running the same large set charges 0 new bytes", async () => {
    await mkAccount("acc", 10_000_000);
    const set = refs(6500);
    await commitAccounting(db(), "acc", set, NOW);
    const res2 = await commitAccounting(db(), "acc", set, NOW + 1000); // retry (e.g. after a head 409)
    expect(res2).toEqual({ ok: true });
    expect(await used("acc")).toBe(6500 * 10); // unchanged
    expect(await refCount("acc")).toBe(6500);
  });

  it("over-cap mid-loop keeps completed super-batches charged (no rollback)", async () => {
    // cap fits the first super-batch (3000·10=30000) but not the second.
    await mkAccount("acc", 35_000);
    const res = await commitAccounting(db(), "acc", refs(6000), NOW);
    expect(res).toHaveProperty("overCap");
    // The first super-batch persisted; the second rolled back. NOT 0 (no compensation),
    // NOT 60000 (the guard stopped the over-cap batch).
    expect(await used("acc")).toBe(30_000);
    expect(await refCount("acc")).toBe(3000);
  });

  it("a retry after an over-cap partial, once cap is raised, completes the rest", async () => {
    await mkAccount("acc", 35_000);
    const set = refs(6000);
    await commitAccounting(db(), "acc", set, NOW); // partial: 3000 charged
    expect(await used("acc")).toBe(30_000);
    await db().prepare("UPDATE accounts SET cap_bytes=100000 WHERE id='acc'").run();
    const res2 = await commitAccounting(db(), "acc", set, NOW + 1000); // re-run: first 3000 charge 0, rest complete
    expect(res2).toEqual({ ok: true });
    expect(await used("acc")).toBe(60_000); // all 6000 now
    expect(await refCount("acc")).toBe(6000);
  });
});

// §30 codex BLOCKER 5: an account inserted without cap_bytes must NOT end up unguarded.
describe("§30 cap_bytes is materialized on insert (0016 trigger)", () => {
  const capOf = async (id: string) =>
    Number((await db().prepare("SELECT cap_bytes FROM accounts WHERE id=?").bind(id).first())!.cap_bytes);

  it("a tenant insert omitting cap_bytes gets its plan cap (none=1B), guard active", async () => {
    await db().prepare("INSERT INTO accounts(id, plan, created_at) VALUES ('t1','none',?)").bind(NOW).run();
    expect(await capOf("t1")).toBe(1);
    // and the guard is now live: a charge over 1 byte aborts
    await expect(
      db().batch(commitBatch("t1", [{ sha: "big", size: 2 }])),
    ).rejects.toThrow(/over_cap|ABORT|constraint/i);
  });

  it("a 'pro' insert omitting cap_bytes gets 250GiB", async () => {
    await db().prepare("INSERT INTO accounts(id, plan, created_at) VALUES ('t2','pro',?)").bind(NOW).run();
    expect(await capOf("t2")).toBe(250 * 1024 * 1024 * 1024);
  });

  it("the platform 'default' account stays cap_bytes=0 (deliberate unlimited)", async () => {
    await db().prepare("INSERT INTO accounts(id, plan, created_at) VALUES ('default','none',?)").bind(NOW).run();
    expect(await capOf("default")).toBe(0);
  });
});
