# REVIEW-151 — adversarial design review, round 1

Target: `docs/design/151-phase0-containment.md`

Baseline independently inspected: `fc476f7` (`main` / `origin/main`) plus the
design-149 document on local branch `feat/149-storage-economics` where the target
explicitly claims composition with that not-yet-merged design.

## Verdict: CHANGES-REQUIRED

The four audit findings are real, and the basic containment direction is sound,
but the design is not yet safe to dispatch. Unit 1 promises data that cannot be
computed at the exact failure boundary and changes an operator response consumed
by an unlisted script. Unit 2's explicit cap rejects current legitimate 5,000,
50,000, and unbounded normal-client batches. Unit 3 does not define the caller
switch needed to keep typed timeouts from authorizing deletion, restart, or state
removal. Unit 4 does not define its existing unversioned wire format or reconcile
fail-closed auth behavior with intentionally best-effort diagnostic flows. The
four-PR independence claim is also false.

## Findings

### 1. BLOCKER — Unit 1 cannot produce `uniqueRoots` at the ninth-row breach

`workspaceSnapshot()` returns `null` as soon as its `LIMIT maxW + 1` sentinel is
present, before either phase calls `reachableFromWorkspaces()`
(`apps/api/src/versions.ts:193-216,488-500`). Root cardinality exists only as the
ephemeral `Set.size` inside that later traversal (`versions.ts:58-125`); current
`gc_state` contains generic cursor/lease values, not root cardinality
(`versions.ts:179-190`, `apps/api/migrations/0024_gc_state.sql:5-8`).

Therefore neither the budget-exceeded response nor a read-only health route can
truthfully return a *current* unique-root count once the row gate has fired. A
last-successful sample is implementable, but the contract must make it nullable
and label it with `measuredAt` and `stale`; it must not call that value current.
The over-budget outcome should likewise use `uniqueRoots: null` or explicitly
named last-known fields.

The proposed `rows` field has a related accuracy problem: the sentinel query
returns at most nine rows. With 100 workspace/project rows it still observes
`results.length === 9` (`versions.ts:193-200`). The health route needs a separate
exact `COUNT(*)`, or the response must call this a lower bound/truncated count.
There is no qualifying predicate today: every row in `workspaces` counts
(`apps/api/migrations/0005_gc.sql:8-13`).

### 2. HIGH — Unit 1's replacement response shape breaks an existing operator caller

The current budget exits are HTTP 200 JSON bodies preserving phase-specific
numeric fields: `{marked:0,budgetExceeded:true}` and
`{purged:0,opened:0,budgetExceeded:true}`
(`apps/api/src/versions.ts:210-215,494-499`; `json()` defaults to 200 at
`apps/api/src/util.ts:61-62`). The admin route passes those `Response` objects
through unchanged (`apps/api/src/routes/admin.ts:161-184`).

`scripts/gc-drain.ts:29-65` is a real caller. It treats every 2xx purge body as
`{opened,purged}`, adds both values to totals, and terminates only when both are
zero. Replacing the body with only `{ok:false,reason,...}` makes the totals `NaN`
and the loop never terminates. Cron is different: it ignores the returned response
(`apps/api/src/worker.ts:114-132`), so its warning must be emitted within the GC
operation/helper.

The design must choose and test an HTTP compatibility contract: either return a
non-2xx response and update the drain, or retain the old numeric fields while
adding the typed fields and update the drain to fail on `ok:false` /
`budgetExceeded`. Existing direct tests throughout
`apps/api/test/gc-purge.test.ts`, `account-delete.test.ts`, and
`pack-gc.test.ts` also consume the response bodies and must be migrated.
This is the complete caller set found: cron in `worker.ts`, the manual admin
route in `routes/admin.ts`, the supervised `scripts/gc-drain.ts` client, and
direct test calls in those three test files. No other production caller was
found.

### 3. HIGH — Unit 1 outcome persistence and warning semantics are incomplete

Serving “last mark/purge outcome + timestamp from `gc_state`” requires new D1
writes, contradicting “observe-only; zero mutation-path changes” in its literal
form and the existing sentinel invariant that no `gc_state` row is written on an
over-budget exit (`apps/api/test/gc-purge.test.ts:408-423`). `gc_state` is a
reasonable GC-local KV location, but the design must define:

- separate mark/purge keys and a versioned value schema;
- timestamps and all terminal outcomes, including thrown reachability/list/state
  failures, purge's `zero_chunk`, `lease_busy`, `lease_lost`, internal 500, and
  success (`apps/api/src/versions.ts:488-537`);
- whether an observability-write failure is best-effort and may never turn a
  successful GC operation into failure;
- whether the cron warning is edge-triggered (“crosses”) or level-triggered. An
  edge requires persisted prior state and tests for 5→6, repeated 6, and 6→5;
- unknown/stale root behavior after the row gate has fired.

The arithmetic itself is correct but should state both formulas. Mark uses
`floor((800-10-3)/90)=8`; purge uses
`floor((800-10-5-3-1)/90)=8`
(`apps/api/src/versions.ts:130-146,210,494`). The 75% thresholds are therefore
6 rows and 562,500 roots. `MAX_UNIQUE_ROOTS = 750_000` at `versions.ts:28` is
also correctly cited. “At 2 rows today” is fleet-state evidence and is not
verifiable from the repository.

### 4. HIGH — Unit 1's Design 149 relationship is inaccurate

Design 151 says Unit 1 avoids Design 149's seams and identifies Unit C's ledger as
the intended canonical-GC foundation. On `feat/149-storage-economics`, Unit C is a
fair-use history/prune-floor ledger, not a replacement for canonical
`gcMark`/`gcPurge` (`docs/design/149-storage-economics.md:670-685,679-807`). It
materializes account membership and moves retention floors; canonical GC still
reclaims the resulting unreachable objects.

