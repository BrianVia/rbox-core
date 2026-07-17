import { eq, type RouteCtx } from "./shared.js";
import { cappedJson, json } from "../util.js";
import { accountStatus, confirmLink, LINK_REDEEM_MAX_BYTES, linkStatus, redeemLink, startLink, unlinkAccount, validateLinkRedeemBody } from "../account-link.js";
import { accountDevices, accountWorkspaces } from "../auth.js";
import { countWorkspaces, planLimitsFor, usage } from "../billing.js";
import { createWorkspace, type Principal } from "../authz.js";
import { deleteAccount } from "../account-delete.js";

/**
 * Account linking (design 21) — start/status/confirm are PUBLIC: authenticated by
 * a re-verified Clerk JWT (in body, or the Authorization header for the GET), NOT
 * an rbox bearer, so they sit before authenticate() and outside the §1.1 gate.
 */
export async function accountLinkPublicRoutes({ req, env, url, seg }: RouteCtx): Promise<Response | null> {
  if (req.method === "POST" && eq(seg, ["v1", "account", "link", "start"])) return startLink(req, env, Date.now());
  if (req.method === "GET" && eq(seg, ["v1", "account", "link", "status"])) return linkStatus(req, env, Date.now(), url.searchParams.get("pollKey") ?? "");
  if (req.method === "POST" && eq(seg, ["v1", "account", "link", "confirm"])) return confirmLink(req, env, Date.now());
  return null;
}

/** Authed account ops (scoped to the caller's account), under the §1.1 web-token gate. */
export async function accountRoutes({ req, env, url, seg }: RouteCtx, p: Principal): Promise<Response | null> {
  if (req.method === "GET" && eq(seg, ["v1", "account", "usage"])) return usage(env, p);
  // design 22 §2: the web-facing devices/workspaces lists (camelCase, secret-free).
  if (req.method === "GET" && eq(seg, ["v1", "account", "devices"])) return accountDevices(env, p, url);
  if (req.method === "GET" && eq(seg, ["v1", "account", "workspaces"])) return accountWorkspaces(env, p, url);
  // Account linking — AUTHED rbox-bearer routes (under the §1.1 web-token gate).
  if (req.method === "POST" && eq(seg, ["v1", "account", "link", "redeem"])) {
    const parsed = await cappedJson(req, { maxBytes: LINK_REDEEM_MAX_BYTES }, validateLinkRedeemBody);
    if (!parsed.ok) return parsed.response;
    return redeemLink(env, p, parsed.value.code);
  }
  if (req.method === "POST" && eq(seg, ["v1", "account", "unlink"])) return unlinkAccount(env, p, Date.now());
  if (req.method === "GET" && eq(seg, ["v1", "account", "status"])) return accountStatus(env, p);
  // Self-serve account + data deletion (design 37) — OWNER-ONLY, confirmation-gated.
  if (req.method === "DELETE" && eq(seg, ["v1", "account"])) return deleteAccount(env, p, req, Date.now());
  if (req.method === "POST" && eq(seg, ["v1", "workspaces"])) {
    const limits = await planLimitsFor(env, p.accountId); // workspace-count quota (M7b)
    if ((await countWorkspaces(env, p.accountId)) >= limits.workspaces) {
      return json({ error: "quota_exceeded", limit: "workspaces", cap: limits.workspaces }, 402);
    }
    // `name` is the OPT-IN, server-visible dashboard label (§ workspace-names); absent → private default.
    return createWorkspace(env, p, url.searchParams.get("project") ?? "root", url.searchParams.get("name"));
  }
  return null;
}
