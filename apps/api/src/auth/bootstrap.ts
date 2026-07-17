import type { Env } from "../env.js";
import { cappedJson, ctEqual, isWellFormed, json, objectWithKeys, truncateUtf8, utf8Bytes } from "../util.js";
import { capBytesFor } from "../plans.js";
import { dbFor, dirDb } from "../db.js";
import { pingNewAccount } from "../slackpipes.js";
import { randomHex } from "./shared.js";
import { mintDevice } from "./mint.js";
import { fairUseQueueStatement } from "../fairuse.js";

type BootstrapPlan = "solo" | "pro";
export const DEVICE_BOOTSTRAP_MAX_BYTES = 64 * 1024;

export function allowedBootstrapPlan(plan: unknown): BootstrapPlan | null {
  return plan === "solo" || plan === "pro" ? plan : null;
}

export function validateBootstrapBody(value: unknown): { secret: string; label?: string; accountName?: string; plan?: BootstrapPlan } | null {
  if (!objectWithKeys(value, ["secret", "label", "accountName", "plan"], ["secret"])) return null;
  if (typeof value.secret !== "string" || value.secret.length === 0 || utf8Bytes(value.secret) > 4096) return null;
  if (value.label !== undefined && (typeof value.label !== "string" || !isWellFormed(value.label))) return null;
  if (value.accountName !== undefined && (typeof value.accountName !== "string" || value.accountName.length === 0 || !isWellFormed(value.accountName))) return null;
  if (value.plan !== undefined && value.plan !== "solo" && value.plan !== "pro") return null;
  return {
    secret: value.secret,
    ...(value.label === undefined ? {} : { label: truncateUtf8(value.label, 600) }),
    ...(value.accountName === undefined ? {} : { accountName: truncateUtf8(value.accountName, 600) }),
    ...(value.plan === undefined ? {} : { plan: value.plan }),
  };
}

// POST /v1/auth/device/bootstrap { secret, label, plan? } -> { token, deviceId, accountId }
// Creates a fresh account + owner user + device (the trust anchor for a new tenant).
export async function bootstrap(req: Request, env: Env, ctx: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
  const parsed = await cappedJson(req, { maxBytes: DEVICE_BOOTSTRAP_MAX_BYTES }, validateBootstrapBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const secret = env.RBOX_BOOTSTRAP_SECRET ?? "";
  if (!secret || typeof body.secret !== "string" || !ctEqual(body.secret, secret)) {
    return json({ error: "unauthorized" }, 401); // constant-time, identical failure
  }
  const requestedPlan = allowedBootstrapPlan(body.plan);
  if (env.RBOX_ALLOW_BOOTSTRAP_PLAN === "1" && body.plan !== undefined && !requestedPlan) {
    return json({ error: "bad_plan" }, 400);
  }
  const plan = env.RBOX_ALLOW_BOOTSTRAP_PLAN === "1" && requestedPlan ? requestedPlan : "none";
  const now = Date.now();
  const accountId = `acct_${randomHex(8)}`;
  const userId = `user_${randomHex(8)}`;
  // origin='bootstrap' marks this as a crypto-anchored account (design 21 §3.2) — never
  // auto-reclaimable. cap_bytes is the materialized §23 hard-cap (kept in sync by the trigger).
  const accountDb = dbFor(env, accountId);
  await accountDb.batch([
    accountDb.prepare("INSERT INTO accounts (id, name, plan, origin, created_at, cap_bytes) VALUES (?, ?, ?, 'bootstrap', ?, ?)")
      .bind(accountId, body.accountName ?? "account", plan, now, capBytesFor(plan)),
    fairUseQueueStatement(accountDb, accountId, now, "account_created"),
  ]);
  // users/memberships are directory-plane (authenticate JOINs memberships, §32 §2).
  await dirDb(env).prepare("INSERT INTO users (id, account_id, created_at) VALUES (?, ?, ?)").bind(userId, accountId, now).run();
  await dirDb(env).prepare("INSERT INTO memberships (account_id, user_id, role) VALUES (?, ?, 'owner')").bind(accountId, userId).run();
  const { token, deviceId } = await mintDevice(env, accountId, userId, "dev", body.label ?? "bootstrap");
  // §32 Tier 1 business ping (best-effort, never throws/blocks) — a new tenant via the
  // CLI bootstrap path. Fires after the account is durably created.
  pingNewAccount(ctx, env, { accountId, origin: "bootstrap", ...(plan !== "none" ? { plan } : {}) });
  return json({ token, deviceId, accountId });
}
