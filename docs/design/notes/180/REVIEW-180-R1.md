Verdict: **CHANGES-REQUIRED**.

The conflict-raising four-row `D1Database.batch()` core is atomic under current D1 semantics; statement failure rolls back the sequence. The surrounding restart, classification, compatibility, and repair protocols still have substantive gaps. [Cloudflare D1 batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/)

1. **BLOCKER — Ordinary bootstrap loses the only recovery phrase across restart.**

   The journal contains the request body but deliberately excludes RK/phrase, and ordinary bootstrap has no completion hold ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:91), [design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:118), [design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:351)). RK is independently random and returned only as an in-memory phrase ([session.ts](/home/via/Development/Personal/rbox-core/src/engine/e2ee/session.ts:87), [session.ts](/home/via/Development/Personal/rbox-core/src/engine/e2ee/session.ts:118)). Current bootstrap saves device/MK, posts, and only then returns that phrase ([e2ee-client.ts](/home/via/Development/Personal/rbox-core/src/cli/e2ee-client.ts:110)); `saveDevice` stores no RK ([e2ee-keystore.ts](/home/via/Development/Personal/rbox-core/src/cli/e2ee-keystore.ts:93)).

   A crash after journal publication—before or after server commit—can replay successfully but can never reconstruct the recovery phrase. Require a durable pre-POST RK/phrase foothold for every bootstrap and a completion hold until phrase delivery or durable artifact commitment.

2. **HIGH — The journal is stronger than the private-key files it depends upon.**

   The design persists device/MK “as today” and hardens only the journal ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:91), [design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:131)). Today `writeSecret` is recursive `mkdir` plus an in-place `writeFile`, without atomic rename, read-back, file fsync, or explicit directory/ancestor durability ([e2ee-keystore.ts](/home/via/Development/Personal/rbox-core/src/cli/e2ee-keystore.ts:40)). `saveDevice` performs separate device and MK writes ([e2ee-keystore.ts](/home/via/Development/Personal/rbox-core/src/cli/e2ee-keystore.ts:93)).

   A durable journal or committed genesis can therefore survive while its private keys do not. Harden `device.json`, `mk.key`, and directory publication before journal publication or POST, with injected durability-failure tests.

3. **HIGH — The classifier cannot observe all states it promises to classify.**

   `GET /v1/keys/account` immediately returns 404 when `account_keys` is absent, without querying child tables ([keys.ts](/home/via/Development/Personal/rbox-core/apps/api/src/keys.ts:133)). Yet the schema has no foreign keys ([0011_e2ee.sql](/home/via/Development/Personal/rbox-core/apps/api/migrations/0011_e2ee.sql:7)), and current device, roster, key-state, admit, and workspace routes can create children without an account claim ([keys.ts](/home/via/Development/Personal/rbox-core/apps/api/src/keys.ts:161), [keys.ts](/home/via/Development/Personal/rbox-core/apps/api/src/keys.ts:181), [keys.ts](/home/via/Development/Personal/rbox-core/apps/api/src/keys.ts:202), [keys.ts](/home/via/Development/Personal/rbox-core/apps/api/src/keys.ts:228), [keys.ts](/home/via/Development/Personal/rbox-core/apps/api/src/keys.ts:259)).

   Consequently, child-only legacy corruption appears as `pristine` or `resume-attempt`, contradicting the exhaustive classification table and partial-shape tests ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:153), [design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:381)). The wire endpoint must expose child presence even without a claim, or provide an authoritative server-side state classifier.

4. **HIGH — Real setup and restart entry points bypass the shared classifier.**

   Genesis persists local device material before POST ([e2ee-client.ts](/home/via/Development/Personal/rbox-core/src/cli/e2ee-client.ts:110)), and `hasDevice` becomes true from `device.json` alone ([e2ee-keystore.ts](/home/via/Development/Personal/rbox-core/src/cli/e2ee-keystore.ts:54)). That causes:

   - Setup to skip `resolveEnrollment` through `enrolledAccountId` ([setup-cmd.ts](/home/via/Development/Personal/rbox-core/src/cli/setup-cmd.ts:190), [setup-cmd.ts](/home/via/Development/Personal/rbox-core/src/cli/setup-cmd.ts:284)).
   - `resolveEnrollment` itself to return before fetching server state ([setup-cmd.ts](/home/via/Development/Personal/rbox-core/src/cli/setup-cmd.ts:511)).
   - Bare `rbox` to route to the enrolled menu ([front-door.ts](/home/via/Development/Personal/rbox-core/src/cli/front-door.ts:52)).
   - A restarted `rbox init --bootstrap` to select `auth="have"` and skip login/classification ([init-plan.ts](/home/via/Development/Personal/rbox-core/src/cli/init-plan.ts:140), [init-cmd.ts](/home/via/Development/Personal/rbox-core/src/cli/init-cmd.ts:370)).

   These are precisely the states produced by a pre-POST or split-publication crash. A valid pending journal must override every local-enrolled shortcut, with whole-command restart tests—not only tests at three inner seams.

