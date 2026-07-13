#!/usr/bin/env bun

/**
 * Supervised design-95 drain. Audit is read-only and walks every server-clamped
 * page; execute performs one bounded lease-holding P2/P3+P1 invocation; drain
 * repeats bounded invocations with pacing until no pass makes progress.
 *
 *   RBOX_API_URL=https://... RBOX_PLATFORM_SECRET=... bun scripts/gc-drain.ts audit
 *   RBOX_API_URL=https://... RBOX_PLATFORM_SECRET=... bun scripts/gc-drain.ts execute
 *   RBOX_API_URL=https://... RBOX_PLATFORM_SECRET=... bun scripts/gc-drain.ts drain
 */

const mode = process.argv[2] ?? "audit";
if (mode !== "audit" && mode !== "execute" && mode !== "drain") throw new Error("usage: gc-drain.ts audit|execute|drain");
const api = (process.env.RBOX_API_URL ?? "").replace(/\/$/, "");
const secret = process.env.RBOX_PLATFORM_SECRET ?? "";
if (!api || !secret) throw new Error("RBOX_API_URL and RBOX_PLATFORM_SECRET are required");

const headers = { "x-rbox-platform": secret };
if (mode === "execute") {
  const res = await fetch(`${api}/v1/admin/gc?phase=purge`, { method: "POST", headers });
  const body = await res.text();
  if (!res.ok) throw new Error(`execute failed (${res.status}): ${body}`);
  console.log(body);
  process.exit(0);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
if (mode === "drain") {
  let passes = 0;
  let opened = 0;
  let purged = 0;
  let bytes = 0;
  let consecutive500s = 0;
  while (true) {
    const res = await fetch(`${api}/v1/admin/gc?phase=purge`, { method: "POST", headers });
    const text = await res.text();
    passes++;
    if (res.status === 409) {
      consecutive500s = 0;
      const busy = JSON.parse(text) as { retryAfterMs?: number };
      const waitMs = Math.min(Math.max(1, busy.retryAfterMs ?? 60_000), 5 * 60_000);
      console.error(`pass ${passes}: lease-busy retry-in=${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }
    if (res.status === 500) {
      consecutive500s++;
      console.error(`pass ${passes}: failed status=500 consecutive=${consecutive500s}`);
      if (consecutive500s >= 3) throw new Error(`drain aborted after 3 consecutive 500s: ${text}`);
      await sleep(90_000);
      continue;
    }
    if (!res.ok) {
      console.error(`pass ${passes}: failed status=${res.status}`);
      throw new Error(`drain failed (${res.status}): ${text}`);
    }
    consecutive500s = 0;
    const pass = JSON.parse(text) as { opened: number; purged: number; bytes?: number };
    opened += pass.opened;
    purged += pass.purged;
    bytes += pass.bytes ?? 0;
    console.error(`pass ${passes}: opened=${pass.opened} purged=${pass.purged} bytes=${pass.bytes ?? 0}`);
    if (pass.opened === 0 && pass.purged === 0) break;
    await sleep(60_000);
  }
  console.log(JSON.stringify({ passes, opened, purged, bytes }));
  process.exit(0);
}

let cursor: string | null = null;
let pages = 0;
let examined = 0;
let wouldIntent = 0;
let wouldDelete = 0;
do {
  const q = new URLSearchParams({ phase: "purge", dryRun: "1", limit: "200" });
  if (cursor) q.set("cursor", cursor);
  const res = await fetch(`${api}/v1/admin/gc?${q}`, { method: "POST", headers });
  if (!res.ok) throw new Error(`audit failed (${res.status}): ${await res.text()}`);
  const page = (await res.json()) as { cursor: string | null; examined: number; wouldIntent: number; wouldDelete: number };
  pages++;
  examined += page.examined;
  wouldIntent += page.wouldIntent;
  wouldDelete += page.wouldDelete;
  cursor = page.cursor;
  console.error(`page ${pages}: examined=${examined} would-intent=${wouldIntent} would-delete=${wouldDelete}`);
} while (cursor);

console.log(JSON.stringify({ pages, examined, wouldIntent, wouldDelete }));
