# Design 89 — History-free quota ("your quota is your files")

> **Implementation: 🔴 NOT STARTED** — design only, by explicit instruction
> (working tree kept clean for the reliability flow). Codex adversarial
> review pass 1: FAIL (4 critical + 3 high + 3 medium) — all ten resolved in
> §10 (normative, amends the body). Status index: [`README.md`](./README.md).

**Status:** DRAFT — review pass 1 folded; ready for a confirming pass
alongside implementation.
**Depends on:** design 86 (paid-only plans), design 33 (per-account GC) — and
makes **GC purge automation a hard prerequisite** (§6).
**Supersedes:** the display-only "usage decomposition" idea (old task: show
live vs history). Product decision from the founder (2026-07-08): don't just
*show* the split — **stop counting history against the quota entirely.**

## 1. Why

During the first agent-key dogfood the founder hit the number every customer
will eventually hit: the account said **41.7 GiB used** while the working set
on disk was ~7 GiB. The delta is version history and git-state lanes — rbox
doing its job. But the quota bar presents it as *your storage*, which:

- punishes exactly the behavior rbox encourages (churn, constant sync,
  history you can restore from);
- makes "50 GB" a lie-shaped truth — users can't predict their own usage;
- turns retention (a headline *feature*, "1-year version history" on Pro)
  into a hidden *cost* against the buyer.

Decision: **quota = live bytes.** History rides free; rbox eats the margin.
Retention windows already bound the exposure — history can't grow without
bound, it expires (30d Solo / 1yr Pro / 90d Team). The cleaner promise is
worth the storage cost, and "version history never counts against your
storage" becomes a marketing line no mainstream competitor matches.

**Deliberately reversible** (founder call, 2026-07-08: "we can ultimately not
do this if we see it's not working"): because `used_bytes` survives untouched
as the ledger (§3) and `live_bytes` is purely additive, reverting is flipping
the enforcement comparison back to `used_bytes` + a copy change — no data
migration, no repricing of stored state. Watch the margin via the §4 bounds
and the admin overview; the exit stays one PR wide.

## 2. The number (what "live" means)

**Live bytes = Σ `blobs.size_bytes` over each `(workspace, project)` head's
verified refset — server-priced, never client-priced.** The client names the
refs (lying about refs breaks its own sync); the SERVER prices them from
`blobs.size_bytes`, which is receipt-measured at upload. The sidecar
descriptor's `totalBytes` is an integrity crosscheck only (§10 R2: its
constituent sizes are client-authored and advisory — a malicious sidecar can
claim size 0, so it must never feed billing). The head refset already unions
git-lane artifacts (bundle, packChain, index, op-state — `blobRefsForManifest`),
so git state is inside the sum, not added on top (§10 R9).