More importantly, Design 149 Unit B explicitly changes the same roots collector,
its page/byte caps, and `versions.ts` rollout (`149-storage-economics.md:590-614,
1234-1241`), and adds an admin roots-coverage surface at the same admin-route seam
(`:574-588`). Unit 1 necessarily edits `versions.ts`, `routes/admin.ts`,
`worker.ts`, and GC tests. The two designs require an explicit order/rebase and a
single source of truth for the collector caps and health fields. No overlap with
Design 150's release-workflow files was found.

### 5. BLOCKER — Unit 2's 1,000-SHA cap rejects legitimate current clients

The repository's declared client maximum is 50,000
(`src/cli/publish-pipeline/shared.ts:80`). Full-audit recovery sends batches of
exactly that size (`src/cli/sync-recovery.ts:94-99`), and
`src/cli/sync/sync.test.ts:858-872` asserts a 50,001-item input becomes
`[50_000, 1]`. The normal publish pipeline sends up to 5,000 unique addresses per
request (`src/cli/publish-pipeline/pipeline.ts:49,196-206`). The non-full-audit
path can send still more because it calls `api.missingBlobs(encShas)` without
chunking (`src/cli/sync-recovery.ts:293-311`). API integration tests deliberately
send 5,600 SHAs and require HTTP 200 in both receipt and legacy modes
(`apps/api/test/blob-check-batch.test.ts:5-24,58-61,69-89,106-135`).

A 50,000-SHA JSON request is about 3.35 MiB. Literal four-times item headroom is
200,000, not 1,000. The revision must either size the server byte/item caps for
the current protocol or change and chunk *every* client path in a coordinated
compatibility rollout. The latter makes the unit client+server and invalidates
the claimed API-only independence.

### 6. HIGH — Unit 2 cites the wrong file and does not enumerate its route contract

All inherited blob anchors at design line 45 name
`apps/api/src/routes/blobs.ts`, but that file ends at line 34 and only dispatches
`blobsCheck` at line 13. The claimed implementation is in
`apps/api/src/blobs.ts:120-125,141-160,179-207`. The
`apps/api/src/d1-batch.ts:33-35` anchor is correct.

“device auth/link, keys” is not an executable route list. The body-parsing routes
apparently in scope are:

- auth/device/pair: POST device start, poll, bootstrap, approve; pair create and
  redeem (`apps/api/src/routes/auth.ts:10-20,26-30`;
  `auth/device-code.ts:27,50,121`; `auth/bootstrap.ts:18`;
  `auth/pairing.ts:47,91`);
- account link: POST start, confirm, redeem (`apps/api/src/routes/account.ts:14-18,
  28-30`; `apps/api/src/account-link.ts:46,139`);
- keys: POST api, bootstrap, device, roster, admit, keystate, workspace
  (`apps/api/src/routes/keys.ts:12-24`).

GET lookup/status/list and API-key revoke do not parse JSON. The revision must
list every included route with exact `maxBytes`, item fields, string fields, and
validator. It must also state why public unauthenticated `POST /v1/web/session`
is deferred even though it still uses unbounded `req.json()`
(`apps/api/src/routes/web.ts:4-8`, `apps/api/src/clerk.ts:110-115`); otherwise
“highest-exposure ... first” is inaccurate.

### 7. HIGH — Unit 2 has no reviewable per-route cap table

Some accepted payloads are already larger than a generic small-control cap.
Pair-create accepts two opaque strings of up to 64 Ki characters each
(`apps/api/src/auth/pairing.ts:46-50`). Key bootstrap declares eight string
fields, with opaque key fields accepted up to 64 Ki characters
(`apps/api/src/keys.ts:17-25,43-55`); admit also carries several opaque fields
(`keys.ts:210-221`). Conversely, device labels, bootstrap labels/secrets, and
approve codes are parsed before meaningful length validation or have no declared
client/server maximum (`auth/device-code.ts:27-44,121-126`;
`auth/bootstrap.ts:18-35`).

“≥4× current legitimate maxima” and “legitimate-maximum fixtures” therefore
cannot be implemented deterministically. Specify whether compatibility means
actual generated client payloads or all payloads the current server accepts, and
measure `maxStringBytes` as UTF-8 bytes rather than JavaScript code units.

### 8. MEDIUM — Workers counting-stream feasibility is already proven; reuse it

There is no ReadableStream blocker. `apps/api/src/util.ts:19-55` already reads
`req.body.getReader()`, counts each chunk's `byteLength`, cancels when the cap is
crossed, and returns collected bytes/text. It is used before `JSON.parse` by
workspace commits, diagnostics, telemetry, and blob-batch
(`workspace-sync.ts:397-414`, `diagnostics.ts:305-314`,
`telemetry-ingest.ts:164-173`, `blob-batch.ts:174-194`). `cappedJson` should wrap
or extend this primitive and add the Content-Length fast reject, not create a
second counting implementation. Peak retained memory is the cap plus one runtime
chunk, followed by concatenation/decoding overhead, which must inform cap sizes.

Deduping the legacy branch itself does not change the successful response. Input
is already filtered/deduped at `apps/api/src/blobs.ts:123-125`, and both branches
build ordered `missing` from `uniq` (`:161-167,203-207`). Passing `uniq` rather
than `shas` only to the legacy D1 lookups (`:179-202`) preserves `{missing}` and
first-occurrence order. Strict malformed-shape rejection is a separate declared
400 behavior change.

