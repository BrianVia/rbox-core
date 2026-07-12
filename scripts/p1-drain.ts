#!/usr/bin/env bun

/** Supervised Phase-1 backlog audit/drain (design 102 Q3). */
const mode = process.argv[2] ?? "audit";
if (mode !== "audit" && mode !== "drain") throw new Error("usage: p1-drain.ts audit|drain");
const api = (process.env.RBOX_API_URL ?? "").replace(/\/$/, "");
const secret = process.env.RBOX_PLATFORM_SECRET ?? "";
if (!api || !secret) throw new Error("RBOX_API_URL and RBOX_PLATFORM_SECRET are required");
const headers = { "x-rbox-platform": secret };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Phase-1 grace. The admin route's query-param default is the PHASE-2 7-day
 *  grace; the Phase-1 cron uses GRACE_1_MS = 24h — pass the cron's value so
 *  audit/drain see the same eligibility the hourly tick does. Override with
 *  RBOX_P1_GRACE_MS. */
const graceMs = String(Number(process.env.RBOX_P1_GRACE_MS ?? 24 * 60 * 60 * 1000));

if (mode === "drain") {
  let passes = 0;
  let marked = 0;
  let purged = 0;
  let resurrected = 0;
  let released = 0;
  let consecutiveZeroProgressFailures = 0;
  while (true) {
    const res = await fetch(`${api}/v1/admin/gc?phase=phase1&graceMs=${graceMs}`, { method: "POST", headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`drain failed (${res.status}): ${text}`);
    const pass = JSON.parse(text) as { marked: number; purged: number; resurrected: number; released: number; failed: number };
    passes++;
    marked += pass.marked;
    purged += pass.purged;
    resurrected += pass.resurrected;
    released += pass.released;
    console.error(`pass ${passes}: marked=${pass.marked} purged=${pass.purged} resurrected=${pass.resurrected} released=${pass.released} failed=${pass.failed}`);
    const zeroProgress = pass.marked === 0 && pass.purged === 0 && pass.resurrected === 0;
    if (zeroProgress && pass.failed === 0) break;
    if (zeroProgress && pass.failed > 0) {
      consecutiveZeroProgressFailures++;
      if (consecutiveZeroProgressFailures >= 3) throw new Error("drain aborted after 3 consecutive zero-progress passes with account failures");
    } else {
      consecutiveZeroProgressFailures = 0;
    }
    await sleep(5_000);
  }
  console.log(JSON.stringify({ passes, marked, purged, resurrected, released }));
  process.exit(0);
}

let cursor: string | null = null;
let pages = 0;
let examined = 0;
let wouldResurrect = 0;
let wouldPurge = 0;
let wouldRelease = 0;
do {
  const q = new URLSearchParams({ phase: "phase1", dryRun: "1", limit: "200", graceMs });
  if (cursor) q.set("cursor", cursor);
  const res = await fetch(`${api}/v1/admin/gc?${q}`, { method: "POST", headers });
  if (!res.ok) throw new Error(`audit failed (${res.status}): ${await res.text()}`);
  const page = await res.json() as { cursor: string | null; examined: number; wouldResurrect: number; wouldPurge: number; wouldRelease: number };
  pages++;
  examined += page.examined;
  wouldResurrect += page.wouldResurrect;
  wouldPurge += page.wouldPurge;
  wouldRelease += page.wouldRelease;
  cursor = page.cursor;
  console.error(`page ${pages}: examined=${examined} resurrect=${wouldResurrect} purge=${wouldPurge} release=${wouldRelease}`);
} while (cursor);
console.log(JSON.stringify({ pages, examined, wouldResurrect, wouldPurge, wouldRelease }));
