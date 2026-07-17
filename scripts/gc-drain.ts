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

export type GcDrainMode = "audit" | "execute" | "drain";

export interface GcDrainDependencies {
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  stdout(line: string): void;
  stderr(line: string): void;
}

const defaultDependencies: GcDrainDependencies = {
  fetch: globalThis.fetch.bind(globalThis),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

type SuccessfulPurgeBody = {
  ok?: boolean;
  budgetExceeded?: boolean;
  opened?: number;
  purged?: number;
  bytes?: number;
  retryAfterMs?: number;
};

function parseBody(text: string): SuccessfulPurgeBody | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? value as SuccessfulPurgeBody : null;
  } catch {
    return null;
  }
}

function assertNonTerminal(body: SuccessfulPurgeBody): void {
  if (body.ok === false || body.budgetExceeded === true) {
    throw new Error("GC stopped: roots workspace budget exceeded");
  }
}

function endpoint(api: string, query: string): string {
  return `${api.replace(/\/$/, "")}/v1/admin/gc?${query}`;
}

export async function runGcDrainMode(
  mode: GcDrainMode,
  api: string,
  secret: string,
  dependencies: Partial<GcDrainDependencies> = {},
): Promise<void> {
  if (!api || !secret) throw new Error("RBOX_API_URL and RBOX_PLATFORM_SECRET are required");
  const deps = { ...defaultDependencies, ...dependencies };
  const headers = { "x-rbox-platform": secret };

  if (mode === "execute") {
    const res = await deps.fetch(endpoint(api, "phase=purge"), { method: "POST", headers });
    const text = await res.text();
    const body = parseBody(text);
    if (body) assertNonTerminal(body);
    if (!res.ok) throw new Error(`execute failed (${res.status}): ${text}`);
    if (!body) throw new Error("GC returned an invalid success body");
    deps.stdout(text);
    return;
  }

  if (mode === "drain") {
    let passes = 0;
    let opened = 0;
    let purged = 0;
    let bytes = 0;
    let consecutive500s = 0;
    while (true) {
      const res = await deps.fetch(endpoint(api, "phase=purge"), { method: "POST", headers });
      const text = await res.text();
      passes++;
      const typed = parseBody(text);
      if (typed) assertNonTerminal(typed);
      if (res.status === 409 && typed) {
        consecutive500s = 0;
        const waitMs = Math.min(Math.max(1, typed?.retryAfterMs ?? 60_000), 5 * 60_000);
        deps.stderr(`pass ${passes}: lease-busy retry-in=${waitMs}ms`);
        await deps.sleep(waitMs);
        continue;
      }
      if (res.status === 500) {
        consecutive500s++;
        deps.stderr(`pass ${passes}: failed status=500 consecutive=${consecutive500s}`);
        if (consecutive500s >= 3) throw new Error(`drain aborted after 3 consecutive 500s: ${text}`);
        await deps.sleep(90_000);
        continue;
      }
      if (!res.ok) {
        deps.stderr(`pass ${passes}: failed status=${res.status}`);
        throw new Error(`drain failed (${res.status}): ${text}`);
      }
      consecutive500s = 0;
      if (!typed) throw new Error("GC returned an invalid success body");
      const pass = typed;
      if (!Number.isFinite(pass.opened) || !Number.isFinite(pass.purged)) throw new Error("GC returned an invalid progress body");
      const passOpened = Number(pass.opened);
      const passPurged = Number(pass.purged);
      const passBytes = Number.isFinite(pass.bytes) ? Number(pass.bytes) : 0;
      opened += passOpened;
      purged += passPurged;
      bytes += passBytes;
      deps.stderr(`pass ${passes}: opened=${passOpened} purged=${passPurged} bytes=${passBytes}`);
      if (passOpened === 0 && passPurged === 0) break;
      await deps.sleep(60_000);
    }
    deps.stdout(JSON.stringify({ passes, opened, purged, bytes }));
    return;
  }

  let cursor: string | null = null;
  let pages = 0;
  let examined = 0;
  let wouldIntent = 0;
  let wouldDelete = 0;
  do {
    const q = new URLSearchParams({ phase: "purge", dryRun: "1", limit: "200" });
    if (cursor) q.set("cursor", cursor);
    const res = await deps.fetch(endpoint(api, q.toString()), { method: "POST", headers });
    if (!res.ok) throw new Error(`audit failed (${res.status}): ${await res.text()}`);
    const page = (await res.json()) as { cursor: string | null; examined: number; wouldIntent: number; wouldDelete: number };
    pages++;
    examined += page.examined;
    wouldIntent += page.wouldIntent;
    wouldDelete += page.wouldDelete;
    cursor = page.cursor;
    deps.stderr(`page ${pages}: examined=${examined} would-intent=${wouldIntent} would-delete=${wouldDelete}`);
  } while (cursor);

  deps.stdout(JSON.stringify({ pages, examined, wouldIntent, wouldDelete }));
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "audit";
  if (mode !== "audit" && mode !== "execute" && mode !== "drain") throw new Error("usage: gc-drain.ts audit|execute|drain");
  await runGcDrainMode(mode, process.env.RBOX_API_URL ?? "", process.env.RBOX_PLATFORM_SECRET ?? "");
}
