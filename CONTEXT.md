# CONTEXT — domain glossary

rbox is end-to-end-encrypted sync of developer folders. A **daemon** watches a
workspace root, a **CLI** drives it, and a Cloudflare Worker (`apps/api`) is a
zero-knowledge sequencer: it stores ciphertext and orders commits, and can
decrypt nothing.

`docs/CODEMAP.md` says who owns what; this says what the words mean, so a
symbol is readable without opening 259 design docs. Every entry is verified
against the owning module, not the design doc — where they disagree the code
wins and the disagreement is noted. Paths are repo-relative.

## The push/pull spine

**manifest** — a point-in-time snapshot of a workspace tree's syncable state:
`{generatedAt, files, manifestSchema?, gitRepos?}`, encrypted client-side into a
blob addressed by `encManifestSha`. Owner: `src/engine/types.ts`,
`src/engine/manifest.ts` (`scanManifest`). Versioning is one integer, not "v2":
`KNOWN_MANIFEST_SCHEMA = 4` (`src/engine/manifest-validate.ts`) — absent = v1
legacy, ≥2 for `gitRepos`, ≥3 for `packChain`, ≥4 for zstd; newer is refused
loudly. Design 40 names an unbuilt chunking prototype "manifest v2"; unrelated.

**section** — one `Manifest.gitRepos[relPath]`, i.e. a `GitSection`: the entire
git state of one discovered repo as one indivisible sync unit. Exactly one kind
of section exists; files are a flat array and are not sectioned. Homonym: git
*config* sections (`src/cli/sync-git/config-sync.ts`).

**sequence** — the monotone commit number of one workspace's append-only chain,
per `(workspaceId, projectId)` Durable Object. The client signs `seq`/
`parentSeq`; the server admits only if `parentSeq === head.sequence`, else 409
`conflict` (`apps/api/src/workspace-sync.ts`). `sourceSeq` on a `RepoRecord` is
not a second counter — it is this number stamped for last-writer-wins merging.

**envelope** — two senses. (1) *manifest delta envelope*: the framed plaintext
that gets encrypted — magic `rbox-mde1\n` + header + body, kinds
`raw`/`snapshot`/`delta` (`src/engine/manifest-delta.ts`). (2) *signed commit
envelope*: `SignedCommit {body, commitHash, sig}`, stored verbatim and never
signature-checked by the server (`apps/api/src/commit-envelope.ts`).

**chain** — also two. (1) `manifestChain`: base-first `encManifestSha` delta
links folded to reconstruct the head manifest, riding inside the signed commit
body, cap 16 (`src/engine/manifest-chain.ts`). (2) `GitSection.packChain`:
ordered git bundle blobs making one repo's history incremental, cap 8, schema
≥3, strictly inside a section. Unrelated to each other.

**meta** — `GlobalManifestMeta` (`src/cli/sync-state-model.ts`): purely local
evidence describing the current baseline so the next push emits a delta without
refetching. Not a "meta section" of the manifest.

## BASE and its neighbours

**BASE** — the device's local per-repo record of the git ref state it last
agreed on with the remote: `RepoRecord.base?: GitSection` plus
`branchBaseOrigins`. The reconcile anchor for git capture and apply, and it is
**local-only — it never goes on the wire**. Owner:
`src/cli/sync-git/base-composer.ts` (`composeRepoBase`, the sole pure
constructor); admission in `base-proof-selection.ts`; persisted in
`.rbox/state/state.db`.

Every composition names one **authority** (`ComposeRepoBaseAuthority`:
`pull-ref-transaction`, `pull-carry`, `observed-landing`, `journal-recovery`,
`publisher-ack`, `manual`, `p-repair`, plus a branded `migration` kind mintable
only in `state-plane/migration/`). Serialized BASE is a materialized view:
readers first overlay valid base-absent artifacts under
`refs/rbox-local/base-absent/` (`src/cli/sync-git/base-artifacts.ts`), and a valid
one beats stale serialized presence. A bad ref yields a `RepoBaseHardHold` →
`disposition: "pending"` → the previous BASE is retained and the candidate ref
move dropped. It never fails the push.

> BASE does **not** grant a push the right to advance — the server never sees
> it. The right to advance is the sequence CAS above.

