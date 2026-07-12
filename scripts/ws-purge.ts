#!/usr/bin/env bun

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const workspaceIds = args.filter((arg) => arg !== "--dry-run");
if (workspaceIds.length === 0) throw new Error("usage: ws-purge.ts [--dry-run] <workspaceId> [<workspaceId> ...]");
const api = (process.env.RBOX_API_URL ?? "").replace(/\/$/, "");
const secret = process.env.RBOX_PLATFORM_SECRET ?? "";
if (!api || !secret) throw new Error("RBOX_API_URL and RBOX_PLATFORM_SECRET are required");
const headers = { "x-rbox-platform": secret };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const safeErrorBody = (text: string): string => text.replaceAll(secret, "[redacted]").slice(0, 200);

interface Counts { commits: number; manifests: number; workspace_keys: number; workspaces: number }
interface PurgeResponse { done: boolean; deleted: Counts }
type DryResult = { workspaceId: string; counts: Counts } | { workspaceId: string; notFound: true };
type PurgeResult = { workspaceId: string; passes: number; deleted: Counts } | { workspaceId: string; notFound: true };
const zero = (): Counts => ({ commits: 0, manifests: 0, workspace_keys: 0, workspaces: 0 });
const validCounts = (value: unknown): value is Counts => {
  if (typeof value !== "object" || value === null) return false;
  const counts = value as Record<string, unknown>;
  return ["commits", "manifests", "workspace_keys", "workspaces"].every((key) => typeof counts[key] === "number" && Number.isFinite(counts[key]) && (counts[key] as number) >= 0);
};
const parseResponse = (text: string, status: number, countsKey: "counts" | "deleted"): { done: boolean; counts: Counts } => {
  let value: unknown;
  try { value = JSON.parse(text); } catch { /* handled by shape check */ }
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  if (typeof record.done !== "boolean" || !validCounts(record[countsKey])) {
    throw new Error(`unexpected response shape (${status}): ${safeErrorBody(text)}`);
  }
  return { done: record.done, counts: record[countsKey] };
};

if (dryRun) {
  const workspaces: DryResult[] = [];
  for (const workspaceId of workspaceIds) {
    const res = await fetch(`${api}/v1/admin/workspace/${encodeURIComponent(workspaceId)}?dryRun=1`, { method: "DELETE", headers });
    const text = await res.text();
    if (res.status === 404) {
      console.error(`${JSON.stringify(workspaceId)}: not found`);
      workspaces.push({ workspaceId, notFound: true });
      continue;
    }
    if (!res.ok) throw new Error(`dry-run failed (${res.status}): ${safeErrorBody(text)}`);
    const parsed = parseResponse(text, res.status, "counts");
    console.error(`${JSON.stringify(workspaceId)}: commits=${parsed.counts.commits} manifests=${parsed.counts.manifests} keys=${parsed.counts.workspace_keys} workspaces=${parsed.counts.workspaces}`);
    workspaces.push({ workspaceId, counts: parsed.counts });
  }
  console.log(JSON.stringify({ dryRun: true, workspaces }));
  process.exit(0);
}

const workspaces: PurgeResult[] = [];
for (const workspaceId of workspaceIds) {
  let passes = 0;
  let consecutiveZeroProgress = 0;
  const deleted = zero();
  while (true) {
    const res = await fetch(`${api}/v1/admin/workspace/${encodeURIComponent(workspaceId)}`, { method: "DELETE", headers });
    const text = await res.text();
    if (res.status === 404 && passes === 0) {
      console.error(`${JSON.stringify(workspaceId)}: not found`);
      workspaces.push({ workspaceId, notFound: true });
      break;
    }
    if (!res.ok) throw new Error(`purge failed (${res.status}): ${safeErrorBody(text)}`);
    const parsed = parseResponse(text, res.status, "deleted");
    const pass: PurgeResponse = { done: parsed.done, deleted: parsed.counts };
    passes++;
    deleted.commits += pass.deleted.commits;
    deleted.manifests += pass.deleted.manifests;
    deleted.workspace_keys += pass.deleted.workspace_keys;
    deleted.workspaces += pass.deleted.workspaces;
    console.error(`${JSON.stringify(workspaceId)} pass ${passes}: commits=${pass.deleted.commits} manifests=${pass.deleted.manifests} keys=${pass.deleted.workspace_keys} workspaces=${pass.deleted.workspaces} done=${pass.done}`);
    if (pass.done) {
      workspaces.push({ workspaceId, passes, deleted });
      break;
    }
    const noProgress = Object.values(pass.deleted).every((n) => n === 0);
    consecutiveZeroProgress = noProgress ? consecutiveZeroProgress + 1 : 0;
    if (consecutiveZeroProgress >= 5) throw new Error(`${workspaceId}: purge aborted after 5 consecutive zero-progress passes`);
    await sleep(1_000);
  }
}
console.log(JSON.stringify({ dryRun: false, workspaces }));
