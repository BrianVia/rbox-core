# Design 226 — git capture uploads AFTER the decision, not before

Status: **SELF-CERTIFIED FOR IMPLEMENTATION** — rounds 1-3 review folded, the
3-round cap closed. Mechanism ratified by the founder and confirmed sound in
round 3; anchors re-verified against `fix/git-capture-upload-before-decide`.

## §0 Level-set — what "helped" means, falsifiably

**Helped.** A repo whose git section is decided AGAINST — carried, reverted,
deferred — costs zero bytes on the wire. Falsifiable two ways:

1. **Test.** A forced-capture plan tick whose `provePendingSupersession` fails
   performs **zero** `put`/`putFile` calls on the workspace `BlobStore` for that
   candidate. Counted with a recording store (pattern at
   `src/engine/git-state.test.ts:578-594`), asserted `=== 0`, not "small".
2. **Field.** On the founder's daemon, with `Personal/rbox-core` still
   permanently deferred for `local-index`, the receipt count in the push
   instrumentation stays flat across hours of push ticks instead of growing
   ~1/tick.

**What could get worse.** All accepted; §2 rules on each.

- **Blast radius (deliberate regression).** Today an upload fault is a CAPTURE
  fault: the per-repo `catch` at `src/cli/sync-git/plan.ts:1096-1099` defers
  THAT repo with base carry while the push proceeds (invariant in code at
  `plan.ts:1065-1068`). After this change the flush is an all-or-nothing
  barrier (§2.2), so one repo's upload fault fails the whole push. Deliberate:
  the alternative is publishing a section whose bytes are missing, and §2.2
  shows the per-repo rescue is unsound for the repos that matter.
- **Disk.** Retention moves the temp-disk budget from SEQUENTIAL to
  SIMULTANEOUS; §2.3 states the arithmetic and bounds it.
- **UX.** `gitcap` byte progress fires today from inside capture
  (`plan.ts:1073-1082`, emit at `:1081`). Splitting encrypt from upload splits
  that number; §2.5 rules `bytesDone` follows the wire.
- **Nothing re-encrypts.** We explicitly do NOT pay re-encryption CPU (§2.3).

Not in scope as "help": the `local-index` permanent deferral itself (§4).

## §1 The problem

### 1.1 Field measurement

The founder's daemon uploaded one ~2.9 MB blob per push tick for 13.5 hours:
**9,982 push ticks, 9,983 upload receipts**, ~29 GB, none of it referenced by
any commit. The chain, each link verified in this worktree:

1. `Personal/rbox-core` git-sync is permanently deferred with reason
   `local-index` (`src/cli/sync-git/follow.ts:607`), so
   `state.gitPendingRemote[repo]` never clears.
2. That stuck pending makes `pendingSupersessionPreProbe`
   (`src/cli/sync-git/pending-supersession.ts:89`) return something other than
   `"carry"`, so the repo joins `pendingSupersessionCandidates` and runs
   `processRepoSlowPath(..., { forceCapture: true })` every tick
   (`plan.ts:903`).
3. Capture UPLOADS before anything is decided: `plan.ts:1086`
   `capturePlannedGitSection` → `src/cli/sync-git/shared.ts:243-288` →
   `captureGitState` → `putGitArtifact` (`src/engine/git/shared.ts:755-782`) →
   `src/cli/remote/blobs.ts:113` `ctx.captureReceipt(...)`.
4. The section is then DISCARDED. `provePendingSupersession`
   (`pending-supersession.ts:193-233`) fails and `revertCapture`
   (`plan.ts:243-258`) splices the repo out of `captured` (`plan.ts:1320-1350`,
   revert at `:1350`). The plan line then prints `captured 0`, which HIDES the
   upload that already happened.
5. The push short-circuits before redeem: `src/cli/sync/push.ts:665-668`
   returns on `sealed.admission === "no-op"`, so the receipt is neither
   redeemed nor discarded and receipts accrete for the daemon's lifetime
   (`src/cli/remote/context.ts:35` holds the map; the comment at `:31-34`
   states the invariant this breaks). The next real commit drains the backlog:
   `src/cli/remote/commits.ts:209` loops `while (ctx.receipts.size > 0)` and
   the server grants + charges a ref for each.

### 1.2 Three facts that make it worse than it looks

- **`store.has()` can never hit for these.** `RemoteBlobStore.has`
  (`src/cli/remote/api.ts:231-233`) asks `missingBlobs`; a receipts-protocol PUT
  writes the canonical key with **no D1 row** (`apps/api/src/blobs.ts:239-250`
  moves charge + grant + `present=1` to commit), so the blob reads as absent.
  **The leak does not need content to change.**
- **Recompaction captures twice.** `shared.ts:283-288`: when
  `exceedsPackChainByteBound` (`:184`) trips, a second full `capture()` runs at
  `:287`, so one forced tick can upload two bundles.
- **A per-tick upload is ≥ 3 PUTs, not 1.** `captureGitState` calls
  `putGitArtifact` for the bundle (`src/engine/git/capture.ts:332`), the staged
  index (`:335`), and each worktree's op-state (`:338`), none of which
  `has()`-hit. The receipt *map* is keyed by encSha, so byte-identical
  index/op-state artifacts collapse to one entry: the measured 9,983 receipts
  UNDERSTATES the PUT count (bandwidth ≥ 29 GB; code inference, not a second
  field measurement). That collapse is also why the flush must not clean up per
  file (§2.2).