5. **HIGH — Client-only exact comparison is unsafe during the old-CLI transition and repair.**

   The design retains `409 already_bootstrapped` and relies on the new classifier to interpret ambiguous success ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:204)). Existing clients automatically retry bootstrap transport faults ([remote/keys.ts](/home/via/Development/Personal/rbox-core/src/cli/remote/keys.ts:7), [resilient.ts](/home/via/Development/Personal/rbox-core/src/cli/remote/resilient.ts:124)). After a successful commit whose response is lost, the retry gets 409; old `runGenesisEnrollment` then deletes device, MK, and cached RK before reporting already set up ([auth-cmd.ts](/home/via/Development/Personal/rbox-core/src/cli/auth-cmd.ts:130), [e2ee-keystore.ts](/home/via/Development/Personal/rbox-core/src/cli/e2ee-keystore.ts:141)).

   This is especially unsafe when an old client consumes a repair permit. Prefer server-side exact-field idempotency—return 200 when the committed genesis exactly matches the replay—or enforce a protocol capability/minimum version for permit-consuming bootstrap. An `x-rbox-version` header already exists ([context.ts](/home/via/Development/Personal/rbox-core/src/cli/remote/context.ts:56)).

6. **HIGH — The production repair runbook is not executable, and its audit record disappears.**

   The runbook says only “invoke the scoped operator repair helper” ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:302)). It specifies no route or script, authentication, request schema, audit-field source, dry-run/output contract, production-target command, or account-ID validation. Existing production mutations have explicit platform-secret admin routes ([routes/admin.ts](/home/via/Development/Personal/rbox-core/apps/api/src/routes/admin.ts:124), [authz.ts](/home/via/Development/Personal/rbox-core/apps/api/src/authz.ts:69)); deployment documentation exposes only migration/deploy/version commands ([DEPLOYMENTS.md](/home/via/Development/Personal/rbox-core/docs/DEPLOYMENTS.md:20)). An `apps/api/src/keys.ts` helper cannot be invoked through `wrangler d1 execute`, and ad-hoc SQL is expressly forbidden.

   Additionally, operator/reason metadata lives in the permit ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:222)), but successful bootstrap deletes that permit ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:263)), while the runbook says to preserve the audit record ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:321)). Specify an invocable authenticated operator surface and a permanent audit write.

7. **HIGH — “Exact legacy orphan” accepts malformed claims the old endpoint could not create.**

   The classifier labels any non-null claim with empty child arrays as repairable, and the SQL proof requires only claim existence plus dependent emptiness ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:160), [design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:236)). But `recovery_wrap`, `recovery_wrap_id`, and `created_at` are nullable in the schema ([0011_e2ee.sql](/home/via/Development/Personal/rbox-core/apps/api/migrations/0011_e2ee.sql:7)), whereas the old endpoint required nonempty wraps/IDs and wrote a timestamp ([keys.ts](/home/via/Development/Personal/rbox-core/apps/api/src/keys.ts:94), [keys.ts](/home/via/Development/Personal/rbox-core/apps/api/src/keys.ts:109)).

   A manually corrupted all-null row could be automatically deleted despite malformed states being a non-goal. Require the precise old-endpoint claim shape in classification and both SQL predicates; otherwise return `integrity-failure`.

8. **MAJOR — No-journal `enrolled` verification does not fully bind fetched opaque rows to the signed chain.**

   The design specifies `verifyAccount`, account-ID binding, and then exact DTO comparison only when a journal exists ([design 180](/home/via/Development/Personal/rbox-core/docs/design/180-atomic-genesis-enrollment.md:163)). `verifyAccount` verifies roster/key-state chains and builds authorized wrap hashes, but it does not inspect DTO recovery/device rows ([session.ts](/home/via/Development/Personal/rbox-core/src/engine/e2ee/session.ts:237)). Those DTO fields are nullable ([e2ee-remote-types.ts](/home/via/Development/Personal/rbox-core/src/cli/e2ee-remote-types.ts:7)).

   A valid signed chain accompanied by a missing/substituted recovery wrap or malformed device row can therefore be called `enrolled` unless “complete” is strengthened. Require recovery-wrap hash/ID binding and explicit device-row parsing, roster membership/lifecycle rules, and wrap authorization for no-journal classification.

9. **MEDIUM — Pairing-token fencing silently depends on N=1 database co-location.**

   Key state is account-data-plane, while pairing tokens are directory-plane ([db.ts](/home/via/Development/Personal/rbox-core/apps/api/src/db.ts:13)); pairing creation writes through `dirDb` ([pairing.ts](/home/via/Development/Personal/rbox-core/apps/api/src/auth/pairing.ts:55)). They are transactionally co-located only because both currently return the same binding at N=1 ([db.ts](/home/via/Development/Personal/rbox-core/apps/api/src/db.ts:27), [db.ts](/home/via/Development/Personal/rbox-core/apps/api/src/db.ts:42)).

   Pin N=1 as a prerequisite and a sharding blocker, or define a mirrored/cross-plane fence protocol before claiming the pairing-token guard remains atomic.

The atomic-publication SQL direction, exact comparison for upgraded clients, conflict-raising inserts, and permit consumption in the same bootstrap batch are otherwise sound. The server invariant should say “all-or-none co-presence”; cryptographic mutual consistency remains a client-classifier guarantee because the API intentionally stores signed envelopes opaquely.