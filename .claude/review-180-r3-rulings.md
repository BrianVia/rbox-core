# 180 r3 rulings (fold into v4; findings 2, 3, 9 also touch 179)

Reviewer: gpt-5.6-sol high, joint 179+180 round, verdict CHANGES-REQUIRED,
9 findings. Rulings:

1. **BLOCKER old client destroys legacy pair before the 428 — ACCEPT.** The
   fence moves to PREFLIGHT: while a repair permit is ACTIVE,
   `GET /v1/keys/account` returns `423 repair_in_progress` to any request
   WITHOUT `x-rbox-genesis-capability: 1`; capable clients send the header on
   the GET too and receive the presence body. An old client's account fetch
   therefore throws before it generates or saves anything (remote/keys.ts:21
   collapses only 404; 423 propagates as an error and the old transport does
   not retry non-5xx). The 428 on POST remains as defense-in-depth. Document
   the old-client UX: the command fails with the server's error message;
   permits are short-lived so the window is operator-controlled.
2. **HIGH competing-cleaned can promote the losing RK — ACCEPT.**
   `competing-cleaned` ALWAYS quarantines (never promotes, never bare-unlinks)
   the losing staged RK regardless of cache preference; 179's promotion rule
   explicitly excludes competing-cleaned. Promotion (in the winning/ordinary
   path) requires exact validated destination `rk.key` bytes before journal
   retirement; a promotion-intent journal where BOTH source and valid
   destination are absent is `integrity-failure`, never silent success.
   Amend both docs.
3. **HIGH completion selection not durable — ACCEPT.** New small durable
   `completion-intent` record (own file beside the journal, same durability
   contract), written BEFORE attempting the selected commitment:
   `{ mode: "phrase-display" | "keychain" (with resolved identity) |
   "kit-path" (with exact path), intentAt }`. Resume with an intent record
   resumes that exact selection per 179's rules. Resume WITHOUT one (crash
   before selection was durably recorded) uses a deterministic, user-visible
   reselection protocol: re-present the completion options with the phrase
   reconstructable from rk.key.staged — the docs must NOT claim original
   selection is resumed in that case. Amend both docs.
4. **HIGH quarantine not crash-closed — ACCEPT.** Executable witness-bound
   `quarantine-resume` contract: quarantine dir name embeds the witness
   auditId (uniqueness: at most one per auditId; more → integrity-failure);
   manifest written FIRST with exact source file hashes; archival then renames
   each source; resume rule: for each manifest entry, the file is either
   still at source with matching hash (rename it) or already in quarantine
   (done) — anything else → integrity-failure. Only after all entries resolve
   does classification proceed as pristine. Extra-artifact classification
   carves out exactly this manifest+quarantine shape.
5. **HIGH stale witness = downgrade authority — ACCEPT.** The repair witness
   is exposed and accepted ONLY while its exact repair permit is ACTIVE.
   Permit consumption or expiry ends witness authority (wire stops exposing
   it; classifier treats witness-less claimless/unmarked states as
   integrity-failure exactly as before the repair). The permanent audit row
   remains, but it is an operator record, not client-visible mutation
   authority.
6. **HIGH impossible race meanings in result vectors — ACCEPT.** Inside the
   single ordered transactional batch the only normal vectors are `1/1/1`
   (success) and `0/0/0` (refused). `1/1/0` and `1/0/0` are INTEGRITY
   ANOMALIES: completion update records `outcome='anomaly'`, the route
   returns a 500-class error with the auditId, and escalation is manual. No
   race semantics inside the transaction.
7. **MEDIUM fence lookup doesn't exist — ACCEPT.** Reword: the commit fence
   is a NEW claim/permit check performed by the sync route immediately before
   DO forwarding (authz.ts reads workspaces only; sync.ts:36 reads key epoch
   only — neither is the fence).
8. **MINOR CODEMAP cite — ACCEPT.** Reword to "will own" (future state), keep
   the required-CODEMAP-update item.
9. **MINOR 179 test-coverage cite — ACCEPT.** Correct the claim: existing
   tests cover wrong phrase against the correct envelope only; the new test
   list gains explicit wrong/historical-envelope substitution coverage.
   Amend 179.