### 1.3 Two corrections to record

- **Reclamation is `gcMark` on the canonical prefix**
  (`apps/api/src/gc-mark.ts:47-53`: `blobs/sha256/`, unreachable + past grace →
  `gc_candidates`), **not staging GC** — `gcStagingSweep` lists `staging/` only
  and can never see a direct-write canonical blob.
- **Receipts expire server-side after 12h** (`apps/api/src/receipts.ts:10`,
  `RECEIPT_TTL_MS`), so a 13.5-hour backlog is not uniformly chargeable — the
  oldest entries 422 and are dropped (`commits.ts:264-281`). Do not claim the
  full 29 GB gets billed.

### 1.4 Why not fix the trigger

Backing off forced capture for this one trigger leaves the class intact: EVERY
path that captures then declines to publish leaks the same way — the
supersession revert at `plan.ts:1350`, the unreadable revert at `:1145`, the
composer reverts at `:1256`/`:1274`/`:1289`/`:1298`. The upload site is the
defect; the trigger is one of six discoverable entrances to it.

## §2 Mechanism — split encrypt from upload; flush after the decision

### 2.1 What the decisions actually read

- **The section needs nothing from the round-trip.** The `GitArtifactRef` at
  `src/engine/git/shared.ts:773` is built entirely from `encryptFileToTemp`'s
  local result; `store.has`/`store.putFile` (`:766-771`) contribute no field.
- **The decisions read TWO lanes.** *Pending / pack-chain artifacts — remote,
  already committed:* `pendingSupersessionPreProbe`
  (`pending-supersession.ts:89-138`) takes no store at all;
  `provePendingSupersession` (`:193-233`) compares field-wise (`:203-228`) and
  reads only `input.pending` via `pendingIndexIsCleanAndPlain` (`:230`, helper
  at `:148`). *The FRESH CANDIDATE's index — local, not yet uploaded:*
  `finalResolutionReport` (`src/cli/sync-git/resolution-intent.ts:289`)
  projects the candidate through the store —
  `pendingIndexProjection(args.ctx, args.candidate, args.store, args.kek)` at
  `:298`, doing `getGitArtifact(store, …)` at `:153` — called from
  `plan.ts:1293`, BEFORE any proposed flush point. **Without a local source for
  those bytes the GET 404s, the lane goes indeterminate, and keep-mine can
  NEVER publish**; a prototype of the naive design failed 10 `design 177`
  keep-mine tests exactly here.
