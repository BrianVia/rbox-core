import type { Env } from "./env.js";
import { audit, type Principal } from "./authz.js";
import { reconcileGenesisRepairAudits } from "./genesis-repair.js";
import { ctEqual, json, logErr, chunked } from "./util.js";
import { dbFor, dirDb } from "./db.js";
import { purgeStripeForAccount } from "./stripe.js";
import { deleteClerkUser } from "./clerk.js";
import { purgeDiagnosticR2 } from "./diagnostics.js";

/**
 * Self-serve account + data deletion (design 37). `DELETE /v1/account` is OWNER-ONLY and
 * confirmation-gated. It does NOT erase synchronously (the Worker has no
 * ExecutionContext/`waitUntil`, and a full purge can touch thousands of R2 objects).
 * Instead it TOMBSTONES atomically — stamps `accounts.deleted_at`, revokes every device,
 * and writes the durable `account_deletions` work-ledger — then the cron backstop (and the
 * optional `ACCOUNT_DELETE_Q`) hard-purge once the grace window elapses, in bounded
 * re-entrant chunks. The ledger row is the source of truth; every step is idempotent.
 *
 * §32 D1 routing: account-DATA tables (accounts, blob_refs/blobs/gc_candidates, workspaces/
 * uploads/upload_parts, the key/roster store, device_notifications + deliveries,
 * account_notify_prefs, audit_log, commits, the `account_deletions` ledger, the WorkspaceSync
 * DO) go through `dbFor(env, accountId)`; DIRECTORY tables (devices, memberships, users,
 * pairing_tokens, device_auth, clerk_users, account_link_*) go through `dirDb(env)`. The
 * global ledger scan (no account in scope) uses `dbFor(env, "")`. At N=1 every helper resolves
 * to the one binding, so the mixed-plane atomic batches below are behavior-preserving.
 */

/** Recovery grace before the irreversible hard-purge (design 37 §3). Tombstone is
 *  immediate; bytes are erased only at/after `purge_after`. Set 0 to purge next cron tick. */
export const DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const LEASE_MS = 60 * 1000; // a 'purging' claim older than this is a dead lease (re-claimable)
const SHA_BATCH = 1000; // blob_refs processed per drive chunk (pure D1: delete refs + condemn orphans)
const UP_BATCH = 100; // in-flight uploads (MPU abort + staging delete) per chunk
const WS_BATCH = 100; // workspaces (DO purge) per chunk
const DIAG_BATCH = 100; // plaintext support diagnostics (R2 delete + D1 handle) per chunk
const IN_CHUNK = 80; // SQLite bound-variable safety for `... IN (?,?,…)`
// No-queue cron drain cap per account per tick (subrequest budget). With ACCOUNT_DELETE_Q a
// large purge continues promptly across queue messages; WITHOUT it the daily cron resumes the
// durable ledger this-many chunks per tick — correct + bounded, but a multi-million-blob
// account erases over several daily ticks (design 37 §7 SLA note). The parent provisions the
// queue for the prompt path.
const MAX_CHUNKS_PER_TICK = 8;

/** Outcome of one bounded `driveAccountDeletion` chunk. */
export type DriveResult = "done" | "progress" | "blocked" | "skip";

/** The external-erasure steps (Stripe + Clerk), injected so the drain's D1/R2 logic is
 *  testable without real network I/O. Both return true on success (idempotent) / false to
 *  make the drain back off and retry. Production uses `REAL_PURGE_DEPS`. */
export interface PurgeDeps {
  purgeStripe: (env: Env, subscriptionId: string | null, customerId: string | null) => Promise<boolean>;
  deleteClerk: (env: Env, clerkUserId: string) => Promise<boolean>;
  /** Wipe one workspace's authoritative commit log (the WorkspaceSync DO). Returns true on
   *  success / false to retry. Injected because the DO's SQLite storage isn't available in
   *  the test runtime; production uses `purgeWorkspaceDO`. */
  purgeWorkspace: (env: Env, ws: string, proj: string) => Promise<boolean>;
  /** Abort the in-flight MPU AND delete its staging object. Returns true ONLY if BOTH
   *  effectively succeeded (an already-gone MPU / absent staging object counts as success);
   *  false on ANY transient R2 failure → the caller keeps the `uploads` D1 handle and retries.
   *  Injected so the fail-closed behavior is testable; production uses `purgeUploadR2`. */
  purgeUpload: (env: Env, stagingKey: string, uploadId: string) => Promise<boolean>;
  /** Delete one plaintext diagnostics report object from R2. Returns false on transient R2
   *  failure so the D1 row stays as the retry handle. */
  purgeDiagnostic?: (env: Env, r2Key: string) => Promise<boolean>;
}

