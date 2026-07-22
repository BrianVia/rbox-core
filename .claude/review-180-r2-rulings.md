# 180 r2 rulings (fold into v3)

Reviewer: gpt-5.6-sol high, verdict CHANGES-REQUIRED, 11 findings (full text in
the r2 review output; fold-audit table: r1-4/7/8/9 closed, 1/2/3/5/6 partial or
not closed). Rulings:

1. **BLOCKER repair strands the real legacy orphan — ACCEPT.** Add a durable,
   client-observable repair witness: the wire presence payload (the same
   endpoint the classifier reads) exposes `repairedAt`/`auditId` for an
   account whose claim was operator-deleted (sourced from the permanent audit
   table). New classifier rule: claim absent + zero presence counts + server
   repair witness + UNMARKED partial local material (the exact legacy shape:
   device.json/mk.key present, no journal/marker/staged RK) → `repaired-legacy`
   state whose action is: archive-and-remove the local partial material
   (rename into a timestamped quarantine dir under the keystore, never
   unlink-only), then proceed as pristine. Without the server witness the
   state stays `integrity-failure`. The end-to-end repair test MUST seed the
   real orphan (old-flow local device/MK, no journal/no staged RK), not a
   journaled one; fix line ~872's test accordingly.
2. **BLOCKER delete predicate contradiction — ACCEPT.** The delete statement's
   predicate requires "the ONLY existing permit is the exact newly inserted
   permit/audit pair" (permit count = 1 AND that permit's id matches the new
   `permit_id`/`audit_id`), NOT the no-permit condition. Only the
   audit-insert + permit-insert statements carry the no-pre-existing-permit
   condition. Rewrite the result-vector table accordingly (`1/1/0` becomes
   the signature of a lost race to a concurrent permit, handled by refusal).
3. **HIGH cleanup crash states classified corrupt — ACCEPT.** (a) Once a
   durable receipt exists, the journal enters a terminal `cleanup` phase in
   which absent staged RK / absent local staging artifacts are LEGAL and
   cleanup resumes idempotently; classification treats receipt-bearing
   journals as `cleanup-resume`, never `integrity-failure`. (b)
   competing-genesis: durably record the `competing-cleaned` authorization
   BEFORE any destructive removal; crash between authorization and removal
   resumes removal. (c) Prepublication cleanup is marker-last: the marker is
   removed only after every other staged artifact is gone.
4. **HIGH authoritative DO commits invisible — ACCEPT-MODIFIED.** Two parts:
   (a) repair eligibility narrows: refuse any account that owns ANY workspace
   in the authoritative workspace registry (wedged-genesis accounts are
   brand-new; a workspace means real history may exist in DO state that D1
   cannot prove empty) — this is the battle-tested-primitive answer, no DO
   enumeration protocol; (b) forward fence: workspace-sync commit acceptance
   requires an existing account claim (and no active repair permit) via the
   sync route's existing account lookup, so claim-less accounts can never
   accrue authoritative history again. Document that pre-existing claim-less
   DO history is out of repair scope (integrity-failure, manual escalation).
5. **HIGH completion hold bypassable — ACCEPT.** A shared pending-genesis gate
   at the common E2EE-loading boundary (`buildAuthedRemote`/keystore load):
   while a journal with an unreleased completion hold exists, every
   E2EE-consuming command refuses with the resume instruction (finish setup /
   view-and-confirm the recovery phrase). Explicit allowlist for read-only
   diagnostics (status/doctor-style commands) which display the pending state
   instead. Export's independent `hasDevice` shortcut consults the same gate.
   Whole-command tests for at least one gated command (sync) + one
   allowlisted (status).
6. **MAJOR 179/180 staged-RK divergence — ACCEPT.** 180 OWNS the staged-RK
   artifact and its lifecycle (creation, durability, completion hold,
   cleanup). Fold a "Seam with design 179" section: 179's non-interactive
   macOS staging reuses `rk.key.staged` (no second staging record); 179's
   cache-preference restoration and keychain locator reconciliation layer ON
   TOP of the same artifact; crash migration is defined solely by 180's
   journal phases. ALSO amend docs/design/179-recovery-kit-macos-keychain.md:
   replace its separate staging-record mechanism with a reference to 180's
   `rk.key.staged` + a short delta of what 179 adds (cache preference,
   keychain save); bump its Status line to note "v8 — seam amendment per 180
   r2-6". Keep the 179 edit minimal and surgical.
7. **MAJOR durability overclaims — ACCEPT-MODIFIED (weaken + document, don't
   build).** State the failure model explicitly: the contract guarantees
   process-crash safety on all platforms and power-loss/kernel-crash safety
   on Linux (file fsync + directory fsync); on macOS ordinary fsync is used
   and the power-loss residual is DOCUMENTED (F_FULLFSYNC via native call is
   an optional future hardening, not required — the enrollment window is
   seconds). The no-symlink check is lstat-based, best-effort, and NOT
   race-resistant; state that residual instead of claiming elimination.
8. **MAJOR version gate breaks dev validation — ACCEPT.** Replace the
   min-version compare with a protocol capability header
   `x-rbox-genesis-capability: 1` sent by every client that implements the v2
   classifier/journal (dev builds included). Permit-consuming bootstrap
   requires the header; absence → 428-style refusal naming the capability.
   Keep `x-rbox-version` purely informational here.
9. **MAJOR audit outcome crash-consistency — ACCEPT.** Audit state machine:
   the batch inserts the audit row with non-null `outcome='attempted'`;
   after the batch, an idempotent completion UPDATE sets the final outcome
   from the result vector (+ `completed_at`). A row stuck at `attempted` is
   truthful and reconcilable: a follow-up read of claim/permit state
   determines what happened; the dry-run/read path performs that
   reconciliation opportunistically and completes the row. `1/0` vectors are
   recorded by this same completion update.
10. **MEDIUM missing wire version — ACCEPT.** Both 404 and 200 bodies carry
    required `genesisPresenceVersion: 1`; parser rejects unknown versions.
11. **MINOR stale cite — ACCEPT.** Fix `e2ee-client.ts:84-89` → `:92`.

Also: keep the reviewer-endorsed idempotency/TOCTOU analysis paragraph as a
pinned note in the doc (it certifies the branch that survived review).
