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
  The exemption is SCHEDULING, not forgiveness: every warning is AI-authored
  debt and repo-wide zero (end-state #3) remains the contract — no warning
  is ever grandfathered, only deferred to a named later pass.
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
12. **(#42) COMPLETE — Retire the migration tree.** 29 modules / 6,415 lines for the
    completed one-way JSON→SQLite flip; external users start fresh on 2.0
    (founder decision 2026-08-14) so the path is dead for all users.
    ~35 CODEMAP entries — the largest single deletion. Founder support-window
    sign-off received 2026-08-18; executed and validated.

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
| anti-slop warnings, repo-wide | 3,421 | **1,585** | 0 |
| — no-runtime-typeof | — | 753 | 0 |
| — no-conditional-empty-object-spread | — | 400 | 0 |
| — no-shape-in-symbol-names | — | 142 | 0 |
| — no-unknown-parameters | — | 150 | 0 |
| — no-chained-type-assertions | — | 66 | 0 |
| — no-known-value-widening | — | 53 | 0 |
| — no-unsafe-dictionary-type / no-object-parameters | — | 21 | 0 |
| CODEMAP.md size (lines) | 460 | **deleted** | **deleted** |
| size-gate allowlist entries | 69 | 60 | 0 |
| local branches | ~300 | 55 | ~10 |
| worktrees | 61 | 33 | active-only |
| loop tasks complete | 0/12 | **12/12** | 12/12 |

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
- 2026-08-14 (night): **BATCH 3 COMPLETE** — #707 (WatcherTrust owns the
  episode, −206; duplicate-declaration gate forced the AmbientWatcherTrust
  two-trusts disambiguation), #708 (PushSpans; push-tail-timing.ts +
  lane-accumulator.ts DELETED; push.ts 16→0 warnings, pin DOWN), #709
  (plan.ts 1,348-line closure → 214-line loop over three owners; pin
  1,591→1,213 DOWN; grammar census re-pinned w/ SHA-256 copy proof).
  daemon.ts now 2,891 nonblank (from 3,540 at loop start). Three corrective
  rounds this batch, all caught by gates: un-migrated test harnesses ×2 +
  census; zero production regressions reached main. Burn-down 3,260. Fleet
  on 0a1e16d. NEXT: batch 4 — #40 (RefPlaneTransaction) + #41 (engine/git
  merge), then capstones #39 + #42 (needs founder support-window sign-off).
- 2026-08-14 (cont.): **BATCH 4 COMPLETE** — #710 (#40 RefPlaneTransaction:
  follow.ts 1,210→247 nonblank, its allowlist + ratchet entries DELETED;
  review added single-capture authority + detached-progress hardening w/ 2
  regression tests) + #717 (#41: src/engine/git/ GONE — lockfile.ts +
  git-spawn.ts promoted to engine proper, 24 git-state modules folded into
  sync-git beside their only consumers; CODEMAP engine/git section + 25
  entries deleted; git-state.ts pin TIGHTENED 735/33,479→528/24,345; 185
  warnings→0 in moved production files; review residuals were 4 stale
  INVARIANTS links + 2 EOF blanks, fixed + self-certified). Parallel opus
  type-slop lanes #711-716, #718-720 (nine PRs): true-type fixes across
  engine/daemon, apps/api ×3, remote/genesis, codecs/config, journals ×2,
  cli-misc — ~600 warnings of the four type rules with zero faked types;
  honest leftovers documented per PR. Burn-down 3,260 → **2,523** (−898
  from baseline, 26%). REMAINING: capstone #39 (Publication module) + #42
  (migration-tree retirement, AWAITING founder support-window sign-off);
  type-rule mass now concentrated in migration tests (#42 would erase 90),
  standing-branch-proof contract test, prompt-ink leftover, and the two
  structural campaigns (no-runtime-typeof parse-at-boundary; shape-names
  rename decision).
- 2026-08-14 (late): **CAPSTONE #39 MERGED (#724, design 261)** — the
  3-round adversarial loop KILLED the original big-module mechanism (two
  independent reviews proved every proposed extraction breaks a pinned
  contract: capture lives inside preparePublishCandidate, settle precedes
  conditional ack, ports close over attempt-mutable state, report crosses
  the scheduler boundary). What shipped is the honest capstone: the
  Publication domain term in CONTEXT.md; publication.contract.test.ts
  (the loop's whole contract in one file via a FakeRemote test-helper
  extraction, literal-move audited); push.ts's false "pending split"
  marker replaced by an audited-cohesion verdict (gate prose now knows
  audited-cohesive entries; pins unchanged 940/49,750); daemon seal
  observation dedup w/ deliberate deep-clone (aliasing pinned). Net −113
  lines. Wave 4+5 type lanes also merged (#721-723, #725-727; remote,
  engine, daemon/cli, sync-git, state-plane/cmd, api-4): burn-down
  2,523 → **2,390** (−1,031 from baseline, 30%). New flake sighting
  recorded (daemon-activity pr8, rerun-proven). REMAINING: #42 only —
  awaiting founder support-window sign-off. e2ee-client.ts flagged as a
  decomposition candidate (838 lines, warnings clustered).
- 2026-08-18: **CAPSTONE #42 COMPLETE (design 262)** — PR 1 retired the
  44-file JSON→SQLite migration tree after founder support-window sign-off,
  deleting 29 CODEMAP entries and 19,108 lines while preserving the live
  legacy-JSON authority path. PR 2 deleted the remaining 445-line CODEMAP and
  inverted the law: 346 entries judged, 168 load-bearing `Never:` constraints
  moved into their modules, 20 already present, 158 navigation/boilerplate
  entries killed. Ceremony killed: the migration command/copy/benchmark/
  replay surfaces plus the parallel ownership map and its same-PR maintenance
  rule. Combined burn-down at branch tip: 1,777 → **1,585** anti-slop warnings
  (−192); size allowlist 60; architecture loop **12/12**.
