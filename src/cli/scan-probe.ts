import fs from "node:fs/promises";
import path from "node:path";
import { RACY_MARGIN_MS, dirListingReusable, writeFileAtomic, type DirProbeSample, type DirProbeSink } from "../engine/index.js";
import { RBOX_DIR } from "./config.js";

export { RACY_MARGIN_MS };

export interface ScanProbeState {
  version: 1;
  lastScanStartMs: number;
  dirs: Record<string, Pick<DirProbeSample, "mtimeMs" | "ctimeMs" | "readdirMs">>;
}

export interface ScanProbeSummary {
  dirs: number;
  eligible: number;
  eligibleReaddirMs: number;
  totalReaddirMs: number;
  projectedDircacheBytes: number;
  probeOverheadMs: number;
}

const statePath = (root: string) => path.join(root, RBOX_DIR, "state", "scan-probe.json");

export function probeEligible(sample: Pick<DirProbeSample, "key" | "mtimeMs" | "ctimeMs">, prior?: ScanProbeState): boolean {
  const old = prior?.dirs[sample.key];
  if (!old) return false;
  return dirListingReusable(sample.mtimeMs, sample.ctimeMs, old.mtimeMs, old.ctimeMs, prior!.lastScanStartMs);
}

export async function loadScanProbe(root: string): Promise<ScanProbeState | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath(root), "utf8")) as ScanProbeState;
    return parsed?.version === 1 && typeof parsed.lastScanStartMs === "number" && parsed.dirs && typeof parsed.dirs === "object" ? parsed : undefined;
  } catch { return undefined; }
}

export function createScanProbe(prior?: ScanProbeState): DirProbeSink & { samples: DirProbeSample[]; summary(): ScanProbeSummary } {
  const samples: DirProbeSample[] = [];
  const sink: DirProbeSink & { samples: DirProbeSample[]; summary(): ScanProbeSummary } = {
    samples,
    probeOverheadMs: 0,
    record(sample) { samples.push(sample); },
    summary() {
      const eligible = samples.filter((sample) => probeEligible(sample, prior));
      return {
        dirs: samples.length,
        eligible: eligible.length,
        eligibleReaddirMs: eligible.reduce((n, x) => n + x.readdirMs, 0),
        totalReaddirMs: samples.reduce((n, x) => n + x.readdirMs, 0),
        projectedDircacheBytes: samples.reduce((n, x) => n + x.projectedBytes, 0),
        probeOverheadMs: sink.probeOverheadMs,
      };
    },
  };
  return sink;
}

export async function saveScanProbe(root: string, scanStartMs: number, sink: DirProbeSink & { samples: DirProbeSample[] }): Promise<void> {
  const dirs: ScanProbeState["dirs"] = {};
  for (const { key, mtimeMs, ctimeMs, readdirMs } of sink.samples) dirs[key] = { mtimeMs, ctimeMs, readdirMs };
  await fs.mkdir(path.dirname(statePath(root)), { recursive: true });
  await writeFileAtomic(statePath(root), JSON.stringify({ version: 1, lastScanStartMs: scanStartMs, dirs } satisfies ScanProbeState));
}
