# 180 r6 rulings (fold into v7)

Reviewer: gpt-5.6-sol high, verdict CHANGES-REQUIRED, 7 findings. Rulings:

1. **BLOCKER reconcile-vs-mutation race — ACCEPT (transaction-bound).** Every
   tombstone/claim mutator's transaction conditions on ZERO
   `outcome='attempted'` audit rows for the account (a `NOT EXISTS` predicate
   on every guarded statement — repair execute, repair bootstrap batch, and
   the account purge's `account_keys` deletion at the finishD1 boundary). A
   blocked mutator runs reconciliation, then retries; the check is inside the
   mutating transaction, so no interleaving can strand an attempted row whose
   evidence was destroyed. Interleaving tests for bootstrap, hard purge, and
   future cancel/re-repair.
2. **HIGH crashed dry-run audits — ACCEPT.** `dry_run=1` rows have their own
   reconciliation rule: they never mutate, so a stuck attempted dry-run row is
   completed as `outcome='dry_run_incomplete'` (truthful, no authority
   attaches). Attempted dry-run rows still block mutators (ruling 1's
   predicate is any attempted row) until reconciled — reconciliation is cheap
   and runs on read paths. Tests: crash between dry-run insert and completion
   for eligible AND ineligible results.
3. **HIGH audit permanence vs design-37 erasure — ACCEPT-MODIFIED
   (scrub-on-purge).** On account hard purge, `genesis_repair_audit` rows for
   that account are SCRUBBED, not deleted: original claim bytes and free-text
   operator reason are nulled and replaced by a hash; audit_id, timestamps,
   outcome, dry_run flag, and result vector are retained as the minimal
   compliance record. The privacy/erasure contract section states this
   exemption explicitly and cites design 37. Reconciliation (ruling 1) runs at
   the actual finishD1 boundary, and the design corrects "invoke account
   deletion" to reflect scheduled purge semantics. Tests: purge scrubs but
   retains the minimal record; reconciliation precedes the claim deletion.
4. **HIGH losing device/MK disposition — ACCEPT.** `competing-cleaned`
   quarantines ALL THREE losing artifacts — `rk.key.staged`, `device.json`,
   `mk.key` — via the shared quarantine primitive (one manifest listing all
   three, receipt-authorized before any removal, crash-resumable per the
   existing resume rules). Journal retirement requires the manifest completed.
   Test: after competing-genesis cleanup + journal retirement, `hasDevice` is
   false (or gated) and no losing local enrollment survives.
5. **MEDIUM workspace ownership missing from observation — ACCEPT.**
   `GenesisPresence` gains `workspaces: n` (authoritative registry count,
   versioned observation). Client classifier: a workspace-bearing tombstone →
   `integrity-failure` (matches the server's refusal instead of looping).
   Client/state-machine tests added.
6. **MEDIUM quarantine writer test coverage — ACCEPT.** The injected
   hardened-writer failure matrix (temp-create/write/fsync/close, read-back,
   published-file-fsync, parent-fsync) explicitly extends to
   `quarantine-resume.json` and `completed.json` for BOTH quarantine users.
7. **MEDIUM absent-claim workspace creation — ACCEPT (preserve legacy).** The
   creation guard's predicate is "claim is NOT a tombstone": absent claim OR
   real claim proceeds (current behavior for legacy accounts preserved);
   only a tombstone refuses 423. Specify the predicate, its result vector,
   response, and zero-side-effect test for the tombstone case, plus an
   absent-claim regression test pinning current behavior.