### 9. CRITICAL — Unit 3's typed outcomes fail open unless every caller switches on them

Today every caller treats a resolved `Promise<void>` as “the daemon is stopped.”
If `requested` or `timed-out` become ordinary resolved values, the current callers
would authorize unsafe follow-on actions:

- untrack proceeds toward deleting `.rbox`
  (`src/cli/untrack-cmd.ts:48-73`);
- `stopDaemonAndRecordDesired` writes durable desired state `stopped`
  (`src/cli/autostart-cmd.ts:197-202`);
- upgrade starts a replacement (`src/cli/upgrade-cmd.ts:90-99`);
- uninstall swallows stop failures and removes `~/.rbox`
  (`src/cli/uninstall-cmd.ts:81-88,111-118`).

The design must define an exhaustive `StopOutcome` switch and require only
confirmed-dead outcomes to authorize deletion, stopped desired-state writes,
restart, or uninstall. Timeout must propagate nonzero. It must also map the
current no-pid, stale-pid, ownership-lost-before-signal, graceful exit,
force-kill-confirmed, and kill-unconfirmed branches
(`src/cli/daemon-control.ts:404-451`). `requested` is not a safe terminal state.

### 10. CRITICAL — Upgrade's daemon snapshot flow needs an explicit force contract

`restartDaemonsAfterUpgrade` snapshots desired daemon rows and then assumes
`await stop(root)` proves death before calling `start` (`src/cli/upgrade-cmd.ts:52-59,
90-98`). If `timed-out` resolves, `startDaemon` sees the same live/same-binding
process and returns `already-running` (`daemon-control.ts:330-359`), which upgrade
currently reports as restarted because it rejects only `retry-later`
(`upgrade-cmd.ts:96-98`).

Upgrade must be specified as `after-timeout` (it is the internal caller whose
contract already depends on escalation), accept only terminal stopped outcomes,
never start on `requested`/`timed-out`, and preserve the pre-stop desired snapshot
including `pullOnly` and stopped rows. Add a hung-upgrade test. Existing injected
stubs return `Promise<void>` (`src/cli/upgrade-daemons.test.ts:44-113`) and must be
migrated with the typed dependency.

### 11. HIGH — Uninstall's current escalation/removal behavior is omitted

For desired rows, uninstall catches every `stopDaemon` failure and continues
(`src/cli/uninstall-cmd.ts:81-86`). For legacy pidfiles it sends raw SIGTERM with
no wait/confirmation (`:61-78`). It then recursively removes `~/.rbox` regardless
(`:111-118`). The design's promise to audit internal callers later is not a safe
design contract.

State whether consented `uninstall --yes` uses `after-timeout`; require confirmed
death before removal, or explicitly document and justify a different invariant;
and specify the legacy pidfile path. Tests must cover timeout and kill-unconfirmed
behavior before global state removal.

### 12. HIGH — `stop --force`, JSON output, and wrapper propagation are unspecified

`rbox stop` currently declares no flags (`src/cli/help-registry.ts:122-126`) and
the dispatcher forwards none (`src/cli/main-dispatch.ts:339-341`). The deprecated
`rbox daemon stop` aliases to the same route (`src/cli/deprecations.ts:48-52`).
`--json` is disabled for commands that do not declare it
(`main-dispatch.ts:125-127`), while `stopDaemon` writes human output on every path
(`daemon-control.ts:414-446`). Existing `rbox status --json` reports current
liveness, not a stop outcome (`status-cmd.ts:477-497`).

Specify whether “JSON status surfaces it” means `rbox stop --json` (recommended:
one object, no human lines) or persistence into later `rbox status --json`. Define
the schema and exit code. Add `--force`/`--json` to registry, dispatcher, and alias
tests. Untrack help must add `--yes` and split the current combined `--force`
description (`help-registry.ts:237-243`).

The `stopDaemonAndRecordDesired` wrapper, reached by `rbox stop`, the deprecated
alias, and front-door Pause, must write desired `stopped` only for confirmed
terminal outcomes (`autostart-cmd.ts:197-202`; `front-door.ts:71-82`).

### 13. MEDIUM — Unit 3 currently has two untrack escalation controllers

Untrack calls `stopDaemon`, whose current default waits 60 seconds and then kills
(`src/cli/daemon-control.ts:436-451`), then performs its own 5-second wait and
2-second `--force` kill sequence (`src/cli/untrack-cmd.ts:27-28,50-63`). The local
force branch is effectively unreachable today: `stopDaemon` either confirms its
own SIGKILL or throws. The revision must name one owner of term/kill deadlines,
delete the duplicate layer, and pin whether untrack's graceful deadline is 5 or
60 seconds.

Complete production `stopDaemon` inventory: direct untrack; the
`stopDaemonAndRecordDesired` wrapper reached by `rbox stop`, deprecated
`rbox daemon stop`, and front-door Pause; upgrade restart; uninstall desired rows.
Rebind is *not* a caller: `startDaemon` has its own SIGTERM + 5-second +
`retry-later`, explicitly no-SIGKILL path (`daemon-control.ts:330-356`). Daemon
self-shutdown is separate and drains the pump
(`src/cli/daemon/daemon.ts:650-693,2335-2362`). The dispatcher's automatic true
confirmation has exactly one consumer: untrack (`main-dispatch.ts:161-172`).
Direct `stopDaemon` tests are `src/cli/daemon-stop.test.ts:23-103`; injected
stopper contracts are exercised by `autostart-cmd.test.ts:150-188`,
`upgrade-daemons.test.ts:44-113`, and `uninstall-cmd.test.ts:48-96`. Those stubs
currently resolve `void` and are part of the typed-outcome migration.

