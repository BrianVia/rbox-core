## Round 1 — codex (sol)

1. **BLOCKER — The proposed composite does not represent “active sign-in methods” from Clerk's user object.** `docs/design/94-signin-method.md:46-55` includes every `external_accounts[]` entry solely from `provider`. Clerk explicitly documents that the Backend `User.externalAccounts` array includes both verified and unverified accounts, and each external account exposes `verification.status` (`unverified`, `verified`, `transferable`, `failed`, or `expired`): <https://clerk.com/docs/reference/backend/types/backend-user>, <https://clerk.com/docs/reference/backend/types/backend-verification>. The current source only parses `{ provider?: string }` (`apps/api/src/clerk.ts:233-250`), so the proposed widened shape is still insufficient. A pending or failed Google connection would be surfaced as an active `google` login. Deleted connections disappear on a later successful Clerk fetch, but the refresh behavior below can leave the deleted provider cached; a deleted Clerk user produces a non-OK fetch (`apps/api/src/notify.ts:269-276`) and therefore preserves the stale value. The design must define and test eligibility, at minimum filtering external accounts to `verification.status === "verified"`, and stop calling a mere attached record “active.”

2. **BLOCKER — `email` is not a sound fallback, and `password_enabled` does not answer “how this user signed in.”** `docs/design/94-signin-method.md:53-55` maps an empty external/password set to `email`, but Clerk users may have phone, username, passkey, enterprise-SSO, and other identifiers/factors; possession of a verified primary email (the local provisioning gate at `apps/api/src/clerk.ts:251-253`) does not prove email-code was the login method. Clerk defines `passwordEnabled` only as whether the user has a password, while `externalAccounts` are associated OAuth accounts—not the method used for the current or last session: <https://clerk.com/docs/reference/backend/types/backend-user>. It is useful for OAuth-only users (`false` means no password is set), but it does not establish that password auth is currently enabled for the instance or that the user used it. `docs/go-live-todo.md:54-56` proves Google/GitHub are enabled; it does not prove those plus email/password exhaust Clerk's possible methods. Either redefine the field honestly as verified attached login credentials (and use `unknown`/empty rather than fabricating `email`), or obtain session-attempt/factor data if the requirement is the actual sign-in method.

3. **MAJOR — The claimed “failed fetch inserts NULL” path is impossible in the current first-login control flow.** `docs/design/94-signin-method.md:111-116` says a failed Clerk fetch reaches the INSERT with `signInMethod = null`. In reality, non-OK/network failures return `verified:false` and null decorations (`apps/api/src/clerk.ts:242-255`), and `webSession` returns 403 before the INSERT whenever `verified` is false (`apps/api/src/clerk.ts:134-141`). Every successful path to the INSERT currently gets a non-null result from `signInMethodOf` (`apps/api/src/clerk.ts:233-236,251-253`). If a later attempt fetches successfully, it is still a first-login attempt and inserts then; there is no unknown row to “self-heal.” This invalidates the stated failure envelope, NULL provenance, and a required test scenario.

4. **MAJOR — The refresh result is incorrectly coupled to verified-email success.** `docs/design/94-signin-method.md:120-125` says `fetchClerkPrimaryEmail` returns the composite “alongside the email” and `cacheOwnerEmail` writes both. The real result type can only carry an address on `kind:"ok"` (`apps/api/src/notify.ts:246`); the fetched user becomes `absent` when the primary email is missing/unverified (`apps/api/src/notify.ts:271-274`), and both callers write only on `ok` (`apps/api/src/notify.ts:253-255,287-288`). Thus a perfectly successful Clerk response with usable method data can discard that data. The design needs a result shape that separates fetch success, email availability, and method availability, plus independent cache updates. Otherwise its NULL and backfill promises are false.

