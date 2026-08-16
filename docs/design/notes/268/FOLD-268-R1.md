# Fold order — 268 implementation review r1 (codex CODEX-268-IMPL-R1.md + opus, synthesized rulings)

Process: bun run test:affected per fix; full suite once at end; lint:affected zero new warnings; no suppressions. state-cas-locks.ts is at 499/500 nonblank — if any fix pushes it over, decompose a coherent concern (never shave, never re-pin).

## CRITICAL-1 (opus): v2 journal busts its 1 MiB cap at FM scale → permanent pull wedge
- Restructure acquisition records: do NOT repeat lockPath+marker; reference the header allowlist by ordinal (record = {ordinal, observation} / {ordinal, blocked, holderMarker}). Parser binds ordinal→header entry; out-of-range/duplicate ordinal = whole-journal indeterminate.
- Enforce the bound at prepareStateCasLocks from N BEFORE publishing anything (fail-closed, actionable error naming N and the bound).
- v2 gets three DISTINCT bounds (per design §M1): per-line, record-count, total-bytes — sized so N=4096 realistic refs fits with ≥2x headroom. v1 load-side 1 MiB refusal unchanged.
- New test: N≈2000 realistic long ref names (refs/remotes/origin/feature/...) round-trips acquire+parse well under bound; plus a prepare-time refusal test above the derived N cap.

## CRITICAL-2 (codex): double-release deletes retained authority — ONE OWNER ruling
- acquirePreparedStateCasLocks returns a SINGLE-USE handle owning release (handle.release(options?)); on acquisition failure NO handle exists — internal cleanup runs exactly once, journal retirement decided ONLY by the existing fine-grained `exact` computation (flush failure → not durable → retained; clean abort e.g. shutdown gate → exact → retired, fixing opus M2's journal leak).
- DELETE the retainJournal option entirely (opus M2: redundant + coarse). No acquireFailed flags anywhere — the invalid second release must be unrepresentable, not guarded.
- received-git-transition-commit.ts finally: release via the handle only. Add the production-wrapper failure test codex reproduced (batch-finalization failure through withRevalidatedGitPartialApplies → journal RETAINED, links cleaned, and the parent dirs of cleaned links re-fsynced before any later retirement).

## MAJOR (opus M1): absent-parent recovery arm
- Replace the indeterminate-forever arm (state-cas-locks.ts:366-369) with the design's semantics: for a dead-owner non-blocked entry whose parent dir is absent, fsync the NEAREST EXISTING ancestor (bounded inside the common dir), then treat as released/retirable. Never a permanently unclearable state. Test: dead owner + pruned ref subdir → pass 1 retires the journal, indeterminate 0.

## MAJOR (opus M3): forged-journal tests
- Append "\n" in the three forged fixtures AND add the negative control: re-stringified UNMODIFIED journal with newline must PARSE (proves the forgery checks, not the EOF rule, produce undefined).

## MINOR fixes (all)
1. EOF-pop dead branch (state-cas-journal.ts:191-193): single pop with a comment stating the one-suffix rule.
2. Receipt ceremony → what it proves: replace brand+WeakMap+consume with a #flushed flag + existing #used single-use guard on the batch object; appendLocked takes the batch and asserts flushed. Update design §M2.2 wording accordingly.
3. casStepMs unit-mixing: counts move to a sibling casCounts detail ({locks, blocked}); format.ts renders from it; step→ms map stays pure.
4. formatCasSteps: omit locks/blocked fragment when there was no CAS (no git repos) — restore conditional emptiness.
5. Drop dead PreparedStateCasLocks.root field.
6. #ensureOpen returns the handle (no assertion); MAX_LINE_BYTES gets a real value distinct from total; drop MAX_RECORDS if implied or make it meaningful; ternary-as-statement → if/else.
7. Old-binary compat test: use the REAL parseV1 from the module against a v2 document → undefined → retained fail-closed (delete the 3-line JSON.parse stand-in); name it honestly.
8. Scope the lockfile staged-token/readback hardening (lockfile.ts:1227,1378) behind the CAS opt-in (hook/batch presence) so acquireLock/acquireFence behavior is byte-identical to origin/main (codex MINOR; broadening is a separate founder approval).
9. Revert the format.ts:24 typeof drive-by (267's line, untested change) unless a test pins it.

## Design-doc amendments (do them)
- §M1: ordinal-referenced acquisition records + the three real bounds + prepare-time N refusal.
- §M2: handle-owns-release, retainJournal deleted, exact-decided retirement (one owner per physical effect); receipt simplified.
- §M2.5: absent-parent ancestor-fsync clearing rule.
