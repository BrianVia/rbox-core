import type { Env } from "./env.js";
import { json, SHA256_HEX_RE as SHA_RE } from "./util.js";

const MAX_COMMIT_BODY = 256 * 1024; // opaque body cap (256KB)
const MAX_BLOB_REFS = 50000; // sanity cap on referenced blobs per commit

/** The opaque signed commit envelope the server stores verbatim (design 12, v4).
 *  The server reads a FEW fields out of `body` for validation but NEVER verifies
 *  the signature — clients verify from genesis. */
interface SignedCommit {
  body: string; // canonical JSON of the commitBody (opaque)
  commitHash: string; // hex
  sig: string; // b64url Ed25519 (opaque)
}
/** The minimal slice of commitBody the server inspects. Everything else is opaque. */
interface CommitBodyView {
  type?: unknown;
  seq?: unknown;
  parentSeq?: unknown;
  encManifestSha?: unknown;
  deviceId?: unknown;
  blobRefs?: unknown;
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
 *     clients never depend on delivery for correctness.
 *
 * Under full E2EE the server is ZERO-KNOWLEDGE: a commit carries a SIGNED COMMIT
 * ENVELOPE (opaque body + hash + sig), not a plaintext manifest. The DO stores it
 * verbatim and never decrypts or verifies signatures.
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
    const seg = url.pathname.split("/").filter(Boolean); // v1 ws :ws proj :proj <action>
    const ws = seg[2] ?? "";
    const proj = seg[4] ?? "";
    const action = seg[5] ?? "";

    await this.ensureBootstrap(ws, proj);

    if (action === "connect" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.connect(url);
    }
    if (action === "latest" && req.method === "GET") return this.latest();
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
      const row = await this.env.rbox_dev_db
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
    const body = (await req.json().catch(() => null)) as { parentSequence?: number | null; commit?: SignedCommit } | null;
    const commit = body?.commit;
    const parent = body?.parentSequence ?? 0;
    // Authenticated account, set by the Worker after authorizeWorkspace (the DO is
    // only reachable via the Worker, which overrides any client-provided value).
    const accountId = req.headers.get("x-rbox-account") ?? "";

    // Envelope shape: three opaque strings. The body is bounded (we store verbatim).
    if (!commit || typeof commit.body !== "string" || typeof commit.commitHash !== "string" || typeof commit.sig !== "string") {
      return json({ error: "bad_request", message: "missing signed commit" }, 400);
    }
    if (commit.body.length > MAX_COMMIT_BODY) return json({ error: "bad_request", message: "commit body too large" }, 400);

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
    const refs = Array.isArray(cb.blobRefs) ? (cb.blobRefs as Array<{ encSha?: unknown }>) : null;
    if (!refs || refs.length > MAX_BLOB_REFS) return json({ error: "bad_request", message: "bad blobRefs" }, 400);
    const refShas: string[] = [];
    for (const r of refs) {
      if (!r || typeof r.encSha !== "string" || !SHA_RE.test(r.encSha)) return json({ error: "bad_request", message: "bad blobRef encSha" }, 400);
      refShas.push(r.encSha);
    }
    const deviceId = typeof cb.deviceId === "string" ? cb.deviceId : null;

    // Blob-existence: refuse to advance head past a commit referencing blobs we
    // don't have (the encrypted manifest is itself a normal blob the client
    // uploaded first), or every future pull breaks. 422 → client uploads.
    const shas = [...new Set([cb.encManifestSha, ...refShas])];
    const missing = await this.missingBlobs(shas, accountId); // account-scoped (M7)
    if (missing.length > 0) return json({ error: "unsatisfied_blobs", missing }, 422);

    // Atomic head check + advance — synchronous, no await inside. We store the full
    // SignedCommit verbatim (opaque); parent===head guarantees next === cb.seq.
    const stored = JSON.stringify({ commitHash: commit.commitHash, sig: commit.sig, body: commit.body });
    let outcome: { sequence: number } | { conflict: number };
    try {
      let next = 0;
      this.ctx.storage.transactionSync(() => {
        const head = (this.ctx.storage.kv.get("head") as number | undefined) ?? 0;
        if (parent !== head) {
          outcome = { conflict: head };
          throw ABORT;
        }
        next = head + 1;
        this.ctx.storage.kv.put("head", next);
        this.ctx.storage.kv.put(`seq:${next}`, stored);
      });
      outcome = { sequence: next };
    } catch (e) {
      if (e !== ABORT) throw e;
    }