/** True ONLY for a CONCRETE "this multipart upload is already gone" signal — R2 `NoSuchUpload`
 *  (error code 10024) or an explicit already-completed/already-aborted. Deliberately NARROW: a
 *  generic/internal R2 error (e.g. 10001) or any 5xx/network failure must NOT be read as success
 *  — it is transient, so the caller keeps the D1 handle and retries. (A broad "does not
 *  exist"/"not found" substring match would mis-read a generic failure whose text happens to
 *  contain that wording as success → drop the retry handle → strand MPU parts.) */
function mpuAlreadyGone(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  return /\bNoSuchUpload\b|\(10024\)|already (been )?(completed|aborted)/i.test(msg);
}

/** Real upload R2 cleanup (design 37 §4f, FAIL-CLOSED for BOTH the abort and the staging
 *  delete). A transient abort failure (R2 5xx) must NOT let us drop the `uploads` row — the
 *  uploaded MPU parts would sit in R2 with no retry handle. Returns true only once R2 has
 *  actually released the MPU and removed the staging object. */
export async function purgeUploadR2(env: Env, stagingKey: string, uploadId: string): Promise<boolean> {
  try {
    await env.rbox_dev_blobs.resumeMultipartUpload(stagingKey, uploadId).abort();
  } catch (e) {
    if (!mpuAlreadyGone(e)) {
      logErr("account_delete_mpu_abort_failed", e); // transient → keep the handle, retry
      return false;
    }
    // already gone → idempotent success; fall through to the staging-object delete
  }
  try {
    await env.rbox_dev_blobs.delete(stagingKey); // throws on a real R2 failure
  } catch (e) {
    logErr("account_delete_staging_r2_failed", e);
    return false;
  }
  return true;
}

/** Real DO purge: POST a FIXED `/purge` path → `ctx.storage.deleteAll()` (design 37 §4g).
 *  The DO is addressed by `idFromName(ws/proj)` (the same canonical key commit uses), and the
 *  request path is the constant `/purge` — NOT `…/ws/:ws/proj/:proj/purge`. Embedding a
 *  user-chosen `projectId` in a positionally-parsed path lets a `proj` containing `/`
 *  mis-parse the action segment → a 404 → the driver loops forever (the §3 wedge). A fixed
 *  path can't mis-parse for ANY projectId; deleteAll needs no ws/proj. */
export async function purgeWorkspaceDO(env: Env, ws: string, proj: string): Promise<boolean> {
  const id = env.WORKSPACE_SYNC.idFromName(`${ws}/${proj}`);
  const res = await env.WORKSPACE_SYNC.get(id).fetch("https://do/purge", { method: "POST" });
  return res.ok;
}

export const REAL_PURGE_DEPS: PurgeDeps = { purgeStripe: purgeStripeForAccount, deleteClerk: deleteClerkUser, purgeWorkspace: purgeWorkspaceDO, purgeUpload: purgeUploadR2, purgeDiagnostic: purgeDiagnosticR2 };

// ── DELETE /v1/account (owner-only, confirmation-gated) ──────────────────────

