# 163 / 2.0 execution roadmap — what's done, what's next

> **Pointer document, not authority.** The ratified design
> (`docs/design/163-state-plane-sqlite.md`, v11 — RATIFIED AMENDMENT) is the
> only normative source; section references below are to its headings. If this
> file and the doc disagree, the doc wins and this file has a bug. Update this
> file's checkboxes as units land; never restate requirements here.
> Last synced to the doc: 2026-07-28 (v11, `#544`).

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
- [ ] **U0 — entry interning** (doc §"U0 — entry interning"). Internal,
  unshippable, no gate. Can start on main now.
- [ ] **U1 — store, schema, digests, backup, read-only adapters** (doc §U1).
  Includes the `bun:sqlite` contract suite + pinned Bun floor, and the
  reproducible `corpus-112k` fixture (both named U1 deliverables).
- [ ] **U2 — reset/quarantine on DB artifacts** (doc §U2 — deliberately ahead
  of the flip so migration entry is structurally impossible before reset
  support exists).
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

## Next concrete actions (in order)

1. Founder: authorize the **1.11.0** release train (B0 is merged and gated).
2. Nudge the 1.6 user; watch rbox-admin until drain shows ≥ 1.11.0 fleet-wide.
3. Dispatch **U0** (small, main, no gate) and **U1** (contract suite + fixture
   first — they de-risk everything after).
4. Founder: name the machine profile whenever convenient (only blocks U5).