    if ("conflict" in outcome!) return json({ error: "conflict", head: outcome!.conflict }, 409);
    const sequence = outcome!.sequence;

    // Best-effort D1 commit mirror (not authoritative). Workspace ownership is
    // established at creation (POST /v1/workspaces), NOT here, so no registry write.
    try {
      await this.env.rbox_dev_db
        .prepare("INSERT OR IGNORE INTO commits (workspace_id, project_id, sequence, commit_hash, body, sig, device_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(ws, proj, sequence, commit.commitHash, commit.body, commit.sig, deviceId)
        .run();
    } catch (e) {
      console.error("D1 commit mirror failed (non-fatal)", e);
    }

    this.broadcast(JSON.stringify({ type: "committed", sequence, deviceId }), deviceId);
    return json({ sequence, commitHash: commit.commitHash });
  }

  /** Authoritative retained roots (GC): for every sequence the DO still holds
   *  (pruneFloor, head], the referenced content addresses parsed FROM the stored
   *  commit body — so the mark phase needs no R2 manifest fetch. */
  private async roots(): Promise<Response> {
    const head = (this.ctx.storage.kv.get("head") as number | undefined) ?? 0;
    const floor = (this.ctx.storage.kv.get("pruneFloor") as number | undefined) ?? 0;
    const roots: Array<{ seq: number; commitHash: string; encManifestSha: string; encShas: string[] }> = [];
    for (let s = floor + 1; s <= head; s++) {
      const raw = this.ctx.storage.kv.get(`seq:${s}`) as string | undefined;
      if (!raw) continue;
      const sc = JSON.parse(raw) as SignedCommit;
      const cb = JSON.parse(sc.body) as CommitBodyView;
      const encShas = Array.isArray(cb.blobRefs) ? (cb.blobRefs as Array<{ encSha?: unknown }>).map((r) => r.encSha).filter((x): x is string => typeof x === "string") : [];
      roots.push({ seq: s, commitHash: sc.commitHash, encManifestSha: typeof cb.encManifestSha === "string" ? cb.encManifestSha : "", encShas });
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
  private async missingBlobs(shas: string[], accountId: string): Promise<string[]> {
    const entitled = new Set<string>();
    const condemned = new Set<string>();
    for (let i = 0; i < shas.length; i += 80) {
      const chunk = shas.slice(i, i + 80);
      if (chunk.length === 0) break;
      const ph = chunk.map(() => "?").join(",");
      const rows = await this.env.rbox_dev_db
        .prepare(`SELECT sha256 FROM blob_refs WHERE account_id = ? AND sha256 IN (${ph})`)
        .bind(accountId, ...chunk)
        .all<{ sha256: string }>();
      for (const r of rows.results ?? []) entitled.add(r.sha256);
      const cand = await this.env.rbox_dev_db.prepare(`SELECT sha256 FROM gc_candidates WHERE sha256 IN (${ph})`).bind(...chunk).all<{ sha256: string }>();
      for (const r of cand.results ?? []) condemned.add(r.sha256);
    }
    return shas.filter((s) => !entitled.has(s) || condemned.has(s));
  }

  // ---- WebSocket fanout (hibernatable) ----

  private connect(url: URL): Response {
    const deviceId = url.searchParams.get("device");
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ deviceId });
    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(message: string, fromDeviceId: string | null): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue; // set can include CLOSING sockets
      const att = ws.deserializeAttachment() as { deviceId: string | null } | null;
      if (fromDeviceId && att?.deviceId === fromDeviceId) continue; // don't echo to the committer
      try {
        ws.send(message);
      } catch {
        // one dead socket must not abort the fanout
      }
    }
  }

  // Hibernation handlers. Clients never drive state over WS, so messages are ignored
  // (protocol pings are auto-answered via setWebSocketAutoResponse).
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