- **Remedy: a plan-local read-through store**, so fresh-candidate reads resolve
  locally without a PUT:

  ```
  planReadThroughStore(
    remote: Pick<BlobStore, "get" | "getToFile">,
    retained: Map<encSha, ctPath>,
  ): Pick<BlobStore, "get" | "getToFile">
  ```

  `get`/`getToFile` consult `retained` first (returning the ciphertext bytes a
  remote GET would; decrypting stays the caller's job) and fall back to
  `remote` for pending/pack-chain artifacts. Constructed once per
  `planGitSections`, passed as `store` to `finalResolutionReport`
  (`plan.ts:1293`) and `provePendingSupersession` (`plan.ts:1327-1328`) in place
  of the bare `api.blobStore()`; capture and the flush keep the bare store. It
  also removes an existing needless round-trip — today the candidate's freshly
  uploaded index is downloaded back to project it.

  Three structural requirements, each replacing a rule someone must remember:

  - **Narrow the type; do not wrap `BlobStore`.** It has exactly five members
    (`src/engine/blobstore.ts:13-29`) and a wrapper's `has`/`put`/`putFile`
    would be unreachable — the flush uses the bare store. The `Pick<…>` above
    makes "`has` must reflect the SERVER, never local retention" unstatable
    rather than documented. **There is no full-`BlobStore` fallback variant** —
    not a throwing one, not any other. A wrapper carrying `has` is the exact
    member this narrowing exists to make unconstructable, and it is the path of
    least resistance for anyone who hits a signature mismatch.

    The narrowing therefore obliges widening **eight declaration sites**, all of
    which today demand the full interface, and none of which would typecheck
    against the `Pick` without this change. Transitively these functions touch
    no store member but `getGitArtifact`'s, which uses only `getToFile` then
    `get` (`git/shared.ts:786-787`) — so the narrowing is feasible, not merely
    desirable. The complete list, to be widened to
    `Pick<BlobStore, "get" | "getToFile">`: `src/engine/git/shared.ts:784`
    (`getBlobToFile`), `:793` (`getGitArtifact`),
    `src/cli/sync-git/resolution-intent.ts:142` (`pendingIndexProjection`),
    `:169` (`pendingOpStateOids`), `:253` (`preliminaryResolutionReport`),
    `:293` (`finalResolutionReport`), and
    `src/cli/sync-git/pending-supersession.ts:151`
    (`pendingIndexIsCleanAndPlain`), `:197` (`provePendingSupersession`). A full
    `BlobStore` stays assignable to the `Pick`, so **no other caller of these
    eight is affected** — the widening is source-compatible everywhere.
  - **Define `getToFile` presence-conditionally.** It is optional
    (`blobstore.ts:19`) and feature-detected by every caller
    (`git/shared.ts:786`, `src/engine/apply.ts:352`, `:369`). Defining it
    unconditionally over a store lacking it calls `undefined(...)` — latent, and
    CI-green because every in-tree store implements it. Define it only when
    `remote.getToFile !== undefined`, or implement it over `get`.
  - **A retention MISS must be loud.** `pendingIndexProjection` wraps its read
    in `catch { return { kind: "indeterminate" } }` (`resolution-intent.ts:163`)
    and cannot tell absent from read-failed; both become a silent keep-mine
    refusal with an unactionable reason — the failure mode that cost round 1 a
    ten-test debugging cycle. When `retained` HAS an entry whose file is
    unreadable, throw a distinct, logged error naming encSha and path; never
    fall back to `remote`.

- **Determinism — load-bearing only for the REJECTED re-encryption alternative
  (§2.3).** No ref is ever recomputed at flush. For raw git artifacts under a
  fixed KEK, `encryptFileToTemp` (`src/engine/crypto.ts:339`) →
  `encryptFileToTempInline` (`:241`) derives key and nonce convergently from
  content (`deriveKeyNonce`, `:141`, used at `:298`), so only the temp PATH
  varies per call. Caveats: general file encryption also depends on compression
  options (git artifacts are never compressed), and `encryptFileToTempInline`
  re-snapshots the SOURCE every call (`crypto.ts:246-250`), so determinism holds
  only against a stable source — why §2.3's retry ruling matters.

### 2.2 Shape

Split `putGitArtifact` (`src/engine/git/shared.ts:755-782`) into:

- `encryptGitArtifact(kek, srcPath, retainDir, opts) -> { ref, pending }` — runs
  `encryptFileToTemp`, moves the ciphertext to a **per-call unique path** under
  the plan retention dir, returns the `GitArtifactRef` plus a handle naming that
  path and the cipher size. No store.
- `flushGitArtifact(store, pending, opts) -> void` — the existing
  `has`/`putFile`/`put` body plus the mismatch retry (§2.3), and **no per-file
  cleanup**. Retention is keyed by `encSha`, artifacts collapse across repos
  (§1.2), and the flush points are staggered (§2.3), so per-file cleanup can
  delete the ciphertext a still-retained repo's read-through GET needs. `remote`
  cannot rescue that: a receipts PUT early-returns at
  `apps/api/src/blobs.ts:261` having written only the canonical R2 key and
  granting no entitlement (the D1 writes at `:272`/`:282` are the non-receipts
  path), and `blobGet` gates on `isEntitled` before R2 (`:334`), so the GET 404s
  into `pendingIndexProjection`'s `catch → indeterminate`. The single `finally`
  sweep of the retention dir already reclaims everything, including the
  recompaction path's discarded first capture.
- `putGitArtifact` **stays** as the composition of the two, keeping its current
  signature for direct/engine callers.

**`captureGitState` keeps flushing inline UNLESS the caller supplies a
pending-upload collector; only `capturePlannedGitSection` supplies one.** This
is the contract, not a compatibility concession. `captureGitState` has 74 call
sites across 15 files besides `sync-git/shared.ts` — seven of which read the
artifacts straight back out of the store the capture wrote them to, so a
collector-by-default would break them at runtime, not just at the type level:
`src/engine/git-nested.test.ts:227` captures into a `LocalBlobStore` whose only
writer is that capture and then calls `applyGitState` over it at `:235`;
`src/engine/git-state.test.ts:293` captures, then reads
`store.get(section!.bundleEncSha)` at `:297`; and `git-sync.test.ts:1078`,
`:1108`, `:3641`, `:3731` each capture into `remote.blobStore()` to fabricate
another device's pending section — those artifacts must really be in the remote
store or `pendingIndexIsCleanAndPlain` (`pending-supersession.ts:148`) 404s and
the design-174/177 lanes go indeterminate. `putGitArtifact` surviving (above)
does NOT cover them: they call `captureGitState`, not `putGitArtifact`. An
implementer who instead makes deferral unconditional faces ~50 red tests with an
obvious wrong fix available — put the upload back inside `captureGitState`,
i.e. undo this design.

`capturePlannedGitSection` supplies the collector and returns the pending uploads
alongside the section, and **the recompaction second capture REPLACES the first
capture's pending-upload list** — `sync-git/shared.ts:272` then `:287` return
only the second section, so the first capture's artifacts must never reach the
flush (a full wasted bundle).
`planGitSections` (`plan.ts:154`) accumulates them per repo and flushes **only
the pending uploads of repos still in `captured`**, at the two points §2.3
fixes. `revertCapture` (`plan.ts:243-258`) is NOT modified — the surviving
`captured` filter already excludes reverted repos and the `finally` sweep
reclaims their bytes.

**Specify the `finally` sweep; it does not exist yet.** Four sections above rely
on it and `planGitSections` (`plan.ts:154`) has **no top-level `try`/`finally`
today** — the only two in its body are inside inner closures (`plan.ts:190-192`,
the `timed` wrapper; `plan.ts:1085-1099`, the per-repo capture). **Wrap
`planGitSections`' body so the plan's retention dir is removed on every exit,
including a throw.** That single sweep is the only reclamation (there is no
per-file cleanup), and it covers the recompaction path's discarded first capture,
every reverted repo's bytes, and the all-or-nothing barrier's rejection.

**Flush is an all-or-nothing barrier.** Any `has`/PUT failure rejects
`planGitSections` outright; the `finally` cleanup still runs; no manifest
proceeds. A per-repo `catch { revertCapture }` is unsound **for any repo that
passed `commitAbsentBranchVerification` (`plan.ts:1239`) or `pinDisplaced`
(`plan.ts:1307`)** — both have done irreversible work by the flush point and
`revertCapture` clears neither. That set is not statically known at the flush,
which is why the barrier is global; do not over-generalize the constraint to
repos that merely captured. The invariant, verbatim, pinned by a test in §3:

> `planGitSections` returns only after every fresh artifact referenced by its
> final captured sections is either already remotely satisfied or successfully
> flushed.

**Flush dedupe is FLUSH-TIME ONLY.** One per-plan `Set<encSha>`; an `encSha`
enters it **only after `has === true` or a successful PUT** — never at retain
time. Per-plan and never persisted, so it cannot mask a
`gitForceForMissingBlobs` recovery (§2.5).

### 2.3 Ruling: RETAIN the ciphertext, per call, under the gitcap scratch root

Re-encrypting at flush is CPU-cheap and safe, but it does not avoid retention —
it requires the **plaintext** bundle to survive the decision window instead, and
the plaintext is larger. It buys nothing on the axis it was proposed to fix and
costs a second AES-GCM pass over every bundle on the slowest phase of a first
push. **Retain the ciphertext, free the plaintext at the end of capture** — the
same point capture frees it today.

**Retention paths are unique per CALL, not per content.** Recompaction's two
captures stage the same index and op-state files, and encryption is convergent,
so both produce the SAME `encSha`. Keying retention *paths* by `encSha` makes
the second capture's published section reference bytes the first capture's
cleanup deletes — a prototype retaining as `<encSha>.ct` failed 42 tests with
ENOENT out of the flush. Mirror `encryptFileToTempInline`'s own rule
(`crypto.ts:246-249`: random-named, "so concurrent calls never share a path").
The `encSha` set in §2.2 is a flush-time dedupe and nothing else.

**Retention lives under the gitcap scratch root, not `.rbox/state/uploads`.**
`plan.ts:1083`'s `uploadsDir` is the resumable-multipart TOKEN directory
(`src/cli/remote/multipart.ts:69`, `${sha256}.json`) — persistent state with no
sweeper; a category error. **Export `makeGitCaptureDir`
(`src/engine/git/capture.ts:174-185`) and REUSE it** — do not reimplement it.
Its mkdtemp-then-rename dance is load-bearing: the staging name
`.rbox-gitcap-*` deliberately does not match the sweep's `rbox-gitcap-` prefix,
which protects the window before `owner.pid` is written. Reuse also inherits the
crash reaper — `sweepStaleGitCaptureDirs` (`capture.ts:150-172`) removes
`rbox-gitcap-*` dirs whose `owner.pid` is dead or absent or older than
`GITCAP_STALE_MS` (`:41`), and runs on every `makeGitCaptureDir` (`:178`) — so
**there is no new crash-cleanup obligation**, and the `owner.pid` that keeps the
absent-owner sweep branch from deleting the dir mid-plan under
`GIT_CAPTURE_CONCURRENCY` is written for free.

`captureGitState`'s `finally` does `fs.rm(tmpDir, …)` (`capture.ts:391-394`, rm
at `:393`), so retained ciphertext MUST be moved out of `tmpDir` first — the
prototype hit this. `src/engine/git-state.test.ts:600-602` already asserts
upload paths sit under `gitCaptureScratchRoot(workspace)` (`capture.ts:115`);
that INTENT survives this choice and would have broken under the uploads-dir
choice. The assertion itself could not have observed it, though: the paths come
from `recordingStore.putFile` (`git-state.test.ts:590-593`) and `:598` asserts
`uploadPaths.length > 0` before the loop, so a deferring capture would fail there
and never reach it. **Ruling 1 makes that evaporate** — `git-state.test.ts:596`
supplies no collector, so it flushes inline, `putFile` is still called, and the
test is untouched. It is not on any change list.

