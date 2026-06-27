import type { Env } from "./env.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
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
