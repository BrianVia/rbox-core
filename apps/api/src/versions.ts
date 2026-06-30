import type { Env } from "./env.js";
import { blobKey, json, manifestKey } from "./util.js";
import { releaseUsage } from "./billing.js";
import { dbFor } from "./db.js";

// §32 FLAG: global GC (mark/purge) enumerates `workspaces`/`blobs`/`blob_refs`/
// `gc_candidates` across ALL accounts and keys the per-blob deletes by `sha256` — an
// account-data-plane CROSS-SHARD fan-out (design 32 §6b, deferred to §33). None of these
// sites has an account id in scope, so they call `dbFor(env, "")`: account-less, the one
// shard at N=1, and exactly the sites a real shard cutover must turn into a per-shard
// fan-out. (`releaseUsage` below DOES carry the owning account → routes normally.)

/**
 * Build the GLOBAL reachable set from AUTHORITATIVE DO roots (GC). Enumerates the
 * workspace registry and asks each DO for its retained roots (fail closed if any
 * can't be read). Under full E2EE the DO parses each retained commit body and
 * hands back the content addresses directly — the encrypted manifest sha and every
 * referenced encSha — so GC needs NO R2 manifest fetch and stays zero-knowledge.
 */
async function computeReachable(env: Env): Promise<Set<string>> {
  const reachable = new Set<string>();
  const wss = await dbFor(env, "").prepare("SELECT workspace_id, project_id FROM workspaces").all<{ workspace_id: string; project_id: string }>();
  for (const w of wss.results ?? []) {
    const id = env.WORKSPACE_SYNC.idFromName(`${w.workspace_id}/${w.project_id}`);
    const res = await env.WORKSPACE_SYNC.get(id).fetch(`https://do/v1/ws/${w.workspace_id}/proj/${w.project_id}/roots`);
    if (!res.ok) throw new Error(`GC abort (fail-closed): cannot read roots for ${w.workspace_id}/${w.project_id}`);
    const { roots } = (await res.json()) as { roots: Array<{ seq: number; commitHash: string; encManifestSha: string; encShas: string[] }> };
    for (const r of roots) {
      if (r.encManifestSha) reachable.add(r.encManifestSha); // the encrypted manifest (itself a normal blob)
      for (const s of r.encShas) reachable.add(s); // every referenced ciphertext blob
    }
  }
  return reachable;
}

const shaOfKey = (key: string) => key.split("/").pop() ?? "";

/** GC mark: tag unreachable canonical objects older than grace as candidates.
 *  NEVER moves/deletes canonical R2 keys (a candidate reads as "missing" via the
 *  existence check, so a new dedup reference re-uploads → resurrects it). */
export async function gcMark(env: Env, graceMs: number): Promise<Response> {
  const reachable = await computeReachable(env);
  const now = Date.now();
  let marked = 0;
  for (const [prefix, kind] of [["blobs/sha256/", "blob"], ["manifests/sha256/", "manifest"]] as const) {
    let cursor: string | undefined;
    do {
      const list = await env.rbox_dev_blobs.list({ prefix, cursor, limit: 1000 });
      for (const o of list.objects) {
        const sha = shaOfKey(o.key);
        if (!sha || reachable.has(sha)) continue;
        if (now - o.uploaded.getTime() < graceMs) continue; // protect brand-new uploads
        const r = await dbFor(env, "").prepare("INSERT OR IGNORE INTO gc_candidates (sha256, kind, marked_at) VALUES (?, ?, ?)").bind(sha, kind, now).run();
        marked += r.meta.changes ?? 0;
      }
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  }
  return json({ marked });
}

/** GC purge: re-mark, then delete only candidates still unreachable AND past the
 *  grace window; un-condemn any that became reachable. */
export async function gcPurge(env: Env, graceMs: number): Promise<Response> {
  const reachable = await computeReachable(env); // fresh authoritative roots
  const now = Date.now();
  const cands = await dbFor(env, "").prepare("SELECT sha256, kind, marked_at FROM gc_candidates").all<{ sha256: string; kind: string; marked_at: number }>();
  let purged = 0;
  let resurrected = 0;
  for (const c of cands.results ?? []) {
    if (reachable.has(c.sha256)) {
      await dbFor(env, "").prepare("DELETE FROM gc_candidates WHERE sha256 = ?").bind(c.sha256).run();
      resurrected++;
      continue;
    }
    if (now - c.marked_at < graceMs) continue; // not past grace yet
    // Decrement each entitled account's usage counter before dropping entitlements (M7b).
    if (c.kind === "blob") {
      const sizeRow = await dbFor(env, "").prepare("SELECT size_bytes FROM blobs WHERE sha256 = ?").bind(c.sha256).first<{ size_bytes: number }>();
      const size = Number(sizeRow?.size_bytes ?? 0);
      if (size > 0) {
        const accts = await dbFor(env, "").prepare("SELECT account_id FROM blob_refs WHERE sha256 = ?").bind(c.sha256).all<{ account_id: string }>();
        for (const a of accts.results ?? []) await releaseUsage(env, a.account_id, size);
      }
    }
    await env.rbox_dev_blobs.delete(c.kind === "manifest" ? manifestKey(c.sha256) : blobKey(c.sha256));
    await dbFor(env, "").prepare("DELETE FROM blobs WHERE sha256 = ?").bind(c.sha256).run();
    await dbFor(env, "").prepare("DELETE FROM blob_refs WHERE sha256 = ?").bind(c.sha256).run(); // drop entitlements (M7)
    await dbFor(env, "").prepare("DELETE FROM gc_candidates WHERE sha256 = ?").bind(c.sha256).run();
    purged++;
  }
  return json({ purged, resurrected });
}

/** GET /v1/ws/:ws/proj/:proj/versions?limit=N — commit history (newest first).
 *  Read from the D1 `commits` mirror (eventually consistent; fine for browsing). */
export async function versionsList(env: Env, accountId: string, ws: string, proj: string, limit: number): Promise<Response> {
  const n = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 50;
  // `commits` is account-data; the Worker authorizes the workspace (owner === accountId)
  // before calling, so route by the verified caller's account (§32 §2).
  const rows = await dbFor(env, accountId)
    .prepare("SELECT sequence, commit_hash, device_id, created_at FROM commits WHERE workspace_id = ? AND project_id = ? ORDER BY sequence DESC LIMIT ?")
    .bind(ws, proj, n)
    .all<{ sequence: number; commit_hash: string; device_id: string | null; created_at: number }>();
  return json({ versions: rows.results ?? [] });
}