| neighbour | it is |
|---|---|
| `lastSyncedManifest` | whole-workspace **file-plane** baseline — the last manifest that applied completely; diff base for the next push |
| `appliedBase` | not a record — a **parameter name** for `state.lastSyncedManifest` in the publish path (`sync/push.ts`, `publish-candidate.ts`); `appliedBaseGit` is its `.gitRepos` |
| applied-manifest oracle | a **prover**, not a base: `AppliedManifestOracle` (`src/engine/apply-receipt.ts`) proves the on-disk subtree still equals the applied manifest (`match`/`mismatch`/`indeterminate`), gating git apply/capture/resolve |

## Failure-to-apply state

Not four alternative states: `pending`, `partial`, `deferrals` and `attempt` are
sibling fields of one per-repo record (`RepoStateValues`, `src/cli/sync-state.ts`)
and sibling columns of `repo_records`. One follow transition commonly writes all
four at once.

**deferral** — a durable per-repo, per-lane refusal: one `GitDeferral` per
`(repo, lane)` with one classified `reason`, episode timestamps and `lastSeen`
(`src/cli/sync-state-model.ts`). Set by `sync-git/apply.ts` and
`git-capture-observation.ts`; cleared by publisher-ACK retirement and
`deferral-hygiene.ts`. **The lane is the dimension being refused, not a property
of the deferral**: exactly three — `apply`, `capture`, `config` — held
concurrently. 18 causes in `GIT_DEFERRAL_REASONS`; a *second*, deliberately
different ordering (`GIT_DEFERRAL_REASON_PRECEDENCE`) picks which single reason a
multi-cause repo displays, because declaration order is an enumeration, not a
ranking. Unrelated homonym: "sidecar lanes" (`CarriedSidecarLanes`).

**pending** — `RepoRecord.pending` is the unapplied **remote** `GitSection`: the
newest remote truth a pull could not apply. Pull-side, *not* an ACK-wait. Five
other senses must not be merged into it: `GitPartialApply.checkoutPending` (a
flag inside partial), the `deletion-pending` deferral *cause*,
`accepted-state-pending` (the push-side outcome awaiting ACK,
`sync/publisher-ack-transition.ts`), and the BASE composer's
`disposition: "pending"`.

**partial** — `GitPartialApply`: a per-**repository** record of how far one
incoming section got (`appliedRefs`, `heldRefs`, `checkoutPending`,
`configApplied`), bound to one `incomingKey`. Also written when every ref applied
fine but the *config* did not land, so "incompletely applied" is too narrow.

**held** — a follow that **succeeded and advanced BASE** but could not retire the
incoming section; it keeps `pending` set, holds the apply deferral open, and
stores a `GitHeldAttempt`. Owners: `sync-git/held-decision.ts`, `held-skip.ts`.
Held ≠ deferred — a *blocked* follow is `outcome: "deferred"` with no BASE
advance, a different branch and a different persisted shape. "May skip" does not
mean the section may be skipped: it means a **later pull may skip the expensive
fetch and classification** when the stored attempt still matches, under a closed
blocker allowlist, a one-hour floor and three kill switches. What held blocks is
retirement of `pending`, which suppresses local capture. Homonyms: held *locks*,
and an in-flight `heldRefs` in `src/cli/sync-git/git-state-apply.ts`.

## Carry

**carry** — preserving a prior durable fact through a transition that did not
re-derive it, **without creating authority for it**. The code states it: *"a
carry never mints authority"* (`base-composer.ts`); *"carry-only authority —
recording an observation never mints or advances a BASE"*
(`git-capture-observation.ts`). Canonical constructor `carryRepoBaseProof()`,
yielding the authority-free `pull-carry` member of the authority union.

Only the *subject* varies: no-op / commit-free **sidecar carry** (zero-commit
push), **unreadable-ref-database BASE carry**, **carry proof** across a
wire-absence deletion, **packed-ref identity carry**, and `StandingProofCarry` —
carried lineage/record/BASE that every refusal still hands back.
`carryMatrixMatches` (`sync-git/shared.ts`) is the outlier: a predicate deciding
*whether* carry is legal.

Server-side, same rule, different subject: a **carried ref** is a SHA present in
both parent and child refsets — unchanged across the delta, therefore not
re-derived by delta admission (`apps/api/src/commit-delta.ts`). Prune-marked
carried refs are re-admitted into full checking; that is the safety envelope
`docs/DEPLOYMENTS.md` describes.

## Identity-bound effects

