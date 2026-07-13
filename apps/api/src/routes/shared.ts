import type { Env, WorkerEntrypointExports } from "../env.js";
import { json } from "../util.js";

/**
 * Shared plumbing for the domain route modules (see ./). A route group is a
 * `(ctx[, p]) => Promise<Response | null>`: it returns a Response when it OWNS the
 * request, or `null` to fall through to the next group — reproducing the original
 * worker.ts if-chain's "first match wins" semantics. The dispatch order in
 * worker.ts is load-bearing for the documented overlapping-prefix cases (e.g.
 * blobs/check before blobs/:sha); exact-match routes across groups are mutually
 * exclusive, so grouping them by domain is behavior-preserving.
 */
export interface RouteCtx {
  req: Request;
  env: Env;
  exports: WorkerEntrypointExports;
  url: URL;
  seg: string[];
}

export function eq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** `POST /v1/auth/devices/:deviceId/revoke` — a wildcard route (`:deviceId`) `eq`
 *  can't express, so it has its own matcher used by BOTH the dispatcher and the
 *  web-token allowlist (kept in one place so the two never drift). */
export function isDeviceRevoke(method: string, seg: string[]): boolean {
  return method === "POST" && seg.length === 5 && eq([seg[0]!, seg[1]!, seg[2]!, seg[4]!], ["v1", "auth", "devices", "revoke"]);
}

export function badRequest(message: string): Response {
  return json({ error: "bad_request", message }, 400);
}
