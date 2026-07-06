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
 * `detail` is DISPLAY-ONLY (spinner + status line): a human hint such as the
 * repo currently being captured. The precise property: the `detail` ARGUMENT
 * itself is never persisted anywhere — not in activity.json, not in daemon
 * logs, not in metrics/phase-report (the daemon sink drops it; renderers
 * sanitize + truncate it in-memory). Note this is scoped to THIS argument:
 * repo relpaths do intentionally appear in the daemon log via the design 43
 * §10 forensic git-sync summary lines — that is a separate, pre-existing,
 * local-only observability channel that support debugging depends on, and it
 * is not routed through this callback.
 */
export type TransferPhase = "scan" | "gitcap" | "encrypt" | "upload" | "download";

/** Progress for the long phases of sync. The CLI renders it on the spinner and
 *  `rbox status` line; the daemon records the coarse `{phase,done,total}` into its
 *  activity sidecar (never `detail`). */
export type TransferProgress = (done: number, total: number, phase: TransferPhase, detail?: string) => void;
