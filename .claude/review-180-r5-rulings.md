# 180 r5 rulings (fold into v6)

Reviewer: gpt-5.6-sol high, verdict CHANGES-REQUIRED, 8 findings. The pivot
survived: split-read, ACTIVE-conflation, and expiry blockers verified
eliminated. Rulings:

1. **BLOCKER refusal proof impossible — ACCEPT (honest downgrade).** On
   `update=0` the design STOPS promising an exact transaction-bound refusal
   classification. The completion update records `outcome='refused'` plus a
   POST-HOC re-read snapshot explicitly labeled as observational (not proof);
   the wire response is a generic `repair_refused_state_changed` refusal
   carrying the auditId and the observational snapshot. Remove every claim of
   "exact, truthful refusal classification with actual counts"; add the
   concurrent-mutation race test (child inserted between preflight and batch
   → generic refusal, no update, truthful audit).
2. **HIGH all-zero predicate not normative on every statement — ACCEPT.**
   EVERY statement of the repair-bootstrap batch (all three child inserts AND
   the final claim update) carries the complete predicate: exact tombstone
   (repair_id match) AND zero roster/key-state/device/workspace-key/
   pairing-token rows AND zero workspace-registry rows. Add the child-bearing
   tombstone API test (dirty tombstone → whole batch refuses).
3. **HIGH old-client copy false at non-crypto call sites — ACCEPT.** Correct
   the narrative to the verified per-call-site truth: genesis preflight
   reports already-setup (no error); setup offers pair/recovery whose flows
   then fail at verifyDto before any local write; the load-bearing safety
   invariant is stated as: NO old-client path writes or deletes local keys on
   a tombstone (deletion requires the literal 409 already_bootstrapped, and
   tombstone POSTs return 423). Add the table-driven tests over every GET
   consumer (presence-only, admission retry, partial healing, sync pinning,
   423-vs-409 discriminator).
4. **HIGH workspace fencing precedence + side effects — ACCEPT.** Specify:
   the tombstone check runs FIRST in workspace creation — before quota and
   viewer authorization — so 423 has precedence over 402/403; the creation
   batch's every statement (ownership insert, fair-use upsert) is guarded and
   the audit write is suppressed on refusal; for workspace-sync the fence is
   defense-in-depth (a LEGAL tombstone owns no workspaces, so authorization
   404s first) placed before DO forwarding for the anomalous
   workspace-bearing case. Tests: tombstoned + over-quota → 423; tombstoned
   viewer → 423; refusal leaves zero fair-use/audit/DO side effects.
5. **HIGH reconciliation erasable by tombstone mutators — ACCEPT.** New
   invariant: every tombstone mutator (repair bootstrap, account deletion,
   future cancel/re-repair) MUST first run attempted-audit reconciliation for
   that account and complete any stuck rows before mutating/deleting the
   tombstone or claim. Account deletion's design impact is named explicitly
   (account-delete flow gains the reconciliation step). Test: update=1 crash
   before completion → account deletion first reconciles the audit to its
   true outcome, then deletes.
6. **HIGH quarantine durability underspecified — ACCEPT.** Add the quarantine
   directory chain, `quarantine-resume.json`, and `completed.json` to the
   hardened writer contract's applicability list verbatim (ancestor
   publication, temp file, file fsync, rename, read-back, parent fsync).
   Replace the loose publish/fsync language in the quarantine section with a
   reference to that contract. Add the enumerated test cases: manifest/marker
   parser failures, ancestor fsync loss, empty-current-dir recovery,
   nonempty manifest-less dir, duplicate/different keys, both-present and
   both-absent entries, unexpected names/types, completed-to-manifest hash
   mismatch — for BOTH quarantine users.
7. **MEDIUM completion-intent target/authorization gaps — ACCEPT.** kit-path
   intent persists the RESOLVED ABSOLUTE path (resolved at selection time,
   before intent publication); test a cwd change across restart. Add negative
   tests: a structurally valid intent must not cause phrase display, Keychain
   add, or file output under tombstone/competing/indeterminate/
   integrity-failure classifications.
8. **LOW stale version references — ACCEPT.** 179:40 says "v9" → "v10";
   180:1249's "v2 classifier/journal" reconciled with the v1 schema naming
   (the capability is the version boundary, schemas stay v1 — pick consistent
   wording).