Not counted: superseded version blobs, trash, tombstones, GC candidates,
in-flight upload staging. Counted: everything the newest state of every
`(workspace, project)` stream references — including current git artifacts,
which ride inside the refset (they're part of "your files today").

## 3. Enforcement mechanics (the load-bearing part)

Today: `accounts.used_bytes` is a cumulative referenced-bytes counter,
charged race-safely per commit by `commitAccounting` (receipts path;
`grantEntitlementWithQuota` serves the legacy blob/multipart completion
paths — §10 R5) with the `accounts_cap_guard` trigger as the hard gate. It
equals *live + history* — verified against `blob_refs` joins to the byte in
prod.

**Keep `used_bytes` exactly as-is** — it is the abuse/accounting ledger and
the thing GC reconciles. Add the new plane instead of mutating the old one:

- **Per-stream live ledger** (new table or columns keyed
  `(workspace_id, project_id)` — the DO/schema unit, §10 R8): the commit path
  computes the head's server-priced refset total (Σ `blobs.size_bytes`) and
  records the per-sequence delta as an **idempotent ledger row riding the
  same at-least-once machinery `commitAccounting` already uses** — NOT a bare
  `+=` in the pre-DO accounting batch. Today's D1 accounting runs BEFORE the
  authoritative DO head CAS and a 409 can follow it; entitlement idempotence
  absorbs that for `used_bytes`, and live deltas must be keyed the same way
  (per `(ws, proj, sequence)`) so replays and post-accounting conflicts
  reconcile instead of drifting (§10 R4).
- `accounts.live_bytes` (new column): rolled up from the per-stream ledger in
  the same conditional write, guarded by a **new `accounts_live_guard`
  trigger** — the exact race-safe RAISE-ABORT pattern the current cap guard
  uses, applied to `live_bytes` vs `cap_bytes` (§10 R3). A read-then-write
  preflight alone is not race-safe across concurrent `(ws, proj)` DOs; the
  conditional increment is the gate, the preflight is just the friendly 402.
- A periodic reconcile sweep (rides the existing hourly cron) recomputes live
  from **authoritative DO heads + `blobs.size_bytes`** (inline heads carry no
  descriptor; sidecars only exist above the size threshold — §10 R6) and
  repairs drift.
- The `accounts_cap_guard` trigger (used_bytes vs cap_bytes) is **repointed
  at the stuffing bound** (§4: `K × cap_bytes`). The `cap_bytes`
  materialization triggers are unchanged.

## 4. Abuse guardrails (why used_bytes must survive)

If history is free and only *live* bytes are billed, the attack is obvious:
upload blobs and never reference them (or reference then immediately
supersede) → unbounded free R2. Three bounds close it:

1. **Retention IS the history bound.** Superseded blobs live at most
   `retentionDays`, then the plan-driven prune (design 13) + GC reclaim them.
   Worst-case paid-for-free storage ≈ churn-rate × retention-window — finite,
   plan-priced, and exactly the margin the founder chose to eat.
2. **Stuffing bound (the repointed guard):** `used_bytes` (total referenced +
   staged) may not exceed `K × cap_bytes` (**K = 4**, per-plan override
   possible — margin-validated in §11). When the bound binds, behavior splits
   by cause (§11 rider 2): **honest churn thins** — the retention prune runs
   early against that account, oldest/densest history first (the
   Syncthing/Nextcloud staggered norm; Microsoft now ships the same idea as
   "automatic" versioning), so the user experience is "up to 1 year of
   history, full fidelity for 30 days," never a blocked push. The hard 402
   (`reason: "churn_bound"`) is reserved for the §4.3 receipt-stuffing case,
   where there is no history to thin.
3. **Unreferenced uploads — the hole codex closed (§10 R1):** receipt PUTs
   (single AND batch) write canonical R2 and mint receipts **before any
   `blob_refs`/`used_bytes` exist**, and the batch path currently has no
   `wouldExceedCap` precheck at all — so "upload unique blobs forever, never
   commit" is free unbounded R2 under the naive design. Fix: the upload-time
   bound must count **outstanding receipt bytes**, i.e. enforce
   `used_bytes + Σ(unconsumed, unexpired receipt bytes) ≤ K × cap_bytes` on
   BOTH upload paths (add the missing batch precheck), and unconsumed
   receipts must expire and their canonical objects become purge-eligible.
   The R2 reclaim itself requires the purge cron (§6).

## 5. Surfaces (and the CLI-impact answer)

**CLI impact is display-only.** The CLI never computes quota — it renders the
usage endpoint. No engine, sync, or crypto changes.

- `GET /v1/account/usage` adds `liveBytes` and `historyBytes`
  (`used - live`, floor 0); `storageCap` semantics now bind to live.
- `rbox usage`:

  ```
  plan:       pro
  storage:    ▓░░░░░░░░░░░  6.8 GiB / 250 GiB   (your files)
  history:    34.9 GiB of version history — free, kept 1 year
  ```

- Dashboard: same split; the bar is live-only, history is a sub-line.
- 402 handling: unchanged shape; new optional `reason: "churn_bound"` string
  (CLI prints the existing quota message if it doesn't recognize the reason —
  forward-compatible).
- Site copy (separate repo, one line on the pricing section): "Version
  history never counts against your storage."

## 6. Hard prerequisite: GC purge automation

In a history-free-quota world, **rbox's own R2 bill is bounded only if GC
actually reclaims** expired history and unreferenced blobs. Today Phase 2
(`gcPurge`, the R2 deleter) is manual-only and has **never run**: measured
2026-07-08, prod R2 holds 111.8 GiB total vs 44.9 GiB referenced (~67 GiB
dead), 70,040 condemned candidates un-purged. Founder call: review ~2026-07-15.

This design makes it structural: **purge must become a cron** (long grace —
days, not the 1-hour default; retention → mark → purge order per the admin.ts
comment) before or with the quota flip. Shipping free history atop a GC that
never deletes is a one-way cost ratchet.

## 7. Found bug (fix first, independent of this design)

**rbox.to sells Pro with "1-year version history" (2026-07-08 pricing
update), but the PRODUCT still says 90 days everywhere** — `plans.ts`
pro.retentionDays = 90, and repo-shipped copy agrees with the code
(README.md, docs/pricing.md, the dashboard plan card). The mismatch is
site-vs-product (§10 R10). Founder direction: align product to site —
**90 → 365** in plans.ts plus the three copy surfaces, one PR, ship first.
Until then, Pro history is pruned 9 months earlier than the site sells.

## 8. Migration sketch

0. **GC purge cron ships first** (§6 is a prerequisite, not a footnote —
   §10 R7): retention → mark → purge on a schedule, long grace (days).
1. Migration: per-stream live ledger + `accounts.live_bytes` (default 0),
   `accounts_live_guard` + repointed stuffing guard per §3/§4, backfill by
   the §3 reconcile computation (DO heads + blobs.size_bytes — NOT
   descriptors).
2. Commit finalize writes live_bytes; preflight enforces live vs cap.
3. Usage endpoint + CLI + dashboard rendering.
4. Reconcile sweep on the existing hourly cron.
5. Site copy line.
6. Retention fix (§7) travels first.

## 9. Open questions

1. ~~K for the stuffing bound?~~ Resolved (§11): K = 4, with thin-don't-block
   for honest churn and the IA-tiering rider.
2. ~~Do git-lane bundle bytes count as live?~~ Resolved (§10 R9): they're
   already inside the head refset — counted, not double-counted.
3. Team pooled-storage interaction (150 GB/user) — live-bytes pooling is the
   natural reading; confirm before Team ships.

## 10. Codex adversarial review (pass 1)

Codex (gpt-5.5, read-only against the live tree) reviewed the first draft:
**VERDICT: FAIL** — 4 critical, 3 high, 3 medium. All ten were correct; the
body above has been amended. This section is normative.

- **R1 [CRITICAL] Free unbounded R2 was constructible.** Receipt PUTs (single
  and batch) write canonical R2 before any reference exists; the batch path
  had no cap precheck; Phase 1 scans only `blob_refs`; Phase 2 never runs.
  "Upload forever, never commit" was free. **Resolution:** §4.3 — the
  upload-time bound counts outstanding receipt bytes on both paths; receipts
  expire; purge cron reclaims (§6/§8 step 0).
- **R2 [CRITICAL] Sidecar `totalBytes` is client-advisory, not billing-grade.**
  The server only checks internal consistency of client-authored sizes; a
  malicious sidecar can claim size 0. **Resolution:** §2 — live bytes are
  server-priced from `blobs.size_bytes` over the head refset; the descriptor
  is an integrity crosscheck only.
- **R3 [CRITICAL] Read-only preflight isn't race-safe.** Concurrent commits in
  different `(ws, proj)` DOs both pass a read check. **Resolution:** §3 — a
  conditional-write `accounts_live_guard` trigger (the existing cap-guard
  pattern) is the gate; the preflight is only the friendly 402.
- **R4 [CRITICAL] "Same finalize batch" didn't exist.** D1 accounting runs
  before the DO head CAS; 409s can follow it; the commit mirror is
  best-effort. A bare `+=` drifts. **Resolution:** §3 — per-sequence
  idempotent live-delta ledger riding `commitAccounting`'s at-least-once
  machinery, plus the reconcile sweep.
- **R5 [HIGH] Misstated the current charger** (`grantEntitlementWithQuota` is
  the legacy path; receipts commits use `commitAccounting`). Corrected in §3.
- **R6 [HIGH] Backfill can't read descriptors** (inline heads have none;
  sidecars exist only above threshold). **Resolution:** §3/§8 — backfill and
  reconcile compute from authoritative DO heads + `blobs.size_bytes`.