**Disk arithmetic, honestly.** `MAX_GIT_REPOS = 256`
(`src/engine/manifest-validate.ts:22`) and a first push captures all of them
full-history, 4-wide (`GIT_CAPTURE_CONCURRENCY`, `sync-git/shared.ts:19`), each
in-flight capture already holding the plaintext bundle plus an immutable
encryption snapshot (`crypto.ts:246-250`). "Strictly the bytes we are about to
send anyway" is right in shape and wrong in risk: that is a SEQUENTIAL budget
today, a SIMULTANEOUS one after. Peak ≈ (4 × in-flight plaintext + snapshot) +
Σ cipherSize over every repo retained through the decision window.

**And recompaction doubles that per-repo term.** A repo tripping
`exceedsPackChainByteBound` (`sync-git/shared.ts:184`) retains BOTH captures'
ciphertexts until the sweep: retention paths are unique per call (above), the
flush does no per-file cleanup (§2.2), and the first capture's pending list is
discarded rather than freed. The bound trips when the increment ≥
`chain[0].cipherSize` (`shared.ts:186-187`), so such a repo's retained peak is
~2× a full bundle. That is the honest number; it is bounded, not unbounded, and
the two flush points below are what keep the Σ small.

**Bound it by flush POINT, not by repo set — retain for ALL captured repos.**
An earlier draft flushed repos in neither `pendingSupersessionCandidates` nor
`resolutionCandidates` immediately and retained nothing for them. The
set-membership premise is sound (`resolutionCandidates.add` `plan.ts:878` and
`pendingSupersessionCandidates.add` `:901` both precede the capture pool at
`:1084`) but insufficient: the unreadable revert (`:1145`), the absence-witness
revert (`:1256`) and the tombstone-exactness revert (`:1274`) reach any captured
repo, are the leak class §1.4 cites as the reason to fix the upload site, and an
absence-proof refusal is persistently repeatable — so it leaks per tick, not
once. Bound disk with TWO incremental flush points instead:

1. **After the tombstone-exactness loop closes (`plan.ts:1280`)** — every repo
   the unreadable/absence/tombstone reverts can touch has been decided. Flush
   all surviving `captured` repos in neither candidate set.
2. **After the supersession loop closes (`plan.ts:1351`)** — flush the rest.

§0's "helped" claim stands as written: neither point precedes a decision that
can revert the repo being flushed.

**Mismatch retry uses the retained ciphertext.** `putGitArtifact`'s loop today
re-enters `encryptFileToTemp` from the staged plaintext
(`git/shared.ts:762-778`), which capture deletes on return (`capture.ts:393`) —
the prototype failed both `git artifact sha_mismatch` tests. Do NOT retain the
plaintext to fix this. On `BlobShaMismatchError`, re-verify the retained
ciphertext locally (`hashFile(path) === encSha`, `src/engine/hash.ts:15`) and
retry the SAME bytes; **fail closed** if verification fails. Multipart already
drops its stale resume token on mismatch (`multipart.ts:33-39`).

### 2.4 The hard ordering constraint

Git artifact blobs live in `manifest.gitRepos`, not `manifest.files`, so they
are added to `blobRefs` explicitly — the comment at
`src/cli/e2ee-remote.ts:770-773` and the union in `blobRefsForManifest`
(`:141-155`, git branch at `:151-154`). They must be in R2 **before**
`api.commit` sends the refset (`src/cli/sync/push.ts:807`). Flushing inside
`planGitSections` — which runs in the `git-plan` phase (`push.ts:520`, the
`planGitSections` call at `:530`), long before `encryptAndUpload` (`:686`) and
`api.commit` — satisfies that deadline with margin, inside the same mutation
lease (`push.ts:521`).

### 2.5 Constraints and progress reporting

- **`gitForceForMissingBlobs`** (`plan.ts:1481-1488`, wired at `push.ts:229` →
  `push.ts:530`) re-captures repos whose committed sections reference a missing
  `encSha`. Those repos capture, are not reverted, and flush; `store.has()`
  returns false (the server said missing) so the PUT happens. The per-plan
  dedupe set starts empty each plan, so recovery is never short-circuited. A
  test pins this (§3).
- **Progress reporting.** `noteRepoBytes` (`plan.ts:1073-1082`) converts
  `putGitArtifact`'s `onBytes` (`capture.ts:320-330`) into `gitcap` `bytesDone`.
  Decision: **`bytesDone` follows the wire** — it moves to the flush and arrives
  as two bursts at the §2.3 flush points. The completed count (`captureDone` /
  `repoCount` / `detail`) keeps ticking during capture, which is what keeps the
  long silent phase alive (`onProgress` doc comment, `plan.ts:161-164`). A late
  byte curve beats a byte number that lies.

### 2.6 What actually protects a wrongly-skipped flush

Recorded because it sets the severity class of this whole area. The load-bearing
protection is **the server's 422 fence, not any client-side guard.** Whatever
makes `store.has()` report a blob satisfied is the same
entitled-AND-`present=1` predicate commit admission uses — `blobsCheck`
(`apps/api/src/blobs.ts:136-213`) is what `RemoteBlobStore.has` reaches, and
`validateCommitRefs` (`apps/api/src/commit-accounting.ts:118-148`) is the
admission predicate itself. Both run the same `blob_refs ⋈ blobs present=1`
SELECT behind the same `blob_ref_candidates` and `gc_candidates` barriers
(`blobs.ts:156-163` vs `commit-accounting.ts:121-124`), and `blobsCheck` adds one
further `pack_gc_candidates NOT EXISTS` clause (`blobs.ts:160-163`). So `has()`
is **strictly stricter** than admission, which is the direction that makes this
safe: `has() === true` ⟹ admission has it. A blob the flush wrongly skipped is a
blob admission reports missing: the commit fails closed with 422
`unsatisfied_blobs`
(`apps/api/src/workspace-sync.ts:553-564`, `:672-673`, `:949-951`), which drives
`gitForceForMissingBlobs` and recovery. A wrongly-skipped flush is therefore a
**wasted round trip, never silent corruption**.

The same predicate closes the loop on §1.1's field evidence. Admission also
satisfies a ref on a **valid receipt alone**, with no prior `blob_refs` row
(`commit-accounting.ts:142-144`: `verifyReceipt` ok → `verified`, then
`resolveVerifiedRefs` grants it) — that is precisely the mechanism by which a
9,983-receipt backlog of unreferenced uploads became chargeable at the next real
commit. The leak was not just wasted bandwidth; the receipts made it billable.

Closed audit, recorded so it is not re-run: no pre-commit value can reach `prev`
(`plan.ts:323-339`, where `durablePending` is assigned in last). `base` advances solely through `gitBaseAfterCommit` after
an accepted commit, `record.advertised` is written only in
`acknowledgePublishedGitTransitions`
(`src/cli/sync/publisher-ack-transition.ts:154-187`), and `durablePending` comes
from another device's accepted commit. Fresh machine, pruned pack chain,
divergence-cache miss and GC'd blob were each checked and are not holes.

