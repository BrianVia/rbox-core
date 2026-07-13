import { type ApplyStats, type ScanStats } from "../../engine/index.js";
import { type CommitTimings, type LatestTimings } from "../remote.js";

const fmtDetailSeconds = (ms: number): string => (ms / 1000).toFixed(1);
const fmtDetailBytes = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}KB`;
  return `${n}B`;
};
export const formatCommitTimings = (t: CommitTimings): string =>
  `r${fmtDetailSeconds(t.refreshMs)} sc${fmtDetailSeconds(t.sidecarMs)} e${fmtDetailSeconds(t.encodeMs)} c${fmtDetailSeconds(t.encryptMs)} u${fmtDetailSeconds(t.uploadMs)} p${fmtDetailSeconds(t.postMs)} ${fmtDetailBytes(t.encBytes)}${formatServerTimings(t.serverTimings)}`;
/** Design 97: the server's own commit decomposition, echoed on the commit response.
 *  Rendered only when the server sent it (older workers omit the field). */
const formatServerTimings = (t: CommitTimings["serverTimings"]): string =>
  t ? ` srv${fmtDetailSeconds(t.totalMs)} env${fmtDetailSeconds(t.envelopeMs)} acct${fmtDetailSeconds(t.accountingMs)} ssc${fmtDetailSeconds(t.sidecarMs)} cm${fmtDetailSeconds(t.commitMs)} mir${fmtDetailSeconds(t.mirrorMs)} rsp${fmtDetailSeconds(t.responseMs)}` : "";
export const formatLatestTimings = (t: LatestTimings): string => `d${fmtDetailSeconds(t.downloadMs)} x${fmtDetailSeconds(t.decryptMs)} p${fmtDetailSeconds(t.parseMs)} ${fmtDetailBytes(t.encBytes)}${t.fold ? ` fold=${t.fold}${typeof t.foldLinks === "number" ? ` f${t.foldLinks}` : ""}` : ""}`;
/** Design 85 §6.1: the scan details carry an explicit residual (wall minus the
 *  five timed components — allocation, path construction, readlink, cache lookup,
 *  loop overhead) and the mid-write deferral count from the P-1 guard. */
export type ScanDetails = ScanStats & { residualMs: number; midwriteDeferred: number };
export const scanDetailsOf = (s: ScanStats, wallMs: number, midwriteDeferred: number): ScanDetails => ({
  ...s,
  residualMs: Math.max(0, wallMs - (s.readdirMs + s.statMs + s.matcherMs + s.hashMs + s.sortMs)),
  midwriteDeferred,
});
export const formatScanStats = (s: ScanDetails): string =>
  `rd${fmtDetailSeconds(s.readdirMs)} st${fmtDetailSeconds(s.statMs)} mt${fmtDetailSeconds(s.matcherMs)} h${fmtDetailSeconds(s.hashMs)} srt${fmtDetailSeconds(s.sortMs)} res${fmtDetailSeconds(s.residualMs)} d${s.dirsWalked} f${s.filesStatted} hit${s.filesSkippedCacheHit} defer${s.midwriteDeferred} reuse${s.dirsReusedFromCache} dc:${s.dircacheOutcome}`;
/** mk=mkdir/cr=created, walk=dir components, uniq=dirs, ls=lstat, rn=rename,
 * stg=stages, pre=preflight, pool=write pool, sm/lg=count and bytes. */
export const formatApplyStats = (s: ApplyStats): string =>
  `mk${s.mkdirCalls}/cr${s.mkdirCreated} walk${s.dirComponentWalks} uniq${s.uniqueDirs} ls${s.lstatCalls} rn${s.renameCalls} stg${s.stageCalls} pre${fmtDetailSeconds(s.preflightMs)}s pool${fmtDetailSeconds(s.writePoolMs)}s sm${s.smallCount}n/${fmtDetailBytes(s.smallBytes)} lg${s.largeCount}n/${fmtDetailBytes(s.largeBytes)}`;
