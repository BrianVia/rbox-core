import type { Env } from "./env.js";
import { ctEqual, json, logErr, SHA256_HEX_RE as SHA_RE } from "./util.js";
import { emit as emitMetric, emitDelta, emitRedeemPhases, startOp, type MetricEvent } from "./metrics.js";
import {
  validateCommitRefs,
  commitAccounting,
  CARRIER_REFS,
  MAX_REFS_PER_COMMIT,
  receiptRedeemMax,
  type RefWithSize,
} from "./commit-accounting.js";
import { loadSidecarRaw, resolveSidecarRaw, loadSidecarShaSet } from "./sidecar.js";
import { classifyShadow, DELTA_MAX_REFS, divergenceDigest, FENCE_SET_MAX, mergeAddedShas, mergeSortedUnique, type DeltaResult, type ShadowFlags } from "./commit-delta.js";
import { dbFor } from "./db.js";
import { batchedInLookup } from "./d1-batch.js";
import { refsetShas } from "../../../src/engine/refset.js";
import { readManifestChain } from "../../../src/engine/manifest-chain.js";
import { verifyReceipt } from "./receipts.js";
import {
  MAX_COMMIT_BODY,
  MAX_COMMIT_SPAN,
  MAX_REQUEST_BODY,
  readBodyCapped,
  orderChainFirst,
  readRefMode,
  unsatisfiedBlobsBody,
  type CommitBodyView,
  type SignedCommit,
} from "./commit-envelope.js";
import { acceptConnection, broadcast as wsBroadcast } from "./ws-fanout.js";

const ROOTS_PAGE_LIMIT = 20_000;
const ROOTS_OUTER_MAX_REFS = 3_000_000;
const GAP_MAX = 8;
const FOLD_MAX_REFS = 250_000;
const FOLD_CHUNK = 5_000;
const SWEEP_CHUNK = 500;
let isolateFoldActive = false;

