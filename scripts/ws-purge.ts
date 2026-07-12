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
const safeErrorBody = (text: string): string => text.replaceAll(secret, "[redacted]");

interface Counts { commits: number; manifests: number; workspace_keys: number; workspaces: number }
interface PurgeResponse { done: boolean; deleted: Counts }
type DryResult = { workspaceId: string; counts: Counts } | { workspaceId: string; notFound: true };
type PurgeResult = { workspaceId: string; passes: number; deleted: Counts } | { workspaceId: string; notFound: true };
const zero = (): Counts => ({ commits: 0, manifests: 0, workspace_keys: 0, workspaces: 0 });

if (dryRun) {
  const workspaces: DryResult[] = [];
  for (const workspaceId of workspaceIds) {
    const res = await fetch(`${api}/v1/admin/workspace/${encodeURIComponent(workspaceId)}?dryRun=1`, { method: "DELETE", headers });
    const text = await res.text();
    if (res.status === 404) {
      console.error(`${workspaceId}: not found`);
      workspaces.push({ workspaceId, notFound: true });
      continue;
    }
    if (!res.ok) throw new Error(`dry-run failed (${res.status}): ${safeErrorBody(text)}`);
    const body = JSON.parse(text) as { counts: Counts };
    console.error(`${workspaceId}: commits=${body.counts.commits} manifests=${body.counts.manifests} keys=${body.counts.workspace_keys} workspaces=${body.counts.workspaces}`);
    workspaces.push({ workspaceId, counts: body.counts });
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
      console.error(`${workspaceId}: not found`);
      workspaces.push({ workspaceId, notFound: true });
      break;
    }
    if (!res.ok) throw new Error(`purge failed (${res.status}): ${safeErrorBody(text)}`);
    const pass = JSON.parse(text) as PurgeResponse;
    passes++;
    deleted.commits += pass.deleted.commits;
    deleted.manifests += pass.deleted.manifests;
    deleted.workspace_keys += pass.deleted.workspace_keys;
    deleted.workspaces += pass.deleted.workspaces;
    console.error(`${workspaceId} pass ${passes}: commits=${pass.deleted.commits} manifests=${pass.deleted.manifests} keys=${pass.deleted.workspace_keys} workspaces=${pass.deleted.workspaces} done=${pass.done}`);
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