5. **MAJOR — The 24-hour email throttle contradicts “next login,” and the new timestamp has no specified gating semantics.** `docs/design/94-signin-method.md:77-78,123-128,142-145,177-178` promises next-dashboard-login self-heal/backfill and at most a one-login stale window. The actual gate skips every returning login while `email_updated_at` is less than 24 hours old (`apps/api/src/notify.ts:27,283-288`). A legacy row with fresh email cache and NULL `signin_method`, or a user who attaches/removes Google just after an email refresh, can remain stale through arbitrarily many logins for almost 24 hours and indefinitely if there is no later login. Specify whether refresh is due when either timestamp is NULL/stale, how the two timestamps interact, and correct the staleness/production validation claims.

6. **MAJOR — Concurrent refreshes can regress the cached method, and the design does not use its timestamp to prevent stale-last-writer wins.** The current throttle is a read followed by an unguarded fetch and UPDATE (`apps/api/src/notify.ts:283-288,259-260`), so two returning logins can both pass the gate. If Clerk state changes between their GETs, the request with the older snapshot may complete last and overwrite the newer composite. Concurrent first logins also all fetch before `INSERT OR IGNORE`; whichever INSERT wins selects the initial snapshot (`apps/api/src/clerk.ts:118-147`). This is best-effort metadata, but it is explicitly sold for support/forensics and deterministic change detection (`docs/design/94-signin-method.md:19-21,64-65,165-166`). Define a fetched-at/conditional-write rule (or explicitly accept and bound regression); merely adding `signin_method_updated_at` does not solve the race.

7. **MAJOR — Dev rollout order is backwards, while the broad “no version skew hazard” claim hides a real old-schema failure.** The production claim is supported: the recorded Workers Builds build command applies prod migrations before the separate deploy command (`docs/DEPLOYMENTS.md:12-21`), and migrations auto-apply on a main merge touching `apps/api/**` (`docs/DEPLOYMENTS.md:23-31`). However, validation says deploy the new dev worker and then apply the migration (`docs/design/94-signin-method.md:173-176`). The new INSERT/SELECT/UPDATE SQL will fail against the old dev schema; nullable/additive does not make a reference to a nonexistent column safe. Apply the dev migration before deploying schema-dependent code. Also use the canonical command with `cd apps/api &&` from `docs/DEPLOYMENTS.md:28-29`; the design's root-context command at `docs/design/94-signin-method.md:94-95` omits the Wrangler config directory. Limit the “never sees old schema” assertion to prod's recorded pipeline rather than claiming general read-before-write safety (`docs/design/94-signin-method.md:87,162-164`).

8. **MAJOR — NULL/absent handling is not implementable by the abbreviated CLI plan without touching all propagation points.** Today `fetchAccountSummary` destructures and reconstructs the API payload independently (`src/cli/account-cmd.ts:51-64`), `formatAccountSummary` is one human renderer (`src/cli/account-cmd.ts:76-88`), and `accountStatus` performs a second destructure, constructs a separate JSON DTO, and prints the other human renderer (`src/cli/account-cmd.ts:96-116`). The design only says “AccountStatus type + one line ... and JSON” (`docs/design/94-signin-method.md:134-136`) and cites `:118`, which is not a renderer. Both fetch/destructure paths must propagate the field. `JSON.stringify` includes an explicitly supplied `null` (`src/cli/json.ts:1-10`), so “omitted when null” requires conditional object construction, not `signInMethod: null`. Require tests for API `null`, an older API with the field absent/undefined, both human renderers, and JSON key omission. Existing tests exercise old-server absence but know nothing about this field (`src/cli/account-cmd.test.ts:74-80,102-117`; `src/cli/json-output.test.ts:334-345`). The web likewise currently types only `{accountId, linked}` (`apps/web/src/lib/api.ts:162-166`), stores only those two values (`apps/web/src/routes/settings/+page.svelte:55-61`), and renders the account section at `apps/web/src/routes/settings/+page.svelte:104-143`; all three locations need an explicit absent/null contract.

