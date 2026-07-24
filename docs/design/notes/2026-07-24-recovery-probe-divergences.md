# Recovery-probe vs pump divergences — intent rulings needed

Context: `runRecoveryProbe` (daemon.ts:1525-1566) re-implements the pump's op
bodies (:1632-1680) instead of sharing them. The copies have diverged in four
ways. Before extracting a shared `executeOp(op, {recovery})` (thermo sweep
Tier 0 #2), each divergence needs an explicit intent ruling — the duplication
has been making these decisions implicitly.

## D1 — recovery scans never clear watcher-degraded

Pump full/deep-scan pass their coverage to
`maybeClearWatcherDegradedAfterScan(gen, cov)` (:1637, :1643); recovery
scans (:1556-1563) do not. A watcher-degraded surface therefore survives a
successful recovery scan and waits for the next ordinary scan.

**Recommendation: unify (clear it).** A successful scan is a successful
scan; the degraded surface should reflect observed reality regardless of why
the scan ran. The omission reads as accidental.

## D2 — recovery fullScan never arms the out-of-storage probe

Pump fullScan sets `outOfStorageProbeArmed = true` when
`activity.outOfStorage` (:1644); recovery fullScan does not, so an
out-of-storage workspace recovering via probe does not get the follow-up
quota probe an ordinary scan would arm.

**Recommendation: unify (arm it).** Harmless when wrong, useful when right.

## D3 — recovery pull neither records nor consumes notify latency

Pump pull consumes `notifyPullPendingAt`, records the ws_health notify
latency at dequeue, and passes it into `doPull` (:1647-1656). Recovery pull
calls `doPull(syncMutex, undefined, undefined, carrier)` (:1548) and leaves
`notifyPullPendingAt` set. Two effects: (a) a notify serviced by a recovery
pull is invisible in notify-latency telemetry; (b) worse, the surviving
timestamp inflates the NEXT ordinary pull's recorded latency by the entire
halt duration — corrupting the metric the 189/propagation dashboards read.

**Recommendation: unify (consume + record identically).** At minimum the
timestamp must be consumed; recording it too keeps the metric honest about
notifies serviced during recovery.

## D4 — recovery ops skip `maybeClearWatcherUnsettledAfterOp`

The pump explicitly guards `if (op !== "recoveryProbe")` (:1680). Unlike
D1-D3 this LOOKS deliberate (recovery ops run outside the normal
watcher-generation bracketing the guard's generation argument assumes).

**Recommendation: keep the exclusion, but document it** with one comment at
the guard, and re-express it explicitly in `executeOp`'s recovery flag so it
survives the extraction as a decision rather than an accident.

## Implementation shape (after rulings)

Characterization tests FIRST pinning: catch-up-generation restore-on-failure
(both paths), single notify-latency recording per notify, then the ruled D1-D3
behaviors. Then extract `executeOp(op, syncMutex, {recovery})`; the
push-conflict preflight (:1526-1542) stays a recovery-only wrapper. The
existing daemon-safety / recovery-policy suites are the harness base.

Status: AWAITING FOUNDER RULINGS on D1-D4 (recommendations above).
