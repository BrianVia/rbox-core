import type { Env } from "./env.js";
import { json, logErr, SHA256_HEX_RE as SHA_RE } from "./util.js";
import { startOp, type MetricEvent } from "./metrics.js";
import { validateCommitRefs, commitAccounting, MAX_REFS_PER_COMMIT } from "./commit-accounting.js";
import { resolveSidecarBytes, loadSidecarRefs } from "./sidecar.js";
import { dbFor } from "./db.js";
import { batchedInLookup } from "./d1-batch.js";
import {
  MAX_COMMIT_BODY,
  MAX_COMMIT_SPAN,
  MAX_REQUEST_BODY,
  readBodyCapped,
  readRefMode,
  type CommitBodyView,
  type SignedCommit,
} from "./commit-envelope.js";
import { acceptConnection, broadcast as wsBroadcast } from "./ws-fanout.js";

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
 * DO storage (SQLite-backed, synchronous KV): `head` (number) and `seq:<n>`
 * (JSON of the full SignedCommit). Authoritative; D1 `commits` is a best-effort
 * mirror for cross-workspace queries.
 */
export class WorkspaceSync {
  private bootstrapped = false;
  private bootstrapPromise?: Promise<void>;

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

    // SERVER-INTERNAL roots/prune (design 37 §4f follow-up): the GC reachability scan and the
    // retention prune address the DO from D1, where project_id may contain "/". A positional
    // `…/proj/:proj/roots` path mis-parses such a projectId → 404 → gcPurge aborts fail-closed
    // and reclaims NOTHING (an indefinite blob leak). So these use a FIXED action path with
    // ws/proj carried in the QUERY (slash-safe), still bootstrap-seeded from D1. The legacy
    // positional handlers below remain for any direct caller.
    if (url.pathname === "/roots" || url.pathname === "/prune") {
      await this.ensureBootstrap(url.searchParams.get("ws") ?? "", url.searchParams.get("proj") ?? "");
      if (url.pathname === "/roots" && req.method === "GET") return this.roots();
      if (url.pathname === "/prune" && req.method === "POST") return this.prune(req);
      return json({ error: "not_found" }, 404);
    }

    const seg = url.pathname.split("/").filter(Boolean); // v1 ws :ws proj :proj <action>
    const ws = seg[2] ?? "";
    const proj = seg[4] ?? "";
    const action = seg[5] ?? "";

    await this.ensureBootstrap(ws, proj);

