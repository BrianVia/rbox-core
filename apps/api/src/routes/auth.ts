import { eq, isDeviceRevoke, type RouteCtx } from "./shared.js";
import { approveDeviceAuth, approveDeviceAuthDev, bootstrap, createPairToken, listDevices, lookupDeviceAuth, lookupDevicePubkeys, pollDeviceAuth, redeemPairToken, revokeDevice, startDeviceAuth } from "../auth.js";
import type { Principal } from "../authz.js";
import { ackKeyDelivery, fetchKeyDeliveryRequest, submitKeyDeliveryBlob } from "../auth/key-delivery.js";

/**
 * Public auth endpoints (EXACT routes only). These carry no rbox Principal (the
 * pasted pair token / device flow IS the credential), so they sit BEFORE
 * authenticate().
 */
export async function authPublicRoutes({ req, env, executionCtx, seg }: RouteCtx): Promise<Response | null> {
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "start"])) return startDeviceAuth(req, env);
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "poll"])) return pollDeviceAuth(req, env, executionCtx);
  // design 47: the web confirm page only has the userCode from the URL — this lets
  // it show "approve login for <label>?" before requiring a session. Query-string
  // route (no path param), so it's `seg`-matched like the others; `code` is read
  // inside the handler.
  if (req.method === "GET" && eq(seg, ["v1", "auth", "device", "lookup"])) return lookupDeviceAuth(req, env);
  if (req.method === "GET" && eq(seg, ["v1", "auth", "device", "pubkeys"])) return lookupDevicePubkeys(req, env);
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "bootstrap"])) return bootstrap(req, env, executionCtx);
  // Pairing redeem is PUBLIC (the pasted token IS the credential) — exact route.
  if (req.method === "POST" && eq(seg, ["v1", "auth", "pair", "redeem"])) return redeemPairToken(req, env);
  return null;
}

/** Authed device/credential ops (scoped to the caller's account, under the §1.1
 *  web-token gate). */
export async function authDeviceRoutes({ req, env, executionCtx, seg }: RouteCtx, p: Principal): Promise<Response | null> {
  if (req.method === "POST" && eq(seg, ["v1", "auth", "pair", "create"])) return createPairToken(req, env, p);
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "approve"])) return approveDeviceAuth(req, env, p, executionCtx);
  // DEV-ONLY (design 192): scriptable approve for the headless 189 rig. Reachable only
  // by a durable device bearer; approveDeviceAuthDev 404s unless env.RBOX_ENV==="dev".
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "approve-dev"])) return approveDeviceAuthDev(req, env, p, executionCtx);
  if (req.method === "POST" && eq(seg, ["v1", "auth", "key-delivery", "fetch"])) return fetchKeyDeliveryRequest(req, env, p);
  if (req.method === "POST" && eq(seg, ["v1", "auth", "key-delivery", "submit"])) return submitKeyDeliveryBlob(req, env, p);
  if (req.method === "POST" && eq(seg, ["v1", "auth", "key-delivery", "ack"])) return ackKeyDelivery(req, env, p);
  if (req.method === "GET" && eq(seg, ["v1", "auth", "devices"])) return listDevices(env, p);
  if (isDeviceRevoke(req.method, seg)) return revokeDevice(env, p, seg[3]!);
  return null;
}