**receipt** — a closed, identity-bound record of what an executed effect actually
did, handed to a caller forbidden to re-derive it. Kinds: the *upload receipt*
(server-issued opaque string proving a blob was staged, accumulated client-side
in `src/cli/remote/context.ts` and redeemed at commit time to keep per-blob
accounting off the PUT hot path — not a durable server row);
`GitCaptureExecutionReceipt` (`{planId, plan}`); `CaptureObservationReceipt`;
`StandingBranchProofReceipt`; `PhaseReceipt`.

**attempt** — one bounded execution with an identity. Two senses: the
publish attempt (`sealPublishRequest(attemptId, …)`,
`src/cli/daemon/daemon-publish-transition.ts`) and the durable `GitHeldAttempt`
that feeds held-skip.

**packet** — **not a wire unit.** `StateSavePacket` (`src/cli/sync-state-model.ts`):
one atomic, CAS-gated batch of state-plane transitions. Its defining property is
whole-packet rejection — *"no global or per-repo member lands unless every
precondition succeeds"* — on `stream`, `nonce`, `repo-generation`,
`global-sequence` or `owner-lost`. One packet may mix authority kinds.

**the identity-binding rule** — *an outcome bound to another attempt performs no
transition.* Canonically: *"an outcome whose `attemptId` is not the one this
transition sealed performs NO effect at all"* (`daemon-publish-transition.ts`).
It is an **invariant with ~6 enforcement sites, not a shared helper**: publish
transitions key on `attemptId`, `publish-candidate.ts` on `planId`,
`remote-repository-deletion.ts` on deletion identity, `follow-repo-transition.ts`
and `standing-branch-proof.ts` on repository+`incomingKey`, state-plane packets
on the CAS triple, and `src/engine/e2ee/keys.ts` refuses to unwrap a wrap bound
to a different account/epoch/purpose. Consolidation is unbuilt work.

## Identity axes

**lineage / `lineageHash`** — an **identity hash, not a time axis**: SHA-256 over
the workspace root, `SyncState.stream`, the state nonce and the repo identity,
naming *which repo incarnation under which state incarnation* owns a BASE proof
artifact. Compared for equality only, never a row, embedded in ref namespaces
(`src/cli/sync-git/repo-lineage.ts`). `repositoryIdentityHash` is a narrower
*component* (paths, dev/ino, birthtime); a `rbox reset` changes lineage but not
repository identity.

**epoch** — the only genuine ordered axis. `accountEpoch` indexes a hash-chained
signed key-state chain; `keyEpoch` is the per-workspace KEK counter baked into
manifest AAD. Monotone append enforced in SQL (`apps/api/src/keys.ts`), gating
commit admission (409 `epoch_stale`), token mint and crypto-pool reuse. *In
practice it never advances*: design 191 (rotation) is a stub and nothing outside
tests calls the keystate endpoint. Homonyms: Unix-epoch ms, and a random UUID
tag in `apps/api/src/pack-gc.ts`.

**episode** — a three-way homonym; always check which. (a) *branch-transition
episode*: a 128-bit random per-attempt tag binding one transition's artifacts,
keep-pins, reflog message and recovery ref (`sync-git/branch-transition.ts`) —
attempt identity, not a clock. (b) *watcher drop episode*: a coalesced interval —
one burst of drop callbacks within 5s is one episode, and episode starts in a
rolling window drive the trust fuse (`src/cli/daemon/policy.ts`). (c)
`LockStarvationEpisode` in the daemon scheduler. They share no code.

**provenance** — not an axis and not a record. Primarily the typed discriminator
`TypedBlocker.provenance` — which subsystem authored a git deferral blocker
(`ref-plane | checkout | boundary | indeterminate | protocol | composer`).
Elsewhere prose with three referents: branch-base origins (whose real ordering
field is `sourceSeq`), design 206's "matcher provenance" (actually a staleness
boolean), and keep-pin "human provenance". There is no `Provenance` type.

## The two trusts

They share a word and one boolean edge. Nothing else.

**`TrustState`** — whether the daemon may believe its filesystem watcher:
`"trusted" | "suspect" | "fused"` (`src/cli/daemon/policy.ts`). In-memory,
process-local, resets to `trusted` on restart; sole writer `setTrustState` in
`daemon.ts`; recovery owned by `watcher-session-supervisor.ts`. Drops →
`suspect`; a fatal error, ≥6 drop episodes in 10 minutes, or an ignore-rule
rebuild that moves native watch admission → `fused`. `fused` is recoverable on
the parcel backend via supervised re-arm, terminal on chokidar and on a
structural-conflict recovery. Public projection narrows to
`WatcherTrust = "suspect" | "fused"`; `trusted` serializes as absent.

