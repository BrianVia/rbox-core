import fs from "node:fs/promises";
import path from "node:path";
import { classifyDivergenceCacheEntry } from "../src/cli/sync-git.js";

const CACHE_REL = ".rbox/state/git-divergence.json";
const CACHE_VERSION = 3;

type CacheLoad =
  | { ok: true; version: number | "unknown"; repos: Map<string, unknown> }
  | { ok: false; reason: string };

type Counts = {
  hitOk: number;
  hitMismatch: number;
  stale: number;
  untrusted: number;
  skipped: number;
};

const zeroCounts = (): Counts => ({ hitOk: 0, hitMismatch: 0, stale: 0, untrusted: 0, skipped: 0 });

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function show(v: string | undefined): string {
  return v === undefined ? "<undefined>" : JSON.stringify(v);
}

function repoEntries(repos: Map<string, unknown>): Array<[string, unknown]> {
  return [...repos.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function parseRepos(v: unknown): Map<string, unknown> | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  return new Map(Object.entries(v));
}

async function loadRawCache(root: string): Promise<CacheLoad> {
  const cachePath = path.join(root, CACHE_REL);
  let raw: string;
  try {
    raw = await fs.readFile(cachePath, "utf8");
  } catch (e) {
    return { ok: false, reason: `missing or unreadable cache at ${cachePath}: ${errMsg(e)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `invalid JSON in ${cachePath}: ${errMsg(e)}` };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "cache root is not an object" };
  }
  const rootObj = parsed as { version?: unknown; repos?: unknown };
  const repos = parseRepos(rootObj.repos);
  if (!repos) return { ok: false, reason: "cache repos field is not an object" };
  return {
    ok: true,
    version: typeof rootObj.version === "number" ? rootObj.version : "unknown",
    repos,
  };
}

function mismatchDetails(result: Extract<Awaited<ReturnType<typeof classifyDivergenceCacheEntry>>, { verdict: "hit-mismatch" }>): string {
  const parts: string[] = [];
  if (!result.identityMatches) {
    parts.push(`cachedIdentity=${show(result.cachedIdentityKey)}`, `freshIdentity=${show(result.freshIdentityKey)}`);
  }
  if (!result.parentRelMatches) {
    parts.push(`cachedParent=${show(result.cachedParentRel)}`, `freshParent=${show(result.freshParentRel)}`);
  }
  return parts.join(" ");
}

function printSummary(counts: Counts): void {
  console.log(
    `PARITY hitOk=${counts.hitOk} hitMismatch=${counts.hitMismatch} stale=${counts.stale} untrusted=${counts.untrusted} skipped=${counts.skipped}`
  );
}

async function classifyV3Entry(root: string, rel: string, rawEntry: unknown, counts: Counts): Promise<void> {
  const result = await classifyDivergenceCacheEntry(root, rel, rawEntry);
  switch (result.verdict) {
    case "hit-ok":
      counts.hitOk++;
      console.log(`${rel} HIT-OK identityKey=match parentRel=match`);
      return;
    case "hit-mismatch":
      counts.hitMismatch++;
      console.log(
        `${rel} HIT-MISMATCH identityKey=${result.identityMatches ? "match" : "mismatch"} parentRel=${result.parentRelMatches ? "match" : "mismatch"} ${mismatchDetails(result)}`
      );
      return;
    case "stale":
      counts.stale++;
      console.log(`${rel} STALE cachedHash=${result.cachedHash} freshHash=${result.freshHash}`);
      return;
    case "untrusted":
      counts.untrusted++;
      console.log(`${rel} UNTRUSTED maxTsMs=${Math.trunc(result.maxTsMs)} writtenAtMs=${Math.trunc(result.writtenAtMs)}`);
      return;
    case "skipped":
      counts.skipped++;
      console.log(`${rel} NO-PROBE/ERROR ${result.reason}`);
      return;
  }
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const root = path.resolve(argv[0] ?? process.cwd());
  const loaded = await loadRawCache(root);
  const counts = zeroCounts();

  if (!loaded.ok) {
    console.log(`CACHE skipped ${loaded.reason}`);
    printSummary(counts);
    return 0;
  }

  console.log(`CACHE version=${loaded.version} repos=${loaded.repos.size}`);

  if (loaded.version === 2) {
    for (const [rel] of repoEntries(loaded.repos)) {
      counts.stale++;
      console.log(`${rel} STALE-V2`);
    }
    printSummary(counts);
    return 0;
  }

  if (loaded.version !== CACHE_VERSION) {
    for (const [rel] of repoEntries(loaded.repos)) {
      counts.skipped++;
      console.log(`${rel} NO-PROBE/ERROR unsupported-cache-version=${loaded.version}`);
    }
    printSummary(counts);
    return 0;
  }

  for (const [rel, rawEntry] of repoEntries(loaded.repos)) {
    await classifyV3Entry(root, rel, rawEntry, counts);
  }

  printSummary(counts);
  return counts.hitMismatch === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(errMsg(e));
    process.exitCode = 1;
  }
);