### 2.7 Rejected alternative: add a receipt-discard API

`src/cli/remote/api.ts` exposes only `receiptCount()` (`:100`) and `redeem()`
(`:101`); receipts are removed un-redeemed only on the 422 path
(`commits.ts:274-278`). "Add `discardReceipt()`" adds surface, still burns the
bandwidth, still orphans the R2 object, and obliges every future
capture-then-decline path to remember to call it. Moving the upload makes it
unnecessary. **Do not add one.**

## §3 Tests the implementation MUST write

1. **The regression (primary).** Extend `design 174 B: a ref reset between
   maybe-probe and capture fails final candidate proof and carries P`
   (`src/cli/sync-git/git-sync.test.ts:3895`) — it injects a stuck pending via
   `gitPendingRemote` and fails the proof through the `afterPendingPreProbe`
   hook (`plan.ts:122`, `:902`). Wrap the plan's `BlobStore` in a counting
   decorator (lift `recordingStore` from `git-state.test.ts:578-594`) and assert
   **`put` + `putFile` calls === 0**, alongside the existing carry and `did not
   supersede` assertions.
2. **Keep-mine still publishes.** The `design 177` keep-mine suite
   (`git-sync.test.ts:1642`, `:1758`) passes UNCHANGED — the direct regression
   test for §2.1's read-through store, and what the naive design broke.
3. **The flush still happens.** For a candidate that DOES supersede (extend
   `git-sync.test.ts:1538`), assert every `encSha` in
   `gitSectionBlobRefs(plan.gitRepos[rel])` was written before the plan
   returned. Fails if the flush is wired after `api.commit`.
4. **All-or-nothing, AND recoverable.** Make one artifact's PUT throw; assert
   `planGitSections` REJECTS, no other repo's section is published, and the
   retention dir is gone. Then assert **the next push succeeds and publishes**.
   The rejection IS recoverable — `commitAbsentBranchVerification` re-proves
   absence/HEAD/ownership inside the lock before applying, `pinDisplaced` writes
   additive pins, the keep-mine receipt arms later at `push.ts:769-798`, and the
   mutation lease releases in `finally` — but a test asserting rejection alone
   would pass over an unrecoverable state.
5. **Recompaction retains per call and flushes ONLY the second capture.** Trip
   `exceedsPackChainByteBound` (`shared.ts:184`) with a small byte bound so
   `capturePlannedGitSection` takes the second-capture path at `:287`; assert
   `put + putFile calls === gitSectionBlobRefs(recompacted).length` — not merely
   that the recompacted section's artifacts flush — and that no temp survives
   the `finally`.
6. **`gitForceForMissingBlobs` still recovers.** Non-empty `force` for a repo
   whose section references a store-reported-missing `encSha`: assert the
   artifact re-flushes in that same plan even though the recaptured section is
   identical.
7. **Crash cleanup.** Throw from the supersession loop after some repos have
   captured; assert the retention dir is removed and no ciphertext leaks.
