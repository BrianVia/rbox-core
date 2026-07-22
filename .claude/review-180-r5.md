Verdict: **CHANGES-REQUIRED**

The pivot genuinely eliminates the split-read, ACTIVE-conflation, and expiry fail-open mechanisms. Retained-archive legality is fixed at the state-machine level, but its crash-safety proof is incomplete and relocates that blocker into underspecified quarantine durability.

| Round-4 blocker | Result |
|---|---|
| Split-read race | Eliminated: the claim remains one row, and replacement is conditional on the exact tombstone. |
| ACTIVE conflation | Eliminated: audit state no longer grants authority or participates in fencing. |
| Expiry fail-open | Eliminated: the tombstone has no expiry. |
| Retained-archive illegality | Conceptually fixed, but not fully proved across marker-publication crashes; see finding 6. |

1. **BLOCKER — The two-statement execute batch cannot produce its promised transaction-bound refusal proof.**

   Statement 1 stores the preflight proof and an exact snapshot of only the account claim; statement 2 independently evaluates dependent counts and workspace ownership ([design 180:935](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:935), [design 180:947](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:947)). Therefore `update=0` proves only that some predicate failed. It cannot support the promised exact, truthful refusal classification and actual counts ([design 180:964](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:964), [design 180:1055](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:1055)) when a child or workspace changes between preflight, batch execution, and any post-batch observation.

   The safe update itself remains conditional, but the audit/response contract is impossible with the recorded evidence. Capture the decisive inventory/ownership snapshot transactionally, or return a generic concurrent-state refusal. The tests at [design 180:1393](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:1393) do not cover this race.

2. **HIGH — “Exact tombstone expected previous” does not explicitly include the authoritative all-zero state.**

   The database tombstone shape is defined principally by `account_keys` columns, while child-bearing tombstones are separately called integrity failures ([design 180:548](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:548)). The repair-bootstrap batch says each child insert requires the “same exact tombstone,” but the final update only expressly requires the three newly inserted children ([design 180:780](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:780)). It does not normatively repeat zero extra roster, key-state, device, workspace-key, pairing-token, and workspace-registry rows.

   Client classification catches a dirty tombstone, but the server must independently refuse it. Require the complete all-zero/no-workspace predicate in every child insert and the final claim update. The API atomicity tests test wrong/stale `repairId`, not a child-bearing tombstone ([design 180:1356](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:1356)).

   Once that predicate is explicit, concurrent capable clients are sound: D1 batches execute sequentially and transactionally, so one client replaces the tombstone and a competitor writes nothing; identical payloads may pass exact-field idempotency, while different payloads conflict. [Cloudflare D1 batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)

3. **HIGH — The asserted old-client behavior is false at several real call sites, although key preservation currently holds.**

   The current transport does no DTO validation beyond `JSON.parse()` and a TypeScript cast ([remote/keys.ts:21](/home/via/Development/Personal/rbox-core/src/cli/remote/keys.ts:21)). Consequently:

   - Genesis preflights only test object truthiness and return `already-setup`, without parsing or chain verification ([auth-cmd.ts:128](/home/via/Development/Personal/rbox-core/src/cli/auth-cmd.ts:128), [auth-cmd.ts:175](/home/via/Development/Personal/rbox-core/src/cli/auth-cmd.ts:175)).
   - Setup branches on `accountKeys === null`; a tombstone is treated as an existing account and pair/recovery is offered ([setup-cmd.ts:522](/home/via/Development/Personal/rbox-core/src/cli/setup-cmd.ts:522)).
   - Only the cryptographic consumers reject the empty chains at `verifyDto` ([e2ee-client.ts:89](/home/via/Development/Personal/rbox-core/src/cli/e2ee-client.ts:89)).

   Thus [design 180:460](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:460) and the test oracle at [design 180:1376](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:1376) incorrectly promise a verification/transport error for every old client.

   The important safety claim does survive current code inspection: pairing, recovery, agent admission, partial-keystore healing, and sync verification fail before their following local-key writes; the admission-retry GET occurs after a pre-existing save but performs no new save on the tombstone. The sole deletion path is the literal `409 already_bootstrapped` branch ([auth-cmd.ts:134](/home/via/Development/Personal/rbox-core/src/cli/auth-cmd.ts:134), [e2ee-keystore.ts:141](/home/via/Development/Personal/rbox-core/src/cli/e2ee-keystore.ts:141)); the proposed tombstone POST returns 423, so it is not reached.

   Add table-driven tests for every GET consumer, including presence-only behavior, admission retry, partial healing, sync pinning, and the 423-versus-409 deletion discriminator.

