import fs from "node:fs/promises";
import path from "node:path";
import { hashBytes, hashFile, statsStableAcrossHash, writeFileAtomic, type FileEntry, type Manifest, type WatchEvent } from "../engine/index.js";
import { RBOX_DIR } from "./config.js";

export const AUDIT_SETTLE_MS = 4_000;
export const AUDIT_EVENT_CAP = 10_000;
/** Bound on persisted pending candidates — a soak sidecar must not grow without
 *  bound or amplify apply-time work. Overflow drops the excess (measurement is
 *  fail-soft; a real fleet drift count is orders of magnitude smaller). */
export const PENDING_CAP = 500;
export type DriftKind = "added" | "deleted" | "modified";
export type DriftClass = "racing" | "late-covered" | "covered-ambiguous" | "unattributable" | "confirmed" | "reverted";
export type EntrySnapshot = Pick<FileEntry, "type" | "sha256" | "size" | "mode" | "symlinkTarget">;
export const ABSENT = null;

export interface DriftCandidate {
  path: string;
  kind: DriftKind;
  expected: EntrySnapshot | null;
  observed: EntrySnapshot | null;
  firstSeenAtMs: number;
  eventGenAtScan: number;
  bootId: string;
  watcherSessionId?: string;
  errorGenAtScan: number;
  /** Origin scan's quiescence tag — only confirmed drops born in a QUIESCENT scan
   *  feed the design's drop-rate gate (§5 P0.3 filter c). */
  quiescentAtScan: boolean;
}
export interface DriftAuditState {
  version: 1;
  pending: DriftCandidate[];
  resolvedSinceLastAudit: { lateCovered: number; coveredAmbiguous: number };
}
export interface ContinuityContext { bootId: string; watcherSessionId?: string; errorGeneration: number; watcherUnhealthySince: boolean }

const snap = (entry?: FileEntry): EntrySnapshot | null => entry ? ({ type: entry.type, sha256: entry.sha256, size: entry.size, mode: entry.mode, ...(entry.symlinkTarget !== undefined ? { symlinkTarget: entry.symlinkTarget } : {}) }) : null;
export const snapshotEntry = snap;
export function sameSnapshot(a: EntrySnapshot | null, b: EntrySnapshot | null): boolean {
  return a === b || (!!a && !!b && a.type === b.type && a.sha256 === b.sha256 && a.size === b.size && a.mode === b.mode && a.symlinkTarget === b.symlinkTarget);
}
/** A candidate before its origin scan's quiescence is known (stamped at settle time). */
export type DriftCandidateDraft = Omit<DriftCandidate, "quiescentAtScan">;

export function diffForDrift(expected: Manifest, observed: Manifest, context: Omit<DriftCandidateDraft, "path" | "kind" | "expected" | "observed">): DriftCandidateDraft[] {
  const before = new Map(expected.files.map((x) => [x.path, x]));
  const after = new Map(observed.files.map((x) => [x.path, x]));
  const paths = new Set([...before.keys(), ...after.keys()]);
  const out: DriftCandidateDraft[] = [];
  for (const p of paths) {
    const a = snap(before.get(p)); const b = snap(after.get(p));
    if (sameSnapshot(a, b)) continue;
    out.push({ path: p, kind: !a ? "added" : !b ? "deleted" : "modified", expected: a, observed: b, ...context });
  }
  return out;
}
export function eventCoversPath(event: WatchEvent, candidatePath: string): boolean {
  return event.relPath === candidatePath || ((event.kind === "addDir" || event.kind === "unlinkDir") && candidatePath.startsWith(`${event.relPath}/`));
}
export function eventsCoverPath(events: WatchEvent[], candidatePath: string): boolean { return events.some((e) => eventCoversPath(e, candidatePath)); }
export function continuityBroken(candidate: DriftCandidateDraft, now: ContinuityContext): boolean {
  return candidate.bootId !== now.bootId || candidate.watcherSessionId !== now.watcherSessionId || candidate.errorGenAtScan !== now.errorGeneration || now.watcherUnhealthySince;
}
export function horizonClass(candidate: DriftCandidateDraft, currentObserved: EntrySnapshot | null, continuity: ContinuityContext): "confirmed" | "reverted" | "unattributable" {
  if (continuityBroken(candidate, continuity)) return "unattributable";
  return sameSnapshot(candidate.expected, currentObserved) ? "reverted" : "confirmed";
}
export function candidateStillMismatch(candidate: DriftCandidateDraft, current: EntrySnapshot | null): boolean {
  if (candidate.kind === "added") return current !== null;
  if (candidate.kind === "deleted") return current === null;
  return current !== null && !sameSnapshot(candidate.expected, current);
}
export function resolveCoveredAtApply(pending: DriftCandidate[], events: WatchEvent[], deferred: Set<string>, manifest: Manifest): { pending: DriftCandidate[]; lateCovered: number; coveredAmbiguous: number } {
  const truth = new Map(manifest.files.map((x) => [x.path, snap(x)]));
  let lateCovered = 0, coveredAmbiguous = 0;
  const kept = pending.filter((candidate) => {
    if (deferred.has(candidate.path) || !eventsCoverPath(events, candidate.path)) return true;
    if (sameSnapshot(candidate.observed, truth.get(candidate.path) ?? null)) lateCovered++; else coveredAmbiguous++;
    return false;
  });
  return { pending: kept, lateCovered, coveredAmbiguous };
}