8. **Sha-mismatch: both tests change deliberately.**
   - `git-sync.test.ts:1193` ("re-encrypts and retries with resumable
     uploadsDir"): the `gitPutUploads[0].src !== gitPutUploads[1].src` assertion
     ("stale ciphertext temp was dropped and recreated") INVERTS to `===` — the
     retry re-sends the retained ciphertext after local `hashFile`
     verification. The equal-`encSha`, scratch-root and `uploadsDir` assertions
     stand.
   - `git-sync.test.ts:1214` ("retries are bounded; final failure defers with
     base carry") is an **intentional inversion — flag it as such in the
     test**, because the obvious way to make it green again is to reinstate the
     per-repo `catch { revertCapture }` §2.2 declares unsound. It asserts today:
     3 PUT calls, the push still commits `note.txt`, that repo base-carries, and
     a `deferred 1 … capture failed` log line. Under the §2.2 barrier an
     exhausted PUT rejects `planGitSections`, so NONE hold. Replace with
     `remote.gitPutCalls === 3` and `backoffAttempts === [0, 1]` (retry budget
     unchanged), the push fails, no new manifest is published, and — per test 4
     — the next push succeeds.
   - Add the fail-closed case: retained ciphertext corrupted on disk → reject.

### 3.1 Census of the tests this change INVERTS

An earlier draft closed §3 with *"everything else passes UNCHANGED, by construction
— that is a design property, not an optimistic estimate."* **That claim was false and
is withdrawn.** It was reasoned from the PRODUCTION call graph — `captureGitState`'s
74 collector-less call sites — and never enumerated the **fault-injection seams** the
suite pushes through, which is exactly where the §2.2 barrier's blast radius shows.
There are two such seams, and a census that names only one is not a census:

- **`failNextGitPut`** (`git-sync.test.ts:112`, thrown from the fake store's `putFile`
  at `:213-216`) — one artifact upload fails. Pre-226 that was a CAPTURE fault absorbed
  by the per-repo `catch` at `plan.ts:1096-1099`; post-226 it is a FLUSH fault and meets
  the barrier. Self-clearing.
- **`gitShaMismatchFailures`** (`:113`, `BlobShaMismatchError` at `:209-211`) — the
  retry-budget seam. A COUNTER; it must be reset before any recovery push.

**Five tests invert: four barrier inversions and one retry inversion.** Line anchors
are the pre-change file, matching the rest of this section.

| test | seam | pre-226 assertion that inverts |
|---|---|---|
| `D2 capture deferral survives failures and remains exact while pending is outstanding` (`git-sync.test.ts:483`) | `failNextGitPut` | expected `/post-plan network failure/` from an injected `commit` behind a durable `deferrals.capture.reason === "artifact"` lane. The barrier rejects earlier with the upload error and writes no capture observation at all, so that lane never exists |
| `a repo whose capture fails mid-push is DEFERRED with base carry; the push commits everything else` (`:1127`) | `failNextGitPut` | that repo defers with base carry while the push still commits the stable file subset |
| `git artifact sha_mismatch retries are bounded; final failure defers with base carry` (`:1214`) | `gitShaMismatchFailures` | 3 PUTs, the push commits `note.txt`, that repo base-carries, and a `deferred 1 … capture failed` log line |
| `design 174 B: upload, commit-error, and multi-writer 409 preserve every P-bound sidecar pre-ACK` (`:1506`) — **upload leg only** | `failNextGitPut` | the upload leg's push SUCCEEDS. The commit-error and 409 legs are unaffected by 226 and must keep working |

The one **retry** inversion is §3 test 8's first bullet:
`git artifact sha_mismatch re-encrypts and retries with resumable uploadsDir` (`:1193`)
— `gitPutUploads[0].src !== gitPutUploads[1].src` becomes `===`, because the retry
re-sends the retained ciphertext rather than re-encrypting from a plaintext that is
already gone. Not a barrier inversion; the push still succeeds.

**All four barrier inversions are re-expressed to ONE shape**, whose template is the
re-expressed `:1214`: the push `rejects`, `headSeq()` is unchanged, nothing is
published, the retention dir is swept (`retainedGitCiphertext(root)` is empty), **and
then a recovery push succeeds**. The recovery leg is the load-bearing part — it is what
separates a recoverable rejection from a wedge, and a test asserting rejection alone
would pass over an unrecoverable state (test 4 above). Each carries a doc comment
naming the inversion and warning against the obvious wrong fix: reinstating the
per-repo `catch { revertCapture }` §2.2 rules unsound.

One wrinkle the shape has to respect. In the `design 174 B` test a push that SUCCEEDS
supersedes P and clears the sidecars its two remaining legs need outstanding, so the
recovery assertion rides the 409 leg's own push (the first one allowed to succeed) and
checks that BOTH files the failed pushes blocked have landed — rather than adding a
push between the legs.

**These parts of the withdrawn claim do hold:**

- `captureGitState`'s **74 call sites across 15 files** (every one of them
  outside `sync-git/shared.ts`) supply no pending-upload collector, so per §2.2
  they still flush inline and are untouched. This includes the seven that read
  the captured artifacts straight back out (`git-nested.test.ts:227`+`:235`,
  `git-state.test.ts:293`+`:297`, `git-sync.test.ts:1078`, `:1108`, `:3641`,
  `:3731`) and `git-state.test.ts:596-602`'s scratch-root upload-path assertion
  (§2.3). If a change list ever grows to include these, §2.2's contract has been
  inverted.
- `pending-supersession.test.ts:93` and
  `src/cli/byte-progress-wrappers.test.ts:35` call `putGitArtifact` directly;
  because §2.2 keeps that helper's signature, both pass UNCHANGED. Only if the
  combined helper is later removed does `byte-progress-wrappers.test.ts` need
  rewriting to assert bytes on the flush.
- The eight signatures §2.1 narrows to `Pick<BlobStore, "get" | "getToFile">`
  break no caller: a full `BlobStore` stays assignable.

So the tests that change are: the new tests 1-7, and the five inversions enumerated
in §3.1.

## §4 Non-goals

- **Fixing the `local-index` permanent deferral** (`follow.ts:607`) — the
  trigger, a real bug worth its own cycle. This makes it cheap, not absent.
- **Backing off forced capture** for stuck-pending repos. §1.4: the class, not
  the entrance.
- **Reclaiming the ~29 GB already orphaned.** `gcMark`
  (`apps/api/src/gc-mark.ts:47-58`) marks unreachable canonical blobs past
  grace; no client change is needed.
- **Adding a receipt-discard API.** Rejected in §2.7.
- **Skipping the flush on `changed === false`.** Tried and deleted; below.
- **Changing the receipts protocol, `RECEIPT_TTL_MS`, or the `no-op` push
  short-circuit** at `push.ts:665-668`. The short-circuit is correct; it was
  only harmful because bytes had already been spent behind it.

### 4.1 Considered and DEFERRED — per-repo deferral via a two-pass flush

Implementation surfaced four barrier inversions rather than the one the spec named
(§3.1), which reopened the question of whether per-repo deferral on an upload fault
could be preserved after all. Round 3's finding F14 identified the shape that would do
it: **flush in two passes** — repos with no irreversible work first, so an upload fault
can still defer just that repo, and apply the all-or-nothing barrier only to repos past
`commitAbsentBranchVerification` (`plan.ts:1239`) or `pinDisplaced` (`plan.ts:1307`).

**Founder ruling: the barrier STAYS; the three inversions are re-expressed.** Recorded
here because someone will revisit it. Two reasons:

1. **Round 2 proved a per-repo catch is unsound AT the flush point.** Preserving
   per-repo defer therefore means real added mechanism — a second pass, a
   statically-computed irreversible-work set — on the one path in this design that has
   to be exactly right.
2. **The field cost of the barrier is modest.** Captures are idempotent, so a failed
   push simply retries, and the daemon pushes every ~4s. A visible failure on a manual
   `rbox push` that succeeds on retry is a fair price for "never publish a section
   without its bytes".

The three tests that asserted the old per-repo behaviour are correct-but-outdated
assertions of the ratified §0/§2.2 rule reached through the `failNextGitPut` seam,
not evidence the mechanism is wrong — which is why they were re-expressed rather than
preserved.

**Reopen trigger:** if the barrier proves painful in the field — repeated whole-push
failures traced to one repo's uploads — the two-pass split above is the known remedy,
and round 3's F14 carries the analysis (recorded in
`docs/design/notes/226/REVIEW-LOG.md` under the implementation round).

