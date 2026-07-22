## Round-1 fold audit

| R1 | Status | Assessment |
|---|---|---|
| 1 | NOT CLOSED | RK is staged, but post-receipt and competing-genesis cleanup states are not restartable (finding 3). |
| 2 | PARTIAL | Atomic-write steps are specified, but the macOS durability and no-symlink guarantees exceed the available primitives (finding 7). |
| 3 | PARTIAL | D1 key-child rows are now visible, but authoritative workspace commits remain invisible (finding 4). |
| 4 | CLOSED | The four named bypass families are mandatory classifier consumers with whole-command tests. |
| 5 | PARTIAL | Exact-field server idempotency is sound; the version gate breaks pre-release validation (finding 8). |
| 6 | NOT CLOSED | The route is concrete, but the repair cannot recover the normal legacy orphan and its SQL predicate is contradictory (findings 1–2). |
| 7 | CLOSED | Client and both SQL predicates require the old endpoint’s nonempty typed claim shape. |
| 8 | CLOSED | Recovery wrap, device rows, roster lifecycle, public keys, and principal-specific wrap authorization are now required. |
| 9 | CLOSED | N=1 co-location and a hard sharding blocker are explicit and match [db.ts](/home/via/Development/Personal/rbox-core/apps/api/src/db.ts:27). |

## Findings

1. **BLOCKER — Repair leaves the normal production legacy orphan permanently unbootstrappable.**

   The actual old flow writes `device.json` and `mk.key` before POST ([e2ee-client.ts](/home/via/Development/Personal/rbox-core/src/cli/e2ee-client.ts:110)). The server then commits the claim separately before its child batch ([keys.ts](/home/via/Development/Personal/rbox-core/apps/api/src/keys.ts:109)). A child-batch failure therefore leaves the exact orphan plus unmarked local device/MK material; ordinary bootstrap has no marker, journal, or staged RK, and non-`already_bootstrapped` failures do not clean it ([auth-cmd.ts](/home/via/Development/Personal/rbox-core/src/cli/auth-cmd.ts:130)).

   After operator repair deletes the claim, v2 explicitly classifies “unmarked partial local material” as `integrity-failure` ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:227)), while `pristine` requires no pending device/MK ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:320)). Consequently, runbook step 6’s promise that the retained machine can create a new bundle is false ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:747)).

   The repair protocol needs a durable, client-observable repair witness that authorizes cleanup/adoption of this exact legacy local state. The end-to-end test must seed the real no-journal/no-staged-RK orphan, not the impossible journaled orphan currently specified at line 872.

2. **BLOCKER — The repair batch’s predicates make `audit=1, permit=1, delete=1` impossible as written.**

   Both predicates are said to require “no pre-existing repair permit” ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:536)). The delete then “repeats the entire” proof while also requiring the newly inserted permit ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:549)).

   D1 executes batch statements sequentially in one transaction. Once statement 2 inserts the permit, statement 3 cannot simultaneously satisfy `NOT EXISTS (permit)` and require that exact permit. Its result is necessarily `1/1/0`, which the design labels impossible. Cloudflare confirms ordered execution and whole-sequence rollback on statement failure; a zero-change conditional statement is not a failure. [Cloudflare D1 batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)

   The delete predicate must replace the no-permit condition with “the only permit is the exact newly inserted permit/audit pair,” not repeat it.

3. **HIGH — Cleanup crashes produce states that the classifier declares corrupt.**

   After a receipt is durable, v2 permits deletion or promotion of `rk.key.staged` before journal retirement ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:190)). But any journal with missing staged RK is an integrity failure ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:222)). The mandated crash “after staged cleanup before journal retirement” therefore cannot resume as claimed ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:808)).

   `competing-genesis` has the same flaw: step 7 performs cleanup before recording `competing-cleaned` ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:674)). A crash after removing device/MK but before the receipt leaves a journal whose required local keys are missing.

   A receipt-bearing cleanup phase must explicitly allow absent staged/local material and resume cleanup idempotently. For competing cleanup, durable authorization/phase transition must precede destructive removal. Prepublication cleanup likewise needs a marker-last order.

4. **HIGH — The “exhaustive” server observation misses authoritative E2EE commits.**

   The proposed inventory contains only D1 key tables and E2EE pairing tokens ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:235)). However, the current sync route treats an account with no key state as epoch 0 ([sync.ts](/home/via/Development/Personal/rbox-core/apps/api/src/routes/sync.ts:36)), and the Durable Object accepts a commit solely when its submitted epoch equals that forwarded value ([workspace-sync.ts](/home/via/Development/Personal/rbox-core/apps/api/src/workspace-sync.ts:680)). The authoritative commit is stored in DO state; its D1 mirror is explicitly best-effort ([workspace-sync.ts](/home/via/Development/Personal/rbox-core/apps/api/src/workspace-sync.ts:691), [workspace-sync.ts](/home/via/Development/Personal/rbox-core/apps/api/src/workspace-sync.ts:720)).

   Thus a claim-less or repair-permit account can contain authoritative encrypted history that neither `GET /v1/keys/account` nor the repair predicates can observe. Repair can declare an account eligible, delete its claim, and later install genesis unrelated to an existing commit chain.

   At minimum, commit publication needs the same claim/no-permit fence. Legacy repair also needs authoritative proof that every workspace DO head is empty, or a deliberately narrower eligibility rule such as refusing accounts with any workspace.

