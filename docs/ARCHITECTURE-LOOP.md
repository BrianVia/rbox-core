# Architecture goal loop

Deepening roadmap from the 2026-08-14 architecture review (explorer report
summarized in `docs/STATUS.md` evening cap). Session task ids #31-#42
mirror this list; this file is the durable copy.

## End state (founder, 2026-08-14) — the loop is DONE when all three hold

1. **`docs/CODEMAP.md` is deleted.** The structure explains itself; no map.
2. **The code is understandable by looking at it.** No long comment
   threads — comments only for constraints the code cannot express
   (existing founder rule, now a termination condition: explanatory
   comment blocks die as deepening makes them redundant).
3. **The whole repo passes the oxlint anti-slop rules.** Repo-wide ZERO
   warnings, not just touched-files. Baseline 2026-08-14: **3,421
   anti-slop warnings** across src+apps — this is the burn-down number,
   reported in the running totals at every batch boundary.

## The ceremony-kill metric (hard rule)

Every PR in this loop must name the guard, map entry, allowlist line, or
freeze rule it made UNNECESSARY — and delete it in the same PR where safe.
A PR that can't name one is furniture-moving and gets rejected. Running
totals tracked per batch: CODEMAP entries deleted, size-allowlist entries
retired.

## Standing rules (founder, baked 2026-08-14)

- **Implementation routes to codex (gpt-5.6-sol) by default** — founder call
  2026-08-14; opus only as the two-strikes fallback when codex's output
  misses the bar twice with corrective feedback. Reviews stay multi-model.
- Behavior-preserving only; move-fidelity audit where code moves.
- Touched files get ALL anti-slop warnings fixed (whole files, not new
  lines) — triggers on SUBSTANTIVE changes; import-line-only touches are
  exempt, but grab cheap fixes opportunistically (founder ruling 08-14).
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

## Scoreboard (live — update at every batch boundary)

| metric | baseline (2026-08-14) | current | target |
|---|---:|---:|---:|
| anti-slop warnings, repo-wide | 3,421 | **3,307** | 0 |
| — no-runtime-typeof | — | 982 | 0 |
| — no-conditional-empty-object-spread | — | 620 | 0 |
| — no-unknown-parameters | — | 537 | 0 |
| — no-shape-in-symbol-names | — | 447 | 0 |
| — no-chained-type-assertions | — | 418 | 0 |
| — no-known-value-widening | — | 287 | 0 |
| — no-unsafe-dictionary-type / no-object-parameters | — | 40 | 0 |
| CODEMAP.md size (lines) | 460 | 456 | **deleted** |
| size-gate allowlist entries | 69 | 67 | 0 |
| local branches | ~300 | 53 | ~10 |
| worktrees | 61 | 34 | active-only |
| loop tasks complete | 0/12 | **6/12** (#31-35) | 12/12 |

Measurement commands: warnings `bunx oxlint --config .oxlintrc.json src apps \| grep -oE 'anti-slop\([a-z-]+\)' \| sort \| uniq -c`; allowlist `grep -cE '^  \["' src/cli/state-plane/file-size.test.ts` (÷2).

## Progress

- 2026-08-14: **BATCH 1 COMPLETE** — #703 (CONTEXT.md, 9 brief corrections,
  design-number decoder) + #704 (4 barrels deleted w/ importers rewritten,
  5 facades audited-retained, one timing table, engine/index.ts shrink plan
  in design 253). Ceremony killed: 4 CODEMAP entries, 1 facade-surface
  test, the #698-shaped triple enumeration, ~10 repeated invariant
  restatements. Burn-down: 3,421 → 3,372 anti-slop warnings. Fleet on
  be6c39e.
- 2026-08-14 (late): **BATCH 2 COMPLETE** — #705 (satellites own state;
  membrane deleted: 21 variants + 22 methods + 21 switch arms + 10 getters +
  22 callbacks; crash-order tests behavioral; lazy projection restored) +
  #706 (RemoteWakeupChannel: daemon.ts 3,531→3,097 nonblank, channel 399 on
  merit, 14 deterministic tests, ALL 27 protected flake-regression tests
  survive ported — first round deleted them and was REJECTED; mapping table
  in design 255). daemon.ts total this loop: 3,540→3,097. Burn-down 3,307.
  Fleet on 590fee6. NEXT: batch 3 — #36/#37/#38 dispatched in parallel
  (three disjoint lanes).
