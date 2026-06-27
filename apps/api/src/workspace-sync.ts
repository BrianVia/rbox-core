import type { Env } from "./env.js";
import { validateManifest } from "../../../src/engine/manifest-validate.js";

/**
 * WorkspaceSync — the per-(workspace, project) Durable Object (D2).
 *
 * Two jobs:
 *  1. Authoritative commit sequencer. The Worker's old MAX(sequence)+1 was racy
 *     across an await; here the head check + advance happen in a SYNCHRONOUS
 *     storage transaction (`transactionSync`) with no external I/O inside, so the
 *     DO's single thread makes them genuinely atomic. R2 upload + blob-existence
 *     checks happen BEFORE the transaction.
 *  2. Live notification fanout over hibernatable WebSockets. Notification-only —
 *     clients never depend on delivery for correctness.
 *
 * DO storage (SQLite-backed, synchronous KV): `head` (number) and `seq:<n>`
 * (manifest blob sha). Authoritative; D1 `manifests` is a best-effort mirror for
 * future cross-workspace queries (M7).
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
    // GET /v1/ws/:ws/proj/:proj/manifests/:seq — a specific historical version.
    if (seg[5] === "manifests" && seg[6] && req.method === "GET") return this.manifestAt(Number(seg[6]));
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
        .prepare("SELECT sequence, manifest_blob_sha FROM manifests WHERE workspace_id = ? AND project_id = ? ORDER BY sequence DESC LIMIT 1")
        .bind(ws, proj)
        .first<{ sequence: number; manifest_blob_sha: string }>();
      if (row) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.kv.put("head", Number(row.sequence));
          this.ctx.storage.kv.put(`seq:${row.sequence}`, row.manifest_blob_sha);
        });
      }
    }
    this.bootstrapped = true;
  }

  // ---- commit (the atomic sequencer) ----

  private async commit(req: Request, ws: string, proj: string): Promise<Response> {
    const body = (await req.json()) as { parentSequence?: number | null; deviceId?: string; manifest?: unknown };
    const parent = body.parentSequence ?? 0;

    const v = validateManifest(body.manifest);
    if (!v.ok) return json({ error: "bad_request", message: v.error }, 400);
    const manifest = body.manifest as { files: { type: string; sha256: string; encSha?: string }[] };

    // Blob-existence: refuse to advance head past a manifest that references blobs
    // we don't have, or every future pull breaks. Distinct 422 so the client uploads.
    // Check the STORED address: encSha (ciphertext) when encrypted, else the sha.
    const fileShas = [...new Set(manifest.files.filter((f) => f.type === "file").map((f) => f.encSha ?? f.sha256))];
    const missing = await this.missingBlobs(fileShas);
    if (missing.length > 0) return json({ error: "unsatisfied_blobs", missing }, 422);

    // Stage the manifest blob in R2 BEFORE the critical section. If this commit
    // loses the sequence race it's just an orphan blob (content-addressed; GC reclaims).
    const serialized = new TextEncoder().encode(JSON.stringify(body.manifest));
    const sha = await sha256Hex(serialized.buffer as ArrayBuffer);
    await this.env.rbox_dev_blobs.put(manifestKey(sha), serialized);
    await this.env.rbox_dev_db.prepare("INSERT OR IGNORE INTO blobs (sha256, size_bytes) VALUES (?, ?)").bind(sha, serialized.byteLength).run();

    // Atomic head check + advance — synchronous, no await inside.
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
        this.ctx.storage.kv.put(`seq:${next}`, sha);
      });
      outcome = { sequence: next };
    } catch (e) {
      if (e !== ABORT) throw e;
    }

    if ("conflict" in outcome!) return json({ error: "conflict", head: outcome!.conflict }, 409);
    const sequence = outcome!.sequence;

    // Best-effort D1 mirror (not authoritative) + workspace registry for GC.
    try {
      await this.env.rbox_dev_db
        .prepare("INSERT OR IGNORE INTO workspaces (workspace_id, project_id, created_at) VALUES (?, ?, ?)")
        .bind(ws, proj, Date.now())
        .run();
      await this.env.rbox_dev_db
        .prepare("INSERT OR IGNORE INTO manifests (workspace_id, project_id, sequence, manifest_blob_sha, device_id) VALUES (?, ?, ?, ?, ?)")
        .bind(ws, proj, sequence, sha, body.deviceId ?? null)
        .run();
    } catch (e) {
      console.error("D1 manifest mirror failed (non-fatal)", e);
    }

    this.broadcast(JSON.stringify({ type: "committed", sequence, deviceId: body.deviceId ?? null }), body.deviceId ?? null);
    return json({ sequence, manifestSha: sha });
  }

  /** Authoritative retained roots (M6 GC): {seq, manifestSha} for every sequence
   *  the DO still holds (pruneFloor, head]. The mark phase reads these. */
  private async roots(): Promise<Response> {
    const head = (this.ctx.storage.kv.get("head") as number | undefined) ?? 0;
    const floor = (this.ctx.storage.kv.get("pruneFloor") as number | undefined) ?? 0;
    const roots: Array<{ seq: number; sha: string }> = [];
    for (let s = floor + 1; s <= head; s++) {
      const sha = this.ctx.storage.kv.get(`seq:${s}`) as string | undefined;
      if (sha) roots.push({ seq: s, sha });
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

  /** A specific historical version's manifest (M6). */
  private async manifestAt(seq: number): Promise<Response> {
    if (!Number.isInteger(seq) || seq < 1) return json({ error: "bad_request" }, 400);
    const sha = this.ctx.storage.kv.get(`seq:${seq}`) as string | undefined;
    if (!sha) return json({ error: "not_found" }, 404);
    const obj = await this.env.rbox_dev_blobs.get(manifestKey(sha));
    if (!obj) return json({ error: "manifest_blob_missing" }, 500);
    return json({ sequence: seq, manifest: JSON.parse(await obj.text()) });
  }

  private async latest(): Promise<Response> {
    const head = (this.ctx.storage.kv.get("head") as number | undefined) ?? 0;
    if (head === 0) return json({ sequence: 0, manifest: { generatedAt: "", files: [] } });
    const sha = this.ctx.storage.kv.get(`seq:${head}`) as string | undefined;
    if (!sha) return json({ error: "manifest_pointer_missing" }, 500);
    const obj = await this.env.rbox_dev_blobs.get(manifestKey(sha));
    if (!obj) return json({ error: "manifest_blob_missing" }, 500);
    return json({ sequence: head, manifest: JSON.parse(await obj.text()) });
  }

  private async missingBlobs(shas: string[]): Promise<string[]> {
    const present = new Set<string>();
    const condemned = new Set<string>();
    for (let i = 0; i < shas.length; i += 80) {
      const chunk = shas.slice(i, i + 80);
      if (chunk.length === 0) break;
      const ph = chunk.map(() => "?").join(",");
      const rows = await this.env.rbox_dev_db.prepare(`SELECT sha256 FROM blobs WHERE sha256 IN (${ph})`).bind(...chunk).all<{ sha256: string }>();
      for (const r of rows.results ?? []) present.add(r.sha256);
      // GC candidates count as MISSING → forces a re-upload that resurrects them
      // before any new commit can reference them. Closes the dedup/GC race.
      const cand = await this.env.rbox_dev_db.prepare(`SELECT sha256 FROM gc_candidates WHERE sha256 IN (${ph})`).bind(...chunk).all<{ sha256: string }>();
      for (const r of cand.results ?? []) condemned.add(r.sha256);
    }
    return shas.filter((s) => !present.has(s) || condemned.has(s));
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

function manifestKey(sha: string): string {
  return `manifests/sha256/${sha.slice(0, 2)}/${sha}`;
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