### 4.2 Known follow-up — the flush serializes uploads that used to run 4-wide

§2.2's dedupe rule ("an `encSha` enters the set only after `has === true` or a
successful PUT" — never at retain time) forbids a batch pre-dedupe, so
`flushGitArtifacts` (`src/cli/sync-git/plan-artifacts.ts:66`) uploads **serially** at
both flush points. Capture used to upload 4-wide inside the capture pool
(`GIT_CAPTURE_CONCURRENCY`, `sync-git/shared.ts:19`). On a 256-repo first push
(`MAX_GIT_REPOS`, `manifest-validate.ts:22`) that is a real wall-clock regression, not
a rounding error.

Suggested shape, not done here so the barrier path stayed minimal: a `poolMap` over the
owed artifacts with set insertion still strictly AFTER success. That keeps the §2.2
contract verbatim and races only on duplicate `encSha`s — whose bytes are byte-identical
by convergent encryption (§2.1), so the worst case is one redundant PUT, never a skipped
one.

## §5 Review provenance

Round-1, round-2 and round-3 ledgers: `docs/design/notes/226/REVIEW-LOG.md`.
Round 3 enumerated every `revertCapture` site against the two flush points and
could not construct a path where a section publishes without its bytes: the
mechanism is SOUND. Its findings were missing spec text, folded here, with no new
design decisions — which is why the 3-round cap closes at round 3.

**Settled — do not re-litigate:**

- **`captureGitState` flushes INLINE unless the caller supplies a pending-upload
  collector; only `capturePlannedGitSection` supplies one** (§2.2). Its 74 other
  call sites are untouched by construction. Unconditional deferral breaks seven
  read-back sites at runtime and reds ~50 tests whose obvious wrong fix is to put
  the upload back inside `captureGitState`.
- **The read-through type is `Pick<BlobStore, "get" | "getToFile">` with NO
  full-`BlobStore` fallback** (§2.1) — not a throwing one. Widen the eight
  declaration sites instead; a full `BlobStore` stays assignable, so nothing else
  breaks. A wrapper carrying `has` is the member the narrowing exists to make
  unconstructable.
- **The candidate-bytes read is real.** `finalResolutionReport` projects the
  FRESH candidate's index through the store (`resolution-intent.ts:298`, from
  `plan.ts:1293`). The read-through store (§2.1) is the remedy; do not
  re-propose flushing early.
- **Flush is all-or-nothing** (§2.2). Per-repo defer-on-upload-fault is unsound
  for any repo past `commitAbsentBranchVerification` or `pinDisplaced`; the
  blast-radius regression is accepted (§0). Re-affirmed by founder ruling after
  implementation surfaced three more inversions of it — the two-pass rescue is
  **considered and deferred** with a named reopen trigger (§4.1). Four tests assert
  the pre-226 per-repo behaviour and are re-expressed, not preserved (§3.1).
- **Retention paths are unique per CALL, not per `encSha`** (§2.3). The `encSha`
  set is a flush-time dedupe only, entered after `has`/PUT success.
- **Retention lives under the gitcap scratch root** (§2.3), reached by exporting
  and reusing `makeGitCaptureDir` — not `.rbox/state/uploads` (the
  multipart-token dir), and not a reimplementation.
- **The `changed === false` flush skip was tried and DELETED as vacuous.**
  `GitSection.generatedAt` is required (`src/engine/types.ts:117`), set fresh on
  every capture (`capture.ts:353`), and nothing normalizes it away
  (`sanitizeGitSectionForPersistence`, `src/engine/git/config-sync.ts:233`,
  touches only `config`). Two captures of an unchanged repo differ in exactly
  `["generatedAt"]`, so `changed === false` implies no surviving fresh capture
  and the flush list is already empty. Production reaches `changed === false` by
  REVERT (`revertCapture` sets `out[rel] = pending`, so
  `outgoing[rel] === prev[rel]` by identity, `plan.ts:1350`), which §2.2's
  `captured` filter already covers. Its guard was wrong too: `force` is not the
  only force authority (`mustCapture = force.has(rel) || republish.has(rel)`,
  `plan.ts:178`; `republish` is the #526 chain-restart set).
- **`flushGitArtifact` does NO per-file cleanup** (§2.2). A shared `encSha`
  would have its ciphertext deleted out from under a still-retained repo's
  read-through GET, and `remote` cannot rescue it (`blobs.ts:261`, `:334`). The
  `finally` sweep suffices.
- **Retention covers ALL captured repos, not just the candidate sets** (§2.3).
  The unreadable/absence/tombstone reverts (`plan.ts:1145`, `:1256`, `:1274`)
  reach repos in neither set. Disk is bounded by the two incremental flush
  points (`plan.ts:1280`, `:1351`), not by narrowing the retained set.
