# 177 — keep-mine execution reliability (survive ambient churn)

Status: DRAFT v3 — r1 findings all folded (1 accepted-modified, 2 accepted/
dropped-mechanism-A, 3-5 accepted). r2 (gpt-5.6-sol, high) verdict
CHANGES-REQUIRED, all five findings accepted and folded in v3: absence voids
(r2-1), lineage transition centralized in state composition + take-theirs
clears stale intents (r2-2), repositoryIdentity/repoKind stay hard (r2-3),
record-time branch predicates re-run at execution (r2-4), pin-time stability
endpoint replaces full-equality with refuse-not-void semantics (r2-5).
Round 3 pending.

## Problem (field evidence, 2026-07-21, founder's Mac)

Healing savvy-core took five keep-mine attempts. The dominant failure:
"keep-mine snapshot changed; review the current repository and confirm again",
three consecutive times across ~2h on an actively-used repo. The intent binds
the full snapshot (`resolutionBindingIdentity`: refs, reflogs, head, index,
op-state, stash, config, repoGen, incomingKey…), and ANY drift between record
and the executing push voids it. On a live work repo — IDE background fetches,
linked-worktree agent activity, routine commits, and the daemon's own pull
cadence — the record→push window virtually never closes. Success required
stopping the daemon and scripting record+push into one ~10s window. Users
cannot be expected to discover that.

**Non-problem (r1 finding 2):** there is no quiescent early-exit catch-22.
An executed intent produces `resolvedPending` (plan.ts:992), which alone makes
`gitPlan.changed` true (plan.ts:227) and bypasses the no-op exit
(push.ts:511); the file-plane-quiescent E2E (git-sync.test.ts:1526) passes.
The field "already in sync" pushes were the intent voiding at the equality
gates before execution — fixing the voiding fixes the whole symptom. No
publish-on-pending-intent mechanism is needed, and none is added: a refused,
voided, or journal-blocked intent MUST NOT publish an empty sequence.

## Invariant

"What you previewed is what gets discarded." The final report gate already
re-derives the discard report against the live candidate and authorizes it
lane-by-lane against the confirmed preview (`reportAuthorized`, hardened in
v1.7.18). Snapshot-identity equality is stronger than the invariant requires,
and it is what ambient churn breaks.

## Mechanism

### 1. Decompose ALL THREE equality gates (r1 finding 3)

Current execution performs full-binding equality at plan.ts:734 (pre-capture),
plan.ts:1002 (post-capture), and plan.ts:1031 (pre-pin). Each decomposes into
exactly three categories; full-snapshot equality is no longer computed as a
voiding condition anywhere:

- **Hard fences (void on mismatch, today's "review and confirm again" copy):**
  `stream`, `stateNonce`, `incomingKey`, `repositoryIdentity`, `repoKind`
  (r2-3: physical repo identity is a subject fence — an intent confirmed for
  clone A must never execute after R is replaced by clone B, since capture
  would publish all of clone B's refs while the report examines only
  pending's lanes), and the remote-lineage fence (§2). Checked at all three
  sites.
- **Semantic branch predicates (refuse, retain intent — r2-4):** the two
  record-time refusal predicates (git-cmd.ts:887 BASE-tracked incoming branch
  absent locally; git-cmd.ts:896 divergent incoming branch currently checked
  out) are re-evaluated against the final candidate and live checkout at
  execution. Full-refs equality silently kept these true; without it they
  must be checked explicitly. Failure → refuse with the record-time copy.
- **Op-state safety (refuse/defer, retain intent — never void):** §3.
- **Report authorization (refuse, retain intent):** the existing
  `reportAuthorized` lane gate at plan.ts:1024, unchanged — any lane that
  would discard more than the confirmed preview refuses.
- **Pin-time stability endpoint (refuse/defer, retain intent — r2-5):**
  immediately before preservation pins, re-read refs, HEAD, presence-aware
  op-state, and index identity and require equality with the captured
  candidate's values. This replaces the old full-binding equality at
  plan.ts:1031 with a check scoped to the artifacts actually being published,
  and its failure mode is refuse-and-retry-next-push, not void — shrinking
  the race window from user-scale (record→push, minutes) to capture-scale
  (capture→pin, seconds) instead of pretending it is zero.

Drift in reflogs, stash, and config, and any refs/head/index drift BETWEEN
record and capture, no longer voids; a mismatch in the (still computed)
binding identity is downgraded to a logged notice:
`keep-mine proceeding on a changed repository — discard report re-verified`.

### 2. Remote-lineage fence replaces the repoGen fence (r1 finding 1, accepted-modified)

The CRITICAL risk: pull preserves the previewed pending P1 when an intent
exists (apply.ts:601) while newer remote git truth P2 advances the record
(pull.ts:273, sync-state.ts:353, repoGen bump at config.ts:638). With repoGen
soft and incomingKey matching P1, execution would overwrite never-previewed
P2. With repoGen hard (plan.ts:736 requires exactly `binding.repoGen + 1`),
every ambient pull kills the intent — the daemon's pull cadence makes the
fence unsatisfiable outside stop-the-daemon windows, which is the field bug.

Replacement — void precisely when remote git truth for THIS repo moves.
Remote heads are full decoded manifests (e2ee-remote.ts:132), so for a repo
that existed, presence-aware truth is well-defined (r2-1): a manifest whose
git section for R has the SAME `gitIncomingKey` leaves the intent alone; a
DIFFERING section voids it; and ABSENCE of R's section also voids it —
absence is authoritative newer truth (a peer deleted R; apply already clears
pending/base there to prevent resurrection, apply.ts:619/:624), and a
surviving intent would resurrect a never-previewed deletion.

- **Enforcement is centralized in state composition (r2-2), not at ingress
  call sites.** The preserve-pending site (apply.ts:601) is one of at least
  four paths that move remote git truth into the record — journal-recovery
  defer paths (apply.ts:545/:571) and the receiver-key-collision/per-repo
  catch paths (apply.ts:1622/:1636) replace pending before any line-601
  fence would run. Instead, the record-composition layer (sync-state.ts:239,
  where `resolutionIntent` is currently preserved by default) applies the
  lineage rule whenever a state transition carries a new observed remote
  truth for R: same-key → preserve intent; differing-key or absent → drop
  the intent (with the "snapshot changed; review and confirm again" user
  message surfaced via the deferral text) and let pending take the new
  section per existing no-intent behavior.
- A **live intent** is defined as intent + pending both present (r2-2);
  `take-theirs` clears `resolutionIntent` explicitly when it rebuilds the
  record (git-cmd.ts:1062/:1136 currently copy it forward — a stale-intent
  bug independently worth fixing).
- Pulls whose manifests never observed R's stream (file-plane-only sequences
  for other workspaces' shapes) do not touch the intent; "no section for a
  repo the manifest DOES cover" is the deletion case above, not this one.
- `binding.repoGen` is removed from the intent binding; plan.ts:736 drops the
  `+1` fence. Lineage safety now lives in state composition — the single
  choke point every ingress path already flows through.
- Regression test (r1-mandated): confirm intent → another device publishes a
  newer git section for R → pull → intent is void, pending is the NEW
  section, keep-mine re-preview shows P2 content; the executing push after
  re-confirmation discards P2 only.

### 3. Presence-aware op-state, bracketed (r1 findings 4 + 5)

- **Classifier:** record-time (git-cmd.ts:819, :963) and execution-time
  checks stop using bare `readOpState` key enumeration (refs.ts:33 misses
  empty in-progress roots). Reuse follow's presence-aware semantics
  (follow.ts:428, :550): an in-progress root directory counts even when
  empty. Extract the shared classifier rather than duplicating it.
- **Bracket:** capture is not atomic (capture.ts:207 stages index/op-state
  before HEAD/refs/bundle). Per design 176 v6 (held-skip.ts:138 pattern),
  execution takes a trusted fingerprint of the classification inputs
  (presence-aware op-state roots + file hashes + index identity) BEFORE the
  candidate-producing reads and re-verifies it AFTER the final report is
  authorized, at the §1 pin-time stability endpoint. Fingerprint mismatch,
  an in-progress root represented in the captured candidate, or an
  incomplete/indeterminate endpoint observation (r2-5; index projection can
  return indeterminate on probe failure, index-identity.ts:79) →
  refuse/defer retaining the intent (next push retries); never void, never
  publish.
- **ABA soundness argument (r2-5), pinned here because it is the load-bearing
  claim:** an operation that starts and fully unwinds strictly inside the
  bracket (creates `rebase-merge/`, mutates HEAD/refs, aborts, restores)
  cannot corrupt the published candidate, because every published artifact is
  either (a) enumerated at bracket start and byte-read from the append-only
  object store (bundle contents, op-state files listed at capture.ts:279 —
  files created after enumeration are never published), or (b) re-verified at
  the endpoint (refs, HEAD, op-state presence, index identity, all required
  equal to the captured values). An interior op that restores state to
  exactly the captured values has, by construction, not changed anything the
  push publishes. What the bracket therefore excludes is not "no operation
  ran" but "no operation's effects are represented" — which is the safety
  property 176 v6 actually needs. Test: create-then-delete an operation root
  inside the bracket window (test hook) both with and without restoring
  refs — the restored case may publish (endpoint equal), the unrestored case
  must refuse.
- Record-time refusal for in-progress operations keeps today's behavior and
  copy, upgraded to the presence-aware classifier.

## Non-goals

- No change to preview/confirm token flow, refusal shapes, or user-facing
  copy (one new log notice aside).
- No change to take-theirs.
- No publish-on-intent mechanism (dropped, r1 finding 2).
- No retroactive re-execution of intents voided in the field.

## Tests the implementation MUST write

1. Ambient churn: record intent; add commits, grow reflogs, rewrite index,
   touch config between record and push → intent executes, notice logged, no
   void. (Fails today at plan.ts:734 before capture even starts.)
2. Remote lineage: record intent → pull applies a newer git section for R →
   intent void with "snapshot changed" copy, pending replaced by new section;
   re-preview reflects new content.
3. File-plane-only pull between record and push → intent survives, executes.
4. Widened discard: repo change makes a NEW lane discardable (delete a
   preview-subsumed branch) → refuse "review and confirm again", intent
   retained, nothing published for it.
5. Empty in-progress root (bare `rebase-merge/` directory, no files) at
   record time → refusal with in-progress copy; same at execution time →
   refuse/defer retaining intent.
6. Bracket race: mutate op-state between capture reads and pin time (test
   hook) → refuse/defer retaining intent; no void; no publish.
7. Quiescent workspace regression (exists, keep green): record → clean-file-
   plane push executes intent and publishes exactly one sequence
   (git-sync.test.ts:1526).
