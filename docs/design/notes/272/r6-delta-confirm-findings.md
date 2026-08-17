# 272 r6 delta-confirm — findings and ratified dispositions

Round: r6 of `docs/design/272-conflict-copy-oracle.md`, delta-confirm over the
r5→r6 fold. Folded into **r7**. Anchors below re-verified against `main` on
2026-08-16 during the r7 fold.

## Verdict

One blocker, three corrections, four nits. Nothing invalidated r6's
architecture: the grammar predicate, the root-scoped `comparable`, the
empty-population guard, the workspace-wide `conflictCopies` count, and r6's new
`conflict-copies` deferral reason all survived. The blocker corrected the
predicate's BOUNDARY, not its shape; two corrections were accepted as
narrow-the-claim edits and one as a priced residual.

## Blocker

### B-r6-1 — the predicate's boundary was one component too low

r6 wrote the scoped test as "components **at or below** `root`", with a comment
claiming components "strictly above `root` are the caller's addressing". Those
two statements do not describe the same rule, and the one the code would
implement is wrong: it leaves the repo's OWN name component in the content
population. A repo that `apply.ts:296-307`'s `moveAside` renamed under the
grammar (`a/b.dev_x.<ts>.conflict` as the repo root) therefore has every
manifest entry and every walked entry carrying a matching component, empties
both populations, and is misclassified by its own address — `indeterminate`
once §2.4's guard ships, and a vacuous `match` without it.

**Ratified: fix (a).** The predicate tests path components **strictly below**
the projection root. `proveRepo(rel)` addresses the repo BY that path, so the
repo's own name component is the caller's addressing exactly as an ancestor's
is; the name is not content. Consequences folded into r7:

- §2.3's signature comment inverted to the correct statement ("components AT OR
  ABOVE `root` are the caller's addressing … only components strictly below
  `root` are content").
- The ancestor fixture is KEPT unchanged — a conflict-named directory INSIDE a
  repo still prunes its subtree; that is the one position the predicate still
  tests. §7 relabels it "below-root" for accuracy.
- BOTH B1 pin arms (root-named repo, ancestor-named repo) assert
  `verdict.kind === "mismatch"`. Under the corrected predicate the two arms are
  the same rule, which is exactly why both are asserted: a regression to "at or
  below" leaves the ancestor arm green and fails only the root arm.
- The `:636`/`:736` scope-leaf exclusion that §2.3's failure narrative names is
  removed by this predicate: the scope leaf IS `root`, so the grammar can never
  drop it on either walk. §2.3 carries an explicit r7 note saying so.
- The ":198 ancestor-instance-only" claim and §6's `:977-979` entry are
  corrected: root-scoping removes BOTH addressing instances (ancestor-named and
  root-named); what survives it — and what §2.4's guard owns — is the
  at-or-below-INSIDE-the-repo instance, i.e. conflict-named content strictly
  below the root.
