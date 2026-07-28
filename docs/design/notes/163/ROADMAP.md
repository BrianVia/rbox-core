# 163 / 2.0 execution roadmap — what's done, what's next

> **Pointer document, not authority.** The ratified design
> (`docs/design/163-state-plane-sqlite.md`, v11 — RATIFIED AMENDMENT) is the
> only normative source; section references below are to its headings. If this
> file and the doc disagree, the doc wins and this file has a bug. Update this
> file's checkboxes as units land; never restate requirements here.
> Last synced to the doc: 2026-07-28 (v11, `#544`).
> Last progress update: 2026-07-28 late — B0/U0/U1/U2 all merged; U3 is next.

## The shape (founder-ratified 2026-07-28)

Backend-first hybrid: `B0 → U0 → U1 → U2 → U3 → U4a–U4f → U5`.
B0, U0, U1, U2 ship on **main** as ordinary 1.x releases. The long-lived
`2.0` branch opens **only for U3** (migration + the one-way `Q` flip — 2.0
ships there). U4a–U4f land back on main as 2.x releases. Migration is
**lock-exclusive** ("parked car", `MIGRATION-EXCLUSIVITY-v11`): it runs only
holding the workspace mutation locks, entered via `rbox upgrade`'s stop window
or a foreground `rbox migrate`.

## Units