### 14. HIGH — Unit 4's blanket STOP policy conflicts with diagnostic and cleanup contracts

The `loadCredentials` signature reaches at least the following production
surfaces, not merely auth commands:

- strict authenticated operations: account/link/status/unlink, billing subscribe,
  usage, export, device operations, key operations, E2EE build/recovery, recover,
  track, and init continuation (`account-cmd.ts`, `subscribe-cmd.ts`,
  `usage-cmd.ts`, `export-cmd.ts`, `auth-cmd.ts`, `key-cmd.ts`,
  `e2ee-client.ts`, `recover-cmd.ts`, `track-cmd.ts`, `init-cmd.ts`);
- first-run/guided operations: `runInit`, setup account detection/enrollment,
  workspace picker, and polling (`init-cmd.ts:149,255,296`;
  `setup-cmd.ts:182,247,409,478,608`);
- best-effort/status operations: account summary, local status, doctor,
  autostart status/boot resume, and uninstall key-risk warning
  (`account-cmd.ts:68-89`; `status-cmd.ts:265-310`;
  `doctor-cmd.ts:452-470`; `autostart-cmd.ts:269-278,351-357`;
  `uninstall-cmd.ts:24-33`).

The complete production import/wrapper inventory found is: direct imports in
`account-cmd.ts`, `auth-cmd.ts`, `autostart-cmd.ts`, `doctor-cmd.ts`,
`e2ee-client.ts`, `init-cmd.ts`, `key-cmd.ts`, `recover-cmd.ts`, `setup-cmd.ts`,
`status-cmd.ts`, `track-cmd.ts`, and `uninstall-cmd.ts`; the
`requireCredentials()` wrapper in `credentials.ts`; and its consumers in
`account-cmd.ts`, `subscribe-cmd.ts`, `usage-cmd.ts`, and `export-cmd.ts`.
Dependency-injected load sites in autostart, init, recover, setup, and track use
`typeof loadCredentials` and therefore also change type. No other production
caller was found.

First-run absence can map cleanly to today's signed-out behavior, and logout is a
necessary recovery escape hatch because it clears without loading
(`auth-cmd.ts:343-348`). But `fetchAccountSummary` explicitly promises never to
throw so local status works offline (`account-cmd.ts:58-62`), doctor should report
credential corruption alongside its other checks, autostart status intentionally
degrades, and uninstall intentionally swallows failure in its warning probe. A
blanket “all corrupt/unreadable/unsupported callers STOP” breaks those contracts
and can make the command intended to diagnose the fault unusable.

Add a caller-policy matrix. Mutating/authenticated flows should fail closed;
status/doctor should surface an explicit credential-degraded state while remaining
usable; logout must always clear; uninstall must remain possible while making an
unknown backup-risk warning explicit; boot resume should log the actionable fault
and start nothing. Also eliminate `statusCmd`'s current double-load
(`status-cmd.ts:265,304` via `fetchAccountSummary`) so a first load cannot
quarantine and a second silently observe absence.

### 15. HIGH — Unit 4 has no executable credential version or quarantine contract

The current on-disk DTO is unversioned: only `token`, `deviceId`, `remoteUrl`, and
optional `accountId` exist (`src/cli/credentials.ts:11-18,38-52`). The proposed
`unsupported-version` state is impossible to classify until the design defines a
version field, the new supported version, acceptance/migration of every legacy
unversioned file, unknown-field policy, and validation of optional `accountId`.
Without that, a future-version document either passes as valid or is mislabeled
corrupt.

“Preserved, never overwritten” is also not guaranteed by a timestamp filename:
POSIX `rename` replaces an existing destination. Specify a collision-proof
no-clobber quarantine algorithm (not merely `lstat` then `rename`), and retain
0600 on the quarantined secret. A direct `rbox login` currently reaches
`saveCredentials` without first loading the old file
(`src/cli/auth-cmd.ts:215-232,244-289`); unless save/login performs the same
quarantine preflight, it can atomically overwrite a corrupt file before it is
preserved. Test that path, concurrent quarantine naming, and original bytes/mode.

The `RBOX_TOKEN` environment override at `credentials.ts:39-46` must remain a
valid source independent of a corrupt disk file and needs an explicit typed-result
rule.

### 16. MEDIUM — Unit 4's directory security rule is contradictory; macOS mechanics are viable

“Parent directory must be owned by the user and not world-writable (warn
otherwise)” does not say whether failure refuses or warns. For a secret directory,
group-writable is also unsafe; test the `022` group/world mask, ownership, and a
symlinked `~/.rbox` parent, not only a symlink at `credentials.json`. Use
`lstat`/safe directory-chain handling, then the atomic rename. A destination
`lstat` alone does not validate the parent chain.

The file/directory sync sequence itself is portable to the project's released
targets (Apple Silicon macOS and Linux; `scripts/release.ts:24-25`). The repo
already implements sibling temp + file sync + rename in
`src/engine/fsutil.ts:10-57`, directory open/sync/close at `:59-67`, and uses the
same sequence in `src/cli/upgrade-cmd.ts:244-253`. Reuse these helpers with
`flag:"wx"`/0600 and make only unsupported directory-sync errors best-effort;
do not swallow file-sync or rename failures. Add a native macOS focused test, but
there is no macOS API blocker in the proposed sequence.

### 17. HIGH — The four-worktree / independently merged PR claim is false

Units 3 and 4 overlap concrete production files. Unit 3 must change
`autostart-cmd.ts` to interpret stop outcomes and `uninstall-cmd.ts` to define
stop/removal behavior; both files directly call `loadCredentials` and require Unit
4's typed-result migration. Unit 3 may also touch `status-cmd.ts` for the promised
JSON surface, while Unit 4 must change its credential load. Their tests overlap as
well. These PRs require a declared merge order or a shared compatibility shim;
they are not independent.

