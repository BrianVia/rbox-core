# Architecture goal loop

Deepening roadmap from the 2026-08-14 architecture review (explorer report
summarized in `docs/STATUS.md` evening cap). Goal: modules deep enough that
`docs/CODEMAP.md` becomes unnecessary and gets deleted. Session task ids
#31-#42 mirror this list; this file is the durable copy.

## The ceremony-kill metric (hard rule)

Every PR in this loop must name the guard, map entry, allowlist line, or
freeze rule it made UNNECESSARY — and delete it in the same PR where safe.
A PR that can't name one is furniture-moving and gets rejected. Running
totals tracked per batch: CODEMAP entries deleted, size-allowlist entries
retired.

## Standing rules (founder, baked 2026-08-14)

- Behavior-preserving only; move-fidelity audit where code moves.
- Touched files get ALL anti-slop warnings fixed (whole files, not new lines).
- Size-gate trips get decomposition, never re-pins.
- Sync-plane batches close out with BEFORE/AFTER field checks on BOTH lanes.
- Codex adversarial review for daemon/sync-git/state planes; merge on
  rollup==0 only; fleet update after each merged batch.

## Batches, in dependency order

### Batch 1 — low-risk, immediate map shrinkage
1. **(#31) Delete the pure re-export barrels.** engine/git-state.ts (107
   lines, 2 importers), remote/blob-batch.ts (5), engine/crypto-pool.ts
   (11), cli/git-cmd.ts (18) go outright; audit the larger facades
   (sync-git.ts, daemon.ts, sync-state-store.ts, daemon-control.ts,
   folder-config.ts) case by case; plan the shrink of engine/index.ts
   (a 413-line barrel ON the size allowlist).
2. **(#32) One source-of-truth timing table.** apply-metrics.ts enumerates
   the 14-axis GitChainTimings schema three times by hand (the shape that
   caused #698). One `satisfies Record<keyof GitChainTimings,...>` table;
   byte-identical formatter output pinned by test.
3. **(#33) Write CONTEXT.md.** Ten domain terms (BASE; pending/partial/
   held/deferral; carry; receipt/attempt/packet + identity-binding rule;
   binding's three overloads; admission; manifest/section/sequence;
   lineage/provenance/epoch/episode; the two trusts; fence/lease/gate/
   breaker) + the design-number→concept table for the ~20 most-cited
   designs (900 citations across 84 designs today).

### Batch 2 — the daemon core
4. **(#34) Invert the daemon satellites.** daemon-publish/pull-transition
   declare every effect 4× (union → effects interface → switch → daemon
   closures over private fields). Satellites OWN their state; interface
   collapses to publish(provenance, port)→receipt. Scheduler is the
   reference shape. Prerequisite for #35.
5. **(#35) RemoteWakeupChannel.** The WS/keepalive/cursor/backstop machine
   (28 methods + ~28 fields loose in daemon.ts) becomes one module with
   start/stop/onWakeup/healthSample + injected clock. This is where
   FLAKE-001 and the FLAKE-004 cluster lived — zero registry incidents
   have ever occurred in a module with a real boundary.

### Batch 3 — the remaining shallow hotspots
6. **(#36) WatcherTrust.** The fuse/re-trust episode state machine (14
   daemon fields) joins its already-extracted pure predicates.
7. **(#37) Break plan.ts's 1,348-line closure function** into its three
   owners (artifact retention lifecycle, per-repo capture attempt, plan
   accumulator); includes the carryOwnedWithConfig/captureWithConfig
   collapse (durable ratchet headroom, currently 15 bytes).
8. **(#38) One PushSpans owner** for push.ts's four interleaved
   instrumentation systems (incl. the process-global singleton).

### Batch 4 — the deep cuts
9. **(#40) RefPlaneTransaction.** follow.ts's two giants (publishRefPlane
   480 / followDivergedRepo 598 nonblank) — the allowlist itself says "no
   further MOVE can retire this entry." Fail-closed plane: full review
   protocol.
10. **(#41) Merge engine/git into sync-git.** The cli↔engine git seam is
    historical: promote lockfile + git-spawn to engine proper (their real
    consumers are tree-wide), fold the git-state modules into their only
    consumer. The Worker cross-package seam stays (genuine).

### Capstones
11. **(#39) A Publication module.** Nothing names the end-to-end push
    today ("file saved on A appears on B" = ~55 files, 6 barrels). One
    interface owning candidate→capture→encrypt→upload→commit→acknowledge,
    composed from the deepened parts. Do LAST — it consumes batches 1-3.
12. **(#42) Retire the migration tree.** 29 modules / 6,415 lines for the
    completed one-way JSON→SQLite flip; external users start fresh on 2.0
    (founder decision 2026-08-14) so the path is dead for all users.
    ~35 CODEMAP entries — the largest single deletion. NEEDS founder
    sign-off on the support window before executing.

## Loop prompt (paste into any session)

> Run the architecture goal loop per docs/ARCHITECTURE-LOOP.md: work the
> batches in order, one at a time, parallelizing within a batch only on
> disjoint files. Apply the ceremony-kill metric and standing rules from
> that file. Report at batch boundaries only: what merged, what ceremony
> died, the running totals, and anything needing my decision. Cap
> STATUS.md at session end.

## Progress

- 2026-08-14: batch 1 dispatched (#31+#32 codex lane, #33 opus lane) —
  in flight at time of writing.
