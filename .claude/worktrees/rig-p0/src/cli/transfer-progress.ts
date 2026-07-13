/**
 * The one shared progress-callback contract for the long phases of a sync.
 *
 * Previously this shape was copy-pasted inline in ~6 places (sync deps, the
 * sync-recovery producer, the daemon sink, export, and the CLI spinner
 * consumers). Centralizing it here means a new phase (design: `scan` +
 * `gitcap`, the two longest-and-silent phases on repo-heavy trees) is added in
 * ONE place and every producer/consumer stays in lockstep.
 *
 * `done`/`total` are entry/blob/repo counts. `total === 0` marks an
 * INDETERMINATE phase (a live tree walk with no known total — see `scan`).
 * `detail` is a LOCAL-ONLY display hint such as the file or repo currently
 * being processed. It may be projected into `daemon.status.json` for local
 * prompt/menu consumers; it must never leave the machine via metrics,
 * phase-report JSON, support payloads, or remote APIs. Repo relpaths also
 * intentionally appear in the daemon log via the design 43 §10 forensic
 * git-sync summary lines — that is a separate local-only observability channel.
 */
export type TransferPhase = "scan" | "gitcap" | "encrypt" | "upload" | "download";

export interface TransferProgressBytes {
  /** Absolute bytes completed in this phase instance. */
  bytesDone: number;
  /** Present only when the byte denominator is determinate. */
  bytesTotal?: number;
}

/** Progress for the long phases of sync. The CLI renders it on the spinner and
 *  `rbox status` line; the daemon records `{phase,done,total}` plus optional byte
 *  counters into its activity sidecar, and may project `detail` into the local-only
 *  ambient status file. */
export type TransferProgress = (
  done: number,
  total: number,
  phase: TransferPhase,
  detail?: string,
  bytes?: TransferProgressBytes
) => void;
