/**
 * Rig cleanup is scoped to rig=1 resources (with rig- volume identity as the
 * deletion boundary). Global prune is forbidden because the host is shared.
 */
import fs from "node:fs";
import path from "node:path";

export const RUNS_KEEP = 30;
export const WORKLOAD_CACHE_CAP_BYTES = 50 * 1024 ** 3;
export const MIN_DISK_HEADROOM_BYTES = 20 * 1024 ** 3;

export interface ReclaimResult { entries: number; bytes: number }

export function pathSize(target: string): number {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(target); } catch { return 0; }
  if (!stat.isDirectory()) return stat.size;
  let total = stat.size;
  for (const name of fs.readdirSync(target)) total += pathSize(path.join(target, name));
  return total;
}

function entriesByNewest(root: string): Array<{ path: string; mtimeMs: number; bytes: number }> {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
    const target = path.join(root, e.name);
    return { path: target, mtimeMs: fs.statSync(target).mtimeMs, bytes: pathSize(target) };
  }).sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

export function trimRunDirectories(runsDir: string, keep = RUNS_KEEP): ReclaimResult {
  let entries = 0; let bytes = 0;
  for (const item of entriesByNewest(runsDir).slice(keep)) {
    fs.rmSync(item.path, { recursive: true, force: true }); entries++; bytes += item.bytes;
  }
  return { entries, bytes };
}

export function trimWorkloadCache(cacheRoot: string, capBytes = WORKLOAD_CACHE_CAP_BYTES): ReclaimResult {
  const items = entriesByNewest(cacheRoot);
  let total = items.reduce((n, item) => n + item.bytes, 0); let entries = 0; let bytes = 0;
  for (const item of [...items].reverse()) {
    if (total <= capBytes) break;
    fs.rmSync(item.path, { recursive: true, force: true }); total -= item.bytes; entries++; bytes += item.bytes;
  }
  return { entries, bytes };
}

export function parseDfAvailableBytes(stdout: string): number[] {
  const lines = stdout.trim().split("\n").slice(1).filter(Boolean);
  return lines.map((line) => {
    const columns = line.trim().split(/\s+/);
    const kib = Number(columns[3]);
    if (!Number.isFinite(kib)) throw new Error(`cannot parse df available blocks: ${line}`);
    return kib * 1024;
  });
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]; let value = bytes; let unit = units[0]!;
  for (const next of units) { unit = next; if (value < 1024 || next === units.at(-1)) break; value /= 1024; }
  return `${value.toFixed(value >= 10 || unit === "B" ? 0 : 1)} ${unit}`;
}
