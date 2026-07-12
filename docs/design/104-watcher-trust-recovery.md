# Design 104 — Watcher trust recovery on transient FSEvents drops (PLACEHOLDER)

**Status: diagnosed 2026-07-12 (read-only investigation); design + implementation
NOT started.** This document memorializes the root cause and the agreed fix
direction so the work survives session boundaries. Before implementation it
needs a full design pass + codex adversarial review, co-designed with design
85's R1 F8 invariant.

## Problem (measured)

On macOS, `@parcel/watcher`'s FSEvents backend periodically emits the transient
kernel error *"Events were dropped by the FSEvents client. File system must be
re-scanned."* under churn bursts (heavy git/agent activity). The daemon treats
ANY watcher `onError` as **permanent** loss of trust for the process lifetime
(`src/cli/daemon.ts:352–365`; sticky-false is deliberate and test-pinned,
`src/cli/daemon-safety.test.ts:130`). Untrusted watcher ⇒ `nextSafetyDelay`
(`daemon.ts:1657–1660`) pins full safety scans to the 60s floor with no idle
backoff.

Measured on the Mac fleet host (2026-07-11, ~116k files / ~23k dirs):

- 21 sessions over 48h hit ≥1 FSEvents drop; within one session `errorGen`
  reached 21. Every session flips unhealthy at its first drop and never
  recovers until restart.
- Degraded steady state: ~57–64 full stat-sweeps/hr × ~6.5s ≈ **~11% continuous
  I/O duty cycle**; ~670 unnecessary scans ≈ **~70 min of wasted stat I/O in
  one day**, all against a quiescent workspace (`quiescent=y rawEvents=0`
  throughout).
- Ubuntu (inotify) on the same corpus: 0 errors ever, 39/39 healthy audits —
  inotify does not surface this transient class.
- Correctness is NOT at risk (the safety scans are the healer). This is a
  performance/battery regression — and it means **design 85's scan-elimination
  is largely unrealizable on macOS** until fixed: 85 treats watcher un-trust as
  rare/restart-recoverable; on the Mac it is the steady state.

## Fix plan (ranked; P1+P2 together, P4 independent hygiene)

1. **P1 — classify transient vs fatal + re-trust behind an unpruned scan.**
   Transient overflow ("were dropped"/"must be re-scanned"): run the recovery
   rescan (already happens via `pinSafetyFloor`) but KEEP the stream trusted —
   re-arm `watcherHealthy` only after an unpruned safety scan completes with
   `errorGen` advanced (design 85 R1 F8 permits re-trust only behind an
   unpruned scan — do not just clear the flag), with exponential backoff and a
   fuse (M drops in a rolling window ⇒ permanent un-trust, today's behavior).
   Genuine stream death stays permanently un-trusted.
2. **P2 — cheaper degraded mode (independent hedge).** When repeatedly
   `quiescent=y rawEvents=0` while untrusted, back the cadence off toward ~5×
   floor instead of a hard 60s; optionally apply design 85 Layer A dircache
   pruning in degraded mode. Pure `nextSafetyDelay` refinement.
3. **P3 — reduce FSEvents pressure.** Broaden `nativePruneGlobs`
   (`src/cli/watcher.ts:260`); investigate FSEvents coalescing latency.
4. **P4 — raise the Mac daemon FD limit.** `ulimit -n = 256` today (kern
   limits are fine). Not the root cause (FSEvents is one FD) but a latent
   hazard for the 99-repo + encrypt-cache daemon and any future kqueue
   fallback. LaunchAgent `SoftResourceLimits` → ~10240.

## Key references

Un-trust handler `src/cli/daemon.ts:352–365`; backoff `daemon.ts:405–416`,
`nextSafetyDelay` `:1657–1660`; audit stamp `:1243`; sticky-false test
`daemon-safety.test.ts:130`; FSEvents subscribe `src/cli/watcher.ts:204–261`,
onError forward `:228–231`; design-85 invariant
`docs/design/85-incremental-scan.md:318–335, 710–719`. Full diagnosis evidence:
2026-07-12 telemetry sweep + watcher investigation (session "Codex Performance
Improvements").
