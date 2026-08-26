# SPEC — implement design 286 v2 (fix #831)

Authority: docs/design/286-standing-p-as-manual-landing-receipt.md (v2) +
docs/design/notes-286-diagnosis.md. The v2 "Constraints from the
adversarial round" block is NORMATIVE — every bullet is an acceptance item.

## Order of work

1. **Preflight receipt classification** (`src/cli/git/resolve-artifacts.ts`):
   in the settle loop, when `settleExactPresentArtifact` returns the
   `base-absent` hold code for a CREATE-shaped P, do not refuse — classify
   as a candidate receipt IF AND ONLY IF: P/K scan-valid, the receipt
   ref's own live value === P.nextOid, exact reflog episode top, and
   `incoming.refs[ref] === P.nextOid`. Otherwise keep the hold refusal
   with copy naming ref + the actual mismatch (live vs nextOid vs
   incoming). ALL standing Ps must be classified before `ready` is
   returned (no `[0]`-short-circuit: iterate the full set; one refusal
   refuses the whole preflight, naming every offending ref).
   Return the receipts on the ready result.
2. **Witness injection**: thread the receipts into the take-theirs follow
   options so each receipt ref gains a `branchWitnesses[ref]` (CREATE
   shape, `priorOid: null`, `nextOid`) + `branchLockedProofs[ref]`
   consistent with what `commitPlannedBranchTransition` would produce
   (see `branch-transition.ts:285+` manual shape) — this is NEW plumbing
   for side branches (publication yields nothing when `opts.base` is
   undefined); place it where publication merges witnesses so downstream
   is uniform.
3. **Precedence flip** (`src/cli/git/resolve-take-theirs.ts:145-175`):
   witness-derived decisions win — process `manualBranchTerminals` FIRST
   and let the `branchWitnesses` loop run after (or guard the terminal
   loop with `if (branchDecisions[ref]) continue` in whichever order is
   smaller) so a receipt's artifact decision is never clobbered by a
   no-op terminal. In `ref-plane-transaction.ts`, skip minting the #830
   no-op terminal for a ref that has a receipt witness.
4. **Reservation**: every receipt's R (branch ref), P ref, and K-next ref
   join the existing reservation loop (`ref-plane-transaction.ts:~236`)
   with their expected oids, so the checkout CAS (`checkout-txn.ts:798-816`)
   aborts on any movement.
5. **Composer**: UNCHANGED (its artifact arm already accepts
   `beforeBaseOid: null` with a valid witness).
6. **Post-landing**: the existing settlement call
   (`resolve-take-theirs.ts:~294`) now retires the consumed P (BASE
   exists). If retirement fails post-landing, the typed artifact outcome
   is reported with copy telling the user a rerun completes the cleanup.

## Tests (bun test <file>; scratchpad wrapper if the guard refuses)

- resolve-artifacts (new/extended): base-absent CREATE P matching on all
  four conditions → ready with receipt; live≠nextOid → refusal naming the
  ref (no collision path); incoming≠nextOid → refusal naming both oids;
  TWO standing Ps, one matching one not → whole preflight refuses naming
  the nonmatching ref (all-or-refuse).
- resolve-take-theirs/ref-plane-transaction: receipt on the CURRENT
  branch → artifact decision reaches the composer (assert the decision
  kind is "artifact", NOT "no-p"), R/P/K reserved, resolution terminal;
  receipt on a SIDE branch → same; #830 no-op terminal still minted for
  refs WITHOUT receipts (differential).
- Existing suites: `bun test src/cli/sync-git src/cli/git` green;
  composer suite untouched.
- `bun run typecheck` + `bun run lint:affected` zero new warnings; fix
  ALL anti-slop warnings in files you touch (house rule).

## Acceptance

- No behavior change for repos WITH a BASE (their Ps settle exactly as
  today — differential test).
- DO NOT touch: p-settlement.ts's guard semantics for the automatic path,
  design-271 landing/retirement, apply.ts routing, anything under apps/.
- Module size caps: 400 nonblank lines/file — restructure if a file
  approaches it.

## Style

Comments only for inexpressible constraints. Match surrounding idiom.
