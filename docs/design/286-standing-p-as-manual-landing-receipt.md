# 286 — a standing CREATE P is a manual-landing receipt, not a preflight refusal (fix #831)

**Status:** v2 (codex diagnosis + ox-alpha adversarial round folded) ·
**Blocks:** the v2.0.0 tag (founder, 2026-08-25: "go ahead and fix it
before the tag") · **Issue:** #831 · **Full trace:** notes-286-diagnosis.md

## Problem

`rbox git resolve take-theirs` holds with "P settlement BASE absent" for
any repo whose record lacks a BASE while a CREATE-shaped standing P
(`priorOid === null`) exists in the LOCAL protocol refs
(`refs/rbox-local/base-present/v2/*` + K pin). The device minted that P
itself at first-BASE landing (design 271, `branch-transition.ts:176-207`);
design 271 deliberately leaves it standing, and a quiescent repo never
routes through the retirement path (`apply.ts:784` gate). State-row resets
cannot remove it (falsified by field surgery, 2026-08-25); fresh devices
cannot IMPORT one (bundle `--exclude=refs/rbox-*`, `capture.ts:42`;
manifest ref map allows heads/tags/stash only, `manifest-validate.ts:327`)
but CAN self-mint one and later hit the same wedge after local divergence.

The refusal is a misrouting: the manual preflight
(`resolve-artifacts.ts:77→120`) demands settlement of every standing P
before resolution, but a CREATE P against an absent BASE cannot settle
(`p-settlement.ts:84-86` guard) — while the pure manual composer already
accepts exactly this shape as an `artifact` decision with
`beforeBaseOid: null` (`base-composer.ts:465,487`; exercised directly:
terminal, installs N, mints pull-p provenance).

## Rejected options (full table in notes-286-diagnosis.md)

- **(a) raw preflight skip** — violates "no snapshot while unreserved
  exact P authority stands" (`resolve-artifacts.ts:1`), falsely asserts
  `artifactsClear`, and collides when incoming ≠ `P.nextOid`.
- **(b) settle into absent BASE** — a P holds one branch transition; it
  cannot supply the GitSection family; synthesizing BASE in settlement
  moves ownership into the wrong module.

## Invariant restated (ox-alpha round 1)

The old preflight invariant ("a confirmation snapshot is never taken while
exact P authority stands", resolve-artifacts.ts:26) is unenforceable — P/K
are invisible to the snapshot (refs.ts isSyncableRef filter). It is
REPLACED by: **no confirmed mutation while UNRESERVED exact P authority
stands.** Safety rests on the reservation CAS (checkout-txn.ts:798-816,
which aborts on any P/K/branch movement after the confirms) plus
post-journal settlement — not on snapshot visibility.

## Fix — (c) consume the standing P as the manual artifact proof

Reuse existing mechanisms; no new BASE authority. Constraints from the
adversarial round are normative:

- **All-or-refuse classification**: the preflight classifies EVERY
  standing P before returning ready (the one-per-pass presentArtifacts[0]
  loop must not let receipts short-circuit remaining Ps).
- **Per-receipt live equality**: a receipt requires the receipt ref's OWN
  live value to equal P.nextOid (not just the HEAD branch's) — a
  live-diverged side ref with a matching incoming refuses today's way
  instead of colliding at prepareBasePresentArtifact.
- **Receipts take precedence over #830 no-op terminals** for the same
  ref: the transaction skips minting a no-op terminal when a receipt
  witness exists, and makeIntended must not overwrite a witness-derived
  decision with a terminal (today resolve-take-theirs.ts:163-175 runs
  after the witness loop and clobbers it — flip the precedence). The
  composer's artifact arm then genuinely sees the P.
- **Side-branch injection is new plumbing, named as such**: with
  opts.base undefined, publication produces nothing for an equal-value
  standing-P ref; the receipt injection point (witness + lockedProof) is
  added deliberately, not smuggled as "existing".
- **Benign edge documented**: a nonmatching P on a branch absent from
  base AND incoming composes via the before===requested arm and is
  retired by ordinary post-landing settlement.
- **Post-landing settlement failure is owned**: if retirement fails after
  the checkout landed, the resolve reports the typed artifact outcome
  (refused/artifact) — recoverable by rerun; the copy says so.

1. Manual preflight classifies an exact `base-absent` CREATE P as a
   manual-landing receipt instead of a generic hold — only after
   validating P/K identity, `R == P.nextOid`, and the exact reflog
   episode.
2. The receipt feeds the existing `branchWitnesses`/`branchLockedProofs`
   plumbing with `beforeBaseOid: null`, and ONLY when
   `incoming.refs[ref] === P.nextOid`. Any other shape (nonmatching or
   advancing P) keeps today's repair/refuse behavior.
3. `RefPlaneTransaction` reserves R/P/K through checkout via its existing
   witness reservation loop (`ref-plane-transaction.ts:236`).
4. The manual composer is UNCHANGED — its artifact arm already accepts
   the shape.
5. The existing post-journal settlement call
   (`resolve-take-theirs.ts:294`) retires P/K normally once BASE exists.

Ownership split preserved: incoming supplies the GitSection family; the P
proves its one branch transition; the composer owns BASE selection;
settlement owns artifact retirement.

## Validation

1. Unit: base-absent CREATE P with matching incoming → resolution
   terminal, P consumed as artifact decision, R/P/K reserved; nonmatching
   `nextOid` → today's refusal; advancing P → repair path unchanged.
2. Existing composer suite untouched and green (14/14 baseline).
3. Field acceptance (tag gate), with recorded payload evidence
   (for-each-ref refs/rbox-local/* captured 2026-08-25): FM
   `Dfinitiv/savvy-rewards-network` — three K-next pins equal today's
   incoming main (b432f33a) — is the HEAL expectation; FM
   `Dfinitiv/savvy-core` — no visible pin matches incoming (dd3a409d) —
   is the TYPED-REFUSAL expectation. Gate: each repo resolves OR emits a
   typed refusal naming the true mismatch; a bare "P settlement BASE
   absent" on either fails. Mac `Personal/rbox-admin`: same
   resolve-or-named standard.
4. Differential: repos WITH a BASE and standing Ps keep today's exact
   settlement path byte-identical.

## Non-goals

- No change to design 271's automatic landing/retirement.
- No BASE synthesis anywhere.
- The #832 architecture evaluation stays queued; this fix is another
  evidence entry for it, not a substitute.
