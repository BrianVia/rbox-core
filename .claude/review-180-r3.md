## Fold audit

| R2 finding | Disposition |
|---|---|
| 1 repaired-legacy witness | Partial — quarantine intermediate states and stale-witness authority remain unsafe. |
| 2 delete predicate/vector | Partial — predicate is repaired, but vector meanings contradict the transaction model. |
| 3 cleanup crash legality | Partial — cleanup phase exists, but RK disposition is not outcome-safe. |
| 4 workspace eligibility/fence | Mostly closed — required fence is specified, but the claimed existing lookup does not exist. |
| 5 E2EE boundary gate | Closed. |
| 6 design-179 seam | Partial — single ownership is stated, but target persistence and cleanup rules still disagree. |
| 7 durability model | Closed. |
| 8 capability header | Partial — header protocol is present, but it does not protect old local keys before POST. |
| 9 attempted→completed audit | Partial — state machine exists, but result-vector semantics are unsound. |
| 10 presence wire version | Closed. |
| 11 citation correction | Closed. |

## Findings

1. **BLOCKER — the 428 refusal arrives after an old client has already destroyed the repaired legacy pair.**

   Design 180 claims that 428 preserves old-client local keys because only `already_bootstrapped` triggers cleanup ([180:553](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:553)). That is only true after POST.

   An old client collapses the repaired account’s 404 to `null` ([remote/keys.ts:21](/home/via/Development/Personal/rbox-core/src/cli/remote/keys.ts:21)), generates new keys, and calls `saveDevice` before POST ([e2ee-client.ts:110](/home/via/Development/Personal/rbox-core/src/cli/e2ee-client.ts:110)). `saveDevice` replaces both files ([e2ee-keystore.ts:93](/home/via/Development/Personal/rbox-core/src/cli/e2ee-keystore.ts:93)) through truncating `fs.writeFile` ([e2ee-keystore.ts:40](/home/via/Development/Personal/rbox-core/src/cli/e2ee-keystore.ts:40)). Only afterward does bootstrap return 428.

   The exact witnessed legacy `device.json`/`mk.key` pair is therefore overwritten before the refusal. The permit must fence old clients during preflight—before generation or local publication. A non-404/non-200 account response would already make the old transport stop without mutating local keys.

2. **HIGH — `competing-cleaned` can promote the losing RK into `rk.key`.**

   Design 180 correctly says the losing phrase must never be treated as the account recovery phrase, but its generic cleanup rule permits staged-RK promotion after any receipt ([180:215](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:215), [180:225](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:225)). Design 179 likewise says cleanup promotes whenever `originalCacheRecovery` is true, without excluding `competing-cleaned` ([179:193](/home/via/Development/Personal/rbox-core/docs/design/179-recovery-kit-macos-keychain.md:193)).

   That would cache an RK cryptographically unrelated to the winning genesis. `competing-cleaned` must always remove or quarantine the losing RK, never promote it, regardless of cache preference.

   The cache-true crash case is also under-specified: cleanup treats an absent staged file as legal, but after a promotion attempt it must require exact validated `rk.key` destination bytes before retiring the journal. Absence of both source and valid destination cannot mean successful preference restoration.

3. **HIGH — the selected recovery-kit completion action is not durable.**

   The strict journal stores the request, cache preference, generic hold, and receipts, but no completion mode, explicit path, or resolved Keychain identity ([180:183](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:183)). Nevertheless, the resume handler promises to finish “the selected artifact commitment” ([180:500](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:500)).

   Design 179 requires resuming a selected Keychain or `--kit-path` save and retaining the hold after failure ([179:193](/home/via/Development/Personal/rbox-core/docs/design/179-recovery-kit-macos-keychain.md:193), [179:614](/home/via/Development/Personal/rbox-core/docs/design/179-recovery-kit-macos-keychain.md:614)). If the process crashes before `kit.json` locator publication, neither document preserves what was selected. A later plain `rbox setup` cannot know whether to re-present the phrase, resolve Keychain, or retry a specific explicit path.

   The immutable pre-POST journal needs a strict completion intent/target, or the documents need a deterministic, user-visible reselection protocol that does not claim to resume the original selection.