9. **MAJOR — The validation plan points at fixtures that do not validate either write path or the composite semantics.** `docs/design/94-signin-method.md:103-107,170-172` relies on `slackpipes.test.ts` fixtures already carrying `signInMethod`, but those are pure formatter cases with single literal values (`apps/api/test/slackpipes.test.ts:84-89,115`); they never call Clerk parsing or the provisioning INSERT. The worker's Clerk fixture returns only email fields and no external accounts/password flag (`apps/api/test/worker.test.ts:569-577`), so it can at most exercise the questionable fallback. Add backend-user fixtures for verified plus unverified/failed/expired external accounts, duplicate providers, password-only, OAuth-only, mixed password+OAuth, empty/unsupported factor sets, deleted provider on refresh, non-OK fetch, absent verified email with valid method data, and concurrent refresh ordering.

10. **MINOR — Several “verified” source claims are false or stale.** The schema statement at `docs/design/94-signin-method.md:10-13` says the table stores only `clerk_user_id`, `account_id`, and `email` and cites migrations 0010/0014. In fact, 0010 defines `clerk_user_id`, `account_id`, `user_id`, and `created_at` (`apps/api/migrations/0010_clerk.sql:5-10`), while email and `email_updated_at` arrive in 0016 (`apps/api/migrations/0016_device_notifications.sql:54-60`); 0014 adds no email column. The fetch implementation is at `apps/api/src/clerk.ts:242-253`, not `:239`; `refreshOwnerEmail` is invoked at `apps/api/src/clerk.ts:185`, not `:196`; the standalone CLI output is at `src/cli/account-cmd.ts:114-116`, not `:118`; and `verifyClerkJWT` spans `apps/api/src/clerk.ts:59-101`, while `:109-112` begins `webSession`. These should be corrected because the design explicitly depends on line-level auditability.

11. **MINOR — A simpler shared parser is missed, inviting semantic drift between the two fetch paths.** The design upgrades the private `signInMethodOf` in `apps/api/src/clerk.ts:233-237` but separately says `notify.ts` “additionally parses” the same Clerk fields (`docs/design/94-signin-method.md:101-105,120-123`). Centralize one pure Backend-User-to-methods parser (including verification filtering and normalization) and reuse it from both fetch paths. For the dashboard specifically, the already-loaded Clerk frontend user is demonstrably available (`apps/web/src/routes/settings/+page.svelte:28`), so live UI display could use Clerk directly; D1 persistence is still justified for CLI/status, but the design should acknowledge that the web row need not wait on the 24-hour D1 cache if freshness matters.

Verdict: **REVISE**

## Round 1 response — Claude (Fable)

All 11 findings accepted; design revised to DRAFT v2. Disposition:

1. ACCEPTED (blocker) — semantics re-founded on VERIFIED external accounts
   only (`verification.status === "verified"`); unverified/failed/expired/
   transferable excluded. §2, §3.2 parser.
2. ACCEPTED (blocker) — column redefined as "verified attached sign-in
   credentials at last observation", NOT the session's method; `email`
   fallback removed — empty set → NULL rendered "unknown". §2, §4.
3. ACCEPTED — insert-NULL-then-heal path deleted; §3.3 now states the
   fail-closed control flow (403 before INSERT) and the only NULL-at-INSERT
   case (empty credential set).
4. ACCEPTED — refresh result restructured: `signinMethod` + `fetchedAt`
   populated on any successful fetch including `absent` email; writes
   decoupled from email availability. §3.4.
5. ACCEPTED — explicit refresh-due rule: email throttle OR
   `signin_method IS NULL` (backfill kicker); staleness window stated
   honestly (≤24h under continued logins; indefinite without). §3.4.
6. ACCEPTED — conditional write keyed on fetch timestamp
   (`WHERE signin_method_updated_at IS NULL OR < fetchedAt`); new invariant
   I5 (monotone freshness). `signin_method_updated_at` redefined as the
   FETCH timestamp. §3.4, §5.
7. ACCEPTED — dev order corrected to migrate-then-deploy with the canonical
   `cd apps/api &&` commands; "never sees old schema" scoped to prod's
   recorded pipeline only. §3.1, §6.2.
8. ACCEPTED — CLI touch list enumerates both destructure paths, both human
   renderers, and conditional JSON key construction (stringify serializes
   explicit null); old-server-absent ≡ null required behavior + tests. §3.5.
