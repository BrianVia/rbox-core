import { eq, type RouteCtx } from "./shared.js";
import { admitDevice, appendKeyState, appendRoster, bootstrapAccountKeys, getAccountKeys, getWorkspaceKeys, putDeviceKeys, putWorkspaceKey } from "../keys.js";
import type { Principal } from "../authz.js";

/**
 * E2EE opaque key storage (design 12) — all authed + account-scoped via Principal.
 * The server is zero-knowledge: it stores/serves these blobs verbatim, never decrypts.
 * A non-matching request inside the `v1/keys` prefix falls through (returns null) to
 * the next route group, exactly as the original if-block did.
 */
export async function keysRoutes({ req, env, seg }: RouteCtx, p: Principal): Promise<Response | null> {
  if (seg[0] === "v1" && seg[1] === "keys") {
    if (req.method === "POST" && eq(seg, ["v1", "keys", "bootstrap"])) return bootstrapAccountKeys(env, p, await req.json().catch(() => ({})));
    if (req.method === "GET" && eq(seg, ["v1", "keys", "account"])) return getAccountKeys(env, p);
    if (req.method === "POST" && eq(seg, ["v1", "keys", "device"])) return putDeviceKeys(env, p, await req.json().catch(() => ({})));
    if (req.method === "POST" && eq(seg, ["v1", "keys", "roster"])) return appendRoster(env, p, await req.json().catch(() => ({})));
    // C5: atomic device-keys + roster append (admission) in one D1 batch.
    if (req.method === "POST" && eq(seg, ["v1", "keys", "admit"])) return admitDevice(env, p, await req.json().catch(() => ({})));
    if (req.method === "POST" && eq(seg, ["v1", "keys", "keystate"])) return appendKeyState(env, p, await req.json().catch(() => ({})));
    if (req.method === "POST" && eq(seg, ["v1", "keys", "workspace"])) return putWorkspaceKey(env, p, await req.json().catch(() => ({})));
    if (req.method === "GET" && seg.length === 4 && seg[2] === "workspace") return getWorkspaceKeys(env, p, seg[3]!);
  }
  return null;
}
