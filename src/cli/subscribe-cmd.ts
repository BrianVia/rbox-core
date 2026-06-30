import { spawn } from "node:child_process";
import { requireCredentials } from "./credentials.js";

/**
 * `rbox subscribe [plan]` / `rbox billing` (design 21 §3.4.1) — the PRIMARY billing
 * path. A durable CLI device token already authenticates on the user's real account
 * X, and `/v1/billing/checkout` binds the Stripe checkout to `Principal.accountId`,
 * so opening that checkout pays onto X directly — no web shell, no re-point.
 *
 * SECURITY: this is a BILLING handoff, not an IDENTITY handoff. It binds no Clerk
 * identity and creates no account link; it is deliberately separate from
 * `rbox account link` (which stays dashboard→CLI for takeover-safety, §5.2).
 */

const PLANS = ["solo", "pro"] as const;

/** Open a URL in the user's browser, cross-platform. Returns false (so the caller
 *  prints the URL) when there's no opener or we're not on a TTY — never blocks. */
function openInBrowser(url: string): boolean {
  if (!process.stdout.isTTY) return false; // CI / piped → just print the URL
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // a missing opener rejects async — handled by the printed fallback
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Open `url` (or fall back to printing it), with the verb-appropriate message. */
function openAndShow(url: string, opening: string, fallback: string): void {
  console.log(`${openInBrowser(url) ? opening : fallback}\n  ${url}`);
}

/** `rbox subscribe [plan]` — open a Stripe checkout bound to THIS account. */
export async function subscribe(plan: string | undefined): Promise<void> {
  if (!plan) throw new Error(`usage: rbox subscribe <plan>  (one of: ${PLANS.join(", ")})`);
  if (!(PLANS as readonly string[]).includes(plan)) throw new Error(`unknown plan "${plan}" — choose one of: ${PLANS.join(", ")}`);
  const c = await requireCredentials();
  const res = await fetch(`${c.remoteUrl}/v1/billing/checkout?plan=${encodeURIComponent(plan)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${c.token}` },
  });
  if (res.status === 409) {
    // already_subscribed — not an error; the account already pays. Point at the portal.
    const body = (await res.json().catch(() => ({}))) as { plan?: string };
    console.log(`You're already subscribed${body.plan ? ` (plan: ${body.plan})` : ""}. Manage or change it with \`rbox billing\`.`);
    return;
  }
  if (res.status === 501) throw new Error("billing isn't enabled on this server yet.");
  if (!res.ok) throw new Error(`subscribe failed: ${res.status} ${await res.text()}`);
  const { url } = (await res.json()) as { url: string };
  openAndShow(url, "Opening your browser to complete checkout...", "Open this URL in your browser to complete checkout:");
}

/** `rbox billing` — open the Stripe customer portal for THIS account (manage/cancel). */
export async function billingPortal(): Promise<void> {
  const c = await requireCredentials();
  const res = await fetch(`${c.remoteUrl}/v1/billing/portal`, {
    method: "POST",
    headers: { authorization: `Bearer ${c.token}` },
  });
  if (res.status === 409) throw new Error("no subscription yet — run `rbox subscribe <plan>` first.");
  if (res.status === 501) throw new Error("billing isn't enabled on this server yet.");
  if (!res.ok) throw new Error(`billing portal failed: ${res.status} ${await res.text()}`);
  const { url } = (await res.json()) as { url: string };
  openAndShow(url, "Opening your billing portal...", "Open your billing portal:");
}