All four units also claim a changelog entry, so every PR edits the same
`CHANGELOG.md` `[Unreleased]` insertion point (`CHANGELOG.md:7`). Unit 1 and Unit 2
can remain production-file-disjoint if Unit 1 avoids `util.ts`, but Design 149
still overlaps Unit 1 as finding 4 explains. Revise the implementation shape to
describe parallel worktrees followed by ordered rebases/integration, not four
independently mergeable PRs.

## Anchor and claim verification ledger

- **Unit 1:** `versions.ts:193-203`, `210-215`, `494-499`, and `:28` all resolve
  and support the basic ceiling/no-op claims. The displayed mark arithmetic is
  correct; purge reaches the same ceiling through a different formula. The ninth
  row purge sentinel substantially already exists at
  `apps/api/test/gc-purge.test.ts:408-423`; mark/health/log coverage is missing.
- **Unit 2:** the `d1-batch.ts:33-35` claim is exact. Every blob anchor names the
  wrong file; the correct file is `apps/api/src/blobs.ts`. Counting request bytes
  on Workers is feasible and already implemented in `util.ts:19-55`. Legacy query
  dedupe preserves the existing successful response shape/order.
- **Unit 3:** all inherited anchors resolve to the claimed behavior:
  auto-confirm (`main-dispatch.ts:161-172`), untrack deletion
  (`untrack-cmd.ts:66-73,81-102`), combined force help
  (`help-registry.ts:237-243`), unconditional stop escalation
  (`daemon-control.ts:425-451`), rebind's no-kill rationale
  (`daemon-control.ts:349-354`), and the fail-closed ignore precedent
  (`ignore-cmd.ts:70-88`). Rebind and daemon self-stop are separate paths.
- **Unit 4:** `credentials.ts:38-52` does collapse every disk read/parse failure
  to `undefined`. `credentials.ts:63-66` writes the final path directly and chmods
  afterward; an existing symlink is followed by `writeFile`. The proposed atomic
  sequence is viable on the shipped macOS/Linux targets, but versioning,
  quarantine no-clobber, caller policy, and directory-chain security are not
  specified.

## Required revision gates before round 2

1. Make Unit 1 health data honest (`current` versus last-known/unknown), preserve
   or deliberately migrate operator response compatibility, and specify outcome
   persistence/warning semantics.
2. Replace Unit 2's 1,000-item cap with a client-compatible cap/rollout and add an
   exact per-route cap/validator table using the existing capped byte reader.
3. Give every stop caller an exhaustive outcome policy, especially upgrade,
   desired-state recording, untrack, and uninstall; specify flags/JSON/exit codes.
4. Add Unit 4's file version/migration/quarantine algorithm and a strict-versus-
   diagnostic caller matrix; preserve logout and env override recovery paths.
5. Replace the independence claim with an explicit merge/rebase order, including
   Design 149 collector integration and Unit 3→4 shared CLI files.

## Final verdict: CHANGES-REQUIRED

## Round 1 rulings (orchestrator) — ALL 17 ACCEPTED

1. Health fields: `rows` from a dedicated exact `COUNT(*)`; `uniqueRoots`
   nullable `{value, measuredAt, stale}` last-successful sample; the
   over-budget outcome uses `uniqueRoots: null`. Never label a sample
   current.
2. Compatibility contract: RETAIN existing numeric fields
   (`marked/purged/opened/budgetExceeded`) and ADD typed fields
   (`ok,reason,rows,maxRows,...`); HTTP stays 200. `scripts/gc-drain.ts`
   updated to terminate-with-error on `budgetExceeded`; the three test
   files migrate in the same PR.
3. gc_state observability keys: `gc_obs_mark` / `gc_obs_purge`, versioned
   value `{v:1, at, outcome, ...}` covering ALL terminal outcomes incl.
   thrown/zero_chunk/lease_busy/lease_lost/500/success; writes are
   best-effort and can NEVER fail the GC operation; warn is
   LEVEL-triggered each cron tick (simpler, hourly cadence makes edge
   suppression pointless); both ceiling formulas stated (mark 8, purge 8,
   75% = 6 rows / 562,500 roots).
4. 149 relationship corrected: Unit C is fair-use flooring, NOT canonical
   GC replacement; the true seam is 149-Unit-B's collector/caps/admin
   surface. ORDER: 151-U1 merges FIRST (observe-only), 149-B rebases
   over it and becomes sole owner of collector caps + extends the health
   surface. Recorded in both docs at implementation time.
5. Caps sized to the real protocol: blobs/check `maxItems = 200_000`,
   `maxBytes = 16 MiB` (4× the declared 50k client max). The unchunked
   `sync-recovery.ts:293` missingBlobs path gets client-side 50k
   chunking IN THIS UNIT (unit becomes client+server; independence claim
   dropped per F17).
6. Exact route list adopted from the reviewer's inventory (correct file:
   `apps/api/src/blobs.ts`), PLUS unauthenticated `POST /v1/web/session`
   — it is the actual highest-exposure route and is IN scope, not
   deferred.
7. Per-route cap table with UTF-8 byte semantics, sized from
   SERVER-accepted maxima (64Ki opaque fields where declared); fields
   without any declared max get one, documented per route.
8. `cappedJson` WRAPS the existing counting primitive at
   `apps/api/src/util.ts:19-55` + Content-Length fast reject; no second
   implementation. Legacy-branch change is `uniq` into the D1 lookups
   only; strict-shape 400 documented as a behavior change.
