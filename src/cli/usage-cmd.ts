import { requireCredentials } from "./credentials.js";
import { formatBinaryBytes } from "./quota-format.js";
import { friendlyHttpError } from "./http-error.js";

export interface AccountUsageDTO {
  plan: string;
  usedBytes: number;
  storageCap: number | null;
  workspaces: number;
  workspaceCap: number | null;
  retentionDays: number;
  graceUntil: number | null;
  readOnly: boolean;
}

const BAR_WIDTH = 20;

function renderPlan(plan: string): string {
  return plan === "none" ? "no active plan" : plan;
}

export async function usageCmd(opts: { json?: boolean } = {}): Promise<void> {
  const c = await requireCredentials();
  const res = await fetch(`${c.remoteUrl}/v1/account/usage`, {
    headers: { authorization: `Bearer ${c.token}` },
  });
  const text = await res.text();
  if (!res.ok) throw await friendlyHttpError(res, "usage", text);
  if (opts.json) {
    console.log(text);
    return;
  }
  console.log(renderUsage(JSON.parse(text) as AccountUsageDTO));
}

function renderUsage(u: AccountUsageDTO): string {
  let pct: number | undefined;
  if (u.storageCap !== null) {
    if (u.storageCap <= 0) {
      pct = u.usedBytes > 0 ? 100 : 0;
    } else {
      pct = Math.min(100, Math.max(0, Math.round((u.usedBytes / u.storageCap) * 100)));
    }
  }
  const filled = pct === undefined ? 0 : Math.min(BAR_WIDTH, Math.max(0, Math.round((pct / 100) * BAR_WIDTH)));
  const bar = "▓".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
  const storage = `${formatBinaryBytes(u.usedBytes)} / ${u.storageCap === null ? "unlimited" : formatBinaryBytes(u.storageCap)}`;
  const storageNote = u.storageCap === null ? "unlimited" : `${pct}%${u.readOnly ? ", read-only" : ""}`;
  const workspaceCap = u.workspaceCap === null ? "unlimited" : u.workspaceCap.toLocaleString("en-US");
  const retention = u.retentionDays === 0 ? "0 days (current state only)" : `${u.retentionDays.toLocaleString("en-US")} day${u.retentionDays === 1 ? "" : "s"}`;
  const grace = u.graceUntil === null ? "none" : new Date(u.graceUntil).toISOString();
  return [
    `plan:       ${renderPlan(u.plan)}`,
    `storage:    ${bar}  ${storage}   (${storageNote})`,
    `workspaces: ${u.workspaces.toLocaleString("en-US")} / ${workspaceCap}`,
    `retention:  ${retention}`,
    `grace:      ${grace}`,
    `read-only:  ${u.readOnly ? "yes" : "no"}`,
  ].join("\n");
}
