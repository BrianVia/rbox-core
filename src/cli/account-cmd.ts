import { loadCredentials, requireCredentials } from "./credentials.js";
import { emitJson } from "./json.js";
import { style } from "./style.js";
import { friendlyHttpError } from "./http-error.js";
import { identityField, identityText, scheduleAccountProfileWrite } from "./account-profile.js";

/**
 * `rbox account <link|status|unlink>` (design 21 §4.0) — the web↔CLI account-link
 * verbs. A NEW top-level group, deliberately NOT folded into `rbox link <path>`
 * (which binds a directory to a workspace). These are thin authed HTTP calls over
 * the per-machine device credential; the security lives server-side (§4.2).
 */

/** `rbox account link <code>` — redeem a dashboard link code from this (durable
 *  OWNER) device. Records a PENDING proposal the user approves in the dashboard. */
export async function accountLink(code: string): Promise<void> {
  if (!code) throw new Error("usage: rbox account link <code>  (copy the code from your rbox dashboard)");
  const c = await requireCredentials();
  const res = await fetch(`${c.remoteUrl}/v1/account/link/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${c.token}` },
    body: JSON.stringify({ code }),
  });
  if (res.status === 403) throw new Error("this device can't link an account — `rbox account link` must run from a non-revoked OWNER device (one set up with `rbox login --bootstrap`).");
  if (res.status === 401) throw new Error("invalid or expired link code — generate a fresh one in your dashboard.");
  if (!res.ok) throw await friendlyHttpError(res, "account link");
  const { account } = (await res.json()) as { account: string };
  console.log(`Proposed link to account ${account}.`);
  console.log(`\nFinish in your rbox dashboard: approve the pending request for this account to complete the link.`);
}

/** The shape of `GET /v1/account/status`. `plan` is best-effort: absence from an
 * older API stays distinguishable for the brief, while the legacy detail renderer
 * continues to display it as no active plan. */
export interface AccountStatus {
  accountId: string;
  plan?: string;
  graceUntil?: number | null;
  readOnly?: boolean;
  /** Whether a web (Clerk) login manages this account. */
  linked: boolean;
  email?: string | null;
  signInMethod?: string | null;
}

function accountStatusFromResponse(body: unknown): AccountStatus {
  const value = body as { accountId: string; linked: boolean; plan?: string; email?: unknown; signInMethod?: unknown };
  const email = identityField(value.email);
  const signInMethod = identityField(value.signInMethod);
  return {
    accountId: value.accountId,
    linked: !!value.linked,
    ...(typeof value.plan === "string" ? { plan: value.plan } : {}),
    ...(email ? { email } : {}),
    ...(signInMethod ? { signInMethod } : {}),
  };
}

/** Best-effort account status for the local-first `rbox status` command. NEVER throws
 *  and NEVER blocks: no credentials → `signed-out`; any network error / non-2xx / a
 *  timeout past `timeoutMs` → `unavailable`. Callers render the result; they must not
 *  have to guard against this rejecting (that's the whole point — `rbox status` stays
 *  usable offline). */
export type AccountSummary =
  | { state: "ok"; status: AccountStatus }
  | { state: "signed-out" }
  | { state: "unavailable" };