9. ACCEPTED — validation §6.1 carries the full fixture matrix (verification
   states, dedup, unknown provider, password/OAuth combos, deleted-last-
   credential → NULL write, error → no write, stale-writer loses, JSON key
   omission).
10. ACCEPTED — all file:line refs corrected (0010 real schema; email columns
    from 0016; fetch at clerk.ts:242-253; refreshOwnerEmail call at :185;
    CLI renderer at account-cmd.ts:114-116; verifyClerkJWT :59-101).
11. ACCEPTED (both halves) — shared pure parser `clerk-signin.ts` owns the
    semantics for both fetch paths; web-side live-Clerk alternative
    acknowledged and rejected for v1 with rationale (single source of truth
    for CLI/web/Slack consistency). §3.2, §3.5.

One deliberate divergence to re-review: on a successful fetch with an EMPTY
credential set, v2 WRITES NULL (deleted-last-credential must clear the
display) rather than treating empty as no-data. Challenge this if you see a
Clerk state where a healthy signed-in user transiently reports zero verified
external accounts and password_enabled=false — that would argue for
never-write-NULL instead.

## Round 2 — codex (sol)

1. **MAJOR — The NULL backfill kicker cannot distinguish “not captured” from a successfully captured empty set, so the deliberate NULL write causes a Clerk fetch on every returning login forever.** The refresh-due rule is `email_updated_at` stale **OR `signin_method IS NULL`** (`docs/design/94-signin-method.md:182-186`), while a successful empty observation deliberately persists `signin_method = NULL` plus a non-NULL observation timestamp (`docs/design/94-signin-method.md:193-195`). The next login therefore satisfies the kicker again even when both observations are seconds old. This contradicts “fires at most once per legacy row” and “no new Clerk traffic” (`docs/design/94-signin-method.md:251-253`) and makes the stated 24-hour behavior false for empty identities (`docs/design/94-signin-method.md:197-200`). The schema already contains the needed discriminator: make the kicker `signin_method_updated_at IS NULL`, not `signin_method IS NULL`. A legacy row then backfills once, while an observed-empty row remains NULL for display but is throttled normally. Add a second-login-after-empty test; the current matrix only checks that the first empty refresh writes NULL (`docs/design/94-signin-method.md:270-274`).

2. **MAJOR — The fetchedAt conditional write still does not establish the claimed stale-snapshot ordering unless the timestamp source/order is defined; with the natural response-completion timestamp it reproduces Round 1's stale-last-writer race.** The design says the result carries a `fetchedAt`, then asserts that comparing it makes an older Clerk snapshot unable to overwrite a newer one (`docs/design/94-signin-method.md:176-181,187-192`) and elevates that to invariant I5 (`docs/design/94-signin-method.md:259-260`). But it never says when `fetchedAt` is sampled. If request A reads the old Clerk state but its response completes after request B has read and stored the new state, completion-time `fetchedAt(A) > fetchedAt(B)` and A wins the proposed UPDATE. Sampling before issuing the request fixes that common ordering but still does not prove snapshot order when server processing is reordered. Clerk's raw Backend User payload has a server `updated_at`; use that as the snapshot version/guard (with a deliberate equal-version policy), or precisely define request-start time and weaken I5 to acknowledge the residual race. As written, Round 1 finding 6 is inadequately addressed.

3. **MINOR — The proposed refresh result is not a valid discriminated contract for the existing notification-consumer caller and leaves an avoidable implementation trap.** Today `ownerEmail` returns `fetchClerkPrimaryEmail` directly and reads `fetched.address` on `kind === "ok"` (`apps/api/src/notify.ts:250-255`), while `cacheOwnerEmail` also takes the address independently (`apps/api/src/notify.ts:258-260`). V2 specifies one object with `kind: "ok" | "absent" | "error"`, optional `email`, but mandatory `signinMethod` and `fetchedAt`, immediately followed by “`error` carries no method data” (`docs/design/94-signin-method.md:176-181`). Those statements conflict, and renaming `address` to `email` would require changing the security-notification path even though the design promises the email cache semantics remain untouched (`docs/design/94-signin-method.md:191-192`). Specify an actual union, e.g. `ok { address, signinMethod, version } | absent { signinMethod, version } | error`, retain the existing `EmailLookup` projection for `ownerEmail`, and perform the method UPDATE separately from the existing email write. This is implementable in the current flow, but the contract should make the non-regression explicit.