- Doc-wide reconciliation done: every "ancestor" and "at or below" occurrence
  re-read; the remaining "at or below" strings are deliberate references to the
  now-rejected rule (§2.3's explanation, §6's rejection entry, §7's pin note).
  §2.5's helper is renamed `matchesConflictGrammarBelow(rel, root)`.

## Corrections

### C-r6-1 — §4's bolded scope-projection claim was too broad

r6 bolded "**No caller applies a scope projection to a file manifest except
one, and that one projects the BASE**". False off the status path: `scopedPull`
(`src/cli/scope/pull-scope.ts:58-59`) projects the LOCAL and REMOTE manifests
too, alongside `reconcileBase` at `:57`.

**Ratified:** narrow the claim to the STATUS path. The true statement is that
`statusScope.projectFiles(state.lastSyncedManifest)` at
`status-projection.ts:289-291` is the only `projectFiles` call on the status
path and its argument is the BASE. The pull-path projections build the
reconciler's inputs and never feed `conflictCopies`. **Conclusion unchanged:**
nothing on the status path scope-projects a local manifest, so neither branch's
count source is scope-projected and the `deleted` hazard still does not
transfer.

### C-r6-2 — the new reason's copy does not reach the ordinary resolve refusal

`refusalMessage`'s new sentence reaches the user only on the locked-boundary
path (`resolve-command.ts:1070`). The ordinary resolve refusal for a
guard-downgraded repo short-circuits earlier: `proofIndeterminate` is set at
`:269`, and `:686-687` (`keep-mine`) and `:892-893` emit the canned
`code: "proof-indeterminate"` text — "retry after Git state settles" —
transient-flavoured copy for a hold whose `transient` is deliberately `false`.

**Ratified: accept as a priced residual and ledger it.** Reasons, stated
plainly in §2.7: the deferral surfaces (`rbox status`, `rbox doctor`, the
deferral listing) are the primary visibility for this hold and they DO carry
the new copy; the generic refusal is shared across ALL indeterminate causes, so
fixing it means threading a cause into a message that today has none; and
threading cause-specific copy into `resolve-command.ts` is deliberately out of
272's blast radius, with design 271 concurrently at that file's ratchet
ceiling. **Named follow-up condition (§6, r7 group):** when `resolve-command.ts`
is next split per its ratchet, the proof-indeterminate refusal gains
reason-aware copy.

### C-r6-3 — the `doctor-cmd` ordering fix is an instance of an untyped invariant

r6 fixed the specific hazard (place `"conflict-copies"` before `"conflict"`)
but left the rule implicit.

**Ratified: record the general invariant.** Any `GIT_DEFERRAL_REASONS` member
that is a superstring of an existing member must PRECEDE it in the declaration.
`gitReasonOf` returns the first `includes()` hit while iterating
`GIT_DEFERRAL_REASON_SET` (`doctor-cmd.ts:213-217`), and that set is built from
the declaration in order (`:43`), so a shorter member declared earlier
permanently shadows every longer member containing it. Today the vocabulary
satisfies the rule by luck (the five `local-*` members share only a prefix).
§7 gains a unit test pinning the invariant itself: for every pair `(a, b)` with
`a !== b` and `a.includes(b)`, `indexOf(a) < indexOf(b)`. Nothing types it.

## Nits (all four accepted)

1. `status-view.test.ts`'s unknown-reason FALLBACK pin is at `:170-174`
   (`"future-reason"` ⇒ "unrecognized Git issue", `transient: false`); §2.7's
   coverage row now names it beside the `:163-169` loop.
2. `settle()` is `:413-415`, not `:413-416`; and `sync-state-model`'s load-time
   duplicate check is `:165-167`, not `:165` — it compares the precedence SET's
   size against `GIT_DEFERRAL_REASONS.length`, so it also catches a member
   ranked but never declared.
3. §2.5's dir arm must be written with the OPTIONAL call —
   `prunes?.(rel + "/") ?? ignores(rel + "/")`. `prunes` is optional on
   `IgnoreMatcher` (`src/engine/ignore.ts:302`); a folded predicate with a
   non-optional call throws on a matcher that does not implement it. Both walks
   already write `this.matcher.prunes?.(dirForm) ?? this.matcher.ignores(dirForm)`
   (`apply-receipt.ts:619`, `:716`).
4. §2.7's "eight surfaces / nine rows" count drifted. Fixed with the true
   enforcement split: nine rows = one declaration + **four compile-time**
   (precedence ranking, telemetry restatement, status-view copy, resolve
   refusal copy) + **three test-enforced** (telemetry length pin, status-view
   coverage test, precedence test) + **one unenforced** (`doctor-cmd`'s
   `gitReasonOf`) — which is why C-r6-3 adds a test for that last one. The §6
   entry's "six of its eight surfaces are compiler-demanded" is corrected the
   same way.

## Verified clean (re-confirmed during the r7 fold, no doc change)

- **The arming seam is one sink per prove.** `project()` runs exactly once per
  prove, always before either walk, and the `armed` sink rides the `Projected`
  struct — not an oracle instance field, which `serial()`
  (`apply-receipt.ts:405-412`) would share across concurrent repo proofs.
- **The r6 dir-arm fold is behavior-preserving.** `inventory` (`:617-620`) and
  `scopedScan` (`:714-717`) carry the identical `prunes?. ?? ignores` test on
  `dirForm`, so folding both into `comparable(childRel, "dir")` changes no
  verdict (given nit 3's optional call). The `scopedScan` restructure that
  hoists the `type` computation above the leaf guard remains required.
- **§2.7's anchors all confirmed:** `sync-state-model.ts:130-134` /
  `:149-153` / `:156-158`, `telemetry/contract.ts:158-165`,
  `telemetry/contract.test.ts:48` (`toHaveLength(18)` ⇒ `19`),
  `status-view.ts:289-307` + `:308`, `resolve-presentation.ts:125-146`,
  `status-view.test.ts:163-169`, `deferral-precedence.test.ts:11-19`,
  `doctor-cmd.ts:43` / `:213-217`, and `status-view.ts:404-412`
  (`remediationClass`, which `transient: false` routes through unchanged).
- **Skew and exact-why robustness confirmed.** Discrimination on
  `CONFLICT_COPY_POPULATION_WHY` by string EQUALITY holds across a client with
  an older oracle: an old `why` simply lands `unreadable`, the status quo, and
  never mis-buckets. No substring sniff anywhere on that path.
- **C2's downgrade breaks nothing.** A downgraded record stores neither
  `tokens` nor a `receiptHash`, which is byte-for-byte a `settle()`-shaped
  record; `receiptHash(rel)` is already `string | undefined` (`:371-373`) and
  every consumer tolerates the absence. `reproveRepo` re-enters `proveFresh`
  (`:382-383`), the documented and intended cost.