4. **HIGH — Workspace 423 fencing is incomplete against the real route ordering and batch side effects.**

   Workspace creation currently performs quota checks before `createWorkspace` ([routes/account.ts:37](/home/via/Development/Personal/rbox-core/apps/api/src/routes/account.ts:37)), and `createWorkspace` performs viewer authorization before its insert ([authz.ts:93](/home/via/Development/Personal/rbox-core/apps/api/src/authz.ts:93)). A tombstoned over-quota or viewer account can therefore return 402/403 rather than the unconditional 423 promised by [design 180:925](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:925).

   Moreover, the creation batch contains an unconditional fair-use queue upsert ([authz.ts:99](/home/via/Development/Personal/rbox-core/apps/api/src/authz.ts:99), [fairuse.ts:24](/home/via/Development/Personal/rbox-core/apps/api/src/fairuse.ts:24)). Guarding only the ownership insert can still mutate fair-use state, and the following audit must also be suppressed.

   Workspace-sync authorization likewise runs before DO forwarding ([routes/sync.ts:22](/home/via/Development/Personal/rbox-core/apps/api/src/routes/sync.ts:22)). Because a legal tombstone owns no workspace, an “immediately before DO” check alone is normally unreachable: authorization returns 404 first.

   Specify status precedence and ensure workspace, fair-use, audit, and DO effects are all absent. Extend tests with role/quota cases and side-effect assertions.

5. **HIGH — Attempted-audit reconciliation proof can be erased by an unguarded tombstone mutator.**

   Reconciliation infers success from the matching tombstone or refusal from the unchanged original snapshot, and only repair bootstrap is required to reconcile before replacing the tombstone ([design 180:971](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:971)). Real account deletion removes `account_keys` ([account-delete.ts:351](/home/via/Development/Personal/rbox-core/apps/api/src/account-delete.ts:351)).

   If repair commits `update=1`, crashes before its completion update, and account deletion or future cancel/re-repair then changes the row, the original outcome becomes unrecoverable. Require reconciliation before every tombstone mutation/deletion, or record the vector atomically inside the execute transaction. No listed test covers this interleaving.

6. **HIGH — Retained-archive safety is relocated into an underspecified quarantine durability seam.**

   The hardened writer contract’s explicit applicability list omits the quarantine directory chain, `quarantine-resume.json`, and `completed.json` ([design 180:366](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:366)). The quarantine section uses less exact “publish/fsync/read-back” language ([design 180:686](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:686)).

   If `completed.json` is acknowledged but its directory entry is lost after tombstone replacement, the retained archive again appears incomplete beside a real claim. Explicitly apply the complete ancestor publication, temp-file, file-fsync, rename, read-back, and parent-fsync contract to both quarantine users.

   Tests currently cover coarse crash boundaries but not the primitive’s full declared failure space for both purposes ([design 180:1310](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:1310)). Missing cases include manifest/marker parser failures, ancestor fsync, empty-current-directory recovery, nonempty manifest-less directories, duplicate/different keys, both-present/both-absent entries, unexpected names/types, and completed-to-manifest hash mismatch.

7. **MEDIUM — Completion intent binds the attempt correctly, but explicit-file target and authorization-state binding remain incomplete.**

   `version`, account, and fresh request digest correctly bind the journal and transitively its device and `repairId` ([design 180:343](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:343)). Keychain identity is explicitly resolved, but `kit-path` is merely the “exact selected path” ([design 180:333](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:333)). Current code resolves relative paths at write time using the current working directory ([recovery-kit.ts:184](/home/via/Development/Personal/rbox-core/src/cli/recovery-kit.ts:184)); a restart from another directory can therefore target a different file. Persist a resolved absolute target before publishing intent and test a cwd change.

   Also add negative tests proving that even a structurally valid intent cannot cause phrase display, Keychain add, or file output under tombstone, competing, indeterminate, or integrity-failure classifications. The normative state machine gates this, but the current test list does not.

8. **LOW — Two fold/version references are stale.**

   Design 179 is v10 but still calls itself “this v9 seam amendment” ([design 179:40](/home/via/Development/Personal/rbox-core/docs/design/179-recovery-kit-macos-keychain.md:40)). Design 180 specifies v1 journal/intent schemas but release order calls for a “v2 classifier/journal” ([design 180:1249](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:1249)).

No stale normative permit, witness-exposure, expiry, or anomaly-vector mechanism remains outside the historical ruling records. Current “witness” references correctly mean the tombstone itself, and current anomaly references expressly reject the old machinery.

No files were edited.

WORK-COMPLETE