4. **MINOR — The parser semantics are supported, and I endorse successful-empty → NULL, but the claim that empty “should not occur for a provisionable user” is not supported by the cited repository evidence.** Clerk documents that `externalAccounts` includes verified and unverified OAuth accounts, that `verification.status` can be `unverified | verified | transferable | failed | expired`, and that `passwordEnabled` only means the user has a password; therefore the filter and password contribution at `docs/design/94-signin-method.md:62-71,132-145` are correct for the newly narrowed “verified attached modeled credentials” meaning. However, `docs/go-live-todo.md:54-56` establishes only that GitHub and Google OAuth are enabled/authenticatable, not that every user must have OAuth or a password, and this repo explicitly records email-code handling (`docs/design/15-web-dashboard.md:9-10`; `docs/go-live-todo.md:42`). A healthy email-code-only (or future passkey/phone/enterprise) user can therefore legitimately produce the empty modeled set. That supports, rather than defeats, writing NULL: NULL honestly clears a deleted last modeled credential and also means “none derivable.” Keep the divergence, remove/soften the impossible-state claim, and rely on `signin_method_updated_at` to distinguish observed-empty from never-observed as in finding 1. Clerk references: <https://clerk.com/docs/reference/backend/types/backend-user>, <https://clerk.com/docs/reference/backend/types/backend-external-account>, <https://clerk.com/docs/reference/backend/types/backend-verification>.

5. **MINOR — The fixture matrix still omits one verification state that the normative parser explicitly excludes.** Section 2 excludes `transferable` along with unverified/failed/expired (`docs/design/94-signin-method.md:62-67`), but the parser fixtures list only unverified/failed/expired (`docs/design/94-signin-method.md:264-270`). Add `transferable`; it was expressly part of Round 1 finding 1 and prevents a future broad “not failed” eligibility check from silently admitting it.

Verdict: **REVISE**

## Round 2 response — Claude (Fable)

All 5 findings accepted; design revised to DRAFT v3. Disposition:

1. ACCEPTED — kicker re-keyed to `signin_method_updated_at IS NULL`
   (never-observed), so observed-empty rows throttle normally; added the
   second-login-after-empty no-refetch test to §6.1; I2 restated.
2. ACCEPTED — guard re-founded on Clerk's `updated_at` from the user payload
   as a server-authoritative snapshot version; `signin_method_updated_at` now
   stores that version (§2, migration comment, §3.4); equal-version policy:
   skip (same snapshot ⇒ same composite). I5 restated as monotone-in-Clerk's-
   version with the sub-resolution residual named and accepted.
3. ACCEPTED — refresh result specified as a real union
   (`ok {address, signinMethod, clerkUpdatedAt} | absent {signinMethod,
   clerkUpdatedAt} | error {}`); `address` name and `ownerEmail` projection
   untouched; method UPDATE is a separate statement from `cacheOwnerEmail`.
4. ACCEPTED — impossible-empty claim removed; §2 now cites the repo's own
   email-code evidence (design 15, go-live-todo:42) and treats empty as a
   legitimate state. Divergence retained per your endorsement.
5. ACCEPTED — `transferable` added to the exclusion fixture list.

## Round 3 — codex (sol)

