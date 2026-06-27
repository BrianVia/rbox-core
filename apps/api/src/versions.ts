import type { Env } from "./env.js";
import { blobKey, json, manifestKey } from "./util.js";
import { releaseUsage } from "./billing.js";

/**
 * Build the GLOBAL reachable set from AUTHORITATIVE DO roots (M6 GC). Enumerates
 * the workspace registry, asks each DO for its retained {seq,manifestSha} roots
 * (fail closed if any can't be read), loads each manifest, and collects every
 * referenced content address: the manifest sha, file `encSha ?? sha256`, and git
 * bundle/index/op-state shas. (Symlink shas and git refs/head are NOT blobs.)
 */
async function computeReachable(env: Env): Promise<Set<string>> {
  const reachable = new Set<string>();
  const wss = await env.rbox_dev_db.prepare("SELECT workspace_id, project_id FROM workspaces").all<{ workspace_id: string; project_id: string }>();
  for (const w of wss.results ?? []) {
    const id = env.WORKSPACE_SYNC.idFromName(`${w.workspace_id}/${w.project_id}`);
    const res = await env.WORKSPACE_SYNC.get(id).fetch(`https://do/v1/ws/${w.workspace_id}/proj/${w.project_id}/roots`);
    if (!res.ok) throw new Error(`GC abort (fail-closed): cannot read roots for ${w.workspace_id}/${w.project_id}`);
    const { roots } = (await res.json()) as { roots: Array<{ seq: number; sha: string }> };
    for (const r of roots) {
      reachable.add(r.sha); // the manifest blob itself
      const obj = await env.rbox_dev_blobs.get(manifestKey(r.sha));
      if (!obj) continue;
      const m = JSON.parse(await obj.text()) as { files?: Array<{ type: string; sha256: string; encSha?: string }>; git?: { bundleSha?: string; indexSha?: string; opState?: Record<string, string> } };
      for (const f of m.files ?? []) if (f.type === "file") reachable.add(f.encSha ?? f.sha256);
      if (m.git) {
        if (m.git.bundleSha) reachable.add(m.git.bundleSha);
        if (m.git.indexSha) reachable.add(m.git.indexSha);
        for (const s of Object.values(m.git.opState ?? {})) reachable.add(s);
      }
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
        const r = await env.rbox_dev_db.prepare("INSERT OR IGNORE INTO gc_candidates (sha256, kind, marked_at) VALUES (?, ?, ?)").bind(sha, kind, now).run();
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
  const cands = await env.rbox_dev_db.prepare("SELECT sha256, kind, marked_at FROM gc_candidates").all<{ sha256: string; kind: string; marked_at: number }>();
  let purged = 0;
  let resurrected = 0;
  for (const c of cands.results ?? []) {
    if (reachable.has(c.sha256)) {
      await env.rbox_dev_db.prepare("DELETE FROM gc_candidates WHERE sha256 = ?").bind(c.sha256).run();
      resurrected++;
      continue;
    }
    if (now - c.marked_at < graceMs) continue; // not past grace yet
    // Decrement each entitled account's usage counter before dropping entitlements (M7b).
    if (c.kind === "blob") {
      const sizeRow = await env.rbox_dev_db.prepare("SELECT size_bytes FROM blobs WHERE sha256 = ?").bind(c.sha256).first<{ size_bytes: number }>();
      const size = Number(sizeRow?.size_bytes ?? 0);
      if (size > 0) {
        const accts = await env.rbox_dev_db.prepare("SELECT account_id FROM blob_refs WHERE sha256 = ?").bind(c.sha256).all<{ account_id: string }>();
        for (const a of accts.results ?? []) await releaseUsage(env, a.account_id, size);
      }
    }
    await env.rbox_dev_blobs.delete(c.kind === "manifest" ? manifestKey(c.sha256) : blobKey(c.sha256));
    await env.rbox_dev_db.prepare("DELETE FROM blobs WHERE sha256 = ?").bind(c.sha256).run();
    await env.rbox_dev_db.prepare("DELETE FROM blob_refs WHERE sha256 = ?").bind(c.sha256).run(); // drop entitlements (M7)
    await env.rbox_dev_db.prepare("DELETE FROM gc_candidates WHERE sha256 = ?").bind(c.sha256).run();
    purged++;
  }
  return json({ purged, resurrected });
}

/** GET /v1/ws/:ws/proj/:proj/versions?limit=N — commit history (newest first).
 *  Read from the D1 mirror (eventually consistent; fine for browsing). */
export async function versionsList(env: Env, ws: string, proj: string, limit: number): Promise<Response> {
  const n = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 50;
  const rows = await env.rbox_dev_db
    .prepare("SELECT sequence, manifest_blob_sha, device_id, created_at FROM manifests WHERE workspace_id = ? AND project_id = ? ORDER BY sequence DESC LIMIT ?")
    .bind(ws, proj, n)
    .all<{ sequence: number; manifest_blob_sha: string; device_id: string | null; created_at: string }>();
  return json({ versions: rows.results ?? [] });
}