export async function fetchAccountSummary(timeoutMs = 3500): Promise<AccountSummary> {
  const c = await loadCredentials();
  if (!c) return { state: "signed-out" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${c.remoteUrl}/v1/account/status`, {
      headers: { authorization: `Bearer ${c.token}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return { state: "unavailable" };
    const status = accountStatusFromResponse(await res.json());
    scheduleAccountProfileWrite({
      accountId: status.accountId,
      email: status.email ?? null,
      signInMethod: status.signInMethod ?? null,
      plan: status.plan ?? null,
    });
    return { state: "ok", status };
  } catch {
    // Offline, DNS failure, timeout/abort, malformed body — all degrade to the same
    // "we couldn't reach the account plane" outcome. Local status still renders.
    return { state: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/** Render the ACCOUNT section of `rbox status` from a (best-effort) summary. Returns
 *  the lines to print — colored via `style` (auto-disabled off a TTY). Split out from
 *  the fetch so the formatting is unit-testable without a network. */
export function formatAccountSummary(s: AccountSummary): string[] {
  if (s.state === "signed-out") {
    return [`${style.bold("account")} ${style.dim("not signed in")} ${style.dim("(run `rbox login`)")}`];
  }
  if (s.state === "unavailable") {
    return [`${style.bold("account")} ${style.yellow("(unavailable — offline?)")}`];
  }
  const { accountId, plan, linked, email, signInMethod } = s.status;
  const identity = identityText(email, signInMethod);
  const renderedIdentity = email && identity
    ? `${style.cyan(email)}${style.dim(identity.slice(email.length))}`
    : identity;
  return [
    `${style.bold("account")} ${style.cyan(accountId)}`,
    ...(renderedIdentity ? [`  ${style.dim(email ? "signed in as:" : "sign-in:")} ${renderedIdentity}`] : []),
    `  ${style.dim("plan:")} ${renderPlan(plan)}`,
    `  ${style.dim("web login linked:")} ${linked ? style.green("yes") : style.yellow("no")}`,
  ];
}

function renderPlan(plan: string | null | undefined): string {
  return (plan ?? "none") === "none" ? "no active plan" : plan!;
}

/** `rbox account status` — is a web login linked to this account? (Also shows plan.) */
export async function accountStatus(opts: { json?: boolean } = {}): Promise<void> {
  const c = await requireCredentials();
  const res = await fetch(`${c.remoteUrl}/v1/account/status`, { headers: { authorization: `Bearer ${c.token}` } });
  if (!res.ok) throw await friendlyHttpError(res, "account status");
  const status = accountStatusFromResponse(await res.json());
  scheduleAccountProfileWrite({
    accountId: status.accountId,
    email: status.email ?? null,
    signInMethod: status.signInMethod ?? null,
    plan: status.plan ?? null,
  });
  const { accountId, linked, plan, email, signInMethod } = status;
  if (opts.json) {
    const usage = await fetch(`${c.remoteUrl}/v1/account/usage`, { headers: { authorization: `Bearer ${c.token}` } });
    if (!usage.ok) throw new Error(`usage failed: ${usage.status}`);
    const u = (await usage.json()) as { plan?: string; graceUntil?: number | null; readOnly?: boolean };
    emitJson({
      accountId,
      plan: u.plan ?? plan ?? "none",
      graceUntil: u.graceUntil ?? null,
      readOnly: u.readOnly === true,
      linked: !!linked,
      email,
      ...(signInMethod != null ? { signInMethod } : {}),
    });
    return;
  }
  console.log(`account:          ${accountId}`);
  const identity = identityText(email, signInMethod);
  if (identity) console.log(`${email ? "signed in as:" : "sign-in:"}${email ? "     " : "          "}${identity}`);
  console.log(`plan:             ${renderPlan(plan)}`);
  console.log(`web login linked: ${linked ? "yes" : "no"}`);
}

/** `rbox account unlink` — detach the web login (rebinds it to a fresh empty shell). */
export async function accountUnlink(): Promise<void> {
  const c = await requireCredentials();
  const res = await fetch(`${c.remoteUrl}/v1/account/unlink`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${c.token}` },
    body: "{}",
  });
  if (res.status === 404) throw new Error("this account has no linked web login.");
  if (res.status === 409) throw new Error("this account has active billing — manage or cancel the subscription before unlinking.");
  if (res.status === 403) throw new Error("unlink requires an owner device.");
  if (!res.ok) throw await friendlyHttpError(res, "account unlink");
  console.log("unlinked — the web login was moved to a fresh empty account (your CLI data is untouched).");
}