1. **MAJOR — Write path A still tells the implementer to persist a local fetch timestamp, reopening the round-2 version bug for every newly provisioned row.** Section 2 defines `signin_method_updated_at` exclusively as Clerk's payload `updated_at` (`docs/design/94-signin-method.md:95-102`), and the returning-login guard and I5 consistently use that server version (`docs/design/94-signin-method.md:204-211,281-285`). But the first-login INSERT says it is bound to the parser output and “the fetch timestamp” (`docs/design/94-signin-method.md:163-170`), while the parser/fetch-shape change list mentions adding `password_enabled` and `verification` but never says `fetchClerkUser` must retain the payload's `updated_at` (`docs/design/94-signin-method.md:157-161`). Implemented literally, the initial row contains a locally sampled value in a column later compared against Clerk versions, so the values are not the promised snapshot-version domain and a legitimate later Clerk snapshot can lose the `< clerkUpdatedAt` guard. Specify that `fetchClerkUser` returns `clerkUpdatedAt` parsed from `u.updated_at`, and that the INSERT binds that exact server value. “Fetch timestamp” must not remain as an alternative interpretation.

2. **MINOR — The final staleness summary still keys immediacy on the nullable value rather than the observation discriminator.** It says the value refreshes after 24 hours “or immediately when NULL” (`docs/design/94-signin-method.md:217-220`), but an observed-empty identity deliberately has `signin_method IS NULL` and a non-NULL `signin_method_updated_at`, and therefore does *not* refresh immediately under the corrected rule (`docs/design/94-signin-method.md:95-102,199-203`). This directly contradicts I2 and the second-login-after-observed-empty test (`docs/design/94-signin-method.md:271-275,297-300`). Say “or immediately when never observed (`signin_method_updated_at IS NULL`)”.

3. **MINOR — “No new Clerk traffic” remains literally false during legacy backfill.** The new kicker intentionally initiates a fetch on the next returning login even when `email_updated_at` is fresh, where the old flow would have skipped it (`docs/design/94-signin-method.md:50,199-203,271-275`). It adds no new endpoint or steady-state polling, and it is bounded to at most one accelerated request per never-observed row, but that request is still new traffic. Restate I2 (and the §1 claim) as “no new fetch call sites / no steady-state traffic; at most one accelerated backfill fetch per legacy row” so rollout load and the actual due rule agree.

Verdict: **REVISE**

## Round 3 response — Claude (Fable)

All 3 findings accepted; design revised to DRAFT v4. Disposition:

1. ACCEPTED (major) — §3.2 now requires `fetchClerkUser` to return
   `clerkUpdatedAt` parsed from the payload's `updated_at`, and §3.3 binds
   the INSERT to that exact server value with an explicit "never a local
   timestamp" rule. The version domain is Clerk-only at every write site.
2. ACCEPTED — §3.4 staleness summary re-keyed to never-observed
   (`signin_method_updated_at IS NULL`), with the observed-empty case
   explicitly excluded from immediate refresh.
3. ACCEPTED — I2 and the §1 claim restated: no new call sites / no
   steady-state increase, plus at most one ACCELERATED backfill fetch per
   never-observed row (bounded by legacy row count; today 1).

## Round 4 — codex (sol)

1. **MINOR — The accelerated-backfill bound is still false when Clerk fetches fail.** The refresh kicker remains true while `signin_method_updated_at IS NULL` (`docs/design/94-signin-method.md:206-210`), and an `error` deliberately writes nothing (`docs/design/94-signin-method.md:219-222`). A legacy row whose accelerated fetch errors is therefore still never-observed and accelerates another fetch on every subsequent returning login until one succeeds. That contradicts both the §1 claim of a “one-time accelerated backfill fetch per pre-existing row” (`docs/design/94-signin-method.md:51-53`) and I2's “at most one fetch per never-observed row” / legacy-row-count bound (`docs/design/94-signin-method.md:280-285`). Restate the bound as at most one *successful* accelerated backfill fetch per legacy row, with failed attempts retried on later logins, or add state that actually caps attempts. The three round-3 edits otherwise landed consistently: both write paths use Clerk's payload `updated_at`, staleness is keyed on never-observed rather than value-NULL, and no other local-timestamp or `signin_method IS NULL` refresh rule remains.

Verdict: **REVISE**

## Round 4 response — Claude (Fable)

Finding 1 ACCEPTED; design at DRAFT v5. §1 and I2 restated: at most one
SUCCESSFUL accelerated backfill fetch per legacy row; a Clerk error writes
nothing and the row retries on later logins (attempt count bounded by login
frequency during a Clerk outage — the identical exposure the existing email
refresh has, so no new state is added to cap attempts).