- **R7 [HIGH] Purge-cron prerequisite was missing from the migration plan.**
  Now §8 step 0.
- **R8 [MEDIUM] Wrong unit:** live ledger is per `(workspace_id, project_id)`
  (the DO/schema unit), not per workspace. Amended in §3.
- **R9 [MEDIUM] Git bytes would have double-counted** — the head refset
  already unions git artifacts. Amended in §2; open question 2 resolved.
- **R10 [MEDIUM] The retention mismatch is site-vs-product**, not a repo
  self-contradiction: repo code AND repo copy say 90 days; rbox.to sells
  1 year. §7 now states it precisely with the founder's chosen direction
  (90 → 365 in plans.ts + README + docs/pricing.md + dashboard card).

## 11. Competitive landscape & margin model (researched 2026-07-08)

Full sourced report in the research archive; the load-bearing facts:

- **History-exempt quota is Dropbox's model** (all tiers, explicitly "doesn't
  take up any of your available storage space"); Microsoft charges quota for
  versions and it is the most-resented storage behavior in that ecosystem;
  Google is in between. So §1's promise is table stakes done right, not a
  radical bet — **the differentiator is the window**: Dropbox gives 180 days
  at the $20-ish Professional tier and reserves 365 for $26+/user Business
  plans. rbox Pro at $20 with 365 days out-windows the direct comparable.