- [x] **B0 — stable-line barrier** (doc §"B0 — pre-U0 stable-line barrier
  release"). IMPLEMENTED, merged `#539`. Q-recognition on every state
  touch point (AST-pinned inventory test), typed unlocked-writer refusals,
  content-bound last-writer witness, 128-byte-headered reserve.
  **Remaining to check the box fully:**
  - [ ] Ship as **1.11.0** (release train; founder tag required).
  - [ ] Adoption drain: all 4 external users + 3 fleet hosts on ≥ 1.11.0,
    read from the **rbox-admin version view** (exists; founder-confirmed).
    Known laggard: 1 user on 1.6 (founder's friend — nudge). Two-week bake.
  - [ ] Follow-up `#542`: barrier read gains `O_NOFOLLOW` (own reviewed PR).
- [x] **U0 — entry interning** (doc §"U0 — entry interning"). MERGED `#554`
  (5 codex rounds → ALIGNED). Readonly conversion tail MERGED `#561`.
- [x] **U1 — store, schema, digests, backup, read-only adapters** (doc §U1).
  Three slices: contract-suite + corpus `#549`, store substrate (U1a) `#564`,
  write seam / CAS / LOCAL plane (U1b) `#567`. bun:sqlite floor CI lane +
  corpus-112k fixture live. Copy-while-hashing containment is the settled
  write mechanism.
- [x] **U2 — reset/quarantine on DB artifacts** (doc §U2). MERGED `#566`.
  Migration entry compiles behind the `withMigrationImporter` capability;
  crash rig drives production writers; legacy JSON reset pinned byte-identical
  to `main`.
- [ ] **U3 — migration + `Q` flip; 2.0 ships here** (doc §U3). Opens the
  `2.0` branch. Exit criteria in the doc include: lock-exclusive entry
  (`migration-not-exclusive` refusal), the drain gate above, the no-regression
  gate (status latency + RSS no worse than 1.x baseline), fixtures F1–F6
  green, dual-binary differential rig (rig needs dual-binary plumbing —
  named deliverable), supported abort procedure.
- [ ] **U4a–U4f — the engine port, six slices on main as 2.x** (doc
  §U4a–U4f). Per-slice differential gate; whole-state adapter must reach zero
  call sites by U4f (CI-inventoried).
- [ ] **U5 — fleet bake + kill criterion** (doc §U5). Ship/no-ship:
  trusted status p50 ≤ 200ms / p95 ≤ 400ms on the 112k corpus AND daemon
  RSS ≤ 1.5GB — else re-scope or revert.
  **BLOCKED on the one owed founder input: the frozen machine profile**
  (which machine, warmup/sample protocol inputs — doc §"Measurement protocol").

## Standing constraints (from the doc; listed for visibility only)

- `2.0` branch: never rebased; main→2.0 merges at worst weekly with a named
  owner and a port-forward ledger (doc §"2.0 branch merge process").
- Every new halt reason ships with plain-English doctor copy + non-interactive
  twin.
- No prerelease channel exists in `scripts/release.ts` — the prerelease-vs-
  latest split is a named pre-U5 deliverable (a 2.0 tag today would publish to
  every user's `rbox upgrade`).

## WHERE U3 PICKS UP (next session — read this first)

B0/U0/U1/U2 are all merged. The **pre-U3 gate (thermo sweep #4,
`docs/design/notes/2026-07-28-thermo-nuclear-sweep-4.md`) is CLOSED** — all
four Tier 0 fixes merged (`#571` report, `#572` T0.2–T0.4, `#574` T0.1). U3 is
clear to dispatch.

**U3 spec is already written**: `.claude/worktrees/` is gone after this
session, so the spec text lives in this session's scratchpad only — RE-DERIVE
it from doc §"Migration authority state machine" (2108) → §"Supported
migratable envelope" (3404), §U3 (~4430), and the F1–F6 fixture matrix. The
sweep's **Tier 1 is the U3 build blueprint** — follow its move lists:

1. **Land the T1 structural moves FIRST** (before migration code), in order:
   T1.1 the compat boundary (`state-plane/paths.ts`, `adapters/legacy-json-store.ts`,
   `store/owner-token.ts` — the `OwnedLock`→`CasOwnerToken` sync bridge,
   `adapters/sqlite-state-save.ts`, `adapters/whole-state-compat.ts` as the sole
   JSON/SQLite authority selector); T1.2 split schema-apply from genesis-install
   before writing the importer; T1.3 the **nine-module** migration split
   (control-codec/publication/classifier/admission/import-json/finalize/
   retirement/cleanup/authority) — the design's 3-file target is too coarse;
   T1.4 the git-section codec + `StateDataCorruptionError`; T1.5 extract
   state-plane doctor policy before adding ~15 migration halts.
2. **Then dispatch U3 proper**: the migration machine M0–M7 (opus, fail-closed
   core) + the whole-state adapter + the `sync-state-store` flip seam, gated on
   the F1–F6 fixtures, the crash/disk-full/resume table, the no-regression
   harness (status latency + RSS on corpus-112k, pre vs post flip), and the
   dual-binary rig scenario (plumbing merged `#560`). **This opens the `2.0`
   branch** — created from main, never rebased.
3. **Capability decision (ratified by the sweep): do NOT build a generic
   capability framework.** U3 consumes `sqliteResetFacade` directly, reuses
   U1b's StageLock containment for compat packet stages, and uses the
   `withMigrationImporter` scope. Only convergence needed is the
   `OwnedLock`→`CasOwnerToken` bridge (T1.1 item 3).

## Standing founder-gated items (unchanged)

1. **Ship 1.11.1** — the #570 macOS ownership-spawn perf fix (106s→24s on
   Macs, validated on-fleet). Founder said ship 2026-07-28; train runs once
   `#572`/`#574` merge. (Changelog entry already written.)
2. **`v2.0.0-beta.1` tag** — founder-authorized, `next` channel, when U3 lands.
3. **Frozen machine profile** — blocks U5's bake only. Owed whenever convenient.
4. **Adoption drain** — 1.6 user + 1.9.x users onto ≥1.11.0 (watch rbox-admin).

## Open perf/hygiene follow-ups (not U3 blockers)

- `#573` — macOS git-apply **residual** ~22s (Mac-only, exposed once #570
  fixed ownership; same per-item-subprocess shape one layer over; needs
  sub-timer coverage to decompose, then fix).
- `#556` — FIFO-at-state-path blocks the O_NOFOLLOW reads (all 3 sidecar
  modules; low urgency).
- Daemon-timer test flake class (`daemon-activity.test.ts` design-178-B/pr8) —
  keeps drawing unlucky CI shards; sweep #4 ruled AGAINST generic shard-pinning
  (real races, injected clocks preferred), so treat as rerun-eligible until a
  specific test earns a real fix.
