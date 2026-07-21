# 175 — Linux git-ref side-channel (a.k.a. 172B): event-driven refs for repos that appear after daemon start

Status: DRAFT v2 (2026-07-21) — round-1 parallel reviews folded (codex xhigh:
4 BLOCKER + 10 MAJOR, REVIEW-175-R1-CODEX.md; opus: 4 MAJOR, synthesized in
FOLD-PLAN-175-R1.md). Every finding ruled; rulings cited inline as (C-n)/(O-n).
Investigation record: `RECOMMENDATION-172B.md` + `PROBE-RESULTS.md`.
Prereq: design 172 (shipped, v1.7.13).

## Problem (field- and rig-proven; unchanged from v1)

Design 172 gives event-driven detection of `.git`-only changes — but ONLY for
repos present at the Parcel watcher's initial crawl. Any repo that appears
afterwards (`git init`, clone, atomic move-in, worktree add) never gets its
ref surface watched: pure-`.git` commits are scan-bound at the 60s floor until
daemon restart. Rig-diagnosed as GENERAL (3-file init = 6243-file clone; run
20260720-230123). Root cause pinned in Parcel 2.5.6 source: initial subscribe
does a full FTS crawl (`InotifyBackend.cc:66-79`, `fts.cc:19-47`); the live
`IN_CREATE|IN_MOVED_TO` path adds only the one reported dir — `watchDir` never
enumerates descendants (`:151-183`, `:81-94`); live add-watch failure is
silently swallowed (`:178-183`); `IN_Q_OVERFLOW` silently discarded
(`:96-123`). Parcel 2.6.0 unchanged. macOS unaffected (single FSEvents
full-path stream; field-verified 2026-07-21).

## Fix shape: bounded Bun `fs.watch` ref side-channel (Linux + Parcel only)

A registry of per-repo ref watches on Bun's `node:fs.watch`, fed by the
engine's git discovery, signaling into 172's `SignalDebouncer` →
`request("push")`. Bun's pinned watcher provides (source-verified at
bun-v1.3.14; behavior-contract-probed):

- dynamic descendant walk of a newly-arriving dir under a recursive root
  (`path_watcher.zig:663-670`, `walkAndAdd :526-533`);
- a separate process-global inotify fd + reader thread (`:454-466`) — Parcel
  working-tree storms cannot flood the ref queue.

**Empirical gate (C-10):** the v1 probe proved arming/latency under churn but
NOT the populated-move-in descendant re-crawl, and its "flood" never actually
pressured Parcel (5–7 delivered events for 7–10k ops — it hit Parcel's own
no-recrawl blindspot). The STRENGTHENED probe (populated multi-level move-in +
mutate a pre-existing deepest descendant; pre-established Parcel dirs with a
delivered-event lower bound; root delete/recreate with (dev,ino)-reuse loop,
report-only; compiled `--compile` execution) MUST pass on Linux before the
registry implementation unit starts. Until it does, the recrawl claim rests on
verified source only.

## The classifier (C-1, O-1): semantic classes, not a boolean

`isGitRefSignal(relPath)` cannot serve the side-channel: it rejects every
`*.lock` (deliberately, 172), knows nothing of structural names, takes a
workspace relPath while `fs.watch` delivers root-relative basenames, and a
pointer repo's control dir (`repoCtxFromDisk` allows arbitrary in-tree names,
`git/shared.ts:299-328`) may contain no `.git` segment at all.

New shared classifier over `(role, tail)` where role ∈ {gitDir, commonDir,
refsRoot, refsNamespace} and tail is target-relative:

`classifyRefEvent(role, tail) → "target" | "lockPreSignal" | "structure" | "none"`

- `target`: the committed-state names per role (HEAD; packed-refs;
  refs/stash; anything under heads/ or tags/ not otherwise excluded) — SAME
  tail table as `isSignalTail` (one shared exported table constant; an
  equivalence test proves the non-lock subset matches `isGitRefSignal`
  behavior).
- `lockPreSignal`: `<target>.lock` only (see next section).
- `structure`: creation/replacement of `refs`, `heads`, `tags` under the
  owning role → registry re-arm input, never a push signal by itself.
