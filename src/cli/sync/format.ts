import { type ApplyStats, type ScanStats } from "../../engine/index.js";
import { type CommitTimings, type LatestTimings } from "../remote.js";

export interface PullOracleMetrics {
  prepareMs: number;
  receiptHashMs: number;
  entriesIndexed: number;
  reposProved: number;
}

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
/** Design 232 §4.1: scanManifest owns the monotonic all-attempt wall and the
 * fixed residual decomposition. The wall argument remains a compatibility
 * fallback for synthetic/older ScanStats producers. */
export type ScanDetails = ScanStats & { midwriteDeferred: number };
export const scanDetailsOf = (s: ScanStats, wallMs: number, midwriteDeferred: number): ScanDetails => ({
  ...s,
  residualMs: s.attemptCount > 0
    ? s.residualMs
    : Math.max(0, wallMs - (s.readdirMs + s.statMs + s.matcherMs + s.hashMs + s.sortMs)),
  midwriteDeferred,
});
const formatResidualBuckets = (s: ScanStats["residualBuckets"]): string =>
  `rpre${fmtDetailSeconds(s.rulePrevalidationMs)} rpost${fmtDetailSeconds(s.rulePostvalidationMs)} rbuild${fmtDetailSeconds(s.ruleRebuildMs)} dir${fmtDetailSeconds(s.directoryMs)} path${fmtDetailSeconds(s.pathMs)} git${fmtDetailSeconds(s.gitDiscoveryMs)} sym${fmtDetailSeconds(s.symlinkMs)} obs${fmtDetailSeconds(s.observerMs)} ent${fmtDetailSeconds(s.entryMs)} ctl${fmtDetailSeconds(s.controlMs)} fin${fmtDetailSeconds(s.finalizationMs)}`;
const formatAttempt = (attempt: ScanStats["attempts"][number], index: number): string =>
  `a${index + 1}[${attempt.mode} wall${fmtDetailSeconds(attempt.scanWallMs)} rd${fmtDetailSeconds(attempt.readdirMs)} st${fmtDetailSeconds(attempt.statMs)} mt${fmtDetailSeconds(attempt.matcherMs)} h${fmtDetailSeconds(attempt.hashMs)} srt${fmtDetailSeconds(attempt.sortMs)} res${fmtDetailSeconds(attempt.residualMs)} ${formatResidualBuckets(attempt.residualBuckets)}]`;
export const formatScanStats = (s: ScanDetails): string =>
  `wall${fmtDetailSeconds(s.scanWallMs)} rd${fmtDetailSeconds(s.readdirMs)} st${fmtDetailSeconds(s.statMs)} mt${fmtDetailSeconds(s.matcherMs)} h${fmtDetailSeconds(s.hashMs)} srt${fmtDetailSeconds(s.sortMs)} res${fmtDetailSeconds(s.residualMs)} ${formatResidualBuckets(s.residualBuckets)} attempts${s.attemptCount} ${s.attempts.map(formatAttempt).join(" ")} d${s.dirsWalked} f${s.filesStatted} hit${s.filesSkippedCacheHit} defer${s.midwriteDeferred} reuse${s.dirsReusedFromCache} dc:${s.dircacheOutcome}`;
/** mk=mkdir/cr=created, walk=dir components, uniq=dirs, ls=lstat, rn=rename,
 * stg=stages, pre=preflight, pool=write pool, sm/lg=count and bytes. */
export const formatApplyStats = (s: ApplyStats): string =>
  `mk${s.mkdirCalls}/cr${s.mkdirCreated} walk${s.dirComponentWalks} uniq${s.uniqueDirs} ls${s.lstatCalls} rn${s.renameCalls} stg${s.stageCalls} pre${fmtDetailSeconds(s.preflightMs)}s pool${fmtDetailSeconds(s.writePoolMs)}s sm${s.smallCount}n/${fmtDetailBytes(s.smallBytes)} lg${s.largeCount}n/${fmtDetailBytes(s.largeBytes)}`;
export const formatPullOracleMetrics = (m: PullOracleMetrics): string =>
  `oracle prep${fmtDetailSeconds(m.prepareMs)} hash${fmtDetailSeconds(m.receiptHashMs)} indexed${m.entriesIndexed} proved${m.reposProved}`;