**`TrustedLocalView`** — `{manifest, deferred}` (`src/cli/sync/policy.ts`): the
daemon's watcher-maintained manifest with unsettled paths stripped, which a pull
may consume *instead of* an O(workspace) scan. Not a state machine — a per-op
capability plus an 8-clause predicate (`buildTrustedPullView`,
`daemon-pull-transition.ts`) whose refusals are named `SkipCause`s
(`kill-switch`, `p1-watcher`, `p2-observation`, `p3-pending`, `p5-seed`,
`p6-reset`, `p7-matcher`, …). Without it a pull reconciles against a stale
manifest and plans deletions for files that exist but were never observed.
Refusal is bounded: the pull re-seals scan-backed exactly once.

The edge is one closure, `watcherTrustedForPull()` in `daemon.ts`, consumed as
clause P1; the view never writes back. **The push plane has no trust gate at
all** (design 247 REJECTED, premise falsified). A third, unrelated trust exists:
`DaemonAmbientTrust` — whether the ambient status file can be believed.

## Admission

**admission** — a gate deciding whether an operation may proceed, returning
*admitted* or a typed refusal. It is a **naming habit across ~8 unrelated
subsystems, not an enforced convention**: no shared base type, helper or lint
rule. Design intent is fail-closed and the code overwhelmingly honours it
(unparseable records refuse; every delta uncertainty falls back to the stricter
full path).

The **commit admission fence** is one specific mechanism: the pre-CAS gate in
`WorkspaceSync.commit` (→ `validateCommitRefs`, `apps/api/src/commit-accounting.ts`)
refusing to advance a head past a commit referencing blobs the account is not
entitled to, that are not `present=1`, or that are prune-marked / under an active
GC deletion intent. The fence proper is two `NOT EXISTS` clauses folded into the
entitlement SELECT — folded rather than run as a second pass to make the barrier
un-forgettable. Refusals: 422 `unsatisfied_blobs` (a protocol bounce — the client
re-uploads and retries the same manifest), 402, 413, 409.

Other admission points, each separately owned: E2EE roster admission grants
(client-owned; the server stores the material verbatim and never parses it),
`/v1/keys/admit` version monotonicity, pairing-token material, **folder
admission** (`admitted | unbound | missing | detached | damaged | ambiguous`),
state-plane migration admission, reset memory admission, transition/stage
admission, and watcher admission (native prune globs — the one best-effort,
non-fencing use).

## Binding