/** Deduplicate candidates by path — the OLDEST candidate wins, since it carries
 *  the original drop evidence and true drift age — then cap. */
export function dedupePending(candidates: DriftCandidate[]): DriftCandidate[] {
  const byPath = new Map<string, DriftCandidate>();
  for (const c of candidates) {
    const prev = byPath.get(c.path);
    if (!prev || c.firstSeenAtMs < prev.firstSeenAtMs) byPath.set(c.path, c);
  }
  return [...byPath.values()].slice(0, PENDING_CAP);
}

/** Held-back pending + this scan's survivors, oldest-per-path, capped. */
export function mergePending(held: DriftCandidate[], survivors: DriftCandidate[]): DriftCandidate[] {
  return dedupePending([...held, ...survivors]);
}

const auditPath = (root: string) => path.join(root, RBOX_DIR, "state", "drift-audit.json");
export const emptyDriftAuditState = (): DriftAuditState => ({ version: 1, pending: [], resolvedSinceLastAudit: { lateCovered: 0, coveredAmbiguous: 0 } });
export async function loadDriftAudit(root: string): Promise<DriftAuditState> {
  try {
    const x = JSON.parse(await fs.readFile(auditPath(root), "utf8")) as DriftAuditState;
    const counters = x?.resolvedSinceLastAudit;
    const validCounters = counters && Number.isFinite(counters.lateCovered) && counters.lateCovered >= 0 && Number.isFinite(counters.coveredAmbiguous) && counters.coveredAmbiguous >= 0;
    const validSnapshot = (snapshot: unknown): snapshot is EntrySnapshot | null => {
      if (snapshot === null) return true;
      if (!snapshot || typeof snapshot !== "object") return false;
      const s = snapshot as Partial<EntrySnapshot>;
      return (s.type === "file" || s.type === "symlink") && typeof s.sha256 === "string" && typeof s.size === "number" && typeof s.mode === "number" && (s.symlinkTarget === undefined || typeof s.symlinkTarget === "string");
    };
    const validPending = Array.isArray(x?.pending) && x.pending.every((candidate) =>
      candidate && typeof candidate.path === "string" &&
      (candidate.kind === "added" || candidate.kind === "deleted" || candidate.kind === "modified") &&
      Number.isFinite(candidate.firstSeenAtMs) && Number.isFinite(candidate.eventGenAtScan) &&
      Number.isFinite(candidate.errorGenAtScan) && typeof candidate.bootId === "string" &&
      (candidate.watcherSessionId === undefined || typeof candidate.watcherSessionId === "string") &&
      typeof candidate.quiescentAtScan === "boolean" &&
      validSnapshot(candidate.expected) && validSnapshot(candidate.observed)
    );
    if (!(x?.version === 1 && validPending && validCounters)) return emptyDriftAuditState();
    // A duplicate-path sidecar would double-count resolutions/confirms — dedupe
    // on load with the same oldest-wins rule the merge uses.
    x.pending = dedupePending(x.pending);
    return x;
  }
  catch { return emptyDriftAuditState(); }
}
export async function saveDriftAudit(root: string, state: DriftAuditState): Promise<void> {
  await fs.mkdir(path.dirname(auditPath(root)), { recursive: true });
  await writeFileAtomic(auditPath(root), JSON.stringify(state));
}

/** P-1-grade point re-verification. `undefined` means unstable; null means absent. */
export async function reverifyPath(root: string, rel: string): Promise<EntrySnapshot | null | undefined> {
  const abs = path.join(root, rel);
  const pre = await fs.lstat(abs).catch(() => undefined);
  if (!pre) return null;
  if (pre.isSymbolicLink()) {
    const target = await fs.readlink(abs).catch(() => undefined);
    return target === undefined ? undefined : { type: "symlink", symlinkTarget: target, sha256: hashBytes(Buffer.from(target)), size: Buffer.byteLength(target), mode: 0o777 };
  }
  if (!pre.isFile()) return null;
  const sha256 = await hashFile(abs, pre.size).catch(() => undefined);
  if (!sha256) return undefined;
  const post = await fs.lstat(abs).catch(() => undefined);
  if (!post || !statsStableAcrossHash(pre, post)) return undefined;
  return { type: "file", sha256, size: post.size, mode: post.mode & 0o777 };
}