- **Margin math (R2 Standard $0.015/GB-mo; deletes free), at the observed
  agent-whale churn of 3.8 GB/day on a 7 GB working set:**
  | Scenario | History COGS/mo | % of $20 Pro |
  |---|---|---|
  | 365d uncapped | $20.81 | 104% — margin trap |
  | 365d, K=4 (≤1 TB referenced) | ~$14.95 | 75% |
  | 365d, K=4 + IA tiering (>30d history in R2 Infrequent Access, $0.01) | ~$11.25 | 56% |
  | Normal dev (0.38 GB/day), 365d | ~$2.83 all-in | 14% (≈86% gross margin) |
  Blended (≈2% whales): ~$3.25/user storage COGS ≈ 84% gross margin.
- **Adopted riders:**
  1. **IA tiering:** age history blobs >30 days old into R2 Infrequent Access
     (verify IA retrieval fees before implementation — restores of old
     versions are rare and can eat a retrieval fee).
  2. **Thin, don't block:** when K×cap binds on honest churn, prune
     oldest/densest history early rather than 402ing (§4.2). Backblaze-honest
     framing: "full fidelity 30 days, up to 1 year."
  3. Skip 180d (saves ~$4/mo on the rarest users, forfeits the headline);
     skip a history add-on at launch (Backblaze's $0.006/GB-mo "forever"
     shape remains available later if whales ask).
- **Free marketing note:** Dropbox heavily markets "Rewind" (point-in-time
  folder/account rollback within the window). rbox's commit-sequence model
  gets this nearly free — a named "rewind" feature is low-cost, high-signal
  once this design ships.
