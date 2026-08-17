# 272 r5 delta-confirm — findings and ratified dispositions

Round: r5 of `docs/design/272-conflict-copy-oracle.md`, delta-confirm over the
r4→r5 fold. Folded into **r6**. Anchors below re-verified against `main` on
2026-08-16 during the r6 fold.

## Verdict

Two blockers, six corrections, four nits. No finding invalidated r5's
architecture: the grammar predicate, the root-scoped `comparable`, the
empty-population guard, and the workspace-wide `conflictCopies` count all
survived. One finding (correction 4) escalated to a product decision and was
ratified as new scope.

## Blockers

### B-r5-1 — §2.5's snippet contradicted the m3 count

r5's snippet said it "replaces `:718-722` only" and that `scopedScan`'s
directory arm "stays exactly where it is / unchanged". That cannot be squared
with m3's seven-call count, which explicitly includes **the dir arms of `:616`
and `:713`**. Either the dir arms convert (seven calls) or they do not (five).

**Ratified:** the dir arms DO convert. §2.5's snippet widens to cover
`:714-722` and shows the dir arm's `this.matcher.prunes?.(dirForm) ??
this.matcher.ignores(dirForm)` test replaced by `comparable(childRel, "dir")`.
The contradictory prose is deleted. Count unchanged at seven.

### B-r5-2 — the scope-projection sentence was false as written

r5 wrote "`scopeProjectionFor` has exactly two callers". Verified: it has
**four** — `status-projection.ts:288`, `workspace-observation.ts:83`,
`sync-git/status.ts:89`, `sync-git/deferral-hygiene.ts:219`.

**Ratified:** reword to the true claim. Three of the four scope git **repo
records** via `scope.classifyRepo(...) === "in"` over repo keys
(`workspace-observation.ts:86`, `sync-git/status.ts:90`/`:108`,
`deferral-hygiene.ts:221`) and touch no file manifest. **No caller applies a
scope projection to a file manifest except** `statusScope.projectFiles(
state.lastSyncedManifest)` at `status-projection.ts:289-291`, which projects the
**BASE only**. The r5 conclusion is UNCHANGED: workspace-wide population on both
status branches, sourced from `rawLocalManifest` (`status-projection.ts:352-354`).

## Corrections (all ratified)

1. **Name the population "zero compared pairs" refers to, per site.** The two
   downgrade sites count different comparisons: at `:541` it is the
   **manifest × manifest** `compareEntries(projected.expected, projected.oracle)`
   from `:495`; at `:669` it is the **disk × manifest**
   `compareEntries(scanned.files, projected.oracle)` from `:664`. r6 states both
   in a table.

2. **The downgraded verdict is computed BEFORE `records.set`,** so the `tokens`
   ternary sees it. Ratified rule (the safe one): **a downgraded record stores
   neither `tokens` nor a `receiptHash`** — i.e. it is `settle()`-shaped
   (`{ verdict }` only). Rationale: `receiptHash` is both the fast-path reprove
   credential and the `oracleReceipt` identity field
   (`src/cli/sync-git/resolution-intent.ts:115`); a receipt minted from a
   grammar-emptied population would let a later boundary re-prove or `--confirm`
   treat the emptied comparison as proven. `receiptHash(rel)` already returns
   `string | undefined` (`apply-receipt.ts:371-373`).

3. **Add the fast-path loss to §2.4's cost.** No usable `tokens` means
   `reproveRepo`'s `if (!prior?.tokens || prior.verdict.kind !== "match")`
   (`:382-383`) fails on both clauses, so every boundary re-prove falls to
   `proveFresh` and re-runs a full `scopedScan` — re-`lstat` of the subtree plus
   re-hash of whatever the hash cache misses (`cache.lookup`, `:698`) — until
   the copy clears. **Same zero-in-field bound** as the re-deferral cost.

4. **PRODUCT DECISION (ratified): a NEW named deferral reason for guard-armed
   holds, `conflict-copies`.** Without it, `follow-classify.ts:139` maps every
   oracle `indeterminate` to `unreadable`, whose repair copy
   (`status-view.ts:302`) tells a non-developer to fix repository permissions
   for a condition whose real fix is deleting a file rbox minted. Now r6 §2.7.
   Full surface set, anchored:
   - discrimination: exact `why`-string equality at `follow-classify.ts:139`,
     against a new exported constant `CONFLICT_COPY_POPULATION_WHY`
     (`apply-receipt.ts`, beside `whyFromScanError`'s vocabulary `:266-272`).
     Exact match, never a substring sniff.
   - enum: `sync-state-model.ts:130-134` (`GIT_DEFERRAL_REASONS`).
   - precedence: `sync-state-model.ts:149-153`, ranked right after `conflict`;
     `:156-158`'s `UnrankedGitDeferralReason` alias and `:165`'s runtime
     duplicate check enforce totality.
   - wire/telemetry restatement: `telemetry/contract.ts:158-165` (a deliberate
     duplicate, licensed by `state-plane/duplicate-declarations.test.ts:59`);
     `telemetry/contract.test.ts:48` `toHaveLength(18)` → `19`.
   - status-view copy: `status-view.ts:289-308`
     (`DEFERRAL_REASON_PRESENTATION`, `satisfies Record<GitDeferralReason, …>`).
     Copy: label "conflict copies"; text "Backup copies rbox made of conflicting
     files are the only thing left to compare here."; repair "Remove the
     conflict-copy files (or resolve them), then let sync retry.";
     `transient: false` (the hold does not self-clear, and `transient` feeds
     `remediationClass` at `:404-412`).
   - resolve refusal copy: `git/resolve-presentation.ts:125-146`.
   - coverage: `status-view.test.ts:163-169` and
     `sync-git/deferral-precedence.test.ts:11-19` cover it automatically.
   - **the one non-mechanical site:** `doctor-cmd.ts:213-217`'s `logRedactionReasonOf`
     iterates `GIT_DEFERRAL_REASON_SET` in declaration order and returns the
     first member the detail `includes(...)`, so `"conflict"` would swallow
     `"conflict-copies"`. Fix: place the new member **before** `"conflict"` in
     the `GIT_DEFERRAL_REASONS` declaration. Declaration order is explicitly an
     enumeration and not a ranking (`sync-state-model.ts:145-147`), so this is
     free — but nothing type-checks it.
   - `projectGitDeferralRepos` (`status-view.ts:378-436`) needs **no change**.
   - design 271 is doing parallel `GitDeferral.detail` work; 272 changes only
     which reason id is added, never how details are carried, and touches none
     of 271's files.
   - **Rejected alternative, ledgered:** accept the `unreadable` mismatch and
     file a papercut. Zero code, permanently wrong instructions for the exact
     user population this design exists to unwedge.

5. **The B1 pin asserts at the ORACLE layer:** `verdict.kind === "mismatch"`
   (the diverged-tree verdict), on both oracles. `expectNotMatch`
   (`apply-receipt.test.ts:70`) is explicitly barred as insufficient — with the
   guard shipping, a deleted §2.3 yields `indeterminate`, which satisfies
   "not match" and leaves the pin green over the deletion.

6. **Name the arming seam.** Ratified shape: `comparable` becomes a per-prove
   bound closure, `comparableFor(root, eq, armed)`, created once per prove with
   a prove-scoped `armed` sink shared by `project()`'s manifest filter and both
   walks; the grammar arm sets it. Landed shape after reading the code:
   - the sink and closure are allocated in **`project()`** (`:460`), right after
     `normalizeRel` (`:463`) and before the filter (`:468-469`), and ride the
     returned `Projected` struct (`:473-482`);
   - `inventory` (called `:500`) and `scopedScan` (called `:659`) take the bound
     closure as a parameter — both call sites already hold `projected`;
   - the downgrade sites read `projected.armed.hit` (`:541`; `:669` via
     `scanAndCompareProjected`'s third parameter at `:658`).
   - **Verified one `project()` per prove:** its only two call sites are `:489`
     (`proveFresh`, threading the same struct to `:493`/`:510`/`:530`) and
     `:651` (`scanAndCompare`, threading to `:655`).
   - Rejected variant: an oracle instance field. `serial()` (`:405-412`)
     de-duplicates per `rel` but does not serialize different repos, so one
     field would be shared across concurrent repo proofs.
   - Consequence: call sites now call `comparable(rel, kind)`; §0's
     module-private table and §2.3's signature block updated. **Count unchanged
     at seven.**

## Nits (all four ratified)

- `enqueueActivityWrite` is `daemon.ts:2407-2445`, not `:2407-2421`; its
  `ambientStatusFrom` call at `:2430` reaches the `files.reduce` at `:2299`.
- A **second** post-`:360` divergence beside the ignored-base carry: the
  case-fold **base-adoption** path, `local-file-projection.ts:68-74` (filter
  `:68`, base adoption `:72-73`, rationale comment `:69-71`). On a fold
  collision `status-projection.ts:360` carries a base-spelled path that may not
  be the one on disk. `rawLocalManifest` precedes both edits, so the single
  sourcing decision already covers both.
- §6's group labels/counts were wrong ("then r4's three" for entries that
  predate r4). Regrouped in r6 as: two r6 entries, three r5 entries (resolving
  r4's blockers), three standing-since-r3 entries, then the standing mint-
  relocation rejection.
- The `settle()` indeterminate-only claim is stated as **verified across its
  eleven call sites** — `:391`, `:487`, `:491`, `:497`, `:503`, `:507`, `:516`,
  `:532`, `:653`, `:662`, `:666` — every one passing an `indeterminate`.

## Verified clean (no change required)

- **The two guard downgrade sites `:541` and `:669` are the ONLY match-minting
  sites.** `settle()` (`:413-416`) records `{ verdict }` with no `receiptHash`
  and no `tokens`, and all eleven of its call sites pass an `indeterminate`.
- **No reprove loop.** `reproveRepo` re-affirms `MATCH` at `:388` only when
  `prior.verdict.kind === "match"` (`:383`); a downgraded record stores
  `indeterminate`, so it re-enters `proveFresh` rather than resurrecting the
  stale match.
- **The FIFO two-belt pin discriminates correctly.** The ≥1-surviving-pair
  requirement keeps the guard from arming, and asserting the specific why
  `"unsupported entry type in repo subtree"` (`whyFromScanError`, `:268`)
  distinguishes the `"other"`-arm hold from the population-emptied hold. Under
  the rejected literal substitution the FIFO is silently skipped, so without
  both belts a broken build passes.
- **B-r4-5's chain holds, with `rawLocalManifest` the correct population.**
  `projectLocalManifest` applies no scope projection; the daemon's
  `this.local.manifest` and the computed branch's `rawLocalManifest`
  (`status-projection.ts:352-354`) are the same disk observation; the `deleted`
  carve-out (`:306-309`) belongs to a diff against a whole-workspace base and
  does not transfer to a count that takes no diff.