function wsMaxSessionMs(env: Env): number {
  const raw = env.RBOX_WS_MAX_SESSION_MS;
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
// Design 102 §3.5B page-class fallback reasons.
const HIGH_SEVERITY_FALLBACKS = new Set(["parent_unreadable", "fence_violation", "delta_error"]);

type IndexState = "building" | "ready" | "lagging";
type FoldCursor = { phase: "removed" | "added"; lastSha: string };
type SqlRow = Record<string, unknown>;

interface ServerTimings {
  totalMs: number;
  envelopeMs: number;
  accountingMs: number;
  sidecarMs: number;
  commitMs: number;
  mirrorMs: number;
  responseMs: number;
}

export async function loadFenceProbe(db: D1Database, accountId: string): Promise<{
  markedSet: Set<string>; intentSet: Set<string>; markedProbeSkipped: boolean; intentOverCap: boolean; observedMarks: number;
}> {
  const [markedRows, intentRows] = await Promise.all([
    db.prepare("SELECT sha256 FROM blob_ref_candidates WHERE account_id = ? LIMIT ?").bind(accountId, FENCE_SET_MAX + 1).all<{ sha256: string }>(),
    db.prepare("SELECT sha256 FROM gc_candidates WHERE deleting_at IS NOT NULL LIMIT ?").bind(FENCE_SET_MAX + 1).all<{ sha256: string }>(),
  ]);
  const markedProbeSkipped = markedRows.results.length > FENCE_SET_MAX;
  return {
    markedSet: markedProbeSkipped ? new Set() : new Set(markedRows.results.map((r) => r.sha256)),
    intentSet: new Set(intentRows.results.map((r) => r.sha256)),
    markedProbeSkipped,
    intentOverCap: intentRows.results.length > FENCE_SET_MAX,
    observedMarks: markedRows.results.length,
  };
}

export function shouldUseDeltaAdmission(deltaMode: string, delta: DeltaResult | undefined, fallback: string | undefined): boolean {
  return deltaMode === "enforce" && !!delta && !fallback && !delta.markedProbeSkipped;
}

async function quotaExceededBody(db: D1Database, accountId: string, overCap: { used: number; cap: number; reason?: "no_plan" }) {
  if (overCap.reason === "no_plan") return { error: "quota_exceeded", used: overCap.used, cap: overCap.cap, reason: "no_plan" as const };
  const row = await db.prepare("SELECT plan FROM accounts WHERE id = ?").bind(accountId).first<{ plan: string }>();
  return { error: "quota_exceeded", used: overCap.used, cap: overCap.cap, ...(row?.plan === "none" ? { reason: "no_plan" as const } : {}) };
}

/**
 * WorkspaceSync — the per-(workspace, project) Durable Object (D2).
 *
 * Two jobs:
 *  1. Authoritative commit sequencer. The Worker's old MAX(sequence)+1 was racy
 *     across an await; here the head check + advance happen in a SYNCHRONOUS
 *     storage transaction (`transactionSync`) with no external I/O inside, so the
 *     DO's single thread makes them genuinely atomic. Blob-existence checks happen
 *     BEFORE the transaction.
 *  2. Live notification fanout over hibernatable WebSockets. Notification-only —
 *     clients never depend on delivery for correctness. (See ws-fanout.ts.)
 *
 * Under full E2EE the server is ZERO-KNOWLEDGE: a commit carries a SIGNED COMMIT
 * ENVELOPE (opaque body + hash + sig), not a plaintext manifest. The DO stores it
 * verbatim and never decrypts or verifies signatures. The envelope's wire types +
 * parsing (caps, capped body read, §24 ref-mode discriminator) live in
 * commit-envelope.ts; this class orchestrates.
 *
 * DO storage (SQLite-backed, synchronous KV): `head` ({sequence, commitHash}),
 * `headWatermark` (highest acked sequence), and `seq:<n>` (JSON of the full
 * SignedCommit). Authoritative; D1 `commits` is a best-effort mirror for
 * cross-workspace queries and explicit repair only.
 */
export class WorkspaceSync {
  private bootstrapped = false;
  private bootstrapPromise?: Promise<void>;
  private repairRequired = false;
  private bootWs = "";
  private bootProj = "";
  private foldPrevCache?: { seq: number; value: { refs: Set<string>; manifestSha: string; carrierSha: string | null } };

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    // Answer protocol-level heartbeats without waking the DO from hibernation.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Account deletion (design 37 §4g): a FIXED, unambiguous path handled BEFORE bootstrap/seed
    // and BEFORE any positional path parsing, so any projectId — including one containing "/" —
    // purges without mis-parsing the action segment (the §3 wedge). deleteAll needs no ws/proj.
    if (req.method === "POST" && url.pathname === "/purge") return this.purge();
    if (req.method === "POST" && url.pathname === "/repair") return this.repair(req, url.searchParams.get("ws") ?? "", url.searchParams.get("proj") ?? "");

    // SERVER-INTERNAL roots/prune (design 37 §4f follow-up): the GC reachability scan and the
    // retention prune address the DO from D1, where project_id may contain "/". A positional
    // `…/proj/:proj/roots` path mis-parses such a projectId → 404 → gcPurge aborts fail-closed
    // and reclaims NOTHING (an indefinite blob leak). So these use a FIXED action path with
    // ws/proj carried in the QUERY (slash-safe), still bootstrap-seeded from D1. The legacy
    // positional handlers below remain for any direct caller.
    if (url.pathname === "/roots" || url.pathname === "/prune") {
      await this.ensureBootstrap(url.searchParams.get("ws") ?? "", url.searchParams.get("proj") ?? "");
      if (this.repairRequired) return this.repairRequiredResponse();
      if (url.pathname === "/roots" && req.method === "GET") return this.roots(url);
      if (url.pathname === "/prune" && req.method === "POST") return this.prune(req);
      return json({ error: "not_found" }, 404);
    }

    const seg = url.pathname.split("/").filter(Boolean); // v1 ws :ws proj :proj <action>
    const ws = seg[2] ?? "";
    const proj = seg[4] ?? "";
    const action = seg[5] ?? "";
    const subaction = seg[6] ?? "";

    await this.ensureBootstrap(ws, proj);
    if (this.repairRequired && action !== "repair") return this.repairRequiredResponse();

    if (action === "connect" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return acceptConnection(this.ctx, url);
    }
    if (action === "latest" && req.method === "GET") return this.latest();
    // C1: the stored SignedCommits for (since, head] so a client can verify the
    // hash-chain forward from its pinned head to latest before applying.
    if (action === "commits" && req.method === "GET") return this.commits(url);
    if (action === "manifests" && req.method === "POST") return this.commit(req, ws, proj);
    if (action === "receipts" && subaction === "redeem" && req.method === "POST") return this.redeemReceipts(req);
    // GET /v1/ws/:ws/proj/:proj/manifests/:seq — a specific historical commit.
    if (seg[5] === "manifests" && seg[6] && req.method === "GET") return this.commitAt(Number(seg[6]));
    // GC support (M6): authoritative retained roots + retention prune.
    if (action === "roots" && req.method === "GET") return this.roots(url);
    if (action === "prune" && req.method === "POST") return this.prune(req);
    if (action === "repair" && req.method === "POST") return this.repair(req, ws, proj);
    return json({ error: "not_found" }, 404);
  }

  // ---- bootstrap (lazy single-flight; the DO can't know ws/proj at construction) ----

  private async ensureBootstrap(ws: string, proj: string): Promise<void> {
    if (this.bootstrapped) return;
    // No await between the check and the assignment → only one doBootstrap runs;
    // every concurrent first-touch request awaits the same promise.
    if (!this.bootstrapPromise) this.bootstrapPromise = this.doBootstrap(ws, proj);
    await this.bootstrapPromise;
  }

  private async doBootstrap(ws: string, proj: string): Promise<void> {
    this.bootWs = ws;
    this.bootProj = proj;
    this.sql().exec("CREATE TABLE IF NOT EXISTS dropped_index (sha256 TEXT PRIMARY KEY, last_seq INTEGER NOT NULL)");
    this.sql().exec("CREATE INDEX IF NOT EXISTS idx_dropped_last ON dropped_index (last_seq)");
    this.sql().exec("CREATE TABLE IF NOT EXISTS seq_roots (seq INTEGER PRIMARY KEY, manifest_sha TEXT NOT NULL, carrier_sha TEXT)");
    const rawHead = this.ctx.storage.kv.get("head") as StoredHead | number | undefined;
    if (typeof rawHead === "number") {
      await this.migrateNumericHead(ws, proj, rawHead);
      if (!this.repairRequired) await this.initializeIndex(rawHead, (this.ctx.storage.kv.get("pruneFloor") as number | undefined) ?? 0);
      this.bootstrapped = true;
      return;
    }
    if (isStoredHead(rawHead)) {
      this.ensureWatermarkAtLeast(rawHead.sequence);
      await this.initializeIndex(rawHead.sequence, (this.ctx.storage.kv.get("pruneFloor") as number | undefined) ?? 0);
      this.bootstrapped = true;
      return;
    }

    const watermark = this.ctx.storage.kv.get("headWatermark") as number | undefined;
    const floor = this.ctx.storage.kv.get("pruneFloor") as number | undefined;
    const hasSeqEvidence = await this.hasRetainedSeqEvidence();
    if (watermark !== undefined || (floor ?? 0) > 0 || hasSeqEvidence) {
      metric(this.env, "bootstrap_head_missing");
      if (hasSeqEvidence) metric(this.env, "head_missing_with_retained_seq");
      this.repairRequired = true;
      this.bootstrapped = true;
      return;
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put("head", { sequence: 0, commitHash: GENESIS_HASH });
      this.ctx.storage.kv.put("headWatermark", 0);
      this.ctx.storage.kv.put("index_synced_seq", 0);
      this.ctx.storage.kv.put("index_generation", 0);
      this.ctx.storage.kv.put("index_state", "ready");
    });
    this.bootstrapped = true;
  }

  private async initializeIndex(head: number, floor: number): Promise<void> {
    if (this.ctx.storage.kv.get("index_state") !== undefined) return;
    this.ctx.storage.transactionSync(() => {
      if (head === 0 && floor === 0) {
        this.ctx.storage.kv.put("index_synced_seq", 0);
        this.ctx.storage.kv.put("index_generation", 0);
        this.ctx.storage.kv.put("index_state", "ready");
      } else {
        this.ctx.storage.kv.put("index_synced_seq", floor);
        this.ctx.storage.kv.put("index_generation", 0);
        this.ctx.storage.kv.put("index_state", "building");
        this.ctx.storage.kv.put("backfill_cursor", floor + 1);
      }
    });
    if (head > floor) await this.armAlarm(Date.now());
  }

  private async migrateNumericHead(_ws: string, _proj: string, seq: number): Promise<void> {
    const hash = this.hashForSeq(seq);
    if (seq > 0 && !hash) {
      this.repairRequired = true;
      metric(this.env, "bootstrap_head_missing");
      return;
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put("head", { sequence: seq, commitHash: hash ?? GENESIS_HASH });
      this.ctx.storage.kv.put("headWatermark", Math.max(seq, (this.ctx.storage.kv.get("headWatermark") as number | undefined) ?? 0));
    });
  }

  private ensureWatermarkAtLeast(seq: number): void {
    const watermark = (this.ctx.storage.kv.get("headWatermark") as number | undefined) ?? seq;
    if (watermark < seq) this.ctx.storage.kv.put("headWatermark", seq);
  }

  private async hasRetainedSeqEvidence(): Promise<boolean> {
    const storage = this.ctx.storage as DurableObjectStorage & { kv?: { list?: (opts?: { prefix?: string; limit?: number }) => Map<string, unknown> | Promise<Map<string, unknown>> } };
    const kvList = storage.kv?.list;
    if (typeof kvList === "function") {
      return (await kvList.call(storage.kv, { prefix: "seq:", limit: 1 })).size > 0;
    }
    const storageList = storage.list;
    if (typeof storageList === "function") {
      return (await storageList.call(storage, { prefix: "seq:", limit: 1 })).size > 0;
    }
    return false;
  }

  // ---- commit (the atomic sequencer) ----

  private async computeCommitDelta(
    db: D1Database,
    accountId: string,
    parent: number,
    commitEpoch: number,
    childBuf: Uint8Array,
    childCount: number,
  ): Promise<{ fallback?: string; delta?: DeltaResult; admitData: string[] }> {
    const phase = (outcome: string, started: number): void => emitDelta(this.env, outcome, { count: Date.now() - started });
    try {
      if (parent === 0) return { fallback: "first_commit", admitData: [] };
      if (childCount > DELTA_MAX_REFS) return { fallback: "refset_too_large", admitData: [] };
      const deleting = await db.prepare("SELECT 1 FROM account_deletions WHERE account_id = ? AND status IN ('pending','purging') LIMIT 1").bind(accountId).first();
      if (deleting) return { fallback: "account_deleting", admitData: [] };

      let parentBuf: Uint8Array;
      try {
        const fetchStarted = Date.now();
        const rawParent = this.ctx.storage.kv.get(`seq:${parent}`) as string | undefined;
        phase("parentFetchMs", fetchStarted);
        if (!rawParent) return { fallback: "parent_unreadable", admitData: [] };
        const parseStarted = Date.now();
        const parentCommit = JSON.parse(rawParent) as SignedCommit;
        const parentBody = JSON.parse(parentCommit.body) as CommitBodyView;
        const parentMode = readRefMode(parentBody);
        phase("parentParseMs", parseStarted);
        if (!parentMode) return { fallback: "parent_unreadable", admitData: [] };
        if (parentBody.accountEpoch !== commitEpoch) return { fallback: "epoch_rotation", admitData: [] };
        if (parentMode.kind === "inline") return { fallback: "parent_not_sidecar", admitData: [] };
        if (parentMode.count > DELTA_MAX_REFS) return { fallback: "refset_too_large", admitData: [] };
        const loaded = await loadSidecarRaw(this.env, parentMode.sidecarSha, parentMode.count);
        if (!loaded.ok || loaded.totalBytes !== parentMode.totalBytes) return { fallback: "parent_unreadable", admitData: [] };
        parentBuf = loaded.buf;
      } catch {
        return { fallback: "parent_unreadable", admitData: [] };
      }

      const fenceStarted = Date.now();
      const probe = await loadFenceProbe(db, accountId);
      phase("fenceQueryMs", fenceStarted);
      if (probe.intentOverCap) return { fallback: "fence_over_cap", admitData: [] };
      const markedProbeSkipped = probe.markedProbeSkipped;
      if (markedProbeSkipped) emitDelta(this.env, "marks_over_cap", { count: probe.observedMarks });
      const diffStarted = Date.now();
      const delta = mergeAddedShas(parentBuf, childBuf, probe.markedSet, probe.intentSet);
      delta.markedProbeSkipped = markedProbeSkipped;
      phase("diffMs", diffStarted);
      if (delta.intentCarriedHit) return { fallback: "fence_violation", admitData: [] };
      emitDelta(this.env, "sizes", { count: delta.addedCount, ratio: delta.carriedCount, bytes: delta.removedCount });
      emitDelta(this.env, "carried_fenced", { count: delta.markedCarried.length });
      return { delta, admitData: mergeSortedUnique(delta.added, delta.markedCarried) };
    } catch {
      return { fallback: "delta_error", admitData: [] };
    }
  }

  private async readShadowFlags(db: D1Database, accountId: string, shas: string[]): Promise<Map<string, ShadowFlags>> {
    const flags = new Map<string, ShadowFlags>();
    await batchedInLookup<{ sha256: string; present: number; entitled: number; marked: number; active_intent: number }>(
      db,
      shas,
      (chunk) => {
        const values = chunk.map(() => "(?)").join(",");
        return db.prepare(`WITH x(sha256) AS (VALUES ${values})
          SELECT x.sha256, CASE WHEN b.present=1 THEN 1 ELSE 0 END present,
            CASE WHEN r.sha256 IS NOT NULL THEN 1 ELSE 0 END entitled,
            CASE WHEN c.sha256 IS NOT NULL THEN 1 ELSE 0 END marked,
            CASE WHEN g.sha256 IS NOT NULL THEN 1 ELSE 0 END active_intent
          FROM x LEFT JOIN blobs b ON b.sha256=x.sha256
          LEFT JOIN blob_refs r ON r.sha256=x.sha256 AND r.account_id=?
          LEFT JOIN blob_ref_candidates c ON c.sha256=x.sha256 AND c.account_id=?
          LEFT JOIN gc_candidates g ON g.sha256=x.sha256 AND g.deleting_at IS NOT NULL`).bind(...chunk, accountId, accountId);
      },
      (rows) => {
        for (const row of rows) flags.set(row.sha256, { present: !!row.present, entitled: !!row.entitled, marked: !!row.marked, activeIntent: !!row.active_intent });
      },
    );
    return flags;
  }

  private async commit(req: Request, ws: string, proj: string): Promise<Response> {
    const startedAt = Date.now();
    const serverTimings: ServerTimings = {
      totalMs: 0,
      envelopeMs: 0,
      accountingMs: 0,
      sidecarMs: 0,
      commitMs: 0,
      mirrorMs: 0,
      responseMs: 0,
    };
    let timingsFinalized = false;
    const metricTimings = (): Pick<MetricEvent, "serverTotalMs" | "envelopeMs" | "accountingMs" | "sidecarMs" | "commitMs" | "mirrorMs" | "responseMs"> => {
      if (!timingsFinalized) serverTimings.totalMs = Date.now() - startedAt;
      return {
        serverTotalMs: serverTimings.totalMs,
        envelopeMs: serverTimings.envelopeMs,
        accountingMs: serverTimings.accountingMs,
        sidecarMs: serverTimings.sidecarMs,
        commitMs: serverTimings.commitMs,
        mirrorMs: serverTimings.mirrorMs,
        responseMs: serverTimings.responseMs,
      };
    };
    const ROUTE = "/v1/ws/:ws/proj/:proj/manifests"; // templated (no ids) for telemetry
    // op.span accumulates this commit's D1 (missingBlobs + mirror, incl. helpers) and
    // DO (transactionSync) time + call count; op.done emits the one metric. Created up
    // front so even the early body_too_large reject is attributed. Pre-op validation
    // guards (bad envelope / non-JSON) return without a metric (the request row covers them).
    const op = startOp(this.env, "commit", ROUTE);
    // §30 (codex r3 MAJOR): bound the body by ACTUAL bytes read — Content-Length is spoofable
    // and absent under chunked/HTTP-2, so a hostile/huge receipts map could otherwise OOM the
    // isolate via req.json(). readBodyCapped aborts the stream past MAX_REQUEST_BODY BEFORE parse.
    const raw = await readBodyCapped(req, MAX_REQUEST_BODY);
    if (raw === null) {
      serverTimings.envelopeMs = Date.now() - startedAt;
      op.done("body_too_large", { bytes: MAX_REQUEST_BODY, ...metricTimings() });
      return json({ error: "body_too_large", message: "request body too large", max: MAX_REQUEST_BODY }, 413);
    }
    let body: {
      parentSequence?: number | null;
      commit?: SignedCommit;
      receipts?: Record<string, string>;
    } | null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    const commit = body?.commit;
    // §23.4 — clients on the receipts protocol carry per-sha upload receipts; the
    // commit then does the batched catalog+charge+grant+promote (D1 off the PUT path).
    const useReceipts = req.headers.get("x-rbox-protocol") === "upload-receipts-v1";
    const receipts = body?.receipts ?? {};
    const parent = body?.parentSequence ?? 0;
    // Authenticated account, set by the Worker after authorizeWorkspace (the DO is
    // only reachable via the Worker, which overrides any client-provided value).
    const accountId = req.headers.get("x-rbox-account") ?? "";
    // C4: the account's current key epoch, read by the Worker (MAX(account_epoch))
    // and forwarded. The commit's accountEpoch must equal it (asserted in the txn).
    const currentEpoch = Number(req.headers.get("x-rbox-account-epoch") ?? "0");

    // Envelope shape: three opaque strings. The body is bounded (we store verbatim).
    if (!commit || typeof commit.body !== "string" || typeof commit.commitHash !== "string" || typeof commit.sig !== "string") {
      return json({ error: "bad_request", message: "missing signed commit" }, 400);
    }
    if (commit.body.length > MAX_COMMIT_BODY) {
      // Directly relevant to the commit-body-scaling TODO: track how often bodies
      // hit the cap (the signal that blobRefs need to move out of the signed body).
      serverTimings.envelopeMs = Date.now() - startedAt;
      op.done("body_too_large", { bytes: commit.body.length, ...metricTimings() });
      return json({ error: "body_too_large", message: "commit body too large", count: commit.body.length, max: MAX_COMMIT_BODY }, 400);
    }

    // Parse the body ONLY to read the handful of fields the sequencer needs. We do
    // NOT verify the signature or canonicalization — clients do that on pull.
    let cb: CommitBodyView;
    try {
      cb = JSON.parse(commit.body) as CommitBodyView;
    } catch {
      return json({ error: "bad_request", message: "commit body not JSON" }, 400);
    }
    if (cb.type !== "rbox/commit/v1") return json({ error: "bad_request", message: "bad commit type" }, 400);
    if (typeof cb.encManifestSha !== "string" || !SHA_RE.test(cb.encManifestSha)) return json({ error: "bad_request", message: "bad encManifestSha" }, 400);
    if (!Number.isInteger(cb.seq) || !Number.isInteger(cb.parentSeq) || (cb.seq as number) !== (cb.parentSeq as number) + 1) {
      return json({ error: "bad_request", message: "seq must be parentSeq+1" }, 400);
    }
    const commitSeq = cb.seq as number;
    if (parent !== cb.parentSeq) return json({ error: "bad_request", message: "parentSequence mismatch" }, 400);
    if (!Number.isInteger(cb.accountEpoch)) return json({ error: "bad_request", message: "bad accountEpoch" }, 400);
    const commitEpoch = cb.accountEpoch as number;
    // §24 strict dual-mode: exactly one of inline blobRefs / sidecar descriptor.
    const mode = readRefMode(cb);
    if (!mode) return json({ error: "bad_request", message: "commit must carry exactly one of blobRefs / blobRefset" }, 400);
    // A sidecar commit needs the receipts protocol (its refs come from a receipt-authenticated
    // R2 object resolved at accounting time) — an old/legacy-protocol sidecar can't be charged.
    if (mode.kind === "sidecar" && !useReceipts) return json({ error: "bad_request", message: "blobRefset requires the upload-receipts protocol" }, 400);
    const chainShas = readManifestChain(cb.manifestChain, cb.encManifestSha as string);
    if (chainShas === null) return json({ error: "bad_request", message: "bad manifestChain" }, 400);
    const deviceId = typeof cb.deviceId === "string" ? cb.deviceId : null;
    const bodyBytes = commit.body.length;
    serverTimings.envelopeMs = Date.now() - startedAt;

    // Blob-existence: refuse to advance head past a commit referencing blobs we don't have
    // (the encrypted manifest is itself a normal blob the client uploaded first), or every
    // future pull breaks. 422 → client uploads. For a sidecar commit the data refs come from
    // the resolved sidecar (below); the existence set always includes encManifestSha and,
    // for sidecar commits, sidecarSha itself (so the published head's sidecar is durable).
    let shas!: string[];
    const emit = (count: number) => (outcome: string, extra: Partial<MetricEvent> = {}) => op.done(outcome, {
      bytes: bodyBytes,
      count,
      ...metricTimings(),
      ...extra,
    });

    const timedResponse = (payload: Record<string, unknown>, status: number, outcome: string, emitOutcome: (outcome: string) => void): Response => {
      const responseStartedAt = Date.now();
      const responsePayload = { ...payload };
      serverTimings.responseMs = Date.now() - responseStartedAt;
      serverTimings.totalMs = Date.now() - startedAt;
      timingsFinalized = true;
      responsePayload.serverTimings = { ...serverTimings };
      emitOutcome(outcome);
      return json(responsePayload, status);
    };

    // Design 103 Part A: cheap best-effort staleness fast-path. Returns a finished
    // 409 Response when the commit is ALREADY stale on arrival, else null (proceed to
    // the authoritative CAS). Only fires under the flag; checks ONLY the two predicates
    // the transaction's CAS also applies (parent, then epoch — same order, so a
    // doubly-stale commit classifies `conflict`). It does NOT replicate the
    // watermark-gap branch. `declaredRefs` is the commit's DECLARED ref count from
    // `mode` (no sidecar fetch): the count metric stays meaningful without R2.
    const earlyStaleReject = (declaredRefs: number): Response | null => {
      if (this.env.RBOX_COMMIT_EARLY_REJECT !== "1") return null;
      const head = readHead(this.ctx.storage.kv.get("head"));
      const watermark = (this.ctx.storage.kv.get("headWatermark") as number | undefined) ?? head.sequence;
      if (parent !== head.sequence) {
        // Same equivocation signal the transaction path emits (audit Finding 2).
        const sameSeqHash = commitSeq <= watermark ? this.hashForSeq(commitSeq) : undefined;
        if (sameSeqHash && sameSeqHash !== commit.commitHash) metric(this.env, "same_sequence_different_hash");
        return timedResponse({ error: "conflict", head: head.sequence }, 409, "conflict",
          (o) => emit(declaredRefs)(o, { earlyReject: 1 }));
      }
      if (commitEpoch !== currentEpoch) {
        return timedResponse({ error: "epoch_stale", currentEpoch }, 409, "epoch_stale",
          (o) => emit(declaredRefs)(o, { earlyReject: 1 }));
      }
      return null;
    };

    if (useReceipts) {
      // §23.4 + §24: resolve refs → validate (present=1+entitled OR receipt) → catalog+charge
      // +grant, all BEFORE the head advance (account-then-publish). On head 409 the accounting
      // is already durable (benign: refs entitled+present; retry charges 0).
      const nowMs = Date.now();
      const db = dbFor(op.env, accountId);
      const configuredDeltaMode = this.env.RBOX_COMMIT_DELTA_ADMISSION;
      const deltaMode = configuredDeltaMode === "shadow" || configuredDeltaMode === "enforce" ? configuredDeltaMode : "off";
      const runFullAdmission = async (fullShas: string[]): Promise<Response | null> => {
        shas = fullShas;
        const accountingStartedAt = Date.now();
        const beforeCalls = op.span.dbCalls;
        const v = await validateCommitRefs(this.env, db, accountId, shas, receipts, nowMs);
        serverTimings.accountingMs = Date.now() - accountingStartedAt;
        const emitDeltaAdmission = deltaMode !== "off" && mode.kind === "sidecar";
        if (!v.ok) {
          if (emitDeltaAdmission) emitDelta(this.env, "admit_stmts", { dbCalls: op.span.dbCalls - beforeCalls });
          emit(shas.length)("unsatisfied_blobs", { ratio: v.needsUpload.length / shas.length });
          return json(unsatisfiedBlobsBody(orderChainFirst(v.needsUpload, chainShas)), 422);
        }
        const acct = await commitAccounting(db, accountId, v.newRefs, nowMs);
        serverTimings.accountingMs = Date.now() - accountingStartedAt;
        if (emitDeltaAdmission) {
          emitDelta(this.env, "admit_stmts", { dbCalls: op.span.dbCalls - beforeCalls });
          emitDelta(this.env, "admitAccountMs", { count: serverTimings.accountingMs });
        }
        if ("needsUpload" in acct) {
          emit(shas.length)("unsatisfied_blobs", { ratio: acct.needsUpload.length / shas.length });
          return json(unsatisfiedBlobsBody(orderChainFirst(acct.needsUpload, chainShas)), 422);
        }
        if ("overCap" in acct) {
          emit(shas.length)("quota_exceeded", { bytes: bodyBytes });
          return json(await quotaExceededBody(db, accountId, acct.overCap), 402);
        }
        return null;
      };

      if (mode.kind === "sidecar") {
        // §30: cap the DATA-ref count directly (the 2 carriers — encManifest + sidecar — ride
        // within the multi-batch accounting, no separate budget). Same bound readRefMode applies
        // to count, so no dead band. Cheap reject BEFORE the R2 fetch.
        const accountedCount = mode.count + CARRIER_REFS + chainShas.length;
        if (accountedCount > MAX_REFS_PER_COMMIT) {
          emit(accountedCount)("too_many_refs");
          return json({ error: "too_many_refs", count: accountedCount, max: MAX_REFS_PER_COMMIT }, 413);
        }
        { const early = earlyStaleReject(mode.count); if (early) return early; }
        const descriptor = { sidecarSha: mode.sidecarSha, count: mode.count, totalBytes: mode.totalBytes };
        const sidecarStartedAt = Date.now();
        const child = await resolveSidecarRaw(this.env, db, accountId, descriptor, receipts, nowMs);
        serverTimings.sidecarMs = Date.now() - sidecarStartedAt;
        if (!child.ok) {
          if ("needsUpload" in child) {
            emit(mode.count)("unsatisfied_blobs", { ratio: 1 });
            return json(unsatisfiedBlobsBody(orderChainFirst(child.needsUpload, chainShas)), 422);
          }
          emit(mode.count)("bad_sidecar");
          return json({ error: "bad_sidecar", message: child.badSidecar }, 400);
        }
        const carriers = [cb.encManifestSha as string, mode.sidecarSha];
        if (deltaMode === "off") {
          const response = await runFullAdmission([...new Set([...carriers, ...chainShas, ...refsetShas(child.buf)])]);
          if (response) return response;
        } else {
          const { fallback, delta, admitData } = await this.computeCommitDelta(db, accountId, parent, commitEpoch, child.buf, child.count);
          let childShas: string[] | undefined;
          const fullChildShas = (): string[] => {
            if (!childShas) {
              const childParseStarted = Date.now();
              childShas = refsetShas(child.buf);
              emitDelta(this.env, "childParseMs", { count: Date.now() - childParseStarted });
            }
            return childShas;
          };
          if (fallback || deltaMode === "shadow") fullChildShas();
          if (fallback) {
            emitDelta(this.env, "fallback", { reason: fallback });
            if (HIGH_SEVERITY_FALLBACKS.has(fallback)) emitDelta(this.env, fallback, { reason: fallback });
          } else if (delta && deltaMode === "shadow") {
            try {
              // §6 four-flag read is bounded in chunked batches, not one transactional pre-state;
              // soak owners should treat harmful-under-concurrent-GC as possible chunk-boundary noise.
              const dataShas = fullChildShas();
              const compareReadStarted = Date.now();
              const flags = await this.readShadowFlags(db, accountId, [...new Set([...carriers, ...dataShas])]);
              emitDelta(this.env, "compareReadMs", { count: Date.now() - compareReadStarted });
              const cmp = classifyShadow({ childShas: dataShas, carriers, addedSet: new Set(delta.added), markedCarriedSet: new Set(delta.markedCarried), markedProbeSkipped: delta.markedProbeSkipped ?? false, flags, receiptKeys: new Set(Object.keys(receipts)) });
              if (cmp.divergent) {
                const d = divergenceDigest(cmp.harmful);
                emitDelta(this.env, "divergence", { count: cmp.harmful.length, digest: d.digest, sample: d.sample });
              }
              if (cmp.benign.length) {
                const d = divergenceDigest(cmp.benign);
                emitDelta(this.env, "benign_marker_divergence", { count: cmp.benign.length, digest: d.digest, sample: d.sample });
              }
            } catch {
              // Shadow comparison failed (telemetry only — the authoritative full path below
              // still responds). Surface high-severity so a broken soak read is not silent.
              emitDelta(this.env, "fallback", { reason: "delta_error" });
              emitDelta(this.env, "delta_error", { reason: "shadow_compare" });
            }
          }
          // design 102 enforce — flag-gated, not enabled in this PR.
          if (deltaMode === "enforce" && delta && !fallback && delta.markedProbeSkipped) {
            emitDelta(this.env, "fallback", { reason: "marks_over_cap" });
          }
          const useDelta = shouldUseDeltaAdmission(deltaMode, delta, fallback);
          const dataShas = useDelta ? admitData : fullChildShas();
          const response = await runFullAdmission([...new Set([...carriers, ...chainShas, ...dataShas])]);
          if (response) return response;
        }
      } else {
        shas = [...new Set([cb.encManifestSha as string, ...chainShas, ...mode.refShas])];
        // Defensive backstop: inline can't actually reach this — >MAX_REFS_PER_COMMIT 64-hex
        // shas blow the 1MB MAX_COMMIT_BODY first (→ 400). The §24 client uses the sidecar
        // long before then; the real large-ref ceiling is enforced on the sidecar `count` above.
        const accountedCount = mode.refShas.length + CARRIER_REFS + chainShas.length;
        if (accountedCount > MAX_REFS_PER_COMMIT) {
          emit(accountedCount)("too_many_refs");
          return json({ error: "too_many_refs", count: accountedCount, max: MAX_REFS_PER_COMMIT }, 413);
        }
        { const early = earlyStaleReject(mode.refShas.length); if (early) return early; }
        const response = await runFullAdmission(shas);
        if (response) return response;
      }
    } else {
      // Legacy (M7): inline only — a sidecar commit was rejected above (requires receipts),
      // so `mode` here is always inline; the guard narrows the type and is defensive.
      if (mode.kind !== "inline") return json({ error: "bad_request", message: "blobRefset requires the upload-receipts protocol" }, 400);
      shas = [...new Set([cb.encManifestSha as string, ...chainShas, ...mode.refShas])];
      { const early = earlyStaleReject(mode.refShas.length); if (early) return early; }
      const accountingStartedAt = Date.now();
      const missing = await this.missingBlobs(dbFor(op.env, accountId), shas, accountId);
      serverTimings.accountingMs = Date.now() - accountingStartedAt;
      if (missing.length > 0) {
        // missingBlobs ratio drives 422→upload round-trips — a key "why is push slow" signal.
        emit(shas.length)("unsatisfied_blobs", { ratio: missing.length / shas.length });
        return json(unsatisfiedBlobsBody(orderChainFirst(missing, chainShas)), 422);
      }
    }
    const emitCommit = emit(shas.length);

    // Atomic head check + advance — synchronous, no await inside. We store the full
    // SignedCommit verbatim (opaque); parent===head guarantees next === cb.seq.
    const stored = JSON.stringify({ commitHash: commit.commitHash, sig: commit.sig, body: commit.body });
    let outcome: { sequence: number; watermark: number } | { conflict: number; equivocation?: true } | { epochStale: number };
    const doT0 = performance.now();
    const commitStartedAt = Date.now();
    try {
      let next = 0;
      this.ctx.storage.transactionSync(() => {
        const head = readHead(this.ctx.storage.kv.get("head"));
        const watermark = (this.ctx.storage.kv.get("headWatermark") as number | undefined) ?? head.sequence;
        if (parent !== head.sequence) {
          const sameSeqHash = commitSeq <= watermark ? this.hashForSeq(commitSeq) : undefined;
          outcome = { conflict: head.sequence, ...(sameSeqHash && sameSeqHash !== commit.commitHash ? { equivocation: true as const } : {}) };
          throw ABORT;
        }
        // C4: refuse a commit signed under any epoch != the account's current one
        // (==, so both stale and unknown-future epochs are rejected). Best-effort
        // precondition; the client's roster/epoch check is the authority.
        if (commitEpoch !== currentEpoch) {
          outcome = { epochStale: currentEpoch };
          throw ABORT;
        }
        if (commitSeq !== watermark + 1) {
          const sameSeqHash = commitSeq <= watermark ? this.hashForSeq(commitSeq) : undefined;
          outcome = { conflict: head.sequence, ...(sameSeqHash && sameSeqHash !== commit.commitHash ? { equivocation: true as const } : {}) };
          throw ABORT;
        }
        next = head.sequence + 1;
        const nextHead = { sequence: next, commitHash: commit.commitHash };
        this.ctx.storage.kv.put("head", nextHead);
        this.ctx.storage.kv.put("headWatermark", nextHead.sequence);
        this.ctx.storage.kv.put(`seq:${next}`, stored);
        if (this.ctx.storage.kv.get("index_state") === "ready") this.ctx.storage.kv.put("index_state", "lagging");
      });
      outcome = { sequence: next, watermark: next };
    } catch (e) {
      if (e !== ABORT) throw e;
    } finally {
      op.span.doMs += performance.now() - doT0; // DO transactionSync hold (contention signal)
      serverTimings.commitMs = Date.now() - commitStartedAt;
    }

    if ("conflict" in outcome!) {
      if (outcome!.equivocation) metric(this.env, "same_sequence_different_hash");
      return timedResponse({ error: "conflict", head: outcome!.conflict }, 409, "conflict", emitCommit);
    }
    if ("epochStale" in outcome!) {
      return timedResponse({ error: "epoch_stale", currentEpoch: outcome!.epochStale }, 409, "epoch_stale", emitCommit);
    }
    const sequence = outcome!.sequence;
    const mirrorStartedAt = Date.now();
    await this.armAlarm(Date.now());

    wsBroadcast(this.ctx, JSON.stringify({ type: "committed", sequence, deviceId }), {
      maxSessionMs: wsMaxSessionMs(this.env),
      now: Date.now(),
    });

    // Best-effort D1 commit mirror (not authoritative). Fanout runs first so
    // `/latest` and WS evidence advance in the same order.
    try {
      await dbFor(op.env, accountId)
        .prepare("INSERT OR IGNORE INTO commits (workspace_id, project_id, sequence, commit_hash, body, sig, device_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(ws, proj, sequence, commit.commitHash, commit.body, commit.sig, deviceId)
        .run();
    } catch (e) {
      logErr("d1_commit_mirror_failed", e); // no raw error (binds carry ws/proj/body/device)
    }
    serverTimings.mirrorMs = Date.now() - mirrorStartedAt;
    // Success: the headline commit-latency / body-size / blobs-per-commit + the
    // R2/D1/DO split (dbMs+dbCalls from missingBlobs & mirror, doMs from the txn).
    return timedResponse({ sequence, commitHash: commit.commitHash }, 200, "ok", emitCommit);
  }

  /** One alarm folds exactly one sequence. The module-level guard is deliberately
   * isolate-wide: two DO instances must not hold two pairs of 250k sets. */
  async alarm(): Promise<void> {
    if (isolateFoldActive) {
      await this.armAlarm(Date.now() + 5_000);
      return;
    }
    isolateFoldActive = true;
    try {
      const head = readHead(this.ctx.storage.kv.get("head")).sequence;
      const floor = (this.ctx.storage.kv.get("pruneFloor") as number | undefined) ?? 0;
      const synced = (this.ctx.storage.kv.get("index_synced_seq") as number | undefined) ?? floor;
      if (synced < head) await this.foldSequence(synced + 1, head, floor);
      this.sweepIndex(floor);
      const nowHead = readHead(this.ctx.storage.kv.get("head")).sequence;
      const nowSynced = (this.ctx.storage.kv.get("index_synced_seq") as number | undefined) ?? floor;
      if (nowSynced < nowHead) await this.armAlarm(Date.now());
    } catch (e) {
      logErr("roots_index_fold_failed", e);
      metric(this.env, "index_fold_failed");
      await this.armAlarm(Date.now() + 5_000);
    } finally {
      isolateFoldActive = false;
    }
  }

  private async foldSequence(seq: number, observedHead: number, floor: number): Promise<void> {
    const state = (this.ctx.storage.kv.get("index_state") as IndexState | undefined) ?? "building";
    const current = await this.refSetAt(seq);
    if (!current) throw new Error(`unreadable fold input ${seq}`);
    if (current.refs.size > FOLD_MAX_REFS) {
      this.ctx.storage.kv.put("index_state", "lagging");
      metric(this.env, "index_fold_max_refs");
      throw new Error(`fold refs exceed ${FOLD_MAX_REFS}`);
    }

    // The first retained sequence is an atomic seed, not a diff against pruned history.
    if (state === "building" && seq === floor + 1 && this.ctx.storage.kv.get("fold_subcursor") === undefined) {
      this.ctx.storage.transactionSync(() => {
        this.sql().exec("INSERT OR REPLACE INTO seq_roots(seq,manifest_sha,carrier_sha) VALUES(?,?,?)", seq, current.manifestSha, current.carrierSha);
        this.ctx.storage.kv.put("index_synced_seq", seq);
        this.ctx.storage.kv.put("backfill_cursor", seq);
        this.ctx.storage.kv.put("index_generation", ((this.ctx.storage.kv.get("index_generation") as number | undefined) ?? 0) + 1);
        if (seq === readHead(this.ctx.storage.kv.get("head")).sequence) this.ctx.storage.kv.put("index_state", "ready");
      });
      this.foldPrevCache = { seq, value: current };
      return;
    }

    const previous = this.foldPrevCache?.seq === seq - 1 ? this.foldPrevCache.value : await this.refSetAt(seq - 1);
    if (!previous) throw new Error(`unreadable fold base ${seq - 1}`);
    if (previous.refs.size > FOLD_MAX_REFS) throw new Error(`fold refs exceed ${FOLD_MAX_REFS}`);
    let cursor = (this.ctx.storage.kv.get("fold_subcursor") as FoldCursor | undefined) ?? { phase: "removed", lastSha: "" };
    while (cursor.phase === "removed") {
      const chunk = diffChunk(previous.refs, current.refs, cursor.lastSha);
      if (!chunk.length) {
        cursor = { phase: "added", lastSha: "" };
        this.ctx.storage.transactionSync(() => this.ctx.storage.kv.put("fold_subcursor", cursor));
        break;
      }
      this.ctx.storage.transactionSync(() => {
        for (const sha of chunk) this.sql().exec("INSERT INTO dropped_index(sha256,last_seq) VALUES(?,?) ON CONFLICT(sha256) DO UPDATE SET last_seq=excluded.last_seq", sha, seq - 1);
        this.ctx.storage.kv.put("fold_subcursor", { phase: "removed", lastSha: chunk[chunk.length - 1]! } satisfies FoldCursor);
      });
      cursor = { phase: "removed", lastSha: chunk[chunk.length - 1]! };
    }
    while (cursor.phase === "added") {
      const chunk = diffChunk(current.refs, previous.refs, cursor.lastSha);
      if (!chunk.length) break;
      this.ctx.storage.transactionSync(() => {
        for (const sha of chunk) this.sql().exec("DELETE FROM dropped_index WHERE sha256 = ?", sha);
        this.ctx.storage.kv.put("fold_subcursor", { phase: "added", lastSha: chunk[chunk.length - 1]! } satisfies FoldCursor);
      });
      cursor = { phase: "added", lastSha: chunk[chunk.length - 1]! };
    }
    this.ctx.storage.transactionSync(() => {
      this.sql().exec("INSERT OR REPLACE INTO seq_roots(seq,manifest_sha,carrier_sha) VALUES(?,?,?)", seq, current.manifestSha, current.carrierSha);
      this.ctx.storage.kv.put("index_synced_seq", seq);
      this.ctx.storage.kv.put("backfill_cursor", seq);
      this.ctx.storage.kv.put("index_generation", ((this.ctx.storage.kv.get("index_generation") as number | undefined) ?? 0) + 1);
      this.ctx.storage.kv.delete("fold_subcursor");
      const liveHead = readHead(this.ctx.storage.kv.get("head")).sequence;
      this.ctx.storage.kv.put("index_state", seq === liveHead ? "ready" : liveHead - seq > GAP_MAX ? "lagging" : state);
    });
    this.foldPrevCache = { seq, value: current };
    metric(this.env, observedHead - seq > GAP_MAX ? "index_lagging" : "index_folded");
  }

  private async refSetAt(seq: number): Promise<{ refs: Set<string>; manifestSha: string; carrierSha: string | null } | null> {
    if (seq === 0) return { refs: new Set(), manifestSha: GENESIS_HASH, carrierSha: null };
    const raw = this.ctx.storage.kv.get(`seq:${seq}`) as string | undefined;
    if (!raw) return null;
    const sc = JSON.parse(raw) as SignedCommit;
    const cb = JSON.parse(sc.body) as CommitBodyView;
    const mode = readRefMode(cb);
    if (!mode || typeof cb.encManifestSha !== "string") return null;
    const chainShas = readManifestChain(cb.manifestChain, cb.encManifestSha);
    if (chainShas === null) return null;
    if (mode.kind === "inline") return { refs: new Set([...mode.refShas, ...chainShas].sort()), manifestSha: cb.encManifestSha, carrierSha: null };
    const loaded = await loadSidecarShaSet(this.env, mode.sidecarSha, mode.count);
    if (!loaded.ok) return null;
    // Sorted insertion order is load-bearing: diffChunk paginates the fold by
    // iterating this Set in order with a `> lastSha` cursor — an out-of-order
    // chain sha appended after the sorted sidecar refs would be skipped on a
    // chunk resume and its dropped_index entry silently lost (GC stranding).
    return { refs: new Set([...loaded.refs, ...chainShas].sort()), manifestSha: cb.encManifestSha, carrierSha: mode.sidecarSha };
  }

  private sweepIndex(floor: number): void {
    this.sql().exec("DELETE FROM dropped_index WHERE sha256 IN (SELECT sha256 FROM dropped_index WHERE last_seq <= ? LIMIT ?)", floor, SWEEP_CHUNK);
    this.sql().exec("DELETE FROM seq_roots WHERE seq IN (SELECT seq FROM seq_roots WHERE seq <= ? LIMIT ?)", floor, SWEEP_CHUNK);
  }

  private async armAlarm(at: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > at) await this.ctx.storage.setAlarm(at);
  }

  private sql(): { exec(query: string, ...bindings: unknown[]): { toArray(): SqlRow[] } } {
    return this.ctx.storage.sql as unknown as { exec(query: string, ...bindings: unknown[]): { toArray(): SqlRow[] } };
  }

  private async redeemReceipts(req: Request): Promise<Response> {
    const startedAt = performance.now();
    const ROUTE = "/v1/ws/:ws/proj/:proj/receipts/redeem";
    const op = startOp(this.env, "receipts.redeem", ROUTE);
    const raw = await readBodyCapped(req, MAX_REQUEST_BODY);
    if (raw === null) {
      op.done("body_too_large", { bytes: MAX_REQUEST_BODY });
      return json({ error: "body_too_large", message: "request body too large", max: MAX_REQUEST_BODY }, 413);
    }
    let body: { receipts?: unknown } | null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    if (!body || typeof body.receipts !== "object" || body.receipts === null || Array.isArray(body.receipts)) {
      op.done("bad_request");
      return json({ error: "bad_request", message: "missing receipts" }, 400);
    }

    const entries = Object.entries(body.receipts as Record<string, unknown>);
    const max = receiptRedeemMax(this.env);
    if (entries.length > max) {
      op.done("too_many_receipts", { count: entries.length });
      return json({ error: "too_many_receipts", max }, 400);
    }

    const accountId = req.headers.get("x-rbox-account") ?? "";
    const nowMs = Date.now();
    const db = dbFor(op.env, accountId);
    const precheckStartedAt = performance.now();
    const have = await this.entitledPresent(db, entries.map(([sha]) => sha).filter((sha) => SHA_RE.test(sha)), accountId);
    const precheckMs = performance.now() - precheckStartedAt;
    const newRefs: RefWithSize[] = [];
    let alreadyEntitled = 0;
    let rejected = 0;
    const verifyStartedAt = performance.now();
    for (const [sha, receipt] of entries) {
      if (!SHA_RE.test(sha) || typeof receipt !== "string") {
        rejected++;
        continue;
      }
      if (have.has(sha)) {
        alreadyEntitled++;
        continue;
      }
      const v = await verifyReceipt(this.env, receipt, { accountId, encSha: sha, nowMs });
      if (!v.ok) {
        rejected++;
        continue;
      }
      newRefs.push({ sha, size: v.size });
    }
    const verifyMs = performance.now() - verifyStartedAt;

    const accountingStartedAt = performance.now();
    const acct = await commitAccounting(db, accountId, newRefs, nowMs);
    const accountingMs = performance.now() - accountingStartedAt;
    // `granted` undercounts durable partial super-batches on failure paths: deliberate,
    // since commitAccounting's shared return shape reports no partial count.
    const phases = (granted: number) => ({
      totalMs: performance.now() - startedAt,
      precheckMs,
      verifyMs,
      accountingMs,
      count: entries.length,
      bytes: raw.length,
      granted,
      alreadyEntitled,
      rejected,
    });
    if ("needsUpload" in acct) {
      op.done("unsatisfied_blobs", { count: entries.length, ratio: entries.length ? acct.needsUpload.length / entries.length : 0 });
      emitRedeemPhases(this.env, "unsatisfied_blobs", phases(0));
      return json(unsatisfiedBlobsBody(acct.needsUpload), 422);
    }
    if ("overCap" in acct) {
      op.done("quota_exceeded", { count: entries.length });
      emitRedeemPhases(this.env, "quota_exceeded", phases(0));
      return json(await quotaExceededBody(db, accountId, acct.overCap), 402);
    }
    op.done("ok", { count: entries.length, ratio: entries.length ? rejected / entries.length : 0 });
    emitRedeemPhases(this.env, "ok", phases(newRefs.length));
    return json({ granted: newRefs.length, alreadyEntitled, rejected });
  }

  /** Design 96 v2 snapshot: two independent SQL streams plus the small raw gap. */
  private async roots(url: URL): Promise<Response> {
    const head = readHead(this.ctx.storage.kv.get("head")).sequence;
    const floor = (this.ctx.storage.kv.get("pruneFloor") as number | undefined) ?? 0;
    const generation = (this.ctx.storage.kv.get("index_generation") as number | undefined) ?? 0;
    const synced = (this.ctx.storage.kv.get("index_synced_seq") as number | undefined) ?? floor;
    const state = (this.ctx.storage.kv.get("index_state") as IndexState | undefined) ?? "building";
    if (url.searchParams.get("rebuild") === "1") {
      this.ctx.storage.transactionSync(() => {
        this.sql().exec("DELETE FROM dropped_index");
        this.sql().exec("DELETE FROM seq_roots");
        this.ctx.storage.kv.put("index_synced_seq", floor);
        this.ctx.storage.kv.put("index_state", head === floor ? "ready" : "building");
        this.ctx.storage.kv.put("backfill_cursor", floor + 1);
        this.ctx.storage.kv.delete("fold_subcursor");
        this.ctx.storage.kv.put("index_generation", generation + 1);
      });
      await this.armAlarm(Date.now());
      return json({ error: "index_building" }, 503);
    }
    if (state === "building") return json({ error: "index_building" }, 503);
    if (head - synced > GAP_MAX) return json({ error: "index_lagging" }, 503);

    const pins = [url.searchParams.get("pinHead"), url.searchParams.get("pinFloor"), url.searchParams.get("pinGen")];
    if (pins.some((x) => x !== null) && (pins.some((x) => x === null) || Number(pins[0]) !== head || Number(pins[1]) !== floor || Number(pins[2]) !== generation)) {
      return json({ error: "snapshot_changed" }, 409);
    }
    const requested = Number(url.searchParams.get("limit") ?? ROOTS_PAGE_LIMIT);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(ROOTS_PAGE_LIMIT, Math.trunc(requested))) : ROOTS_PAGE_LIMIT;
    const fromSha = url.searchParams.get("fromSha") ?? "";
    const fromSeqRaw = url.searchParams.get("fromSeq") ?? "";
    const droppedRows = fromSha === "done" ? [] : this.sql().exec(
      "SELECT sha256 FROM dropped_index WHERE last_seq > ? AND sha256 > ? ORDER BY sha256 LIMIT ?",
      floor, fromSha, limit + 1,
    ).toArray();
    const droppedPage = droppedRows.slice(0, limit).map((r) => String(r.sha256));
    const seqRows = fromSeqRaw === "done" ? [] : this.sql().exec(
      "SELECT seq,manifest_sha,carrier_sha FROM seq_roots WHERE seq > ? AND seq <= ? AND seq > ? ORDER BY seq LIMIT ?",
      floor, head, fromSeqRaw ? Number(fromSeqRaw) : floor, limit + 1,
    ).toArray();
    const seqRootsPage = seqRows.slice(0, limit).map((r) => ({
      seq: Number(r.seq), manifestSha: String(r.manifest_sha), ...(r.carrier_sha == null ? {} : { carrierSha: String(r.carrier_sha) }),
    }));
    const gap: Array<Record<string, unknown>> = [];
    let gapRefs = 0;
    for (let s = Math.max(1, synced); s <= head; s++) {
      const raw = this.ctx.storage.kv.get(`seq:${s}`) as string | undefined;
      if (!raw) return json({ error: "roots_incomplete", message: `retained gap at seq ${s}` }, 409);
      const sc = JSON.parse(raw) as SignedCommit;
      const cb = JSON.parse(sc.body) as CommitBodyView;
      const mode = readRefMode(cb);
      if (!mode) return json({ error: "roots_incomplete", message: `unreadable refs at seq ${s}` }, 409);
      if (typeof cb.encManifestSha !== "string") return json({ error: "roots_incomplete", message: `unreadable refs at seq ${s}` }, 409);
      const chainRefs = readManifestChain(cb.manifestChain, cb.encManifestSha);
      if (chainRefs === null) return json({ error: "roots_incomplete", message: `unreadable refs at seq ${s}` }, 409);
      gapRefs += chainRefs.length;
      if (mode.kind === "inline") {
        gapRefs += mode.refShas.length;
        gap.push({ seq: s, manifestSha: cb.encManifestSha, inlineRefs: mode.refShas, ...(chainRefs.length ? { chainRefs } : {}) });
        continue;
      }
      gapRefs += mode.count;
      gap.push({ seq: s, manifestSha: cb.encManifestSha, carrierSha: mode.sidecarSha, sidecar: { sha: mode.sidecarSha, count: mode.count, size: mode.totalBytes }, ...(chainRefs.length ? { chainRefs } : {}) });
    }
    if (gapRefs > ROOTS_OUTER_MAX_REFS) return json({ error: "roots_too_large" }, 503);
    return json({
      head, pruneFloor: floor, indexGeneration: generation, indexSyncedSeq: synced, gap,
      droppedPage, ...(droppedRows.length > limit ? { nextSha: droppedPage[droppedPage.length - 1] } : {}),
      seqRootsPage, ...(seqRows.length > limit ? { nextSeq: seqRootsPage[seqRootsPage.length - 1]!.seq } : {}),
    });
  }

  /** Retention prune (M6): drop seq pointers ≤ floor (NEVER the head). The blobs
   *  those versions referenced become GC-collectible if no retained version needs
   *  them. Authoritative — operates on DO storage. */
  private async prune(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { floor?: number };
    const head = readHead(this.ctx.storage.kv.get("head")).sequence;
    const curFloor = (this.ctx.storage.kv.get("pruneFloor") as number | undefined) ?? 0;
    const target = Math.min(Number(body.floor ?? 0), head - 1); // never prune the head
    if (!Number.isFinite(target) || target <= curFloor) return json({ pruned: 0, pruneFloor: curFloor });
    const synced = (this.ctx.storage.kv.get("index_synced_seq") as number | undefined) ?? 0;
    if (target >= synced) {
      metric(this.env, "prune_deferred");
      return json({ error: "prune_deferred", indexSyncedSeq: synced }, 409);
    }
    this.ctx.storage.transactionSync(() => {
      for (let s = curFloor + 1; s <= target; s++) this.ctx.storage.kv.delete(`seq:${s}`);
      this.ctx.storage.kv.put("pruneFloor", target);
    });
    return json({ pruned: target - curFloor, pruneFloor: target });
  }

  /** Account deletion (design 37 §4g): erase ALL DO storage for this workspace — the
   *  authoritative commit log (`head`, `seq:*`, `pruneFloor`). The D1 `commits`/`workspaces`
   *  mirror rows are dropped by the caller's purge batch; this wipes the source of truth the
   *  GC reachability scan reads, so the workspace's blobs become unreferenced. Reachable only
   *  via the Worker after a same-account authorize, then unconditionally on the deleted
   *  account. Idempotent (deleteAll on an already-empty DO is a no-op). */
  private async purge(): Promise<Response> {
    await this.ctx.storage.deleteAll();
    this.bootstrapped = true; // storage is now empty; don't re-seed from the (also-being-deleted) D1 mirror
    return json({ ok: true });
  }

  /** C1: the stored SignedCommits for (since, head], so a client can verify the
   *  hash-chain forward from its pinned head to latest. The span is capped — a
   *  client that's fallen too far behind (or below the prune floor, where commit
   *  pointers were dropped) must re-baseline rather than stream unbounded history. */
  private async commits(url: URL): Promise<Response> {
    const since = Number(url.searchParams.get("since") ?? "0");
    if (!Number.isInteger(since) || since < 0) return json({ error: "bad_request", message: "bad since" }, 400);
    const head = readHead(this.ctx.storage.kv.get("head")).sequence;
    if (since >= head) return json({ commits: [] }); // caller already at/ahead of head
    if (head - since > MAX_COMMIT_SPAN) return json({ error: "needs_rebaseline", head, maxSpan: MAX_COMMIT_SPAN }, 409);
    const commits: SignedCommit[] = [];
    for (let s = since + 1; s <= head; s++) {
      const raw = this.ctx.storage.kv.get(`seq:${s}`) as string | undefined;
      // A gap (pruned below the retention floor) breaks chain verification → the
      // client can't link forward and must re-baseline from latest.
      if (!raw) return json({ error: "needs_rebaseline", head }, 409);
      commits.push(JSON.parse(raw) as SignedCommit);
    }
    return json({ commits });
  }

  /** A specific historical commit (the opaque SignedCommit at that sequence). */
  private async commitAt(seq: number): Promise<Response> {
    if (!Number.isInteger(seq) || seq < 1) return json({ error: "bad_request" }, 400);
    const raw = this.ctx.storage.kv.get(`seq:${seq}`) as string | undefined;
    if (!raw) return json({ error: "not_found" }, 404);
    return json({ sequence: seq, commit: JSON.parse(raw) as SignedCommit });
  }

  private async latest(): Promise<Response> {
    const head = readHead(this.ctx.storage.kv.get("head")).sequence;
    if (head === 0) return json({ sequence: 0, commit: null });
    const raw = this.ctx.storage.kv.get(`seq:${head}`) as string | undefined;
    if (!raw) return json({ error: "commit_pointer_missing" }, 500);
    return json({ sequence: head, commit: JSON.parse(raw) as SignedCommit });
  }

  private async repair(req: Request, ws: string, proj: string): Promise<Response> {
    if (!this.isPlatform(req)) return json({ error: "not_found" }, 404);
    if (!this.bootstrapped) await this.ensureBootstrap(ws || this.bootWs, proj || this.bootProj);
    metric(this.env, "repair_invoked");
    const watermark = (this.ctx.storage.kv.get("headWatermark") as number | undefined) ?? 0;
    const retainedSeq = await this.highestRetainedSeq();
    const mirrorRow = ws && proj ? await loadBodyMirrorHead(dbFor(this.env, ""), ws, proj) : null;
    const reconstructedSeq = Math.max(retainedSeq ?? 0, mirrorRow?.sequence ?? 0);
    const target = Math.max(reconstructedSeq, watermark);
    const commitHash = target === 0 ? GENESIS_HASH : this.hashForSeq(target) ?? (mirrorRow?.sequence === target ? mirrorRow.commit_hash : undefined);
    if (!commitHash) return json({ error: "repair_unresolvable", watermark, target }, 409);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put("head", { sequence: target, commitHash });
      this.ctx.storage.kv.put("headWatermark", Math.max(target, watermark));
    });
    this.repairRequired = false;
    await this.initializeIndex(target, (this.ctx.storage.kv.get("pruneFloor") as number | undefined) ?? 0);
    return json({ ok: true, head: target, watermark: Math.max(target, watermark), commitHash });
  }

  private repairRequiredResponse(): Response {
    metric(this.env, "repair_required_served");
    return json({ error: "repair_required" }, 409);
  }

  private isPlatform(req: Request): boolean {
    const h = req.headers.get("x-rbox-platform") ?? "";
    return !!this.env.RBOX_PLATFORM_SECRET && ctEqual(h, this.env.RBOX_PLATFORM_SECRET);
  }

  private hashForSeq(seq: number): string | undefined {
    if (seq === 0) return GENESIS_HASH;
    const raw = this.ctx.storage.kv.get(`seq:${seq}`) as string | undefined;
    if (!raw) return undefined;
    try {
      const sc = JSON.parse(raw) as SignedCommit;
      return typeof sc.commitHash === "string" ? sc.commitHash : undefined;
    } catch {
      return undefined;
    }
  }

  private async highestRetainedSeq(): Promise<number | undefined> {
    const storage = this.ctx.storage as DurableObjectStorage & { kv?: { list?: (opts?: { prefix?: string; limit?: number }) => Map<string, unknown> | Promise<Map<string, unknown>> } };
    const kvList = storage.kv?.list;
    const rows =
      typeof kvList === "function"
        ? await kvList.call(storage.kv, { prefix: "seq:" })
        : typeof storage.list === "function"
          ? await storage.list({ prefix: "seq:" })
          : new Map<string, unknown>();
    let max: number | undefined;
    for (const key of rows.keys()) {
      const seq = Number(key.slice("seq:".length));
      if (Number.isInteger(seq) && seq > (max ?? 0)) max = seq;
    }
    return max;
  }

  /** Account-scoped (M7): a sha is "have it" only if THIS account is entitled
   *  (blob_refs) and it's not a GC candidate (M6). Referencing an unentitled sha
   *  → reported missing → client must upload it (needs the bytes). */
  private async missingBlobs(db: D1Database, shas: string[], accountId: string): Promise<string[]> {
    const entitled = new Set<string>();
    const condemned = new Set<string>();
    // §30: batched dispatch (the byte-identical twin of the legacy blobsCheck path). The two
    // IN-list SELECTs each run as their own grouped db.batch() pass over `shas` — one D1
    // subrequest per group instead of one serial round-trip per 80-sha chunk. Results are
    // merged by set membership; the returned array is still built from the original `shas` order.
    // §33: the Phase-1 prune barrier is FOLDED into the entitled query — a prune-marked ref
    // (`blob_ref_candidates`) is excluded by the NOT EXISTS, so it reads as MISSING → forces a
    // re-upload that re-grants + clears the marker (same candidate-aware barrier as gc_candidates,
    // per-account). The barrier lives in the query, so it can't be forgotten.
    await batchedInLookup<{ sha256: string }>(
      db,
      shas,
      (chunk) =>
        db
          .prepare(
            `SELECT sha256 FROM blob_refs WHERE account_id = ? AND sha256 IN (${chunk.map(() => "?").join(",")})
               AND NOT EXISTS (SELECT 1 FROM blob_ref_candidates c WHERE c.account_id = blob_refs.account_id AND c.sha256 = blob_refs.sha256)`,
          )
          .bind(accountId, ...chunk),
      (rows) => {
        for (const r of rows) entitled.add(r.sha256);
      },
    );
    await batchedInLookup<{ sha256: string }>(
      db,
      shas,
      (chunk) => db.prepare(`SELECT sha256 FROM gc_candidates WHERE sha256 IN (${chunk.map(() => "?").join(",")})`).bind(...chunk),
      (rows) => {
        for (const r of rows) condemned.add(r.sha256);
      },
    );
    return shas.filter((s) => !entitled.has(s) || condemned.has(s));
  }

  private async entitledPresent(db: D1Database, shas: string[], accountId: string): Promise<Set<string>> {
    const have = new Set<string>();
    await batchedInLookup<{ sha256: string }>(
      db,
      [...new Set(shas)],
      (chunk) =>
        db
          .prepare(
            `SELECT r.sha256 FROM blob_refs r JOIN blobs b ON b.sha256 = r.sha256
             WHERE r.account_id = ? AND b.present = 1 AND r.sha256 IN (${chunk.map(() => "?").join(",")})
               AND NOT EXISTS (SELECT 1 FROM blob_ref_candidates c WHERE c.account_id = r.account_id AND c.sha256 = r.sha256)
               AND NOT EXISTS (SELECT 1 FROM gc_candidates g WHERE g.sha256 = r.sha256 AND g.deleting_at IS NOT NULL)`,
          )
          .bind(accountId, ...chunk),
      (rows) => {
        for (const r of rows) have.add(r.sha256);
      },
    );
    return have;
  }

  // ---- WebSocket hibernation handlers (see ws-fanout.ts for connect/broadcast) ----

  // Hibernation handlers. Clients never drive state over WS, so messages are ignored
  // (protocol pings are auto-answered via setWebSocketAutoResponse). The runtime calls
  // these by name on the instance, so they MUST live on the class.
  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {}
  webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code);
    } catch {
      /* already closed */
    }
  }
  webSocketError(): void {}
}