## Round 5 — codex (sol)

1. **MINOR — The successful-fetch bound is still false under concurrent returning logins.** The requested failure wording landed consistently in both §1 and I2: an `error` leaves the row never-observed and retries on a later login. However, “at most one SUCCESSFUL accelerated backfill fetch per legacy row” (§1) and “Successful-fetch count is bounded by the legacy row count” (I2) do not hold when returning logins overlap. Multiple requests can all read `signin_method_updated_at IS NULL`, issue accelerated fetches, and succeed before any request's guarded UPDATE becomes visible. The conditional write bounds the winning observation, not the number of successful in-flight fetches. Restate the bound as one successful accelerated **observation/write** per legacy row, while acknowledging that redundant successful fetches are bounded by concurrent login requests (or add serialization/state that truly caps successful fetches).

Verdict: **REVISE**

## Round 5 response — Claude (Fable)

Finding 1 ACCEPTED; design at DRAFT v6. §1 and I2 restated: the bound is one
successful accelerated OBSERVATION WRITTEN per legacy row; overlapping
concurrent logins may issue redundant successful fetches (bounded by request
concurrency) of which exactly one write wins via the conditional write. No
serialization added — redundant fetches are reads of an already-fetched
object and cost nothing new.

## Round 6 — codex (sol)

1. **MINOR — The one-written-observation bound is still false when concurrent fetches return different Clerk versions.** The v6 edits correctly acknowledge redundant concurrent successful fetches, but the conditional write guarantees one winner only when those fetches carry the same `clerkUpdatedAt` (or when the newest snapshot writes first). If an older snapshot writes first and a newer snapshot writes second, both satisfy `signin_method_updated_at IS NULL OR signin_method_updated_at < ?`, so both accelerated observations are written. Thus §1's “exactly one write wins” and I2's one-written-observation / legacy-row-count bound remain false. Bound redundant successful fetches **and successful writes** by overlapping request concurrency, while retaining the real guarantee that the final stored observation has the greatest Clerk version (subject to I5's equal-version caveat), or add state that truly enforces one write.

Verdict: **REVISE**

## Round 6 response — Claude (Fable)

Finding 1 ACCEPTED; design at DRAFT v7. §1 and I2 restated: the guarantee is
CONVERGENCE, not write-uniqueness — redundant successful fetches and
redundant successful writes are each bounded by overlapping request
concurrency (older-then-newer version writes both pass the monotone guard);
the final stored observation carries the greatest Clerk version observed;
once any write lands the backfill kicker is off for that row. No
serialization added — a redundant guarded UPDATE on a 1-row-per-user table
is cheaper than any lock that would prevent it.

Orchestrator note for round 7: the mechanism has been stable since v3;
rounds 4-6 have each refined one sentence of the same traffic-bound prose.
Judge v7 on whether any finding remains that would change IMPLEMENTATION
behavior — pure prose-precision nits at this point should be folded into an
ALIGNED verdict with wording suggestions, per the no-manufactured-findings
instruction.

## Round 7 — codex (sol)

No implementation-changing findings remain. V7 correctly states the
accelerated-backfill behavior as convergence rather than uniqueness: each
overlapping request can contribute at most one successful fetch and one
guarded write; multiple increasing Clerk versions may therefore write in
sequence; and the monotone `clerkUpdatedAt` predicate leaves the greatest
successfully written version stored. The first successful write also clears
the never-observed kicker, while already in-flight requests remain safe under
the same guard. This agrees with I2, I5, and the specified write-path tests.

Non-blocking wording suggestion: where the design says the final stored value
has the greatest Clerk version "observed," consider "the greatest observed
Clerk version whose guarded UPDATE completes successfully." A successful
Clerk fetch followed by a D1 write failure is technically observed but cannot
affect stored state. The existing retry behavior already handles that case,
so this is prose precision only and requires no implementation change.

Verdict: **ALIGNED**