9. Exhaustive `StopOutcome` union mapped to every daemon-control branch
   (no-pid, stale-pid, ownership-lost, graceful, force-kill-confirmed,
   kill-unconfirmed, timed-out); ONLY confirmed-dead outcomes authorize
   deletion/desired-stopped/restart/uninstall; timeout exits nonzero.
10. Upgrade: `after-timeout` by contract; accepts only terminal stopped
    outcomes; never starts on requested/timed-out; pre-stop desired
    snapshot (incl. pullOnly) preserved; hung-upgrade test; typed stub
    migration.
11. Uninstall `--yes`: `after-timeout` + confirmed death before any
    removal; legacy pidfile path handled through the same owner; timeout
    aborts with `~/.rbox` intact.
12. `rbox stop` gains `--force` and `--json` (registry + dispatcher +
    deprecated alias + tests); `stop --json` = one object, no human
    lines, documented schema + exit codes; desired-stopped writes only on
    terminal outcomes (wrapper + front-door Pause).
13. ONE escalation owner: `stopDaemon({termTimeoutMs, escalate})`;
    untrack's local wait/kill layer DELETED; untrack passes
    termTimeoutMs 15s (UX), default elsewhere 60s.
14. Credentials caller-policy matrix adopted verbatim: strict flows fail
    closed; status/doctor/autostart-status/uninstall-probe surface
    `credential-degraded` and continue; doctor gains an explicit
    credentials check; logout always clears; boot resume logs + starts
    nothing; statusCmd double-load eliminated.
15. DTO gains `v: 1`; legacy unversioned files accepted and migrated on
    next save; unknown-field policy: preserved on read, dropped on save
    (documented); quarantine is no-clobber (`wx` open with counter
    suffix), 0600, and runs as a save-preflight too (login path);
    `RBOX_TOKEN` env override remains valid independent of disk state
    with a typed rule.
16. Directory rule: REFUSE on unowned or group/world-writable parent
    (not warn); symlinked parent chain checked via lstat walk; reuse
    `src/engine/fsutil.ts:10-67` helpers with `wx`+0600; only
    directory-sync errors are best-effort.
17. Implementation shape rewritten: parallel worktrees, ORDERED
    integration (U1 → U2 independent; U4 merges before U3; changelog
    conflicts accepted as trivial rebases). "Four independent PRs"
    claim dropped.

---

# Round 2 (fresh eyes, v2) — 14 findings, verdict CHANGES-REQUIRED

Reviewer verified without findings: both subrequest formulas exact (8/8; thresholds
6 rows / 562,500), all 18 cap-table rows match handlers, both caller inventories
complete, no hidden U1/U2 production-file collision.

## Rulings (orchestrator, binding for v3)

1. **BLOCKER — ownership-loss branches map to confirmedDead without identity proof** —
   ACCEPT. `stopDaemon` pins the original record (pid + identity fields) at snapshot;
   every recheck probes THAT identity, never a re-read of the current pidfile. A
   replaced record is `unknown` (confirmedDead:false) unless the original pid is
   directly proven dead or provably foreign. `ps`/probe failure (incl. EPERM, which
   means alive) → new `unknown` outcome, confirmedDead:false, exits nonzero.
   Reopens round-1 ruling 9 with new evidence; the reopen is justified.
2. **BLOCKER — quarantine/save TOCTOU can delete a concurrently saved valid
   credential** — ACCEPT. Cross-process serialization: a `credentials.lock`
   sibling taken with `wx` (stale-lock policy: age-based takeover with pid tag,
   documented) held across classify→quarantine→save/rename for BOTH load-side
   quarantine and save preflight. rbox is the only writer (cooperative-writer
   framing, same trust model as 149). Handle-identity (`lstat`→open→`fstat`
   compare) required on the source before preservation.
3. **HIGH — 200k item cap rejects released v1.7.2 non-full recovery traffic** —
   ACCEPT. `maxItems = 250_000` (matches the server accounted-ref ceiling,
   commit-accounting.ts:48; 250k×67B ≈ 16.75MB < 16MiB so the byte cap holds).
   Client chunking still ships in the same unit.
4. **HIGH — roots-cap breach (>750k) yields warn:false** — ACCEPT. The cardinality
   throw becomes a distinct `outcome:"roots_cap_exceeded"` carrying a lower-bound
   sample `{value: 750_000, lowerBound: true}`; health warns on it unconditionally.
5. **HIGH — observation read-modify-write races** — ACCEPT. Single-statement
   monotonic upsert (`ON CONFLICT DO UPDATE ... WHERE` newest `at` wins; sample
   merged preserving newest `measuredAt`). No read-then-write.
6. **HIGH — stripe webhook pre-auth unbounded body** — ACCEPT. Bind into Unit 2
   with a RAW capped read (existing counting reader; exact bytes preserved for
   signature verification), 1 MiB, 413 on overflow. It is row 19; it is exempt
   from cappedJson shape validation (signature first, then existing parse).
