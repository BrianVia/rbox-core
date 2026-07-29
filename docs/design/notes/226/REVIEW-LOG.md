# Design 226 — review log

Spec: `docs/design/226-git-capture-upload-after-decide.md`.
House convention: one log per design; append a round per review wave.

## Round 1 — CHANGES-REQUIRED (both reviewers)

Two independent reviewers over the round-0 draft:

- **Reviewer A (opus, prototyping).** Built the split against
  `fix/git-capture-upload-before-decide` and ran the affected suites. Runtime
  evidence throughout.
- **Reviewer B (codex, read-only).** Source-only audit; no prototype.

Both returned CHANGES-REQUIRED and independently named the same three
blockers (1, 2, 3 below). Both also found stale line anchors in the round-0
draft.

### Blockers

| # | Finding | Evidence | Ruling folded into |
|---|---|---|---|
| 1 | §2.1's "no decision reads the candidate's bytes" is FALSE. `finalResolutionReport` projects the FRESH candidate's index through the store (`resolution-intent.ts:298`, called `plan.ts:1293`) before the proposed flush. Under the draft that GET 404s → lane indeterminate → keep-mine can never publish. | Prototype: 10 `design 177` keep-mine tests fail. | §2.1 rewritten; plan-local read-through store adopted (B's remedy, preferred over A's flush-early: no PUT, and it removes an existing needless download of the just-uploaded index). |
| 2 | Flush-failure semantics unspecified. Today an upload fault is a CAPTURE fault, caught per repo (`plan.ts:1096-1099`), deferring one repo with base carry while the push proceeds (invariant stated in code, `plan.ts:1065-1068`). The naive `catch { revertCapture }` is UNSOUND: `commitAbsentBranchVerification` (`plan.ts:1239`) has mutated refs and `pinDisplaced` (`plan.ts:1307`) has written keep-mine pins by the flush point, and `revertCapture` (`plan.ts:243-258`) clears neither. | Source, both reviewers. | §2.2 — flush is an all-or-nothing barrier; invariant stated verbatim + test 4. Blast-radius regression stated in §0. |
| 3 | Retention keyed by `encSha` is wrong. Recompaction's two captures stage the same index/op-state and encryption is convergent, so both yield the SAME `encSha`; §2.3's "delete the first capture's retained ciphertexts" then deletes bytes the second capture's published section references. | Prototype retaining as `<encSha>.ct`: 42 tests fail with ENOENT out of the flush. | §2.3 — retention paths unique per CALL (mirroring `crypto.ts:246-249`); `encSha` set is flush-time dedupe only, entered after `has === true` or a successful PUT. |

### Non-blocking findings, all accepted

