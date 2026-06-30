import { requireCredentials } from "./credentials.js";

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
  if (!res.ok) throw new Error(`link failed: ${res.status} ${await res.text()}`);
  const { account } = (await res.json()) as { account: string };
  console.log(`Proposed link to account ${account}.`);
  console.log(`\nFinish in your rbox dashboard: approve the pending request for this account to complete the link.`);
}

/** `rbox account status` — is a web login linked to this account? */
export async function accountStatus(): Promise<void> {
  const c = await requireCredentials();
  const res = await fetch(`${c.remoteUrl}/v1/account/status`, { headers: { authorization: `Bearer ${c.token}` } });
  if (!res.ok) throw new Error(`status failed: ${res.status}`);
  const { accountId, linked } = (await res.json()) as { accountId: string; linked: boolean };
  console.log(`account:          ${accountId}`);
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
  if (!res.ok) throw new Error(`unlink failed: ${res.status}`);
  console.log("unlinked — the web login was moved to a fresh empty account (your CLI data is untouched).");
}