7. **MEDIUM — field caps reject currently-succeeding released-client traffic** —
   ACCEPT-MODIFIED. Display fields (`label`, `accountName`): server TRUNCATES at
   the documented byte max (preserving today's semantics), never 400s. Secrets/
   structured tokens keep strict rejection; the 4,096B bootstrap secret cap is a
   new declared limit on an operator-controlled input, documented as such.
8. **MEDIUM — breach `rows` not the breach snapshot's count** — ACCEPT-MODIFIED.
   Document `rows` as a post-breach observation (separate statement, may drift by
   concurrent writes); no transactional coupling for an observability field.
9. **MEDIUM — sample not globally point-exact** — ACCEPT. Rewrite as
   "complete per-workspace-consistent traversal ending at measuredAt".
10. **MEDIUM — release-stage observation vs releaseLeaseWithRetry void contract** —
    ACCEPT-MODIFIED. Helper returns a typed outcome instead of throwing; gcPurge
    records `stage:"release"` on failure WITHOUT altering the response (cleanup
    failure never replaces the operation result — the design's own invariant).
    The "record and rethrow" requirement is dropped for release specifically.
11. **MEDIUM — malformed UTF-8 survives via non-fatal TextDecoder** — ACCEPT.
    `cappedJson` decodes with `{fatal:true}` → 400 `bad_request_shape`. Wrapper
    layer only; existing readBodyCapped consumers unchanged.
12. **LOW — front-door test anchor overclaims** — ACCEPT. Fix appendix wording;
    Unit 3 tests add a real wrapper-routing/desired-state test.
13. **LOW — stub inventory incomplete** — ACCEPT. Add autostart-cmd.test.ts:55
    and uninstall-cmd.test.ts:26 stubs to the appendix ranges.
14. **EDITORIAL — "D1 subrequest" naming** — ACCEPT. Rename to Worker
    service-subrequest formulas; arithmetic unchanged.

---

# Round 3 (fresh eyes, v3) — 7 findings, verdict CHANGES-REQUIRED

Verified without findings: load-side lock acquisition coherent; the
lstat→O_NOFOLLOW-open→fstat handle protocol closes the round-2 interleaving on
both platforms (bigint dev/ino, handle retained through fenced removal);
250,000-SHA arithmetic exact (16,750,010 B, 27,206 B margin); all anchors
resolve.

## Round-3 rulings (orchestrator, binding for v4)

1. **BLOCKER, identity attestation** — ACCEPT-MODIFIED. Pinned identity =
   (pid, record bootId, OBSERVED process start-time) captured at first probe
   via the existing platform probes (`src/engine/git/lockfile.ts:225`); every
   recheck re-observes start-time and requires equality. Same-root PID-reuse
   imposters fail the start-time match → `unknown`. The probe→signal window
   remains a documented accepted residual (bounded to signaling a reused PID
   within one tick); on Linux, feature-detected `pidfd_send_signal` is named
   as OPTIONAL hardening, not a step-1 requirement. Strict race-freedom is
   explicitly NOT claimed; the contract text changes from "proves" to
   "attests under the cooperative model with the named residual".
2. **BLOCKER, absent record ≠ dead** — ACCEPT. A per-root daemon lifecycle
   lock (engine lockfile machinery: link-published, age-reaped) is acquired
   by start (held across spawn→record-write), stop/untrack/uninstall
   (held across read→decision→destructive follow-on), and replacement start.
   `no-pid/absent` is `confirmedDead:true` ONLY while holding the lock;
   without it, absent → `unknown`. Manual record deletion under a live
   daemon is thereby also caught (the lock holder re-lists before acting).
3. **HIGH, marker publication** — ACCEPT. Both `credentials.lock` and fence
   markers publish all-or-nothing via the repo's temp+fsync+hardlink pattern
   (`lockfile.ts:709`). Malformed-marker refusal stays (now only reachable by
   tampering).
4. **HIGH, clearCredentials policy** — ACCEPT-MODIFIED. Logout acquires the
   lock under the normal stale policy; on exhausted/malformed acquisition it
   performs the ONE sanctioned destructive-recovery override (unlink lock +
   credentials, explicit warning naming the override). "Always clears"
   survives; the in-flight-save republish race is closed on the normal path;
   the override is bounded to logout alone.
5. **MEDIUM, upsert merge/ties** — ACCEPT. v4 specifies the exact SQL:
   WHERE admits (newer envelope OR newer sample); per-component CASE merges.
   Ties: equal `at` → existing envelope wins UNLESS the incoming outcome is
   `roots_cap_exceeded` (severity outranks); equal `measuredAt` → a complete
   sample outranks `lowerBound:true`. Tests cover the reviewer's T1/T2/T3
   interleaving and both tie cases.
6. **MEDIUM, stripe bound evidence** — ACCEPT-MODIFIED. 1 MiB ships now with:
   observed-size recording on every webhook (the measured-evidence stream),
   a structured overflow warning (content-length + signature presence; body
   is unreadable by definition), and a runbook entry: oversized events appear
   in Stripe's failed-deliveries dashboard; operator fetches the event via
   API and reconciles or raises the cap. No pre-ship measurement gate.
7. **MEDIUM, downstream UTF-16 slicing** — ACCEPT. Order: shape validation →
   600-byte UTF-8 boundary truncation → CODE-POINT-SAFE display truncation
   (pairing.ts:97 and sanitizeWorkspaceName's slice become surrogate-safe).
   Display fields additionally require `isWellFormed()` (escaped lone
   surrogates pass fatal TextDecoder) — reject 400 on ill-formed.

---

# Round 4 (fresh eyes, v4) — 16 findings, verdict CHANGES-REQUIRED

Verified: the upsert SQL compiles and honors all tie rules against the real
gc_state schema (no migration needed for two KV keys); start-time probes
implementable on both platforms with exact string equality.

## Round-4 rulings (orchestrator, binding for v5) — RE-SCOPE

Round 4 expanded (7→16). The identity/lifecycle machinery introduced by my
round-3 rulings is generating surface faster than it closes it. Ruling: Unit 3
returns to CONTAINMENT scope; the integrity machinery is extracted to a new
design 155 (daemon lifecycle integrity), queued, not blocking Phase 0.

**The v5 Unit 3 contract (supersedes v4's identity/lock mechanisms):**
- Consent split (--yes deletion consent, --force escalation consent) —
  unchanged, settled since round 1.
- Confirmation authority is ESRCH-definitive ONLY: stale-pid (probe ESRCH),
  graceful (post-TERM ESRCH), force-kill-confirmed (post-KILL ESRCH),
  and ESRCH at a signal seam (its own named variant, F10). An alive PID that
  cannot be definitively classified → `unknown`, fail closed, actionable copy
  naming the pid and the manual remedies; `--force` is the human override.
- NO bootId/start-time pinning, NO per-root lifecycle lock, NO rebind
  controller unification, NO upgrade/uninstall lock ordering in 151. The
  start spawn→publish window and PID-reuse-with-live-process attestation are
  RECORDED as pre-existing races, named as design-155 scope (F1, F2, F3, F4,
  F5, F6, F7, F8, F9 all fold into 155's problem statement verbatim).
- Appendix A drops the sole-controller claim (F9): stopDaemon is the sole
  ESCALATION controller; rebind's no-escalation TERM path is named as-is.

Per-finding: 1→155 (the ps-substring evidence stands; 151 stops claiming
attestation). 2,3,5,6,7,8→155 verbatim. 4→ACCEPT-MODIFIED: untrack acquires
the EXISTING sync mutex (already the repo's serialization primitive for
root-mutating operations) before deletion — no new lock, total order = mutex
only. 9→ACCEPT (narrowed claim). 10→ACCEPT (named variant).
11→ACCEPT: override extends to any post-acquisition fence/publication
failure — the rule becomes "logout clears unless it cannot do so SAFELY;
every unsafe-path failure prints the manual remedy". 12→ACCEPT: override
deletion runs the same safe-chain/no-follow validation as save; unprovable
safety → refuse + manual remedy (bounded exception to "always clears",
documented). 13→ACCEPT: discriminated reader result {ok,bytes} |
{overflow,bytesCounted} | {error,bytesCounted} — small util change, needed
for truthful observation. 14→ACCEPT-MODIFIED: the evidence-stream ambition is
DELETED; overflow logs one structured line (content-length claim, counted
bytes, signature presence) as anomaly signal only — never cap-raising
evidence; cap changes require Stripe-side corroboration. 15→ACCEPT-MODIFIED:
runbook = raise cap via env/config, then resend the event from Stripe's
dashboard (existing capability); no replay surface is built or claimed.
16→ACCEPT (scope label, anchor range).

---

# Round 5 (fresh eyes, v5) — 8 findings, verdict CHANGES-REQUIRED

Re-scope honored (no extracted races re-raised). Unit 1 clean; Stripe model
coherent; 19-route count and anchors verified.

## Round-5 rulings (orchestrator, binding for v6)

1. **HIGH, override vs in-flight save** — ACCEPT-MODIFIED. Override cleanup
   is honestly non-definitive under a concurrent sign-in: after unlinking,
   logout verifies absence and prints the idempotent remedy ("cleared; if
   another rbox process was signing in concurrently, run `rbox logout`
   again"). The normal locked path remains definitive. No refusal — the
   escape hatch survives.
2. **HIGH, untrack teardown order** — ACCEPT. Daemon runtime deletes FIRST;
   `.rbox` teardown is an ordered walk with `state/sync.lock` as the
   TERMINAL delete; partial-failure and queued-contender tests required.
3. **MEDIUM, zombies** — ACCEPT. A post-signal persistent pid gets a state
   probe (Linux `/proc/<pid>/stat` state `Z`; macOS `ps -o state=`): zombie →
   new `zombie-dead` outcome, confirmedDead:true (a zombie cannot execute).
   Non-zombie persistence keeps today's timed-out/kill-unconfirmed mapping.
4. **MEDIUM, pre-signal ESRCH rows** — ACCEPT. Pre-TERM probe ESRCH →
   `stale-pid`; pre-KILL probe ESRCH → `graceful`. Explicit table rows; no
   signal is sent after an absence observation.
5. **MEDIUM, exception outcome** — ACCEPT. Union gains
   `{kind:"error", errorClass, confirmedDead:false}`; the one-JSON-object
   promise covers it; exit 1.
6. **MEDIUM, invalid env credentials** — ACCEPT. Invalid auxiliary env
   values produce a typed `invalid-environment` state (detail names the
   variable), failing closed in strict flows; never silently ignored.
7. **LOW, reader consumers** — ACCEPT. blob-pack/blob-batch mapping:
   ok→bytes, overflow→legacy null/status, error→rethrow; named in Unit 2.
8. **LOW, stripe cap config** — ACCEPT. `RBOX_STRIPE_WEBHOOK_MAX_BYTES`
   (validated int env, default 1 MiB) is defined in Env + both wrangler
   environments; runbook notes Stripe's 15-day resend window.

---

# Round 6 (fresh eyes, v6) — 5 findings (2 MEDIUM, 2 LOW, 1 EDITORIAL) → ALIGNED v7 (self-certified)

Verified clean: 19 routes, six credential states, five confirmed-dead
outcomes, untrack delta, stripe env pattern, reader seams; no 155 re-raise.
Rulings applied directly by the orchestrator: (1) escalated = observed
SIGKILL-sent, zombie-dead gains phase, error gains pid/phase; (2) teardown
excludes lock-ancestor dirs until the terminal phase, marker retention is
pre-release-only with post-release residue reporting, contended waiters
re-verify binding identity before republishing; (3) esrch-at-signal collapses
to one paired `at` field; (4) caught-500 vs thrown recording stated;
(5) reproduced v4 links marked historical/non-resolving. Self-certified
ALIGNED per the convergence rule.
