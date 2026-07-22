# 180 r1 rulings (fold into v2)

Reviewer: gpt-5.6-sol high, verdict CHANGES-REQUIRED, 9 findings
(REVIEW-180-R1.md). Rulings by the orchestrating session:

1. **BLOCKER phrase-loss across restart — ACCEPT.** Every bootstrap gets a
   durable pre-POST RK foothold: the RK (or its phrase-recoverable encoding)
   is written to a staged keystore artifact (align naming/mechanism with
   design 179's staged-RK no-loss invariant — `rk.key.staged` or equivalent)
   with the hardened durability contract from ruling 2, BEFORE journal
   publication and BEFORE the POST. The enrollment is not "complete" until
   phrase delivery to the user succeeds OR a durable RK artifact is committed;
   a restart in between classifies as resume-attempt and can re-present the
   phrase from the staged artifact. Cleanup of the staged artifact happens
   only after that completion hold releases. Tests must cover crash before
   POST, crash after commit before response, crash after response before
   phrase display.
2. **HIGH journal stronger than key files — ACCEPT.** `writeSecret` (and
   directory creation) gains atomic same-directory rename + file fsync +
   directory fsync, applied to `device.json`, `mk.key`, staged RK, and the
   journal alike; device/MK durability is sequenced BEFORE journal
   publication, which is before POST. Injected durability-failure tests.
3. **HIGH classifier blind to child-only states — ACCEPT.** The wire endpoint
   (`GET /v1/keys/account`) exposes child-table presence even when
   `account_keys` is absent (e.g. 404 body gains `{present: {devices: n,
   roster: n, keyState: n, ...}}` or a dedicated classifier endpoint —
   designer's choice, but the classifier must observe child-only corruption
   and classify it `integrity-failure`, never `pristine`/`resume-attempt`).
4. **HIGH entry points bypass classifier — ACCEPT.** A valid pending journal
   overrides EVERY local-enrolled shortcut: setup's `enrolledAccountId` gate,
   `resolveEnrollment` early return, front-door routing, and `init --bootstrap`
   auth selection all consult the journal/classifier first. Whole-command
   restart tests (not just inner-seam tests) for setup, init --bootstrap, and
   bare rbox.
5. **HIGH old-CLI transition unsafe — ACCEPT, reviewer's preferred option.**
   Server-side exact-field idempotency: bootstrap POST returns 200 (treated as
   success) when the committed genesis exactly matches the replayed payload
   field-for-field; 409 `already_bootstrapped` remains only for genuine
   mismatch. Permit-consuming bootstrap additionally requires a minimum
   `x-rbox-version` (capability gate) so old clients cannot consume a repair
   permit and then self-destruct local keys on a lost-response retry.
6. **HIGH repair runbook not executable — ACCEPT.** Specify a concrete
   authenticated operator surface: platform-secret admin route under
   `apps/api/src/routes/admin.ts` conventions (authz.ts:69 pattern), with
   request schema (accountId + operator + reason), dry-run mode returning the
   classification + SQL-proof result, and a PERMANENT audit write to a
   dedicated audit table (survives permit consumption — the permit row is no
   longer the audit record). Runbook lists the exact curl/script invocation
   for prod.
7. **HIGH malformed-claim orphan shape — ACCEPT.** "Exact legacy orphan"
   classification AND both SQL predicates require the precise old-endpoint
   claim shape (nonempty recovery_wrap, recovery_wrap_id, created_at);
   anything else → `integrity-failure` (manual path), never auto-repair.
8. **MAJOR no-journal enrolled verification — ACCEPT.** Strengthen "complete"
   for no-journal classification: recovery-wrap hash/ID binding against the
   signed chain, explicit device-row parsing, roster membership/lifecycle
   rules, wrap authorization — not just `verifyAccount` chain validity.
9. **MEDIUM pairing-token N=1 co-location — ACCEPT (pin, don't build).** Pin
   N=1 single-database co-location as a stated prerequisite and an explicit
   sharding blocker in the design's invariants section; no cross-plane fence
   protocol now.

Also fold the reviewer's closing note: the server invariant is worded
"all-or-none co-presence"; cryptographic mutual consistency remains a
client-classifier guarantee (API stores opaque signed envelopes).