    if (action === "connect" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return acceptConnection(this.ctx, url);
    }
    if (action === "latest" && req.method === "GET") return this.latest();
    // C1: the stored SignedCommits for (since, head] so a client can verify the
    // hash-chain forward from its pinned head to latest before applying.
    if (action === "commits" && req.method === "GET") return this.commits(url);
    if (action === "manifests" && req.method === "POST") return this.commit(req, ws, proj);
    // GET /v1/ws/:ws/proj/:proj/manifests/:seq — a specific historical commit.
    if (seg[5] === "manifests" && seg[6] && req.method === "GET") return this.commitAt(Number(seg[6]));
    // GC support (M6): authoritative retained roots + retention prune.
    if (action === "roots" && req.method === "GET") return this.roots();
    if (action === "prune" && req.method === "POST") return this.prune(req);
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
    const head = this.ctx.storage.kv.get("head");
    if (head === undefined && ws && proj) {
      // Seed from any pre-DO D1 state so existing workspaces don't reconcile against empty.
      // §32 FLAG: `commits` is account-data, but this DO bootstrap only knows (ws, proj) —
      // the owning account isn't forwarded on a first-touch read. Account-less at N=1 (one
      // shard); a real shard cutover needs a (ws → shard) directory index here.
      const row = await dbFor(this.env, "")
        .prepare("SELECT sequence, commit_hash, body, sig FROM commits WHERE workspace_id = ? AND project_id = ? ORDER BY sequence DESC LIMIT 1")
        .bind(ws, proj)
        .first<{ sequence: number; commit_hash: string; body: string; sig: string }>();
      if (row) {
        const stored = JSON.stringify({ commitHash: row.commit_hash, sig: row.sig, body: row.body });
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.kv.put("head", Number(row.sequence));
          this.ctx.storage.kv.put(`seq:${row.sequence}`, stored);
        });
      }
    }
    this.bootstrapped = true;
  }

  // ---- commit (the atomic sequencer) ----

  private async commit(req: Request, ws: string, proj: string): Promise<Response> {
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
      op.done("body_too_large", { bytes: MAX_REQUEST_BODY });
      return json({ error: "bad_request", message: "request body too large" }, 413);
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
      op.done("body_too_large", { bytes: commit.body.length });
      return json({ error: "bad_request", message: "commit body too large" }, 400);
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
    if (parent !== cb.parentSeq) return json({ error: "bad_request", message: "parentSequence mismatch" }, 400);
    if (!Number.isInteger(cb.accountEpoch)) return json({ error: "bad_request", message: "bad accountEpoch" }, 400);
    const commitEpoch = cb.accountEpoch as number;
    // §24 strict dual-mode: exactly one of inline blobRefs / sidecar descriptor.
    const mode = readRefMode(cb);
    if (!mode) return json({ error: "bad_request", message: "commit must carry exactly one of blobRefs / blobRefset" }, 400);
    // A sidecar commit needs the receipts protocol (its refs come from a receipt-authenticated
    // R2 object resolved at accounting time) — an old/legacy-protocol sidecar can't be charged.
    if (mode.kind === "sidecar" && !useReceipts) return json({ error: "bad_request", message: "blobRefset requires the upload-receipts protocol" }, 400);
    const deviceId = typeof cb.deviceId === "string" ? cb.deviceId : null;
    const bodyBytes = commit.body.length;

    // Blob-existence: refuse to advance head past a commit referencing blobs we don't have
    // (the encrypted manifest is itself a normal blob the client uploaded first), or every
    // future pull breaks. 422 → client uploads. For a sidecar commit the data refs come from
    // the resolved sidecar (below); the existence set always includes encManifestSha and,
    // for sidecar commits, sidecarSha itself (so the published head's sidecar is durable).
    let shas: string[];
    const emit = (count: number) => (outcome: string, extra: Partial<MetricEvent> = {}) => op.done(outcome, { bytes: bodyBytes, count, ...extra });

    if (useReceipts) {
      // §23.4 + §24: resolve refs → validate (present=1+entitled OR receipt) → catalog+charge
      // +grant, all BEFORE the head advance (account-then-publish). On head 409 the accounting
      // is already durable (benign: refs entitled+present; retry charges 0).
      const nowMs = Date.now();
      if (mode.kind === "sidecar") {
        // §30: cap the DATA-ref count directly (the 2 carriers — encManifest + sidecar — ride
        // within the multi-batch accounting, no separate budget). Same bound readRefMode applies
        // to count, so no dead band. Cheap reject BEFORE the R2 fetch.
        if (mode.count > MAX_REFS_PER_COMMIT) {
          emit(mode.count)("too_many_refs");
          return json({ error: "too_many_refs", max: MAX_REFS_PER_COMMIT }, 413);
        }
        const sc = await resolveSidecarBytes(this.env, dbFor(op.env, accountId), accountId, { sidecarSha: mode.sidecarSha, count: mode.count, totalBytes: mode.totalBytes }, receipts, nowMs);
        if (!sc.ok) {
          if ("needsUpload" in sc) {
            emit(mode.count)("unsatisfied_blobs", { ratio: 1 });
            return json({ error: "unsatisfied_blobs", missing: sc.needsUpload }, 422);
          }
          emit(mode.count)("bad_sidecar");
          return json({ error: "bad_sidecar", message: sc.badSidecar }, 400);
        }
        shas = [...new Set([cb.encManifestSha as string, mode.sidecarSha, ...sc.refShas])];
      } else {
        shas = [...new Set([cb.encManifestSha as string, ...mode.refShas])];
        // Defensive backstop: inline can't actually reach this — >MAX_REFS_PER_COMMIT 64-hex
        // shas blow the 1MB MAX_COMMIT_BODY first (→ 400). The §24 client uses the sidecar
        // long before then; the real large-ref ceiling is enforced on the sidecar `count` above.
        if (mode.refShas.length > MAX_REFS_PER_COMMIT) {
          emit(shas.length)("too_many_refs");
          return json({ error: "too_many_refs", max: MAX_REFS_PER_COMMIT }, 413);
        }
      }
      const v = await validateCommitRefs(this.env, dbFor(op.env, accountId), accountId, shas, receipts, nowMs);
      if (!v.ok) {
        emit(shas.length)("unsatisfied_blobs", { ratio: v.needsUpload.length / shas.length });
        return json({ error: "unsatisfied_blobs", missing: v.needsUpload }, 422);
      }
      const acct = await commitAccounting(dbFor(op.env, accountId), accountId, v.newRefs, nowMs);
      if ("overCap" in acct) {
        emit(shas.length)("quota_exceeded", { bytes: bodyBytes });
        return json({ error: "quota_exceeded", used: acct.overCap.used, cap: acct.overCap.cap }, 402);
      }
    } else {
      // Legacy (M7): inline only — a sidecar commit was rejected above (requires receipts),
      // so `mode` here is always inline; the guard narrows the type and is defensive.
      if (mode.kind !== "inline") return json({ error: "bad_request", message: "blobRefset requires the upload-receipts protocol" }, 400);
      shas = [...new Set([cb.encManifestSha as string, ...mode.refShas])];
      const missing = await this.missingBlobs(dbFor(op.env, accountId), shas, accountId);
      if (missing.length > 0) {
        // missingBlobs ratio drives 422→upload round-trips — a key "why is push slow" signal.
        emit(shas.length)("unsatisfied_blobs", { ratio: missing.length / shas.length });
        return json({ error: "unsatisfied_blobs", missing }, 422);
      }
    }
    const emitCommit = emit(shas.length);

    // Atomic head check + advance — synchronous, no await inside. We store the full
    // SignedCommit verbatim (opaque); parent===head guarantees next === cb.seq.
    const stored = JSON.stringify({ commitHash: commit.commitHash, sig: commit.sig, body: commit.body });
    let outcome: { sequence: number } | { conflict: number } | { epochStale: number };
    const doT0 = performance.now();
    try {
      let next = 0;
      this.ctx.storage.transactionSync(() => {
        const head = (this.ctx.storage.kv.get("head") as number | undefined) ?? 0;
        if (parent !== head) {
          outcome = { conflict: head };
          throw ABORT;
        }
        // C4: refuse a commit signed under any epoch != the account's current one
        // (==, so both stale and unknown-future epochs are rejected). Best-effort
        // precondition; the client's roster/epoch check is the authority.
        if (commitEpoch !== currentEpoch) {
          outcome = { epochStale: currentEpoch };
          throw ABORT;
        }
        next = head + 1;
        this.ctx.storage.kv.put("head", next);
        this.ctx.storage.kv.put(`seq:${next}`, stored);
      });
      outcome = { sequence: next };
    } catch (e) {
      if (e !== ABORT) throw e;
    } finally {
      op.span.doMs += performance.now() - doT0; // DO transactionSync hold (contention signal)
    }

    if ("conflict" in outcome!) {
      emitCommit("conflict");
      return json({ error: "conflict", head: outcome!.conflict }, 409);
    }
    if ("epochStale" in outcome!) {
      emitCommit("epoch_stale");
      return json({ error: "epoch_stale", currentEpoch: outcome!.epochStale }, 409);
    }
    const sequence = outcome!.sequence;

    // Best-effort D1 commit mirror (not authoritative). Workspace ownership is
    // established at creation (POST /v1/workspaces), NOT here, so no registry write.
    try {
      await dbFor(op.env, accountId)
        .prepare("INSERT OR IGNORE INTO commits (workspace_id, project_id, sequence, commit_hash, body, sig, device_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(ws, proj, sequence, commit.commitHash, commit.body, commit.sig, deviceId)
        .run();
    } catch (e) {
      logErr("d1_commit_mirror_failed", e); // no raw error (binds carry ws/proj/body/device)
    }

    wsBroadcast(this.ctx, JSON.stringify({ type: "committed", sequence, deviceId }), deviceId);
    // Success: the headline commit-latency / body-size / blobs-per-commit + the
    // R2/D1/DO split (dbMs+dbCalls from missingBlobs & mirror, doMs from the txn).
    emitCommit("ok"); // ratio defaults to 0
    return json({ sequence, commitHash: commit.commitHash });
  }

  /** Authoritative retained roots (GC): for every sequence the DO still holds
   *  (pruneFloor, head], the referenced content addresses parsed FROM the stored
   *  commit body — so the mark phase needs no R2 manifest fetch. */
  private async roots(): Promise<Response> {
    const head = (this.ctx.storage.kv.get("head") as number | undefined) ?? 0;
    const floor = (this.ctx.storage.kv.get("pruneFloor") as number | undefined) ?? 0;
    const roots: Array<{ seq: number; commitHash: string; encManifestSha: string; encShas: string[] }> = [];
    // FAIL CLOSED (§24.3 M3): GC condemns anything NOT named here, so any inability to
    // enumerate a retained commit's reachable set (a gap in (floor, head], or a sidecar that's
    // missing/oversized/corrupt/unparseable) must abort the WHOLE pass (non-2xx → gcMark throws),
    // never silently omit roots. A sidecar commit's sidecarSha is itself a root (losing it must
    // prevent condemnation, since future reachability proofs need it).
    for (let s = floor + 1; s <= head; s++) {
      const raw = this.ctx.storage.kv.get(`seq:${s}`) as string | undefined;
      if (!raw) return json({ error: "roots_incomplete", message: `retained gap at seq ${s}` }, 409);
      const sc = JSON.parse(raw) as SignedCommit;
      const cb = JSON.parse(sc.body) as CommitBodyView;
      const mode = readRefMode(cb);
      if (!mode) return json({ error: "roots_incomplete", message: `unreadable refs at seq ${s}` }, 409);
      const encManifestSha = typeof cb.encManifestSha === "string" ? cb.encManifestSha : "";
      if (mode.kind === "inline") {
        roots.push({ seq: s, commitHash: sc.commitHash, encManifestSha, encShas: mode.refShas });
        continue;
      }
      // Sidecar: fetch+bound+verify+parse to recover the reachable data refs; sidecarSha is a root.
      // (count is already ≤ MAX_REFS_PER_COMMIT via readRefMode, so loadSidecarRefs's size gate bounds the bytes.)
      const loaded = await loadSidecarRefs(this.env, mode.sidecarSha, mode.count);
      if (!loaded.ok) {
        logErr("roots_sidecar_unreadable", new Error(`seq ${s}: ${loaded.reason}`));
        return json({ error: "roots_incomplete", message: `sidecar unreadable at seq ${s}` }, 409);
      }
      roots.push({ seq: s, commitHash: sc.commitHash, encManifestSha, encShas: [mode.sidecarSha, ...loaded.refs.map((r) => r.encSha)] });
    }
    return json({ head, pruneFloor: floor, roots });
  }

  /** Retention prune (M6): drop seq pointers ≤ floor (NEVER the head). The blobs
   *  those versions referenced become GC-collectible if no retained version needs
   *  them. Authoritative — operates on DO storage. */
  private async prune(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { floor?: number };
    const head = (this.ctx.storage.kv.get("head") as number | undefined) ?? 0;
    const curFloor = (this.ctx.storage.kv.get("pruneFloor") as number | undefined) ?? 0;
    const target = Math.min(Number(body.floor ?? 0), head - 1); // never prune the head
    if (!Number.isFinite(target) || target <= curFloor) return json({ pruned: 0, pruneFloor: curFloor });
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
    const head = (this.ctx.storage.kv.get("head") as number | undefined) ?? 0;
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
    const head = (this.ctx.storage.kv.get("head") as number | undefined) ?? 0;
    if (head === 0) return json({ sequence: 0, commit: null });
    const raw = this.ctx.storage.kv.get(`seq:${head}`) as string | undefined;
    if (!raw) return json({ error: "commit_pointer_missing" }, 500);
    return json({ sequence: head, commit: JSON.parse(raw) as SignedCommit });
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