interface AcctRow {
  deleted_at: number | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

/** `DELETE /v1/account` — tombstone + schedule the purge. Owner-only; idempotent. */
export async function deleteAccount(env: Env, p: Principal, req: Request, nowMs: number = Date.now()): Promise<Response> {
  // Owner-only: role from the membership join, re-verified against a live owner row so a
  // viewer-by-absence default ('viewer') or a since-removed user can never reach the purge.
  // memberships is directory-plane.
  if (p.role !== "owner" || !p.userId) return json({ error: "forbidden", message: "account deletion requires an owner" }, 403);
  const owner = await dirDb(env)
    .prepare("SELECT 1 FROM memberships WHERE account_id = ? AND user_id = ? AND role = 'owner'")
    .bind(p.accountId, p.userId)
    .first();
  if (!owner) return json({ error: "forbidden", message: "account deletion requires an owner" }, 403);

  const acct = await dbFor(env, p.accountId)
    .prepare("SELECT deleted_at, stripe_customer_id, stripe_subscription_id FROM accounts WHERE id = ?")
    .bind(p.accountId)
    .first<AcctRow>();
  if (!acct) return json({ error: "not_found" }, 404);

  // Idempotent: already tombstoned → echo status, never re-stamp (grace not extended).
  if (acct.deleted_at !== null) {
    const row = await dbFor(env, p.accountId).prepare("SELECT purge_after FROM account_deletions WHERE account_id = ?").bind(p.accountId).first<{ purge_after: number }>();
    return json({ status: "pending", deletedAt: acct.deleted_at, purgeAfter: row?.purge_after ?? acct.deleted_at + DELETION_GRACE_MS });
  }

  // Confirmation gate: re-type the owner's verified email OR the account id (§5).
  const body = (await req.json().catch(() => ({}))) as { confirm?: unknown };
  const confirm = typeof body.confirm === "string" ? body.confirm : "";
  const match = await confirmationMatches(env, p.accountId, confirm);
  if (!match.ok) return json({ error: "confirmation_mismatch", message: "type your account email or account id to confirm deletion" }, 400);

  const purgeAfter = nowMs + DELETION_GRACE_MS;
  // §32 FLAG: one atomic batch spanning planes — `accounts` + the `account_deletions` ledger
  // (account-data) and the `devices` revoke (directory). Each statement is built via its plane
  // helper; the batch runs on the account-data binding (the tombstone is the headline). One
  // atomic write at N=1; a future cross-plane saga (dirDb revoke + dbFor tombstone) under
  // sharding. Access dies the instant this returns; the irreversible purge waits for purge_after.
  const data = dbFor(env, p.accountId);
  await data.batch([
    data.prepare("UPDATE accounts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").bind(nowMs, p.accountId),
    dirDb(env).prepare("UPDATE devices SET revoked = 1 WHERE account_id = ? AND revoked = 0").bind(p.accountId),
    dirDb(env).prepare(
      "UPDATE key_delivery SET state='expired',wrap_blob=NULL,published_roster_version=NULL WHERE account_id=? AND state IN ('queued','fulfilled')",
    ).bind(p.accountId),
    dirDb(env).prepare("DELETE FROM device_token_escrow WHERE account_id=?").bind(p.accountId),
    data
      .prepare("INSERT OR IGNORE INTO account_deletions (account_id, requested_at, purge_after, status, confirmed_with) VALUES (?, ?, ?, 'pending', ?)")
      .bind(p.accountId, nowMs, purgeAfter, match.with),
  ]);
  await audit(env, p, "account.delete.request", p.accountId);
  return json({ status: "pending", deletedAt: nowMs, purgeAfter });
}

/** The confirmation value matches the owner's verified email (cached on clerk_users) OR
 *  the literal account id. Normalized (trim+lowercase), constant-time. The account id
 *  fallback covers a pure-CLI account with no email on file (§5). clerk_users is directory-plane. */
async function confirmationMatches(env: Env, accountId: string, confirm: string): Promise<{ ok: false } | { ok: true; with: string }> {
  const c = confirm.trim().toLowerCase();
  if (c.length === 0) return { ok: false };
  if (ctEqual(c, accountId.trim().toLowerCase())) return { ok: true, with: "account_id" };
  const row = await dirDb(env).prepare("SELECT email FROM clerk_users WHERE account_id = ? AND email IS NOT NULL LIMIT 1").bind(accountId).first<{ email: string }>();
  if (row?.email && ctEqual(c, row.email.trim().toLowerCase())) return { ok: true, with: "email" };
  return { ok: false };
}

// ── the drain (bounded, re-entrant, idempotent) ──────────────────────────────

/** Advance one account's hard-purge by a bounded chunk. Returns:
 *   - "done": fully erased (ledger marked done);
 *   - "progress": a chunk landed and more remains — lease RELEASED so the caller may
 *     continue immediately (queue re-enqueue / inline loop);
 *   - "blocked": claimed but an external (Stripe/Clerk) step failed — lease HELD so the
 *     retry backs off (cron re-drives next tick);
 *   - "skip": nothing to do (not due / not ours / a fresh lease held elsewhere / done). */
export async function driveAccountDeletion(env: Env, accountId: string, nowMs: number = Date.now(), deps: PurgeDeps = REAL_PURGE_DEPS): Promise<DriveResult> {
  const data = dbFor(env, accountId); // the account-data plane for this account
  // Leased claim (the drive mutex): only past-grace, pending-or-stale-purging rows. A
  // concurrent drive holding a fresh lease sees changes==0 → "skip". We stamp a per-driver
  // `lease_token` so ONLY this driver can later release/reset the lease (CAS in
  // `releaseAndProgress`) — a stale driver can't blow away a fresh owner's lease (§6).
  const leaseToken = crypto.randomUUID();
  const claim = await data
    .prepare(
      `UPDATE account_deletions SET status = 'purging', attempts = attempts + 1, last_attempt_at = ?, lease_token = ?
       WHERE account_id = ? AND status IN ('pending','purging') AND purge_after <= ?
         AND (status = 'pending' OR last_attempt_at IS NULL OR last_attempt_at < ?)`,
    )
    .bind(nowMs, leaseToken, accountId, nowMs, nowMs - LEASE_MS)
    .run();
  if ((claim.meta.changes ?? 0) === 0) return "skip";

  // 1. External erasure (idempotent). Capture clerk ids BEFORE the D1 finish deletes them
  //    (needed for the account-link-by-identity cleanup too). accounts=data, clerk_users=directory.
  const acct = await data.prepare("SELECT stripe_customer_id, stripe_subscription_id FROM accounts WHERE id = ?").bind(accountId).first<{ stripe_customer_id: string | null; stripe_subscription_id: string | null }>();
  const clerkRows = await dirDb(env).prepare("SELECT clerk_user_id FROM clerk_users WHERE account_id = ?").bind(accountId).all<{ clerk_user_id: string }>();
  const clerkIds = (clerkRows.results ?? []).map((r) => r.clerk_user_id);
  const deviceRows = await dirDb(env).prepare("SELECT device_id FROM devices WHERE account_id = ?").bind(accountId).all<{ device_id: string }>();
  const deviceIds = (deviceRows.results ?? []).map((r) => r.device_id);

  const stripeOk = await deps.purgeStripe(env, acct?.stripe_subscription_id ?? null, acct?.stripe_customer_id ?? null);
  let clerkOk = true;
  for (const id of clerkIds) clerkOk = (await deps.deleteClerk(env, id)) && clerkOk;
  if (!stripeOk || !clerkOk) {
    logErr("account_delete_external_pending", new Error(`stripe=${stripeOk} clerk=${clerkOk}`));
    return "blocked"; // lease held → cron backs off and retries (external outage self-heals)
  }

  // 2. Canonical blobs (§4f, race-safe). Drop this account's entitlements (`blob_refs`), then
  //    CONDEMN — never inline-delete — any sha now referenced by NO account, by inserting a
  //    `gc_candidates` row. The EXISTING reachability-GC (`versions.ts::gcPurge`) reclaims the
  //    R2 object + `blobs` row on its quiescent sweep, re-checking reachability so a concurrent
  //    re-reference UN-CONDEMNS it (a receipt-PUT writes the canonical object before any D1 ref;
  //    blobPut/commit `DELETE gc_candidates`, resurrecting it). A bespoke inline R2 delete here
  //    would race that write and erase a blob a LIVE account is mid-referencing — so we route
  //    orphans through the GC pipeline instead, inheriting (not widening) its accepted posture.
  //    blob_refs/blobs/gc_candidates are all account-data plane.
  const refRows = await data.prepare("SELECT sha256 FROM blob_refs WHERE account_id = ? LIMIT ?").bind(accountId, SHA_BATCH).all<{ sha256: string }>();
  const shas = (refRows.results ?? []).map((r) => r.sha256);
  if (shas.length > 0) {
    for (const ck of chunked(shas, IN_CHUNK)) {
      await data.prepare(`DELETE FROM blob_refs WHERE account_id = ? AND sha256 IN (${ck.map(() => "?").join(",")})`).bind(accountId, ...ck).run();
    }
    // Condemn the now-orphaned shas (no remaining ref) to the GC pipeline. INSERT…SELECT…WHERE
    // NOT EXISTS is one statement; INSERT OR IGNORE keeps it idempotent (gc_candidates PK = sha).
    for (const ck of chunked(shas, IN_CHUNK)) {
      const ph = ck.map(() => "?").join(",");
      await data
        .prepare(
          `INSERT OR IGNORE INTO gc_candidates (sha256, kind, marked_at)
           SELECT b.sha256, 'blob', ? FROM blobs b
           WHERE b.sha256 IN (${ph}) AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.sha256 = b.sha256)`,
        )
        .bind(nowMs, ...ck)
        .run();
    }
  }

  // 3. In-flight uploads chunk: abort the MPU AND delete the per-upload staging object, FAIL
  //    CLOSED (§2/finding A): `purgeUpload` returns true ONLY once R2 has actually released the
  //    MPU (or it's already gone) AND removed the staging object. We drop the `uploads`/
  //    `upload_parts` D1 rows ONLY on that confirmation — never before — so a transient R2
  //    failure on EITHER the abort or the delete keeps the handle and forces a `progress` retry,
  //    rather than stranding uploaded MPU parts / staging bytes in R2 with no way to retry.
  //    uploads/upload_parts are account-data plane.
  const upRows = await data.prepare("SELECT upload_id, staging_key FROM uploads WHERE account_id = ? LIMIT ?").bind(accountId, UP_BATCH).all<{ upload_id: string; staging_key: string }>();
  let uploadDeleteFailed = false;
  for (const u of upRows.results ?? []) {
    if (!(await deps.purgeUpload(env, u.staging_key, u.upload_id))) {
      uploadDeleteFailed = true;
      continue; // R2 not confirmed clear → keep the D1 handle, retry next chunk
    }
    await data.prepare("DELETE FROM upload_parts WHERE upload_id = ?").bind(u.upload_id).run();
    await data.prepare("DELETE FROM uploads WHERE upload_id = ?").bind(u.upload_id).run();
  }

  // More work remaining (full chunk, leftover rows, or an R2 delete that must be retried) →
  // progress (continue immediately).
  if (shas.length === SHA_BATCH || (upRows.results?.length ?? 0) === UP_BATCH || uploadDeleteFailed) return releaseAndProgress(env, accountId, leaseToken);
  const moreRefs = await data.prepare("SELECT 1 FROM blob_refs WHERE account_id = ? LIMIT 1").bind(accountId).first();
  const moreUps = await data.prepare("SELECT 1 FROM uploads WHERE account_id = ? LIMIT 1").bind(accountId).first();
  if (moreRefs || moreUps) return releaseAndProgress(env, accountId, leaseToken);

  // 4. Plaintext diagnostics reports: delete the R2 object first, then drop its D1 row.
  //    A transient R2 failure keeps the row as the retry handle and releases the lease for
  //    the next chunk/backstop, matching the upload purge fail-closed pattern above.
  const diagRows = await data.prepare("SELECT id, r2_key FROM diagnostics_reports WHERE account_id = ? LIMIT ?").bind(accountId, DIAG_BATCH).all<{ id: string; r2_key: string }>();
  let diagDeleteFailed = false;
  for (const d of diagRows.results ?? []) {
    const purgeDiagnostic = deps.purgeDiagnostic ?? purgeDiagnosticR2;
    if (!(await purgeDiagnostic(env, d.r2_key))) {
      diagDeleteFailed = true;
      continue;
    }
    await data.prepare("DELETE FROM diagnostics_reports WHERE id = ? AND account_id = ?").bind(d.id, accountId).run();
  }
  if ((diagRows.results?.length ?? 0) === DIAG_BATCH || diagDeleteFailed) return releaseAndProgress(env, accountId, leaseToken);
  const moreDiag = await data.prepare("SELECT 1 FROM diagnostics_reports WHERE account_id = ? LIMIT 1").bind(accountId).first();
  if (moreDiag) return releaseAndProgress(env, accountId, leaseToken);

  // 5. Durable-Object purge chunk: wipe each workspace's authoritative commit log, then
  //    drop its D1 mirror rows so a retry doesn't re-purge it. workspaces/commits/manifests
  //    are account-data plane.
  const wsRows = await data.prepare("SELECT workspace_id, project_id FROM workspaces WHERE account_id = ? LIMIT ?").bind(accountId, WS_BATCH).all<{ workspace_id: string; project_id: string }>();
  for (const w of wsRows.results ?? []) {
    if (!(await deps.purgeWorkspace(env, w.workspace_id, w.project_id))) {
      logErr("account_delete_do_purge_failed", new Error(`${w.workspace_id}/${w.project_id}`));
      return releaseAndProgress(env, accountId, leaseToken); // retry this workspace on the next chunk
    }
    await data.batch([
      data.prepare("DELETE FROM commits WHERE workspace_id = ? AND project_id = ?").bind(w.workspace_id, w.project_id),
      data.prepare("DELETE FROM manifests WHERE workspace_id = ? AND project_id = ?").bind(w.workspace_id, w.project_id),
      data.prepare("DELETE FROM workspaces WHERE workspace_id = ? AND project_id = ? AND account_id = ?").bind(w.workspace_id, w.project_id, accountId),
    ]);
  }
  if ((wsRows.results?.length ?? 0) === WS_BATCH) return releaseAndProgress(env, accountId, leaseToken);
  const moreWs = await data.prepare("SELECT 1 FROM workspaces WHERE account_id = ? LIMIT 1").bind(accountId).first();
  if (moreWs) return releaseAndProgress(env, accountId, leaseToken);

  // 6. D1 finish — every remaining account-scoped table in one atomic batch (accounts last).
  await finishD1(env, accountId, clerkIds, deviceIds, nowMs);
  return "done";
}

/** Release the lease so the next claim continues immediately (progress, not failure). CAS on
 *  `lease_token` (§6): only the driver that holds the lease may reset it — a stale driver whose
 *  lease was already stolen finds changes==0 and leaves the fresh owner's lease intact.
 *  account_deletions is account-data plane. */
async function releaseAndProgress(env: Env, accountId: string, leaseToken: string): Promise<DriveResult> {
  await dbFor(env, accountId)
    .prepare("UPDATE account_deletions SET last_attempt_at = 0 WHERE account_id = ? AND status = 'purging' AND lease_token = ?")
    .bind(accountId, leaseToken)
    .run()
    .catch(() => {});
  return "progress";
}

/** Delete every remaining account-scoped row (design 37 §4a–4e) atomically, accounts last,
 *  and mark the ledger done. Set-based + idempotent: re-running deletes nothing.
 *
 *  §32 FLAG: this batch spans BOTH planes — account-data tables (notification ledger, key
 *  store, blob/upload/workspace pointers, audit_log, accounts, the deletion ledger) and
 *  directory tables (devices, memberships, users, pairing_tokens, device_auth, clerk_users,
 *  account_link_*). Each statement is built via its plane helper; the batch runs on the
 *  account-data binding (the data erasure is the headline). One atomic write at N=1; under real
 *  sharding §6a splits it into a dirDb directory-purge + a dbFor(shard) data-purge. */
export async function finishD1(env: Env, accountId: string, clerkIds: string[], deviceIds: string[], nowMs: number): Promise<void> {
  await reconcileGenesisRepairAudits(env, accountId);
  const a = accountId;
  const data = dbFor(env, a); // account-data plane
  const dir = dirDb(env); // directory plane
  const stmts: D1PreparedStatement[] = [
    data.prepare(`UPDATE genesis_repair_audit SET
      account_id=NULL,operator=NULL,reason=NULL,observed_classification=NULL,proof_json=NULL,
      original_claim_present=NULL,original_claim_snapshot=NULL,original_recovery_wrap=NULL,original_recovery_wrap_id=NULL,
      original_created_at=NULL,original_genesis_device_id=NULL,original_repair_id=NULL,original_repaired_at=NULL,
      completion_observation_json=NULL,scrubbed_at=?
      WHERE account_id=? AND outcome<>'attempted' AND completed_at IS NOT NULL AND scrubbed_evidence_sha256 IS NOT NULL`)
      .bind(nowMs,a),
    // notification_deliveries BEFORE its device_notifications parent (subquery needs it). (data)
    data.prepare("DELETE FROM notification_deliveries WHERE token_hash IN (SELECT token_hash FROM device_notifications WHERE account_id = ?)").bind(a),
    data.prepare("DELETE FROM device_notifications WHERE account_id = ?").bind(a),
    data.prepare("DELETE FROM account_notify_prefs WHERE account_id = ?").bind(a),
    // SPEC-PER-ACCOUNT-LATENCY: per-account latency rollup (account-scoped, data plane).
    data.prepare("DELETE FROM account_op_latency WHERE account_id = ?").bind(a),
    data.prepare("DELETE FROM device_keys WHERE account_id = ?").bind(a),
    data.prepare("DELETE FROM account_keys WHERE account_id = ? AND NOT EXISTS (SELECT 1 FROM genesis_repair_audit WHERE account_id = ?)").bind(a,a),
    data.prepare("DELETE FROM workspace_keys WHERE account_id = ?").bind(a),
    data.prepare("DELETE FROM rosters WHERE account_id = ?").bind(a),
    data.prepare("DELETE FROM account_key_states WHERE account_id = ?").bind(a),
    // Device ownership is directory-plane, so use the scoped prefetch and erase
    // these data-plane rows before the directory DELETE FROM devices below.
    ...chunked(deviceIds, IN_CHUNK).map((ids) =>
      data.prepare(`DELETE FROM device_sync_state WHERE device_id IN (${ids.map(() => "?").join(",")})`).bind(...ids),
    ),
    ...chunked(deviceIds, IN_CHUNK).map((ids) =>
      data.prepare(`DELETE FROM alert_state WHERE device_id IN (${ids.map(() => "?").join(",")})`).bind(...ids),
    ),
    // directory plane:
    dir.prepare("DELETE FROM pairing_tokens WHERE account_id = ?").bind(a),
    dir.prepare("DELETE FROM device_token_escrow WHERE account_id = ?").bind(a),
    dir.prepare("DELETE FROM key_delivery WHERE account_id = ?").bind(a),
    dir.prepare("DELETE FROM account_key_delivery_prefs WHERE account_id = ?").bind(a),
    dir.prepare("DELETE FROM device_auth WHERE account_id = ?").bind(a),
    dir.prepare("DELETE FROM api_keys WHERE account_id = ?").bind(a),
    dir.prepare("DELETE FROM devices WHERE account_id = ?").bind(a),
    dir.prepare("DELETE FROM memberships WHERE account_id = ?").bind(a),
    dir.prepare("DELETE FROM users WHERE account_id = ?").bind(a),
    dir.prepare("DELETE FROM clerk_users WHERE account_id = ?").bind(a),
    // audit_log (data): rows written WITH this account_id, PLUS platform rows (billing.ts
    // adminSetPlan) that store the account id in `target` with account_id NULL — `target` is
    // `<acct>` or `<acct>:<plan>` (§5b). Workspace/device targets ride on rows that carry account_id.
    data.prepare("DELETE FROM audit_log WHERE account_id = ? OR target = ? OR target LIKE ?").bind(a, a, `${a}:%`),
    // account-linking artifacts naming this account (directory plane)…
    dir.prepare("DELETE FROM account_link_events WHERE from_account = ? OR to_account = ?").bind(a, a),
    dir.prepare("DELETE FROM account_link_codes WHERE origin_account = ? OR pending_account = ?").bind(a, a),
    // …and any keyed by the erased Clerk identity (one row per uq_clerk_users_account).
    ...clerkIds.flatMap((id) => [
      dir.prepare("DELETE FROM account_link_events WHERE clerk_user_id = ?").bind(id),
      dir.prepare("DELETE FROM account_link_codes WHERE clerk_user_id = ?").bind(id),
    ]),
    // Defensive: any leftover R2-pointer rows (should already be empty post-chunks). (data)
    data.prepare("DELETE FROM blob_refs WHERE account_id = ?").bind(a),
    // §33: blob_ref_candidates is a per-account Phase-1 prune marker (account-data plane). It's
    // account-scoped, so full erasure must drop it too — else a deleted account leaks orphan
    // markers (some referencing the blob_refs rows we just removed). Same treatment as the
    // account-link reclaim path (account-link.ts).
    data.prepare("DELETE FROM blob_ref_candidates WHERE account_id = ?").bind(a),
    // Design 149 observe-only scan ledger. Child/working relations precede the
    // epoch row; scheduler and deploy-floor metadata are global and survive.
    data.prepare("DELETE FROM fairuse_materialize_refs WHERE account_id = ?").bind(a),
    data.prepare("DELETE FROM fairuse_root_membership WHERE account_id = ?").bind(a),
    data.prepare("DELETE FROM fairuse_sha_last WHERE account_id = ?").bind(a),
    data.prepare("DELETE FROM fairuse_workspace_streams WHERE account_id = ?").bind(a),
    data.prepare("DELETE FROM fairuse_scans WHERE account_id = ?").bind(a),
    data.prepare("DELETE FROM fairuse_leases WHERE account_id = ?").bind(a),
    data.prepare("DELETE FROM fairuse_account_queue WHERE account_id = ?").bind(a),
    data.prepare("DELETE FROM uploads WHERE account_id = ?").bind(a),
    data.prepare("DELETE FROM workspaces WHERE account_id = ?").bind(a),
    data.prepare("DELETE FROM diagnostics_reports WHERE account_id = ?").bind(a),
    // The account row LAST, then close the ledger. (data)
    data.prepare("DELETE FROM accounts WHERE id = ?").bind(a),
    data.prepare(`UPDATE account_deletions SET status='done',last_attempt_at=? WHERE account_id=?
      AND NOT EXISTS (SELECT 1 FROM genesis_repair_audit WHERE account_id=?)`).bind(nowMs,a,a),
  ];
  const results = await data.batch(stmts);
  if ((results.at(-1)?.meta.changes ?? 0) === 0) {
    await reconcileGenesisRepairAudits(env, accountId);
    const blocked = await data.prepare("SELECT 1 FROM genesis_repair_audit WHERE account_id=?").bind(accountId).first();
    if (blocked) throw new Error("genesis repair audit reconciliation blocked account purge completion");
  }
}

// ── cron backstop (worker.ts scheduled) + queue consumer ─────────────────────

/** Daily backstop: drive every past-grace deletion. With the queue, drive once and enqueue
 *  a continuation on progress (prompt, queue-paced). Without it, drain inline up to a chunk
 *  cap per account per tick (subrequest budget) — the durable ledger means the next tick
 *  resumes regardless.
 *
 *  §32 FLAG: the ledger scan has no account in scope (it spans all accounts) → `dbFor(env, "")`,
 *  the one shard at N=1 and a per-shard fan-out under real sharding. Each per-account drive
 *  routes by the row's own accountId. */
export async function sweepAccountDeletions(env: Env, nowMs: number = Date.now(), deps: PurgeDeps = REAL_PURGE_DEPS): Promise<{ drained: number }> {
  const due = await dbFor(env, "")
    .prepare("SELECT account_id FROM account_deletions WHERE status IN ('pending','purging') AND purge_after <= ? ORDER BY purge_after LIMIT 100")
    .bind(nowMs)
    .all<{ account_id: string }>();
  let drained = 0;
  for (const r of due.results ?? []) {
    try {
      let res = await driveAccountDeletion(env, r.account_id, nowMs, deps);
      if (res !== "skip") drained++;
      if (env.ACCOUNT_DELETE_Q) {
        if (res === "progress") await env.ACCOUNT_DELETE_Q.send({ accountId: r.account_id }).catch((e) => logErr("account_delete_enqueue_failed", e));
      } else {
        for (let i = 0; res === "progress" && i < MAX_CHUNKS_PER_TICK; i++) res = await driveAccountDeletion(env, r.account_id, nowMs, deps);
      }
    } catch (e) {
      logErr("account_delete_sweep_failed", e);
    }
  }
  return { drained };
}