| # | Finding | Ruling folded into |
|---|---|---|
| 4 | `.rbox/state/uploads` is the resumable-multipart TOKEN dir (`multipart.ts:69`), persistent, no sweeper — a category error. The gitcap scratch root already has a crash reaper (`sweepStaleGitCaptureDirs`, `capture.ts:150-171`, called from `makeGitCaptureDir` `:178`). | §2.3 — retain under the gitcap root; the draft's "new crash-cleanup obligation" paragraph DELETED. Two consequences added: move ciphertext out of `tmpDir` before `capture.ts:391-394`; write `owner.pid` or the absent-owner sweep branch deletes the dir mid-plan. `git-state.test.ts:599-602` survives this choice and would have broken under the uploads-dir choice. |
| 5 | Peak retained disk understated. `MAX_GIT_REPOS = 256` (`manifest-validate.ts:22`), first push captures all full-history, 4-wide (`sync-git/shared.ts:19`), each in-flight capture holding plaintext + an immutable encryption snapshot (`crypto.ts:246-250`). "Strictly the bytes we send anyway" is a SEQUENTIAL budget today, SIMULTANEOUS after. | §2.3 — real additive peak stated; retained-bytes bound adopted: repos in neither `pendingSupersessionCandidates` nor `resolutionCandidates` flush immediately, so only the decidable minority is retained (also shrinks finding 1's surface). |
| 6 | Sha-mismatch retry breaks: `putGitArtifact`'s loop re-enters `encryptFileToTemp` from the staged plaintext (`git/shared.ts:762-778`) and capture deletes that plaintext (`capture.ts:393`). | §2.3 — B's remedy adopted (not A's "retain the plaintext"): retry the SAME retained ciphertext after local `hashFile(path) === encSha` verification; fail closed otherwise. Multipart already drops its stale resume token (`multipart.ts:33-39`). Both `git artifact sha_mismatch` tests updated deliberately (§3 test 9). |
| 7 | Removable mechanism. (a) The basis-fallback cleanup is fiction: `capturePlannedGitSection` performs no second capture on that path (`sync-git/shared.ts:270-282`); the fallback happens inside `captureGitState`'s bundle-create catch (`capture.ts:305-312`), before the first `putGitArtifact` — one artifact set, nothing to double-free. The draft's sentence citing `shared.ts:280` was wrong on both line and concept. (b) The pending-upload mutation in `revertCapture` is unnecessary. | Both DELETED. §2.2 filters the flush by the surviving `captured` set and sweeps once in `finally`; `revertCapture` is untouched. |
| 8 | The `changed === false` residual. A showed it is NOT bounded to the 422 path — any divergence-cache miss reaches it, and `saveGitDivergenceCache(...).catch(() => {})` (`plan.ts:1428`) swallows every save failure, so a read-only `.rbox` gives a permanent per-tick miss. B: unproven without a reproducer. Converged remedy: test it or delete it. | DELETED as a non-goal. §2.5 instead SKIPS the flush when the plan will report `changed === false` (known at `plan.ts:344-351`), guarded by an empty `force` set so 422 recovery — which recaptures to an identical section precisely when the bytes must be re-sent — is never skipped. Test 7 pins it. |
| 9 | Editorial. §2.1's determinism analysis is load-bearing only for the REJECTED re-encryption alternative; `encryptFileToTemp` re-snapshots the source per call, so determinism holds only against a stable source; the claim needs qualifying to raw git artifacts under a fixed KEK. §3.6's "signature churn" was self-inflicted — the prototype kept `putGitArtifact`'s signature over the new split and both `pending-supersession.test.ts` and `byte-progress-wrappers.test.ts` then passed UNCHANGED. | §2.1 subsection retitled + caveated; §2.2 keeps `putGitArtifact` as the composition; §3's churn item reduced to a note. |

### Anchor corrections applied

| Draft | Correct (verified in `fix/git-capture-upload-before-decide`) |
|---|---|
| `plan.ts:891-902` (force-capture call) | `plan.ts:903` |
| `plan.ts:153` (`planGitSections`) | `plan.ts:154` |
| `e2ee-remote.ts:769-772` (§28 git-blobRefs comment) | `e2ee-remote.ts:770-773` |
| `plan.ts:161-164` (`onProgress` doc) | correct, retained |
| `resolution-intent.ts:153` / `:177` | correct LINES, but the claim attached to them was false — see finding 1 |
| `shared.ts:280` (basis-fallback second capture) | no such path — deleted (finding 7a) |

Reviewer-supplied line numbers for `finalResolutionReport` / `pinDisplaced` /
`commitAbsentBranchVerification` (`:296-299`, `:1291`, `:1312`, `:1241`,
`:243-259`, `:1084-1099`, `git-state.test.ts:596-600`) were themselves
off-by-a-few; the spec carries the re-verified values
(`resolution-intent.ts:297-298`, `plan.ts:1293`, `:1307`, `:1239`,
`:243-258`, `:1096-1099`, `git-state.test.ts:599-602`).

## Round 2 — one execute-lane reviewer, measured; all nine findings ACCEPTED

Single reviewer over the round-1-folded spec. Execute lane: measured the claims
it disputed rather than arguing them, and mechanically resolved ~90 anchors.
Six of the nine rulings DELETE mechanism; the spec shrank 391 → 379 lines while
closing one reachable blocker.

### Blocker

| # | Finding | Evidence | Ruling folded into |
|---|---|---|---|
| 2 | **Per-file cleanup in `flushGitArtifact` is unsafe.** Three round-1 clauses combine badly: retention keyed `Map<encSha, ctPath>` (§2.1), non-candidate repos flushing immediately (§2.3), and per-file cleanup in the flush (§2.2). A non-candidate repo sharing an `encSha` with a retained candidate — and §1.2 asserts byte-identical index/op-state artifacts DO collapse — has its ciphertext deleted out from under the retained repo's read-through GET. `remote` cannot rescue it: a receipts PUT early-returns at `apps/api/src/blobs.ts:261` having written only the canonical R2 key and granting no entitlement (the D1 writes at `:272`/`:282` are the non-receipts path), and `blobGet` gates on `isEntitled` before R2 (`:334`), so it 404s → `pendingIndexProjection`'s `catch → indeterminate` → silent keep-mine refusal. Round-1 blocker 3, reintroduced across repos. | Source, all links resolved. | §2.2 — per-file cleanup DELETED; the single `finally` sweep is the only reclamation, and it already covers the recompaction path's discarded first capture. Recorded in the settled list. |

### Findings

| # | Finding | Ruling folded into |
|---|---|---|
| 1 | **The `changed === false` skip (round-1 finding 8's remedy) is vacuous, and its guard was incomplete.** Guard: `mustCapture = force.has(rel) \|\| republish.has(rel)` (`plan.ts:178`) — there are TWO force authorities and round 1 named one; `republish` is the #526 operator chain-restart set (`republish-requests.ts`), and a republish is by construction the case that must re-send bytes for a section byte-identical to base (single-link chain: differs in `generatedAt` only). And the skip cannot fire anyway: `GitSection.generatedAt` is required (`src/engine/types.ts:117`), set fresh every capture (`capture.ts:353`), and nothing normalizes it away (`sanitizeGitSectionForPersistence`, `config-sync.ts:233`, touches only `config`). **Measured**: two captures of an unchanged repo give equal `bundleEncSha`, deep-equal `false`, differing keys exactly `["generatedAt"]`. So `changed === false` ⇒ no surviving fresh capture ⇒ the flush list (already `captured`-filtered per §2.2) is empty. Round-1's premise was also wrong: production reaches `changed === false` by REVERT (`revertCapture` sets `out[rel] = pending`, so `outgoing[rel] === prev[rel]` by identity, `plan.ts:1350`), not by a fresh capture comparing equal. | DELETED: the skip, its force guard, §2.2's carve-out sentence, and §3 test 7. §2.5 retitled "Constraints and progress reporting". Recorded in the settled list with the `generatedAt` measurement so nobody re-proposes it. |
| 3 | **Round-1's disk bound (finding 5) reintroduces the leak class.** "Repos in neither candidate set flush immediately and retain nothing" misses four revert sites that are not restricted to those sets: the unreadable revert (`plan.ts:1145`), the absence-witness revert (`:1256`), the tombstone-exactness revert (`:1274`). §1.4 names those exact sites as the reason to fix the upload site rather than the trigger, and an absence-proof refusal is persistently repeatable — a per-tick leak, not one-shot. The set-membership premise itself is sound (`resolutionCandidates.add` `:878` and `pendingSupersessionCandidates.add` `:901` both precede the pool at `:1084`) — just insufficient. | §2.3 — retain for ALL captured repos. Disk bounded by TWO incremental flush points instead: non-candidate survivors after the tombstone loop closes (`plan.ts:1280`), the rest after the supersession loop (`:1351`). §0's "helped" claim kept as written. §2.1's "shrinks the read-through surface" clause dropped. |
| 4 | **`git-sync.test.ts:1214` is an unnamed intentional inversion.** "sha_mismatch retries are bounded; final failure defers with base carry" asserts the CURRENT per-repo behaviour end to end: 3 PUT calls, the push still commits `note.txt`, that repo base-carries, a `deferred 1 … capture failed` log line. Under §2.2's barrier an exhausted PUT rejects `planGitSections`, so none hold — and an implementer working the suite green has an obvious wrong fix available: reinstate the per-repo `catch { revertCapture }` §2.2 declares unsound. | §3 test 8 — names `:1214` explicitly as an intentional inversion and states the replacement assertions (retry budget 3 PUTs / `[0, 1]` unchanged; push rejects; nothing published; next push succeeds). `:1193`'s `src[0] !== src[1]` confirmed to invert to `===` and stated per-test. |
| 5 | **§2.1's "`has` must reflect the SERVER" warning guards a method nobody calls.** `BlobStore` has exactly five members (`blobstore.ts:13-29`) and the wrapper's `has`/`put`/`putFile` are UNREACHABLE — the flush uses the bare `api.blobStore()` and capture keeps the bare store. Separately, `getToFile` is OPTIONAL and feature-detected (`git/shared.ts:786`, `apply.ts:352`, `:369`); a wrapper defining it unconditionally over a store lacking it calls `undefined(...)`, latent because every in-tree store implements it. | §2.1 — signature narrowed to `Pick<BlobStore, "get" \| "getToFile">`, three delegations and the prose warning DELETED; a full-`BlobStore` variant must THROW on write/query members. `getToFile` required to be presence-conditional or `get`-based. |
| 6 | **A retention miss is indistinguishable from "index content could not be proven."** `pendingIndexProjection` wraps its read in `catch { return {kind:"indeterminate"} }` (`resolution-intent.ts:163`) and cannot tell absent from read-failed; both degrade to a silent keep-mine refusal with an unactionable reason — the exact failure mode that cost round 1 a ten-test debugging cycle. | §2.1 — the read-through store must THROW a distinct, logged error naming encSha + path when a retained entry's file is unreadable, instead of falling back to `remote`. |
| 7 | Four precision gaps. (a) `makeGitCaptureDir` (`capture.ts:174`) is NOT exported and its mkdtemp-then-rename dance is load-bearing — the staging name `.rbox-gitcap-*` deliberately misses the sweep's `rbox-gitcap-` prefix, protecting the pre-`owner.pid` window; "minted the same way" is not enough. (b) The recompaction second capture REPLACES the first's pending-upload list (`sync-git/shared.ts:272` then `:287` — only the second section is returned); §2.2 never said so, leaving a full wasted bundle possible. (c) §3 test 4 asserted rejection but not recovery — the reviewer verified the barrier's rejection IS recoverable (`commitAbsentBranchVerification` re-proves absence/HEAD/ownership inside the lock; `pinDisplaced` writes additive pins; the keep-mine receipt arms later at `push.ts:769-798`; the lease releases in `finally`), so the test as written would pass over an unrecoverable state. (d) §2.2 asserted "a per-repo catch is UNSOUND" unconditionally; the real constraint is "unsound for repos past `commitAbsentBranchVerification` or `pinDisplaced`". | (a) §2.3 says export and reuse. (b) §2.2 states the replacement; §3 test 5 strengthened to `put + putFile === gitSectionBlobRefs(recompacted).length`. (c) §3 test 4 adds "the next push succeeds and publishes". (d) §2.2 scoped, with the reason the barrier stays global (the set is not statically known at the flush). |
| 8 | **The load-bearing protection was never written down.** It is the server's 422 fence, not any client-side guard: whatever makes `store.has()` false makes commit admission report the same blob missing (both use the entitled-AND-`present=1` predicate, `apps/api/src/blobs.ts:136-213`) and the commit fails closed with 422 `unsatisfied_blobs` (`workspace-sync.ts:553-564`, `:672-673`, `:949-951`), driving `gitForceForMissingBlobs`. That reclassifies a wrongly-skipped flush from silent corruption to a wasted round trip. Also a closed audit worth not re-running: no pre-commit value reaches `prev` (`plan.ts:323-338`) — `base` advances solely via `gitBaseAfterCommit` post-ACK, `record.advertised` is written only in `acknowledgePublishedGitTransitions` (`publisher-ack-transition.ts:154-187`), `durablePending` comes from another device's accepted commit; fresh machine, pruned pack chain, divergence-cache miss and GC'd blob each checked, no holes. | New §2.6; former §2.6 (rejected receipt-discard API) renumbered §2.7 and the §4 cross-reference updated. |
| 9 | Citation nits. ~90 anchors mechanically resolved; all of round 1's corrections held and the rest were clean apart from these. | Corrected below. |

### Anchor corrections applied

| Round-1 spec | Correct (verified in `fix/git-capture-upload-before-decide`) |
|---|---|
| `push.ts:687` (§2.4 `encryptAndUpload`) | `push.ts:686` — `:687` pointed at an argument |
| `capture.ts:150-171` (§2.3 sweeper) vs `150-172` (round-1 log) | `capture.ts:150-172` (function body ends at `:172`) |
| `push.ts:530` ("the `git-plan` phase at") | `push.ts:520` is `report.phase("git-plan", …)`; `:530` is the `planGitSections` call |
| `push.ts:521-522` (mutation lease) | `push.ts:521` |
| `makeGitCaptureDir`, `capture.ts:174-184` | `capture.ts:174-185` |

Round-2 reviewer anchors corrected during the fold (verified line-by-line in
this worktree, not taken on trust): `blobs.ts:333` → `:334` (the `isEntitled`
gate); `publisher-ack-transition.ts:145-186` → `src/cli/sync/publisher-ack-transition.ts:154-187`
(the file is under `sync/`, not `sync-git/`, and the function opens at `:154`);
`push.ts:655` (keep-mine receipt arming) → `push.ts:769-798`; ruling 3's
incremental flush point `plan.ts:1262` → `:1280` (`:1262` closes only the
absence loop; the tombstone-exactness revert at `:1274` lives in the loop
closing at `:1280`).

## Round 3 — FINAL. Mechanism SOUND; six rulings, five folded, one overruled

Single reviewer over the round-2-folded spec, at the hard 3-round cap. It
**confirmed the mechanism**: it enumerated every `revertCapture` site against the
two flush points and could not construct a path where a section publishes without
its bytes. `plan.ts:1280` is late enough — both later revert loops iterate
candidate sets only, and `finalizedOutgoing` is frozen at `plan.ts:1266`. The
reviewer explicitly stated its findings do **not** warrant a round 4: they are
missing spec text with no new design decisions in them. The founder ratified that
and closed the cap; the spec is now SELF-CERTIFIED FOR IMPLEMENTATION.

### Rulings

| # | Finding | Verdict | Folded into |
|---|---|---|---|
| 1 | **§2.2 said unconditionally "`captureGitState` collects pending uploads instead of performing them" — taken literally that removes the only thing that populates the store for its other 74 call sites across 15 files.** Seven read the artifacts straight back out: `git-nested.test.ts:227` then `applyGitState` at `:235` over a `LocalBlobStore` whose only writer is that capture; `git-state.test.ts:293` then `store.get(section!.bundleEncSha)` at `:297`; `git-sync.test.ts:1078`, `:1108`, `:3641`, `:3731` capture into `remote.blobStore()` to fabricate another device's pending section, and those artifacts must really be remote or `pendingIndexIsCleanAndPlain` (`pending-supersession.ts:148`) 404s and the design-174/177 lanes go indeterminate. §2.2's existing mitigation ("`putGitArtifact` stays for direct/engine callers") does NOT cover them — they call `captureGitState`. A fresh implementer faces ~50 red tests with the obvious wrong fix available: put the upload back inside `captureGitState`, i.e. undo the design. | **ACCEPT** — the important one. Ruled: **`captureGitState` keeps flushing inline UNLESS the caller supplies a pending-upload collector; only `capturePlannedGitSection` supplies one.** No restructuring around it. | §2.2 states it as the contract with the seven read-back sites named; §3 states the 74 sites are untouched by construction; added to the settled list. |
| 2 | **The `Pick<BlobStore, "get" \| "getToFile">` narrowing needs signatures the spec never named, and would not typecheck today** — both consumers declare the full interface (`resolution-intent.ts:293`, `pending-supersession.ts:197`). The narrowing IS right and IS feasible: transitively these functions touch nothing but `getGitArtifact`, which uses only `getToFile` then `get`. Separately, §2.1's fallback sentence ("if a full `BlobStore` is ever demanded, its write/query members THROW") reads as permission to build a wrapper with `has` after all — exactly the member round 2 set out to make unstatable, and the path of least resistance. | **ACCEPT**, plus DELETE the escape hatch. | §2.1 — the THROW-fallback sentence DELETED and replaced by "there is no full-`BlobStore` variant, not a throwing one"; all declaration sites enumerated with the source-compatibility argument. Added to the settled list. Round 3 said "seven"; the fold verified **eight** distinct sites and lists eight. |
| 3 | **A second unnamed test inversion.** `git-state.test.ts:598` asserts `uploadPaths.length > 0`, fed by `recordingStore.putFile` (`:590-593`). If capture defers, `putFile` is never called and it fails before reaching the loop at `:600-602`. §2.3's claim that the assertion "survives this choice" was wrong as stated — the intent survives; the assertion cannot observe an upload path. | **ACCEPT** | §2.3 — states the distinction and that **Ruling 1 makes it evaporate** (that call site supplies no collector, so it flushes inline). Deliberately NOT added to a change list, which would then be wrong. |
| 4 | **§2.6 anchors + one strengthening.** (a) §2.6 cited only `blobs.ts:136-213` (`blobsCheck`, the `has()` path), never the admission predicate it claims equivalence with: `commit-accounting.ts:118-148` (`validateCommitRefs`). The equivalence is real and **stronger** than claimed — the same `blob_refs ⋈ blobs present=1` SQL behind the same `blob_ref_candidates`/`gc_candidates` barriers, and `blobsCheck` adds an extra `pack_gc_candidates NOT EXISTS`; so `has()` is *strictly stricter*, which is what makes the direction safe (`has() === true` ⟹ admission has it). (b) Admission satisfies a ref on a valid **receipt alone** — the mechanism by which §1.1's 9,983-receipt backlog became chargeable at the next real commit. (c) `plan.ts:323-338` → `:323-339`: `durablePending` reaches `prev` at `:339`; `:338` is a closing brace. (d) §2.3's disk arithmetic omits **recompaction doubling**: a repo tripping `exceedsPackChainByteBound` (`sync-git/shared.ts:184`) retains BOTH captures' ciphertexts until the sweep (per-file cleanup is correctly forbidden; the first list is discarded, not freed), and the bound trips when the increment ≥ `chain[0].cipherSize`, so that repo's retained peak is ~2× a full bundle. The section is titled "honestly". | **ACCEPT** (all four) | §2.6 gains both anchors, "strictly stricter", and the receipt clause; `:323-339` corrected; §2.3 gains the recompaction-doubling paragraph. |
| 5 | **The `finally` sweep is relied on by §2.2 (twice), §2.3, §5 and §3 test 7, and is never specified.** `planGitSections` has no top-level `try`/`finally` today — the only two in its body (`plan.ts:190-192`, `:1085-1099`) are inside inner closures. | **ACCEPT** | §2.2 — one paragraph: `planGitSections`' body is wrapped so the retention dir is removed on every exit, including a throw. |
| 6 | ~28 lines are provenance rather than specification (§1.3's two corrections, §2.6's closed-audit paragraph, §2.1's determinism bullet); round 3 recommended NOT cutting them at round 3. | **OVERRULE — recorded as a decision.** Each exists to stop a specific re-litigation and the churn buys nothing. Leave them; do not chase a line target. | Nothing. Recorded here so round-4-equivalent thinking does not reopen it. |

### Anchor corrections applied

| Round-3 / round-2 spec | Correct (verified line-by-line in this worktree) |
|---|---|
| `plan.ts:323-338` (§2.6 closed audit) | `plan.ts:323-339` — `Object.assign(prev, durablePending)` is at `:339`; `:338` is a brace |
| `git-state.test.ts:599-602` (§2.3 scratch-root assertion) | `:600-602` is the loop body; `:599` is the `scratch` const and `:598` is the separate `length > 0` assertion (ruling 3) |
| `blobs.ts:157-168` (round 3's have-set SQL) | `blobs.ts:156-163` |
| `commit-accounting.ts:120-126` (round 3's have-set SQL) | `commit-accounting.ts:121-124`; the enclosing predicate is `:118-148` |
| `commit-accounting.ts:143` (admit-on-receipt) | `:142-144` — `verifyReceipt` at `:142`, the `verified.push` at `:144` |
| `capture.ts` / `plan.ts` inner `try`s cited as `plan.ts:192`, `:1099` | the enclosing `try`/`finally` pairs are `plan.ts:190-192` and `:1085-1099` |
| `byte-progress-wrappers.test.ts:35` (unqualified path) | `src/cli/byte-progress-wrappers.test.ts:35` — under `src/cli/`, not `src/cli/sync-git/` |
| "seven signatures" to narrow (ruling 2) | **eight**: `git/shared.ts:784`, `:793`; `resolution-intent.ts:142`, `:169`, `:253`, `:293`; `pending-supersession.ts:151`, `:197` |

Ruling 1's counts were re-derived, not taken on trust: 75 `captureGitState(` call
expressions across 16 files, of which exactly one is the production path in
`src/cli/sync-git/shared.ts` — **74 call sites across 15 files**, as stated.

## Implementation round — the test census was wrong TWICE

The implementer built the mechanism as specified, then correctly STOPPED on a stop
condition: **three test inversions the spec did not name.** It left them red and
untouched, and proved they were signal (each passes on a stashed baseline,
individually). Its diagnosis was right — the spec's test census was wrong, not the
mechanism.

### The census lesson, stated so it generalizes

The census was wrong **twice**, and both times the same way:

- **Round 2** found ONE inversion seam — `gitShaMismatchFailures` — and the spec's §3
  item 8 enumerated exactly the two tests that seam reaches (`git-sync.test.ts:1193`,
  `:1214`).
- **Implementation** found the OTHER seam — `failNextGitPut` — reaching three more
  tests (`:483`, `:1127`, `:1506`'s upload leg). All three assert the ratified §0/§2.2
  behaviour ("one repo's upload fault fails the whole push") through that second seam.

**Rule: a census claim of "everything else passes UNCHANGED, by construction" is not
defensible without enumerating the FAULT-INJECTION SEAMS.** §3's withdrawn claim was
reasoned entirely from the production call graph (`captureGitState`'s 74 collector-less
call sites), which is a real argument about which tests the *happy path* touches and
says nothing about which tests inject a fault into the path being moved. Any design that
relocates a failure boundary must list the seams the suite fails through, then the tests
per seam. The corrected census lives in §3.1: **four barrier inversions plus one retry
inversion, across two seams.**

### Founder ruling on the three: the barrier STAYS, re-express the tests

Full reasoning and the reopen trigger are in **§4.1** of the spec (a design decision, so
it belongs there, not only here). In brief: the three are correct-but-outdated
assertions, not evidence against the mechanism; the two-pass flush from **round 3's F14**
(flush repos with no irreversible work first so they can still defer individually;
barrier only for repos past `commitAbsentBranchVerification` / `pinDisplaced`) was
**considered and deferred** because round 2 proved a per-repo catch unsound at the flush
point — so preserving per-repo defer adds real mechanism to the one path that must be
exactly right — and because the field cost is modest (idempotent captures, ~4s daemon
push cadence). F14 remains the known remedy if the barrier proves painful in the field.

### Re-expression shape

All four barrier inversions now share one shape (template: the re-expressed `:1214`):
the push `rejects`, `headSeq()` unchanged, nothing published, retention swept, **then a
recovery push succeeds**. The recovery leg is the load-bearing one — rejection alone
would pass over an unrecoverable state. Two traps worth recording:

- `gitShaMismatchFailures` is a **counter** and must be reset to 0 before the recovery
  push; `failNextGitPut` self-clears.
- In `design 174 B` a SUCCEEDING push supersedes P and clears the sidecars the
  commit-error and 409 legs need outstanding. The recovery assertion therefore rides the
  409 leg's own push — the first one allowed to succeed — instead of being inserted
  between the legs.

### Also recorded from implementation

**Uploads now serialize where captures used to run 4-wide** (§4.2). §2.2's "an `encSha`
enters the set only after `has === true` or a successful PUT" forbids a batch
pre-dedupe, so `flushGitArtifacts` is a sequential loop at both flush points. On a
256-repo first push that is a real wall-clock regression. Suggested follow-up: a
`poolMap` with set insertion still after success — same contract, racing only on
duplicate `encSha`s, whose bytes are byte-identical anyway.
