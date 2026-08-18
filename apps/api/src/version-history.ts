/** Never: garbage collection, retention mutation, or Durable Object sequencing. */
import type { Env } from "./env.js";
import { json } from "./util.js";
import { dbFor } from "./db.js";

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
