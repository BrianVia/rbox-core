#!/usr/bin/env bun

/**
 * Supervised design-95 drain. Audit is read-only and walks every server-clamped
 * page; execute performs one bounded lease-holding P2/P3+P1 invocation. Operators
 * intentionally rerun execute on later days rather than leaving a local process
 * looping across the 24-hour intent quiescence window.
 *
 *   RBOX_API_URL=https://... RBOX_PLATFORM_SECRET=... bun scripts/gc-drain.ts audit
 *   RBOX_API_URL=https://... RBOX_PLATFORM_SECRET=... bun scripts/gc-drain.ts execute
 */

const mode = process.argv[2] ?? "audit";
if (mode !== "audit" && mode !== "execute") throw new Error("usage: gc-drain.ts audit|execute");
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