const ABORT = Symbol("abort-commit-txn");

const GENESIS_HASH = "0".repeat(64);

interface StoredHead {
  sequence: number;
  commitHash: string;
}

function isStoredHead(v: unknown): v is StoredHead {
  return (
    typeof v === "object" &&
    v !== null &&
    Number.isInteger((v as { sequence?: unknown }).sequence) &&
    typeof (v as { commitHash?: unknown }).commitHash === "string"
  );
}

function readHead(v: unknown): StoredHead {
  if (isStoredHead(v)) return v;
  if (typeof v === "number" && Number.isInteger(v)) return { sequence: v, commitHash: v === 0 ? GENESIS_HASH : "" };
  return { sequence: 0, commitHash: GENESIS_HASH };
}

/** Bounded iterator diff. Canonical sidecars and the sorted inline fallback make
 * Set iteration stable; only the returned SQL chunk is materialized. */
function diffChunk(left: Set<string>, right: Set<string>, after: string): string[] {
  const out: string[] = [];
  for (const sha of left) {
    if (sha <= after || right.has(sha)) continue;
    out.push(sha);
    if (out.length === FOLD_CHUNK) break;
  }
  return out;
}

interface BodyMirrorHeadRow {
  sequence: number;
  commit_hash: string;
  body: string;
  sig: string;
}

async function loadBodyMirrorHead(db: D1Database, ws: string, proj: string): Promise<BodyMirrorHeadRow | null> {
  return (
    (await db
      .prepare("SELECT sequence, commit_hash, body, sig FROM commits WHERE workspace_id = ? AND project_id = ? ORDER BY sequence DESC LIMIT 1")
      .bind(ws, proj)
      .first<BodyMirrorHeadRow>()) ?? null
  );
}

function metric(env: Env, outcome: string): void {
  emitMetric(env, { op: "head_authority", outcome });
}