- Everything else (`reftable` — see below, `refs/remotes`, `refs/rbox-*`)
  → `none`.

Separately, the **repo-candidate lifecycle classifier** runs in the main
watcher event path (ahead of the matcher, same seam as 172's classifier):
ANY event kind — create, update, AND delete (C-8) — on an exact path-segment
`.git` entry (dir or pointer file; exact `=== ".git"` match, same as
`git-discover.ts:39` — never `startsWith`, O-5) is a signal-only lifecycle
input: create/update request discovery; update/delete DIRTY the owning
registry generation (pointer retarget via in-place rewrite is an `update`;
delete invalidates ownership even if a recreate coalesces). Candidates ride
the SAME SignalDebouncer; discovery-negative candidates are cheap no-ops.

**Backend policy (normative):** all backends keep today's `isGitRefSignal`
main-path behavior UNCHANGED (locks stay rejected there — macOS and the
Linux main path do not change; invariant 6). Only the Linux side-channel
consumes `lockPreSignal`/`structure`. Repo-candidate classification is
platform-neutral; its registry consumption exists only where the registry
exists (Linux+Parcel).

## Lock events are pre-signals — with the busy-retry that makes them sufficient (C-7)

Bun coalesces same-type events within ~1ms per handler, more broadly than its
own doc comment claims (`shouldEmit :133-144` vs comment `:124-127` — code
verified): the final `refs/heads/X` rename may be swallowed right after
`X.lock`. So an accepted lock wakes the debouncer. But a lock is only proof a
transaction STARTED: if the debounced push (quiet 400ms / max-wait 3s) reaches
planning while the lock is still held, the planner defers on `isGitBusy`
(`plan.ts:458-478`) — and today the daemon's prompt-retry machinery keys ONLY
on file deferrals. Without more, a max-wait flush can consume the only usable
pre-signal and strand the capture until the safety scan.

**Normative:** the push path reports git-busy deferrals to the daemon
(seam: the same SyncDeps observer below, or a `gitDeferred` field —
implementation picks, but the DAEMON must see it), and the daemon schedules a
bounded post-busy recheck: one retry at +2s, one at +8s, then surrender to
the floor. Test: transaction held past debounce AND max-wait with the final
target callback suppressed — the pre-signal + busy-retry alone must capture.

## Registry: generations, roles, and the ownership graph (C-2, C-5, C-12, O-2)

**Watch roots per unique physical repo** (unchanged from v1): shallow
`gitDir` (HEAD), shallow `commonDir` (packed-refs; notices `refs`), shallow
`commonDir/refs` (stash; notices `heads`/`tags`), recursive
`commonDir/refs/{heads,tags}`. Never watched: objects, logs, remotes,
rbox scratch, reftable, anything outside the sync root.

**Identity and replacement (C-2 — experimentally proven):** `(dev, ino)`
equality is NOT a liveness fence — codex reproduced inode reuse on this
filesystem (identical tuple after rm/recreate; only callback `rename,
filename=null`; new writes invisible). Therefore: a root-self rename or
null-filename callback, and every structure/candidate update/delete touching
a root, marks that handle's GENERATION dirty and forces detach + re-attach
regardless of stat equality. `(dev, ino)`+`ctimeNs` are diagnostics only.
Contract test: recreate until tuple reuse, then prove a mutation below the
replaced root is observed post-re-arm.

**Ownership (C-12):** contributors are stable `(repoOwner, role)` records;
accepted-name filters aggregate by refcount per `(canonicalRoot, mode)` — a
normal repo (`gitDir === commonDir`) contributes BOTH roles to one physical
handle; a linked worktree contributes only the commonDir role. Reconcile
builds the ENTIRE next desired graph before mutating the current one,
publishes newly-armed handles before retiring superseded ones, and closes a
physical handle only when its last next-generation contributor is gone.
Tests: normal+linked sharing, either owner removed, simultaneous transfer,
filter union on `gitDir===commonDir`, replacement mid-reconcile.

**Close fencing (C-5):** a monotonic `closed` bit set before the first await
in `close()`; every reconcile/attach path re-checks it after EVERY await; a
handle created after closure is closed before publication; late discovery
results arriving after close are no-ops (tested explicitly — `stop()` drains
an in-flight pump AFTER `watcher.close()`, so late results WILL happen).

**Bounds (C-11):** repo count capped at the existing `gitRepoCap()` ceiling
with deterministic selection (in-tree dir repos in stable path order;
over-cap repos are floor-eligible, logged once per composition). Descriptor
budget: JS handles are bounded (≤4/repo) but recursive namespace roots cost
one inotify wd per DIRECTORY, unbounded per repo. Pre-arm, the registry
counts namespace dirs itself (cheap bounded walk of `refs/{heads,tags}`); a
repo over the namespace budget (default 512 dirs) gets NO recursive roots —
shallow roots still arm, the repo is floor-eligible, one log line. This makes
"bounded" true rather than claimed.

**Retry/backoff (C-11), executable semantics:** per-target exponential —
base 1s, ×2, cap 60s, ±20% jitter, reset on successful attach; ONE timer
armed for the earliest pending target; a candidate/structure event before
`nextAttemptAt` marks dirty but does not preempt the timer; failures keep
desired ownership and floor eligibility. Fake-clock tests.

**Bun reader death is process-fatal (C-9):** Bun's watcher manager is
process-global, created once, never recreated; a fatal reader error emits
errors and the thread exits (`path_watcher.zig:27-70, 568-585`). On it:
close all handles, latch floor eligibility for the daemon lifetime, suppress
all further attach attempts. Recovery is daemon restart. Root attach
failures (visible, C-verified) remain retryable; reader death is not.

## Discovery and arming: three inputs, one authority (C-5, O-4 — hybrid)

v1's "thread contexts through the terminal PushResult" is DROPPED: the
terminal result misses genesis (early return, `plan.ts:217-227`), arrives
only after capture/upload/commit success, and races `stop()`.

1. **Initial:** the watcher-start `discoverGitRepos` walk (already exists,
   `watcher.ts:270`) feeds the first reconcile.
2. **Every plan:** a `SyncDeps` observer (`onGitReposDiscovered`), invoked
   INSIDE `planGitSections` immediately after discovery — including the
   genesis branch — carrying `{repoPath, kind}[]`. The REGISTRY resolves
   contexts itself via `repoCtxFromDisk` (engine-exported, callable from the
   daemon layer; per-repo resolution failure → pending + floor, not a thrown
   plan). This fires before any later plan/upload failure can eat it, uses
   the plan's own walk as the single authority, and adds no `GitPushPlan`
   field. `SyncDeps` already carries daemon-owned observers (`deps.ts:31-75`).
3. **Candidates:** debounced targeted discovery of the candidate subtree
   only.
4. **Safety-scan completion:** full re-discovery — the ONLY input that may
   SHRINK the eligible set / clear the floor (authoritative snapshot, C-6).

**Arm-then-push handshake (O-7, normative):** after all roots for a newly
discovered or generation-replaced repo are armed, push the SignalDebouncer
once; the handshake push MUST be a real `planGitSections` push (fresh
fingerprints — a coalesced manifest-only push would reopen the gap).
Mutation-before-arming is captured by that plan; after arming, by the watch;
no gap.

## The floor: imperative, backend-independent, snapshot-cleared (C-6, O-3)

Two separate states:
- `gitSafetyFloorRequired` (backend-independent): true iff the latest
  authoritative snapshot contains ANY in-tree repo of kind `dir`, OR any
  registry root is armed/attaching/failed, OR reader-death latched. Pointer-
  only and out-of-root repos do NOT pin — exactly 172's shipped semantics
  (O-3; preserving, not changing, the current pin behavior). Maintained from
  plan/scan snapshots, so Linux+Chokidar (which returns no
  `gitRefWatchActive` and prunes `.git`) now gets the floor it was promised.
- `gitSidechannelActive/Pending`: handle states, for logs/telemetry only.

**Imperative pin (C-6):** the tick-time `pinToFloor` read is not enough — a
quiet tick may have armed a 120–300s timer already. Every false→true
transition of `gitSafetyFloorRequired` calls the existing `pinSafetyFloor()`
(`daemon.ts:639-656`) immediately. Transition sites enumerated: initial
discovery, plan-observer discovery, candidate-driven discovery, attach
failure, over-cap/namespace-budget disposition, reader-death latch, backend
fallback. Only the scan-completion snapshot clears it; zero-repo workspaces
release the pin (test).

## Reftable is refused, not "bounded" (C-3)

Invariant-4-as-v1 was FALSE for reftable: the common-dir fingerprint reads
`packed-refs` + loose `refs` only (`fingerprint.ts:204-224,266-295`) — a
reftable repo's safety scan can carry a stale trusted fingerprint FOREVER.
That is silent unboundedness shipping TODAY (pre-dates 175; 172 §"reftable"
recorded the exception). Resolution: `gitPreflight` gains a STRUCTURAL
refusal for reftable repos (`refs/heads` absent + `reftable/` present ⇒
defer with the teachable message pattern used for shallow clones — design 43
precedent), until a reftable-aware fingerprint exists (explicit non-goal
here). Invariant 4 then holds honestly for every ADMITTED shape.

## Telemetry rider `git_capture` — cross-surface or not at all (C-4, C-13, O-2)

The v1 client-only rider would self-destruct: the deployed ingest normalizes
unknown kinds to `unknown_kind`, DROPS them, and still returns 202
(`telemetry-ingest.ts:142-148,216-236`), upon which the client deletes the
samples (`queue.ts:115-128`). Normative scope:

- **Provenance:** a pending-reason bitset {signal, candidate, scan, other}
  raised at `request("push")` time, SNAPSHOT + cleared when a push dequeues,
  retained across that push's internal retries (409/epoch recovery), reasons
  arriving during an active push stay pending for the next one. Attribution
  is mutually exclusive by precedence signal > candidate > scan > other; the
  unit is TERMINAL SUCCESSFUL PUSHES (not per-repo captures, not attempts);
  counted exactly once at terminal success. (C-13's ancestry ambiguity: a
  push with both signal and scan ancestry counts as `signal` — precedence,
  deterministic, tested.)
- **Client:** `git_capture { signalPushes, candidatePushes, scanPushes }`
  additive accumulator in contract.ts + queue (snapshot/removal like
  ws_health) + queue tests.
- **Server:** mirrored kind in `apps/api` telemetry contract + normalization
  + AE doubles layout + the exact-equality drift test
  (`telemetry-ingest.test.ts:61-79`) + ingest test.
- **Consumer:** the admin AE query for the chart (one documented query;
  panel wiring may follow later).
Sizing includes `apps/api/**`; deployment rides the normal dev-first flow.

## Gates and evidence matrix (C-10, C-14)

- **Bun behavior contract:** new REQUIRED CI job `bun-refwatch-contract` —
  ubuntu runner, the repo's pinned Bun (engines `^1.3.14`), runs the
  strengthened probe from SOURCE; plus `bun build --compile` execution of the
  probe wired into the two native Linux release smoke legs (linux-x64,
  linux-arm64, `release.yml:86-114`); the darwin-arm64 leg asserts ZERO
  side-channel handles instead (the probe on macOS exercises kqueue/FSEvents
  and proves nothing about inotify — the gate is Linux-only by definition).
  Any Bun version bump must pass this gate before release — this is the
  Rust-rewrite insurance: the dependency is the CONTRACT, not zig source.
- **Platform matrix (real targets):** side-channel ON: linux-x64-glibc +
  linux-arm64-glibc with Parcel available. OFF: any Parcel-unavailable
  fallback (chokidar — shares Bun's fs.watch queue with the whole tree),
  unsupported arches, darwin-arm64. Every OFF-Linux shape still gets the
  60s floor via backend-independent eligibility.
- **Rig:** `git-commit-propagation` rounds `small-repo-empty` +
  `big-repo-empty` tighten from `degrade-bounded` to `event-driven` (<30s
  ceiling). HONESTY (C-14): the scenario is not in FAST_SUITE and the e2e
  workflow has no operational self-hosted runner — this is EXPLICIT MANUAL
  VALIDATION (session-run via `sg docker` pre-merge), not a nightly gate;
  recorded as such in the PR. Rig Dockerfile Bun pin 1.3.5 → 1.3.14 first
  (comment updated — `package.json` DOES declare engines `^1.3.14`, C-15).

## Invariants (revised)

1. Ref/lock/structure/candidate signals NEVER enter `pendingEvents`,
   `onRawEvent`, the manifest, or upload. Signal-only, all of them.
2. Scanner/manifest `.git` exclusion untouched; receiver repos fsck-clean
   (rig-asserted).
3. ONE shared tail table is the classification truth: `isGitRefSignal`
   (unchanged, main path, all platforms) and `classifyRefEvent` (side-
   channel) both derive from it; equivalence on the non-lock subset is
   test-pinned. File-plane exclusion is owned by the hard-exclude
   independently of both.
4. Every failure mode of an ADMITTED repo shape degrades toward the 60s
   floor, never silence: visible failures via retry+floor, silent inotify
   modes via floor retention, reader death via latched floor. Reftable is
   refused at preflight (not admitted), so no admitted shape is unbounded.
5. No watch authority outside the sync root.
6. macOS: implementation MUST keep the `process.platform === "linux"` gate
   on registry construction AND floor eligibility; zero side-channel handles
   on darwin (release-leg asserted); `isGitRefSignal` main-path behavior
   unchanged on every platform.

## Tests the implementation MUST write

1. Watcher-first `git init` → empty commit → signal <10s; no git path in
   `settled`/raw/`pendingEvents`.
2. `git init` in existing dir AND at workspace root → candidate → discovery
   → arm → handshake push (real plan).
3. Atomic populated move-in → converge → empty commit event-driven.
4. Nested namespace creation storm; lock pre-signals; no `.lock` in file
   plane; busy-retry captures with final rename suppressed (C-7 test).
5. Pointer repos (incl. control dirs with no `.git` segment), detached +
   linked-worktree HEAD, packed-refs, stash, branch/tag delete,
   missing-then-created namespaces, shared-common-dir role union + either
   owner removed + simultaneous transfer, out-of-root refusal.
6. Replacement: delete/recreate until (dev,ino) reuse → generation-dirty →
   re-arm → mutation observed (C-2 contract + product test).
7. Injected failures: root attach fail (backoff schedule, fake clock),
   reader-death latch (no further attempts, floor latched), over-cap,
   namespace budget exceeded, reconcile race, close-during-attach, LATE
   result after close (C-5).
8. Floor: imperative pin on each transition site; scan-snapshot clear;
   zero-repo release; pointer-only does NOT pin (172 parity); chokidar
   backend gets the floor.
9. Reftable: preflight refusal with teachable message; admitted-shape
   invariant holds.
10. Telemetry: provenance precedence + snapshot/retention across retries +
    exactly-once terminal counting; client accumulator; server drift +
    ingest tests.
11. Strengthened probe: source-run in CI job; compiled run in release legs;
    macOS zero-handle assertion.
12. Rig (manual gate): both empty-commit rounds event-driven <30s.

## Non-goals

No macOS side-channel; no chokidar side-channel; no reftable fingerprint
support (refusal only); no Watchman; no Parcel fork; no polling; no changes
to capture/bundle/encrypt/upload/apply/purge/identity; 173/174 untouched.

## Sizing (revised, C-15)

~450–650 production lines: `src/cli/daemon/git-ref-watch.ts` (~250–320,
registry+classifier+backoff), watcher.ts (~60–100), SyncDeps observer +
plan hook (~30–50), daemon wiring + provenance (~60–90), preflight reftable
(~15–25), telemetry client (~40–60), `apps/api` telemetry (~40–60), CI/
release workflow edits, Dockerfile pin. Tests ~400–600 lines + probe v2.
