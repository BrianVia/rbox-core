import { eq, isDeviceRevoke, type RouteCtx } from "./shared.js";
import { approveDeviceAuth, bootstrap, createPairToken, listDevices, pollDeviceAuth, redeemPairToken, revokeDevice, startDeviceAuth } from "../auth.js";
import type { Principal } from "../authz.js";

/**
 * Public auth endpoints (EXACT routes only). These carry no rbox Principal (the
 * pasted pair token / device flow IS the credential), so they sit BEFORE
 * authenticate().
 */
export async function authPublicRoutes({ req, env, seg }: RouteCtx): Promise<Response | null> {
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "start"])) return startDeviceAuth(req, env);
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "poll"])) return pollDeviceAuth(req, env);
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "bootstrap"])) return bootstrap(req, env);
  // Pairing redeem is PUBLIC (the pasted token IS the credential) — exact route.
  if (req.method === "POST" && eq(seg, ["v1", "auth", "pair", "redeem"])) return redeemPairToken(req, env);
  return null;
}

/** Authed device/credential ops (scoped to the caller's account, under the §1.1
 *  web-token gate). */
export async function authDeviceRoutes({ req, env, seg }: RouteCtx, p: Principal): Promise<Response | null> {
  if (req.method === "POST" && eq(seg, ["v1", "auth", "pair", "create"])) return createPairToken(req, env, p);
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "approve"])) return approveDeviceAuth(req, env, p);
  if (req.method === "GET" && eq(seg, ["v1", "auth", "devices"])) return listDevices(env, p);
  if (isDeviceRevoke(req.method, seg)) return revokeDevice(env, p, seg[3]!);
  return null;
}
