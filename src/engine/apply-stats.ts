import fs from "node:fs/promises";

export interface ApplyStats {
  mkdirCalls: number;
  mkdirCreated: number;
  dirComponentWalks: number;
  uniqueDirs: number;
  lstatCalls: number;
  renameCalls: number;
  stageCalls: number;
  preflightMs: number;
  writePoolMs: number;
  smallCount: number;
  smallBytes: number;
  smallStageMs: number;
  largeCount: number;
  largeBytes: number;
  largeStageMs: number;
}

function zeroApplyStats(): ApplyStats {
  return {
    mkdirCalls: 0, mkdirCreated: 0, dirComponentWalks: 0, uniqueDirs: 0,
    lstatCalls: 0, renameCalls: 0, stageCalls: 0, preflightMs: 0, writePoolMs: 0,
    smallCount: 0, smallBytes: 0, smallStageMs: 0,
    largeCount: 0, largeBytes: 0, largeStageMs: 0,
  };
}

// Safe under design 93's top-level sync mutex: only one apply runs per process.
// Per-scope `measured` snapshots keep operations that straddle a flag flip sane.
const applyStats: ApplyStats = zeroApplyStats();
let enabled = false;
export function setApplyStatsEnabled(on: boolean): void { enabled = on; }
export function applyStatsEnabled(): boolean { return enabled; }
export function snapshotApplyStats(): ApplyStats { return { ...applyStats }; }
export function applyStatsDelta(before: ApplyStats): ApplyStats {
  const delta = zeroApplyStats();
  for (const key of Object.keys(delta) as Array<keyof ApplyStats>) delta[key] = applyStats[key] - before[key];
  return delta;
}

const LARGE_BYTES = Number(process.env.RBOX_APPLY_SIZE_BUCKET_BYTES) || 1_000_000;

export function countMkdir(created: boolean): void {
  if (!enabled) return;
  applyStats.mkdirCalls++;
  if (created) applyStats.mkdirCreated++;
}
/** Recursive mkdir that counts the API call and whether it created anything. */
export async function mkdirCounted(dir: string): Promise<void> {
  const created = await fs.mkdir(dir, { recursive: true });
  countMkdir(created !== undefined);
}
export function countLstat(): void { if (!enabled) return; applyStats.lstatCalls++; }
export function countRename(): void { if (!enabled) return; applyStats.renameCalls++; }
export function addDirComponentWalks(n: number): void { if (!enabled) return; applyStats.dirComponentWalks += n; }
export function addUniqueDirs(n: number): void { if (!enabled) return; applyStats.uniqueDirs += n; }
/** Caller must pre-guard with a scope-captured `measured`; no internal check so a mid-interval flag flip cannot half-record. */
export function addPreflightMs(ms: number): void { applyStats.preflightMs += ms; }
/** Caller must pre-guard with a scope-captured `measured`; no internal check so a mid-interval flag flip cannot half-record. */
export function addWritePoolMs(ms: number): void { applyStats.writePoolMs += ms; }
/** Caller must pre-guard with a scope-captured `measured`; no internal check so a mid-interval flag flip cannot half-record. */
export function countStage(sizeBytes: number, stageMs: number): void {
  applyStats.stageCalls++;
  if (sizeBytes >= LARGE_BYTES) {
    applyStats.largeCount++;
    applyStats.largeBytes += sizeBytes;
    applyStats.largeStageMs += stageMs;
  } else {
    applyStats.smallCount++;
    applyStats.smallBytes += sizeBytes;
    applyStats.smallStageMs += stageMs;
  }
}
