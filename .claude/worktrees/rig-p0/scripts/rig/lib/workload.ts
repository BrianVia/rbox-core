/**
 * Real-workload staging for `conductor-initial-sync` (design 56 §9). The conductor
 * backup tarball is extracted ONCE on the HOST into a content-addressed cache dir
 * (`scripts/rig/cache/conductor-<sha8>/`) and bind-mounted read-only into device A —
 * the same primitive as the src/ mount. The stale top-level `workspaces/.rbox/`
 * (a foreign device's workspace binding) is stripped so the fresh `rbox init` owns
 * the state.
 *
 * Host-side extraction is deliberate: the first cut extracted inside a throwaway
 * guest into a named volume, and Apple container 1.0.0 WEDGED system-wide under that
 * load (`volume delete` + fresh `container run` hung until a daemon restart). Host
 * `tar` + an ATOMIC RENAME (extract to `.tmp-*`, rename into place) needs no loader
 * container, no volume verbs, and makes the cache complete-or-absent — no sentinel.
 *
 * The cache-key derivation is PURE (unit-tested): same tarball bytes → same sha8 →
 * same dir, so a second run is a pure cache hit.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnHost } from "./container.js";

/** Default host location of the conductor backup (overridable via `--workload-tar`). */
export const DEFAULT_WORKLOAD_TAR = path.join(os.homedir(), "Downloads", "conductor-workspaces-backup-2026-07-02.tar.gz");

/** Cache-dir basename from a tarball digest. PURE — the cache key the scheme rides on. */
export function workloadDirName(sha8: string): string {
  return `conductor-${sha8}`;
}

/** `--workload-tar` flag > default. PURE over the passed flags (homedir is the only ambient). */
export function resolveWorkloadTar(flags: Record<string, string>): string {
  const v = flags["workload-tar"];
  return v && v !== "true" ? v : DEFAULT_WORKLOAD_TAR;
}

/** Streaming sha256 → first 8 hex chars. Streams so a 1GB tarball never lands in memory. */
export async function sha8OfFile(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex").slice(0, 8);
}

export interface StageResult {
  /** Absolute host path of the fully-staged workload dir (bind-mount source). */
  dir: string;
  sha8: string;
  /** True when the cache dir already existed (extraction skipped). */
  cached: boolean;
}

/**
 * Ensure the workload cache dir exists + is fully populated, returning its path.
 * Extraction lands in a sibling `.tmp-*` dir first and is RENAMED into place (same
 * filesystem → atomic), so the cache dir's existence proves completeness — an
 * interrupted extraction leaves only a `.tmp-*` orphan that the next run clears.
 * Throws if the tarball is missing (callers pre-check to SKIP instead).
 */
export async function ensureWorkloadDir(tarPath: string, cacheRoot: string, log: (line: string) => void): Promise<StageResult> {
  if (!fs.existsSync(tarPath)) throw new Error(`workload tarball not found: ${tarPath}`);
  const sha8 = await sha8OfFile(tarPath);
  const dir = path.join(cacheRoot, workloadDirName(sha8));

  if (fs.existsSync(dir)) {
    log(`workload cache ${dir} present (cache hit) — reusing`);
    return { dir, sha8, cached: true };
  }

  const tmp = path.join(cacheRoot, `.tmp-${workloadDirName(sha8)}-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  // Clear any orphaned .tmp-* from a previously interrupted extraction of ANY key.
  if (fs.existsSync(cacheRoot)) {
    for (const e of fs.readdirSync(cacheRoot)) {
      if (e.startsWith(".tmp-")) fs.rmSync(path.join(cacheRoot, e), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(tmp, { recursive: true });

  log(`staging workload → ${dir} (one-time host-side extraction; this is slow)…`);
  await spawnHost(["tar", "-xzf", tarPath, "-C", tmp]);
  // Strip the stale foreign workspace binding so the fresh `rbox init` owns the state.
  fs.rmSync(path.join(tmp, "workspaces", ".rbox"), { recursive: true, force: true });
  fs.renameSync(tmp, dir); // atomic: the cache dir is complete-or-absent
  log(`workload cache ${dir} staged`);
  return { dir, sha8, cached: false };
}