5. **HIGH — The completion hold is bypassable by ordinary operational commands.**

   Section 4 names only genesis/device-code, setup, bare `rbox`, and init as mandatory consumers ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:378)). Direct sync, daemon startup, export, versions, Git, and related commands enter through `buildAuthedRemote`, which currently loads device/MK and immediately constructs a usable E2EE client without any pending-genesis check ([e2ee-client.ts](/home/via/Development/Personal/rbox-core/src/cli/e2ee-client.ts:303)). Export also independently treats `hasDevice` as enrollment ([export-cmd.ts](/home/via/Development/Personal/rbox-core/src/cli/export-cmd.ts:368)).

   After “response before phrase display,” a user can run one of these commands indefinitely without releasing the hold or ever seeing/saving the phrase. That contradicts invariant 5’s statement that server commit is not completion. Pending genesis needs a shared gate at the common E2EE-loading boundary, with an explicit allowlist for read-only diagnostics.

6. **MAJOR — Designs 179 and 180 specify incompatible staged-RK authorities.**

   Design 180 introduces `rk.key.staged` for every bootstrap ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:130)). The already-ALIGNED design 179 still requires non-interactive macOS genesis to force the existing `rk.key` cache plus a separate staging record before bootstrap, and later restore the original cache preference ([design 179](/home/via/Development/Personal/rbox-core/docs/design/179-recovery-kit-macos-keychain.md:184)).

   Neither design defines whether both stages exist, which record owns cleanup, how `rk.key.staged` maps into design 179’s status/locator reconciliation, or how crashes migrate between them. R1 explicitly required mechanism alignment; choosing a new filename only in design 180 did not achieve it.

7. **MAJOR — The hardened durability contract overclaims macOS and no-symlink guarantees.**

   On Linux, file fsync plus containing-directory fsync is the correct local-filesystem pattern; Linux documents the need for the separate directory fsync. [Linux `fsync(2)`](https://man7.org/linux/man-pages/man2/fsync.2.html)

   On macOS, Apple documents that ordinary `fsync()` can still lose or reorder writes across OS crash or power loss and identifies `F_FULLFSYNC` for strict ordering. [Apple `fsync(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fsync.2.html) The CLI uses Bun’s `node:fs` compatibility surface, whose `FileHandle.sync()` offers ordinary OS-specific fsync semantics; no `F_FULLFSYNC` mechanism is specified.

   Separately, the existing reusable directory helper stops at the first path whose final component is a directory and therefore does not detect symlinks in earlier components ([fsutil.ts](/home/via/Development/Personal/rbox-core/src/engine/fsutil.ts:81)). Path-based `lstat` followed by rename also cannot eliminate a parent-swap race.

   Define the failure model explicitly. If OS/power crash is included, add a macOS full-flush mechanism or weaken the guarantee. If “no symlink” is intended to be race-resistant, handle-relative traversal/native support is required; otherwise state the residual.

8. **MAJOR — The minimum-version gate makes the required pre-release dev validation impossible.**

   The gate rejects every prerelease below `1.7.21` ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:431)), while the repository’s dev installer deliberately emits versions such as `1.7.21-dev+<sha>` ([dev-install.ts](/home/via/Development/Personal/rbox-core/scripts/dev-install.ts:24)). SemVer orders that below the `1.7.21` release.

   Yet release order requires exercising the dev runbook before releasing CLI 1.7.21 ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:770)). The real dev/local-fleet binary therefore cannot consume the permit it must validate. Use a distinct authenticated protocol-capability header, define an explicit accepted dev capability, or choose a floor compatible with the validation lifecycle.

9. **MAJOR — The permanent audit’s outcome cannot be crash-consistent under the described ordering.**

   `outcome` is non-null, but the audit row is inserted before the permit/delete results exist ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:497), [design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:536)). The design never specifies an atomic SQL-derived initial outcome or a later update of `outcome`/`completed_at`.

   Pre-filling success can lie when a predicate returns zero; pre-filling refusal can lie on success; a post-batch update can be lost to a crash. The claimed recording/escalation of `1/0` is likewise not represented by any mutation. Specify the exact audit state machine and make the batch store an authoritative initial result, followed by an idempotent completion update where appropriate.

10. **MEDIUM — The wire contract refers to version negotiation but contains no version.**

   The parser promises to reject “unknown-version presence data,” and future tables require a “wire-version” update ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:305)). Neither the 404 nor 200 body contains a presence/schema version. Exact-key parsing gives an implicit v1 but no explicit version to increment or diagnose. Add a required bounded `genesisPresenceVersion: 1` field to both variants.

11. **MINOR — One v2 file:line claim is stale.**

   The problem statement cites `src/cli/e2ee-client.ts:84-89` for empty-chain rejection. Lines 84–89 now concern pairing-token parsing and the start of `verifyDto`; the actual empty-chain rejection is at [e2ee-client.ts](/home/via/Development/Personal/rbox-core/src/cli/e2ee-client.ts:92). The `keys.ts:109-125` and both CODEMAP line claims were verified and are accurate.

The exact-field idempotency branch otherwise withstands the requested TOCTOU review: genesis fields are immutable, a complete account is ineligible for repair, the query refuses while any permit exists, and upgraded clients still cryptographically fetch-and-compare after every response. The D1 failure-rollback assumption is also valid; conditional zero-change vectors, however, commit normally and are why finding 2 is fatal.

No files were edited.

Verdict: **CHANGES-REQUIRED**

WORK-COMPLETE