4. **HIGH — repaired-legacy quarantine is not closed under its own crash states.**

   `repaired-legacy` requires the exact top-level `device.json` plus `mk.key` pair and no other partial material ([180:397](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:397)). Archival then creates a manifest and performs two renames ([180:457](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:457)).

   After a crash following manifest creation or the first rename, the required classifier shape no longer exists; there is now an extra quarantine artifact and possibly only one source file. The document simultaneously classifies extra local artifacts as integrity failure ([180:471](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:471)).

   A witness-bound `quarantine-resume` state must define manifest discovery, uniqueness, source/destination combinations, exact identity validation, and completion. The current prose assertion of resumability is not executable.

5. **HIGH — the permanent repair witness becomes stale downgrade authority.**

   The latest successful witness remains exposed after permit consumption ([180:371](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:371)). If the subsequently repaired genesis later disappears because of corruption, administrative deletion, or inconsistent restoration, that historical witness again converts an otherwise fatal claimless/unmarked state into automatic key quarantine and fresh genesis.

   This conflicts with the stated rule that unrelated claim disappearance is an integrity incident. The witness should be bound to the current repair generation—most simply, exposed/accepted only while its exact repair permit remains active—and become unusable once capable bootstrap consumes that permit.

   No wrap, phrase, or key material leaks through the proposed witness. `auditId` and `repairedAt` expose only bounded operational metadata; stale mutation authority is the material problem.

6. **HIGH — the result-vector table assigns race meanings that are impossible inside its stated transaction.**

   Audit insert, permit insert, and claim deletion are defined as one ordered atomic transaction ([180:675](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:675)). The audit and permit statements carry the same eligibility/no-permit proof, and `account_id` is the permit primary key ([180:644](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:644)).

   Once that transaction reports permit insertion `1`, no concurrent permit can interleave before its delete. Therefore `1/1/0` cannot mean “lost race to a concurrent permit,” and `1/0/0` is likewise not a normal refusal if the repeated predicates are identical ([180:702](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:702)).

   Current repository code explicitly relies on `db.batch()` being transactional and ordered ([d1-batch.ts:37](/home/via/Development/Personal/rbox-core/apps/api/src/d1-batch.ts:37), [keys.ts:249](/home/via/Development/Personal/rbox-core/apps/api/src/keys.ts:249)). Those vectors should be integrity anomalies, or the design must specify a non-transactional execution model. The current attempted→completed audit would otherwise permanently record a false race classification.

7. **MEDIUM — the workspace-commit fence relies on an “existing authoritative account lookup” that is not present.**

   Design 180 assigns the fence to the sync route’s existing lookup ([180:668](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:668)). The current route only calls workspace authorization ([sync.ts:14](/home/via/Development/Personal/rbox-core/apps/api/src/routes/sync.ts:14)); that reads `workspaces`, not `account_keys` or repair permits ([authz.ts:20](/home/via/Development/Personal/rbox-core/apps/api/src/authz.ts:20)). Its other account query reads only the maximum key epoch ([sync.ts:36](/home/via/Development/Personal/rbox-core/apps/api/src/routes/sync.ts:36)).

   The proposed fence is implementable and the eligibility refusal is sound, but this requires a new claim/permit check immediately before DO forwarding—not modification of an existing account-claim lookup.

8. **MINOR — the CODEMAP citation overstates current ownership.**

   Design 180 says CODEMAP line 143 already assigns journal, classifier, and exact-comparison ownership to `e2ee-client.ts` ([180:957](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:957)). Current [CODEMAP.md:143](/home/via/Development/Personal/rbox-core/docs/CODEMAP.md:143) assigns general bootstrap/pairing/verification glue only and explicitly excludes key storage. The design’s later requirement to update CODEMAP is necessary; the opening citation should not describe that future ownership as current.

9. **MINOR — one test-coverage citation is inaccurate.**

   Design 179 says existing tests provide correct/wrong-envelope coverage ([179:251](/home/via/Development/Personal/rbox-core/docs/design/179-recovery-kit-macos-keychain.md:251)). The cited tests cover successful unwrap and a wrong recovery phrase/key against the correct envelope; they do not substitute a wrong or historical envelope ([session.test.ts:76](/home/via/Development/Personal/rbox-core/src/engine/e2ee/session.test.ts:76)). The proposed testing still needs explicit wrong-envelope/context coverage.

All other explicit file:line citations in both documents were checked against the current repository and accurately describe the cited code. No files were edited.

Verdict: **CHANGES-REQUIRED**

WORK-COMPLETE