**binding (folder↔workspace)** — the canonical sense: a machine-local record
tying an absolute folder root to one remote sync stream (`workspaceId`,
`projectId`, `remoteUrl`, this machine's `deviceId`, the pull-only `scope`).
Truth is per-root in `<root>/.rbox/workspace.json` (`src/cli/workspace-config.ts`);
`~/.rbox/workspaces.json` (`src/cli/binding-registry.ts`) is only an index of
where to look — *"never synced, never sent to the server, never authoritative."*
One question, one answer: `currentWorkspaceId(root)`.

**binding (daemon startup record)** — `~/.rbox/daemons/<key>/workspace.bound`,
`v2 <workspaceId> <bootId>`, written by a running daemon and compared against the
above to detect a leftover daemon and attribute daemon-owned sidecars
(`src/cli/daemon/runtime-state.ts`, `observation.ts`).

**binding (evidence)** — the highest-volume sense: the exact identity tuple a
durable artifact is tied to so it cannot be replayed elsewhere —
`SourceStageBinding` (*"a name or a stage id alone is forgeable"*),
`ArtifactBinding {lineageHash, repositoryIdentityHash}`, `CheckoutJournalBinding`,
`GitResolutionBinding`; admitted by `assertDeclaredBindings`.

**`bindingId`** — a derived 16-hex identifier naming one local *state lineage*
for telemetry; a reset or rebind mints a new one, which is how the fleet server
separates episodes. `state_lineage.telemetry_binding_id` locally;
`device_sync_state.binding_id` / `fleet_alert_state.binding_id` server-side.

*Not binding senses*: the folder catalog (`~/.rbox/config.json`) is user-owned
configuration that only *observes* bindings. "Safely bound" is prose in
`docs/DEPLOYMENTS.md` with zero code hits — the code says *"live runtime has no
valid desired workspace binding."* Exclude the wrangler-binding, D1 `.bind()` and
Svelte `bind:` homonyms.

## Exclusion, and words that only look like it

**fence** — usually mutual exclusion, and **never a fencing token**: the lock
marker's token is a random nonce nobody orders. The canonical one is the *reap
fence* (`acquireFence`, `src/engine/lockfile.ts`), a second `O_EXCL` lock at
`<lockPath>.reap` stopping two processes from breaking the same stale lock;
released in a `finally`, reclaimed by liveness probe rather than TTL (`unknown`
is never reclaimed). Also a *recovery fence* (an ordered acquisition over
`PROTOCOL_LOCK_ORDER` — lock-ordering discipline, not one lock) and a credential
fence with its own separate lockfile implementation. Several "fences" are
precondition-only (`CommonDirIdentity` matching, `tombstoneFenceResponse`).

**lease** — four meanings, one real. `MutationLease` (`src/engine/mutation-gate.ts`)
is a participation ticket in a shutdown barrier, held concurrently by design —
not exclusion. `CiphertextLease` and `EntryLease` are refcounts. The **GC purge
lease** (`apps/api/src/gc-state.ts`) is the only genuine distributed TTL lease,
and it carries the real fencing semantic under another name: `leaseGuard()`
inlines `owner = ? AND expires >= ?` into every mutating statement, so an expired
holder is rejected by the database.

**gate** — mostly prose for "a precondition that must pass". The one structural
symbol, `ShutdownMutationGate`, is a shutdown barrier, not mutual exclusion.
`SingleGate` (`remote/blob-batch/gate.ts`) is a semaphore. `BreadcrumbVetoGate`
is a ranked union of reasons — pure classification.

**breaker** — a **stateless threshold predicate**, not a circuit breaker: no
open/half-open states, no failure counting, no reset. `pushMassDeleteTrips`
(`src/cli/sync/policy.ts`) refuses a push at `max(1000, 20% of baseline)`
deletions (`MassDeleteGuardError`); the pull-side twin is inlined in
`sync/pull.ts` with its own thresholds. Bypass is per-invocation consent
(`--allow-mass-delete`).

The actual exclusion set is elsewhere: the **workspace sync mutex**
(`src/cli/sync-mutex.ts`, `<root>/.rbox/state/sync.lock`), `acquireLock` /
`OwnedLock` (`src/engine/lockfile.ts` — `O_EXCL` + hardlink marker with
dead-owner reap; **there is no `flock` and no `proper-lockfile` in this repo**),
the ranked protocol lock classes, genesis pairing locks, state CAS locks, and
`HeldStatePlaneLocks` as a branded witness. The one true monotonic epoch is
`pathEpoch` in the entry arena, and it is never called a fence.

## Design numbers

Citations counted over `src/`, `apps/`, `scripts/`. Read a doc for the argument;
read this to know what a citation is claiming.

| # | cites | concept |
|---|---:|---|
| 43 | 89 | per-repo `gitRepos`: every nested repo/worktree ships its own section (killed "repo == sync root") |
| 222 | 67 | U3 state-plane migration protocol: migration unit, the `Q` flip, whole-state adapter, never-open-a-DB-you-don't-own |
| 163 | 50 | the state plane lives in SQLite — migration authority matrix, genesis intent, observation-only opens |
| 130 | 47 | follower branch hygiene: authenticated tombstones of superseded ref values let a follower prune instead of stranding |
| 12 | 46 | the zero-knowledge E2EE wire spec — MK/roster, offline-verifiable admission grants, convergent blob encryption |
| 116 | 45 | checkout follows sync: per-ref partial git apply replaces the whole-section defer (supersedes 68 §3.2) |
| 126 | 42 | op-state breadcrumb waiver: `ORIG_HEAD` is a breadcrumb, not in-progress state — heal it, don't defer forever |
| 37 | 42 | self-serve account/data deletion: owner-only, tombstone + async purge, auth fails closed on a tombstone |
| 200 | 41 | worktree lifecycle resilience: out-of-band branch-deletion capture, and the accepted ACK/BASE-retirement residual |
| 212 | 40 | selective sync v1 — pull-only scoped bindings; never scoped publishing up |
| 202 | 40 | pull consumes the trusted local manifest instead of an O(workspace) pre-pull scan |
| 56 | 39 | the two-device rig: throwaway devices, real workloads, paths-not-milliseconds assertions |
| 178 | 39 | transient hiccups self-heal: durable pending-mode intent register + recovery probes |
| 108 | 38 | **two live docs** — files-first first publish, *and* scan fault isolation (one unreadable file must not fake a mass delete) |
| 226 | 37 | git capture uploads *after* the decision: encrypt and retain locally, flush only what publishes |
| 206 | 34 | unlatch P7: matcher provenance must follow the base, and scan-skips must be named |
| 177 | 29 | keep-mine executes at confirm time — no deferred-intent gap, durable publication receipt |
| 21 | 28 | account identity + web↔CLI linking (Clerk shell vs CLI-born account) |
| 180 | 28 | atomic genesis enrollment: recovery kit staged phrase-recoverable before POST, idempotent bootstrap |
| 68 | 27 | git sync for main clones with linked worktrees (draft; mostly of interest as what 116 superseded) |
| 93 | 26 | git config sync: remotes + branch tracking travel with the repo, under the sync mutex |
| 50 | 25 | destructive-apply safety: type-flip conflicts + the local trash tier before any removal |
| 45 | 23 | status health: daemon activity sidecar, health-diffed `rbox status`, transfer progress |
| 224 | 22 | ignore-plane stranded bytes: an index-less repo defeats every ignore rule |
| 204 | 22 | delta-scoped publish wire: preflight/delta/commit carry only what changed |
| 189 | 19 | web-approved pairing with auto-fulfilled key delivery — zero typed codes |
| 174 | 19 | apply-side perf + the one-writer held-repo livelock (apply HELD and capture GAGGED at once, forever) |
| 49 | 18 | daemon IO priority + idle scan backoff — background sync loses the disk race to the developer |
| 172 | 17 | event-driven git-commit detection: watch refs, notice a commit in seconds |
| 103 | 17 | steady-sync quick wins: early stale-parent/epoch rejection, change-only preflight, 422 accumulator |
| 237 | 13 | watcher fuse episodes + supervised re-arm instead of scanning forever |
| 244 | 10 | echo-publish ring containment and conflict-retry starvation on slow hosts |
| 231 | 9 | user-owned folder configuration authority: one readable `~/.rbox/config.json` |
| 232 | 1 | reactive propagation ≤10s: watcher → push on quiesce → DO → WS → delta-scoped pull. A **yardstick** (draft), not shipped mechanism |
| 219 | 0 | batched follow ownership proof (O(tips×roots) subprocesses → one batched walk) |
| 241 | 0 | held-skip local-edit convergence: `local-edits` is not fingerprint-covered, so it is not skip-eligible |
| 246 | 0 | push epilogue spans: name the ack/transition/drain/settlement tail after the accepted commit |

**Number collisions.** `108` genuinely means both of its docs (~24 cites
files-first, ~13 scan-fault-isolation). `116` is `checkout-follows-sync`;
`116-phase0-findings` is its evidence record, cited as "116 phase-0". `226` in
code is always `git-capture-upload-after-decide` —
`226-cli-daemon-runtime-primitives` lives on the `2.0` branch with zero code
citations. `21` resolves to `21-account-linking.md`; `30` to
`large-ref-commit-accounting`; `141` to `git-shapes-burn-in`.

**Read with care.** 163 v13 amends v12 after a falsified premise (a read-only
SQLite open still writes `-wal`/`-shm`); 222 r6 carries the same correction.
202's §F2 provenance claim is retracted by 206. 200 records its circuit breaker
as REMOVED in one section while three others still describe it in the present
tense. 191 (epoch rotation) is an unbuilt stub. 241's problem statement is
already repaired in `held-skip.ts`. 237 §48's "fused is terminal" is its problem
statement, not current behaviour, and design 104's `RBOX_WATCHER_RETRUST`
default-off was flipped on by 237. 247 is REJECTED. 219/241/246 have no code
citations — not yet established vocabulary. Stale comments in `apps/api` still
call delta admission soak-only; it is `enforce` in dev and prod. Design 53 says
`KNOWN_MANIFEST_SCHEMA` is 3 (it is 4); design 116 specifies a schema-5
`GitSection.tracking` field that does not exist; design 93 calls the sync mutex
an "interprocess fence" where the code reserves `fence` for the `.reap` sibling.
