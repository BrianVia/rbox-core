# Thermo-nuclear structural sweep #2 — 2026-07-24 (post-Tier-2)

Second sweep, run at `ac0c5900` after the first sweep's Tier 0–2 shipped
(#419–#431). Eight parallel reviewers, each given sweep #1's roadmap as an
exclusion list with a mandate to either produce an *executable plan* for a
queued item or *challenge its framing* — not to re-derive it. Lanes:
regression-audit of today's 14 PRs, daemon, state plane, sync-git plane,
engine/git, API worker, CLI command layer, cross-cutting axes.

Every finding below was reported with file:line evidence by its reviewer;
the ones marked ✅ were additionally re-verified first-hand at HEAD.

## Tier A — correctness defects (small PRs, each with a test)

1. ✅ **`multipartComplete` destroys the resume state on the failure it told
   the client to retry** (`apps/api/src/blobs.ts:505-550`). The `finally`
   runs on both `retry_later` 503 paths, deleting the staging R2 object
   (swallowed `.catch`) and calling `cleanupUpload`, which drops the
   `uploads`/`upload_parts` rows. The client's retry gets `unknown_upload`
   404. Affects **every file over 90 MiB** (`SINGLE_PUT_MAX`); recovery is a
   full re-upload. Fix: scope the cleanup to terminal outcomes.
2. ✅ **`journalLocksRemain` fails open** (`engine/git/checkout-txn.ts:306-313`).
   `lockToken` catches everything → `undefined`, so an unreadable
   `index.lock` reads as "no lock". That feeds `journalIntact` (:788, :926)
   and `follow.ts:1567` then **deletes the checkout journal while its lock is
   still on disk** — the journal is that lock's only recovery authority, so
   it becomes permanently stale-unattributed (doctor + human). Fix: three-state
   `LockProbe` (`absent | present | indeterminate`), map indeterminate to
   busy/throw/true per caller.
3. ✅ **`MutationGateClosedError` is swallowed** (`sync-git/apply.ts:1713`),
   defeating `p-settlement.ts:166`'s deliberate re-throw one frame up. A stop
   request mid-pull no longer aborts the repo loop: every remaining repo runs
   its full ungated preparation, dies at its first gated mutation, and has its
   held-attempt state destroyed via `clearAttempt` plus a spurious `"other"`
   deferral. Fix: re-throw it.
4. ✅ **`firstReason` lists 12 of 16 deferral reasons**
   (`sync-git/follow.ts:452-458`; missing `conflict`, `config`,
   `ignored-target`, `stale-unattributed`). `classifyCheckout` returns
   `{safe:true, blockers}` when it finds none — a fail-open safety verdict
   with non-empty blockers. Unreachable today by luck, not by construction.
   Fix: shared ordered constant + non-optional return.
5. ✅ **`confirmDestructive`'s gate is asymmetric** (`cli/prompt.ts:100 vs :105`):
   `throw` uses `isInteractive()`, the other three use `process.stdin.isTTY`
   alone. `rbox untrack --no-interactive` therefore throws instead of
   proceeding — and `prompt.test.ts:41-57` **pins the broken behavior as
   correct**. Violates the scriptable-path rule. Fix: one gate; un-pin the test.
6. ✅ **Flag arity is global, not per-command** (`cli/flags.ts:10-19`).
   `--git` is arity-0 for `status` and arity-1 for `init`/`track`; last wins.
   `rbox status --git <path>` silently loses both the flag and the path.
   Same for `--respect-gitignore` on `track`. Fix: build arity from the
   resolved help key; add a per-command collision test.
7. ✅ **`POST /v1/keys/workspace` skips the viewer gate** (`api/keys.ts:372` →
   `ownsWorkspace`, which has no role check; `keys.ts` contains zero `role`
   references, vs `authz.ts:39`). Bounded to denial/wedging of an unpublished
   epoch by `INSERT OR IGNORE`, not key theft — but it is the one workspace
   write reaching D1 without the role gate.
8. ✅ **`staging/` R2 objects have no reclaimer.** `gcMark` rotates only
   `blobs/sha256/` and `manifests/sha256/` (`versions.ts:416-441`);
   `cleanupUpload` is D1-only. After `mpu.complete()` the staging key is a
   real object R2's 7-day incomplete-MPU TTL no longer covers. Permanent
   unmonitored leak; `multipart-inventory.ts:46` already lists the prefix
   read-only, so the observability exists and the reaper doesn't.
9. ✅ **The unbounded-fetch class is still open** — ~11 command-layer sites
   with no `AbortSignal` (`account-cmd` ×4, `subscribe-cmd` ×2, `usage-cmd`,
   `setup-cmd`, `update-check`, `upgrade-cmd` ×2, diagnostics upload).
   #426 fixed two calls and framed it as a class fix. Fix: route through
   `fetchWithDeadline` + a CI grep gate on bare `fetch(` outside `resilient.ts`.
10. Torn-state riders, all one-line: `stripe.ts:330` requeue left outside its
    batch (its two siblings are inside) — a 500 loses the requeue *and* the
    churn ping permanently; `account-delete.ts:421` account-delete lacks the
    `genesis_repair_audit` guard its sibling ledger-close has, producing an
    unbounded stuck row; `notify.ts` computes and stores `idempotency_key`
    (:182) but never sends it (:260), so the reaper's retry duplicates
    security-alert email.

## Tier B — founder decisions (cheap, large payoff)

11. **Six shipped feature lanes are dark** — default-off `=== "1"` flags with
    zero setters anywhere in src/apps/scripts/CI: `RBOX_PUBLISH_PIPELINE`
    (gates 961 non-test lines; **field gate FAILED 2026-07-13**, +71% slower,
    STATUS:504), `RBOX_MDE_FAST_PULL`, `RBOX_MDE_DELTA`, `RBOX_SCAN_BULK`,
    `RBOX_PREFLIGHT_DELTA` (was set by hand on fleet daemons in the v1.0.1
    era — i.e. it works and everyone wants it), `RBOX_WATCHER_RETRUST`
    (design 104, the Mac I/O duty-cycle fix; default-off contradicts the
    default-on rule and its fork has leaked contamination logic into the
    drift auditor). Each is CI-tested code that never runs in production.
    Needed: one line per flag — flip default-on, or delete the lane.
12. **Delete the dead pre-E2EE plaintext transport.** `commits.ts:377-385`
    still casts `/latest` to `{sequence, manifest}` — a field the Worker
    stopped returning — and `apiFor` (`sync/policy.ts:7`) installs that
    impossible transport as the **default** when `deps.remote` is absent.
    Production always injects `E2eeRemote`; the only live effect is that a
    wiring bug degrades to `manifest: undefined` instead of failing loudly.
    Make `remote` required on `SyncDeps`, delete `apiFor` and the plain
    `commit()`/`latest()` pair.

## Tier C — corrections to sweep #1's roadmap

13. **INVARIANTS.md is structurally decoupled from the code it governs.**
    `grep -rl INVARIANTS src/ apps/ scripts/` returns **nothing** — no test,
    lint, or CI step reads it — and every "Enforced:" line anchor in the git
    lane is now stale (`lockfile.ts:526-555` points at
    `readHostIdentityLedger`; `apply.ts:444-476` at `deleteEntry`; 8 checked,
    8 wrong). The five queued decomposition PRs will each silently invalidate
    more. **Do this before the splits, not after**: slug the headings, tag
    enforcing sites with `// INVARIANT(slug)`, add a structure test
    (precedent: `base-composer-structure.test.ts`). Turns each move-fidelity
    audit into a machine check.
14. **Daemon (Tier 4 #23/#24/#30 + WS): right direction, too modest.**
    `RboxDaemon` carries ~155 instance fields (27 booleans, 41 optionals, 18
    timers) across **14 concerns**; the queued work removes ~4 of them and
    ~900 lines, leaving a ~2,300-line god object. Missing, and the two best
    size-to-risk cuts: a **`StatusSurfaceWriter`** (17 fields, ~450 lines,
    30+ call sites — queued #30 only dedupes two write bodies and leaves the
    concern smeared) and a **`DriftAuditor`** (~250 lines, measurement-only,
    its own code says "sync unaffected" twice). Also: `daemon-ws-reliability.test.ts`
    already reaches WS privates through a hand-declared
    `as unknown as DaemonInternals` — the tests have drawn the boundary.
    Declare the end shape in the design doc first, then extract in this
    order: MutexContention → DriftAuditor → Scheduler → WS → SurfaceWriter →
    (design-104 verdict) WatcherTrust → RecoveryController.
15. **State plane (Tier 3 #15-#18): the prescribed cut is wrong.** The narrow
    write funnel already exists — `applyStateSavePacket` re-runs the
    compose→sanitize→pending epilogue authoritatively under the lock. The
    four "copies" are two clients redundantly pre-running what the store
    re-runs (`sourceRecord` composes a value the store composes again with
    identical inputs) plus two legacy writers that bypass the store.
    Extracting `applyComposedBase` would *preserve* the double-compose.
    Correct moves: export the store's pure transition core and delete the
    client copies (#15); **delete** the three sanitize loops rather than
    promoting them — `stateFromRepoRecords` already sanitizes on the next
    line (#16); make the lane list a **type-level** `satisfies
    Record<keyof Required<RepoStateValues>, LaneSpec>` table, since a runtime
    list fixes the enumeration sites but keeps the compile-time silence that
    is the actual hazard — a 14th lane today has four independent silent
    failure modes (#17); fold `savePublishedRepoIntent` onto a shared CAS
    driver and delete its `forceLegacy` branch, which has **zero production
    callers** (#18). New: `ensureTelemetryBindingId`
    (`sync-state-store.ts:380-409`) is a third write engine — takes the lock,
    checks stream but not nonce, skips the `stateRevision` bump — existing
    only because `StateSavePacket` can't express a non-manifest global field.
16. **API: two queue premises are factually wrong.** `versions.ts` is **one of
    twenty** unowned API modules, not the only one — 7,413 of 17,252 lines
    (43%) match no CODEMAP entry, including the three largest files, which is
    also why the <600-line rule has zero API enforcement. **The CODEMAP
    amendment is a prerequisite for every API split, not a follow-up.** And
    the queued `readGapEntry` dedupe is really a **two-copy snapshot reader**
    (~50 of ~70 lines duplicated between `roots()` and `rootsInspect()`,
    including byte-identical SQL) feeding **GC reachability and fair-use
    accounting**. If they diverge, GC deletes live customer data while
    fair-use miscounts. That is the highest-consequence duplication in the
    lane, not a tidy-up. Do it before `commit()`.
    Also: `versions.ts` splits four ways (`gc-roots` / `gc-state` /
    `gc-observability` / `storage-gc` + a 12-line `commit-history`), and it is
    already the de-facto GC kernel two other GC modules import from.
17. **engine/git: the biggest deletion the sweep missed** — two independent
    `git update-ref --stdin` prepared-transaction drivers
    (`checkout-txn.ts:123-214`, `keep-pins.ts:193-329`, ~225 lines), same
    protocol, divergent robustness. Only keep-pins has a wedged-child timeout
    and SIGKILL escalation; checkout-txn's `finish()` awaits unbounded in the
    design-116 hot path, and polls the whole stdout *file* every 5 ms.
    Unify on the keep-pins implementation. Second: a missing
    `claimExclusivePath` primitive — the ORIG_HEAD/HEAD.lock trio hand-rolls
    claim/release three ways, and only `releaseObservedLock` does the readback
    verification. (Honest counter-finding: the auto-reaping vs never-reaping
    lock split, `index.lock`-as-staged-file, and `journal.id`-as-token are all
    **load-bearing** and must stay separate.)
18. **sync-git: `LockedBranchProof` is a proof object with no constructor.**
    Five sites build it as a literal asserting `artifactsClear: true` etc.
    with no local evidence; exactly one producer earns those booleans inside
    the transaction lock (`branch-transition.ts:294-337`). A spurious `true`
    advances BASE over an unverified artifact. Move construction into
    `base-composer.ts` (the module owning the consuming rule) as the only
    exported producers. Related: the typed `GitDeferralReason` is
    reconstructed from English prose by **four** independent regex tables that
    have already diverged (`"repo unusable (dangling .git pointer?)"` types as
    `other` on one path and `unreadable` on another) — make the engine return
    a typed reason and delete all four.

## Tier D — the one big new investment

19. **`src/wire/` — a shared request/response contract.** The wire shape is
    declared three times (CLI: 42 bare `as {…}` casts on `res.json()`;
    Worker: inline `json({…})` literals; dashboard: a parallel 395-line
    `api.ts`) and validated zero times. Verified skew hazard: the commit 409
    is a union (`conflict` | `epoch_stale`), and the CLI has two independent
    parsers of it — `commitSigned` discriminates correctly, plain `commit()`
    casts every 409 to `{head:number}`, yielding `head: undefined` on an
    epoch-stale body. A server-side field rename type-checks everywhere and
    fails at runtime on the two-minor-behind CLI. Precedent exists: the
    Worker already imports engine modules by relative path. Start with the
    sync-plane families and the ~15 error codes the client actually branches
    on (of 92 inline literals, with live collisions: `internal` vs
    `internal_error`, `too_large` vs `body_too_large`, `rate_limited` with
    two incompatible payloads).

## Came back clean (evidence, not silence)

Error taxonomy: 53 typed `Error` subclasses, 219 structured `{ok:false}`
sites, `process.exit` confined to the dispatch layer, only 3 places in the
tree sniff error-message strings. Layering: no engine→cli imports (one
test-helper, which dies with the gated legacy-journal delete), no
remote→command imports, no sync→daemon imports; of madge's 9 cycles, 8 are
type-only and the 1 real one (`activity.ts ⇄ status-view.ts`) is trivially
broken by a leaf `activity-model.ts`. `as any` is nearly extinct (1 real hit,
`stripe.ts:46`); all 4 `@ts-expect-error` are deliberate and documented.
API error *shaping* is canonical (`json()` at ~428 sites, 2 justified
exceptions). Today's #427 (`executeOp`), #431 (sync-git trio), #428
(`platformSecretMatches`) are good consolidations; the fair-use fragment and
platform-secret migrations are complete.

## What today's merges cost

`daemon.ts` went 3,426 → 3,475 across the 14 dedup PRs — the sweep's stated
consolidation work net-grew the repo's largest file. `executeOp`'s `recovery`
flag is **never read** in the body (declared `daemon.ts:1540`, passed at
:1599/:1601/:1682; the behavior it documents is enforced by the
`op !== "recoveryProbe"` guard at :1687) — delete it. `MoveNoClobberHooks`
exists only to avoid an import that would create no cycle. Four permanent
re-export facades are now locked by four surface tests (277 lines) that also
pin *syntax*; ~45% of `config.ts`'s 118 importers touch exactly one owner
module and could be codemodded straight through.

## Recommended sequencing

1. Tier A as ~6 small PRs (group by lane), each with a regression test.
2. Tier B decision sheet — 15 minutes of founder calls, one of which is a
   −961-line delete.
3. #13 (INVARIANTS tagging + structure test) **before** any decomposition.
4. #16's CODEMAP amendment before any API split.
5. Then the corrected dev-cycles: API roots-reader → daemon end-shape doc →
   state-plane PR → engine/git ref-transaction unification.
6. #19 gets its own design doc and an adversarial round; it is the only item
   with external-user correctness exposure.
