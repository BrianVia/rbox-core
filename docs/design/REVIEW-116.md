# REVIEW-116 — checkout follows sync

Design class: active Git correctness and no-clobber behavior.

Status: initial-draft scrutiny complete; formal `/arbitrage` alignment loop has
not run. The design remains **INITIAL**, not implementation-approved.

## Initial source and adversarial pass — CHANGES-REQUIRED

Three parallel read-only passes inspected the current apply/state model,
designs 43/93, status/daemon paths, and the drafted design. Findings folded
into the initial document:

1. **Reported root cause did not match current HEAD.** Current
   `localDivergedFromBase()` and `applyGitState()` do not read working-tree
   dirt. The design now requires a Phase-0 reproduction against the incident
   release/state and forbids changing the predicate on narrative alone.
2. **Shared tracking-ref fan-out.** Per-pointer complete `refs/remotes/*`
   snapshots could regress a common store like design 43's stash fan-out. The
   design now takes one bracketed snapshot per source commonDir and reduces
   receiver cohorts once by authenticated source sequence, with a cross-shape
   convergence gate.
3. **Object presence was mistaken for incoming ownership.** The design now
   separates incoming logical roots from the planned durable no-drop graph and
   excludes scratch/recovery names from ownership proof.
4. **Checkout TOCTOU holes.** Per-file tokens missed new paths and slow
   ref/config work left a race. The design now requires a second complete
   subtree proof plus HEAD/index/op/ref reclassification at the checkout
   lock/linearization boundary.
5. **Tracking absence and kill-switch false ACK.** Tracking is now a complete
   present-or-no-assertion lane; schema 4 cannot mean delete-all. `=0` disables
   only oracle-authorized checkout movement while safe ref/config/tracking
   progress and visibility remain unconditional.
6. **Partial state could not encode symbolic refs or newer config/tracking
   truth.** `appliedRefs` now uses direct/symbolic values and `incomingKey` is a
   canonical hash over every mutation-relevant field.
7. **Config independence contradiction.** A config failure no longer blocks or
   rolls back a safe checkout; config's existing lane markers retry it.
8. **Chronic age reset.** `deferredSince` now survives newer incoming sections
   and reason changes; `reasonSince` records the narrower episode.
9. **Diagnostics privacy gap.** Redaction now covers legacy and new raw Git log
   forms structurally, with omission as the fail-closed fallback.
10. **Self-busy checkout lock.** Busy probing is now ordered before owned lock
    acquisition, with ownership-aware probing afterward.
11. **Config merge-base loss.** Partial state retains the prior canonical
    config required for design-93 three-way retry after Git base advance.
12. **Current versus non-current local commits.** Only incoming-owned current
    tips authorize checkout; unrelated local refs are held while checkout
    follows, and recovery refs can prove no-drop but never authorize follow.
13. **Push-side invisible deferrals.** Capture/config/apply have independent
    generation-CAS episodes, including sidecar-only saves for no-op base carry.
14. **Partial marker trust.** Live refs are revalidated on every retry/save;
    partial state is a hint, never authority over a later human ref move.
15. **Index and stash semantic holes.** The design now defines a canonical
   semantic index projection and protects every local stash-reflog root, not
   only `indexTree`/the stash tip.
16. **Split-index transport.** Capture normalizes a bracketed private index copy
    to a self-contained full index before projection/encryption; receivers
    never depend on an uncaptured `sharedindex.*`.
17. **Post-plan failure hid capture age.** Capture lane set/clear transitions
    now save locally immediately after planning, independently of later remote
    push success.

## Round 1 (codex, 2026-07-13) — CHANGES-REQUIRED

1 BLOCKER + 8 MAJOR + 1 MINOR. All ten adjudicated against code and adopted
(no misreads this round); folded into the design marked `(r1 Fn)`:

- **F1 [BLOCKER] checkout crash atomicity.** `applyGitState` publishes refs,
  HEAD, index, op-state as separate mutations; `restoreLocal` is in-process
  only — power loss mid-publish leaves the half-moved checkout the design
  forbade while claiming the old rollback boundary sufficed. Adopted: durable
  gitdir checkout journal (old+new values, keyed by `incomingKey`), written
  before first checkout mutation, recovered before any classification (roll
  forward or back; any third value → conflict path), cleared in the state
  save; kill-injection tests at every boundary.
- **F2 [MAJOR] no receiver path-equivalence model.** Validation rejects only
  `toLowerCase()` twins; APFS case/Unicode-normalization aliases could make
  the oracle reason about a different namespace than Git's index. Adopted:
  byte-exact first, probed FS-equivalence for spelling mismatches, collisions
  and scan-deferred paths → `indeterminate`.
- **F3 [MAJOR] lock protocol unimplementable as written.** `update-ref
  --stdin` prepare takes ref locks; naive Git commands between prepare and
  commit self-block (current `clearIndexResolveUndo` runs `git update-index`);
  HEAD needs `symref-update` (modern Git only). Adopted: pinned sequence
  (private candidate index → transaction+prepare → index.lock → lock-free
  second proof → commit), capability probe, typed `unsupported` defer.
- **F4 [MAJOR] tracking-only changes never re-capture.** `gitIdentity`/carry
  matrix exclude `refs/remotes/*`; the LWW convergence claim was vacuous.
  Adopted: per-common-store `trackingKey` capture-dirt predicate, cache
  integration, `gitDivergenceStatus` mirror.
- **F5 [MAJOR] reachability proofs not fail-closed on shallow/partial/
  incremental stores.** Adopted: closure walks with lazy-fetch disabled,
  explicit tag peel, any missing object → `indeterminate`; shallow receiver
  defers checkout; chain-link tip-presence skip is not closure proof.
- **F6 [MAJOR] reflog-only commits lost on ref delete/replace; recovery-pin
  collisions unspecified.** Adopted: stash rule generalized — enumerate and
  pin unreachable reflog OIDs for every deleted/NFF-replaced ref in the same
  transaction; pins are create-only (expected-absent).
- **F7 [MAJOR] Phase-0 scrub-first ordering destroys evidence.** Adopted:
  daemon stop + immutable raw snapshot first, scrubbed archive derived from
  it; check live current-code candidates (needsResolution identity freeze,
  busy-carry incl. stale editor lockfile, pending suppression) before bisect.
- **F8 [MAJOR] schema-5 authorship interlock undefined.** Adopted: checked-in
  build constant `GIT_TRACKING_AUTHORSHIP`, false in the reader release, all
  stamp sites enumerated by a static test.
- **F9 [MAJOR] matrix under-crosses the state space.** Adopted: index/op-state
  divergence as crossed dimensions, pairwise closure over 12 dimensions × 3
  topologies, crash-injection rows per mutation boundary, alias rows.
- **F10 [MINOR] tracking map "applied once" overstated atomic observability.**
  Adopted: transactional all-or-none commit, subset-visible to concurrent
  readers, rbox proofs serialized.

Codex verified sound: the Phase-0 premise (current `localDivergedFromBase`
reads no working bytes; file apply precedes Git apply), scan-defer omission
behavior, ignored-path byte preservation, ownership/no-drop root separation,
stash-reflog enumeration, checkout/ref plane split, absence-supersedes-pending
and partial-hint revalidation, `=0` arm semantics, and the second-scan TOCTOU
closure.

## Round 2 (codex, 2026-07-13) — CHANGES-REQUIRED

3 BLOCKER + 5 MAJOR. r1 F2/F4-F10 verified genuinely closed; F1 and F3 folds
re-opened and rebuilt. All eight adjudicated against code and adopted, folded
as `(r2 Fn)`:

- **F1 [BLOCKER] journal couldn't roll back or forward.** The r1 journal held
  an index projection hash (cannot reconstruct old bytes; `restoreLocal`'s
  bytes are in-memory only), assumed a durably pending section that on first
  apply doesn't exist until state save, and had no home before `git init` on
  fresh targets. Adopted: journal moves to `.rbox/state/git-journal/<key>/`,
  stores byte-exact old index/op-state copies + the verbatim incoming section
  + created-fresh flag.
- **F2 [BLOCKER] roll-forward could bless a crash-window human edit.**
  Working bytes aren't journaled; completing the move without re-running the
  oracle violates the prime invariant. Adopted: recovery is rollback-only;
  follow re-proves everything on ordinary retry.
- **F3 [BLOCKER] two post-apply workspace scans vs the zero-cost constraint.**
  Pull's existing scan is pre-apply; the draft added two more walks. Adopted:
  derived receipt (pre-apply scan ⊕ applied actions, dircache-token verified,
  re-hash only action-touched/token-moved entries, subtree-scoped widening);
  boundary proof is per-repo token-first; rig gate must measure
  publish→bytes-on-disk unchanged before default-on.
- **F4 [MAJOR] no abort path; wrong index publication convention; post-commit
  fsck rollback clobbers a fresh human commit** (existing `restoreLocal` uses
  unconditional `update-ref`). Adopted: connectivity proof moved pre-commit;
  explicit abort step; index published via `index.lock` rename; post-commit
  failures repair only through journal expected-current arbitration.
- **F5 [MAJOR] legacy `needsResolution` checkpoints bypass the oracle
  forever** (unconditional early return in `applyGitSections`). Adopted:
  one-time re-proof of persisted checkpoints under the new classifier,
  idempotent per `incomingKey`; §13.5 remote-absence use of
  `localDivergedFromBase` explicitly untouched.
- **F6 [MAJOR] capture-deferral saves had no ordering key** (candidate-N+1
  stamps would newer-wins-discard genuine N transitions). Adopted: lane-only
  saves never stamp an unaccepted global sequence; per-lane merge algebra;
  repoGen CAS unchanged.
- **F7 [MAJOR] degraded workspace-mutex mode ran follow unserialized.**
  Adopted: follow + independent ref publication disabled in degraded mode
  (config-lane precedent); rollback-only journal recovery and visibility stay.
- **F8 [MAJOR] unbounded recovery-ref growth on LWW tracking NFF churn.**
  Adopted: content-addressed `refs/rbox-local/keep/<oid>` pins (idempotent
  dedup) + bounded age retention for tracking-derived pins only; human-work
  pins never age-pruned.

## Round 3 (codex, 2026-07-13) — CHANGES-REQUIRED

5 BLOCKER + 2 MAJOR, all against the r2 journal/lock/pin folds; r2 F3
(derived receipt), F5, F6, F7 verified closed with no false-PASS trace found.
All seven adjudicated and adopted, folded as `(r3 Fn)`:

- **F1 [BLOCKER] journal clear vs state save had no safe crash order** (state
  claiming "applied" while recovery still rolls back → unchanged-shortcut
  suppression forever). Adopted: two-phase journal — `intent` (recovery =
  rollback) atomically flips to `published` after full checkout publication
  and before state save (recovery = keep checkout, re-run idempotent save).
- **F2 [BLOCKER] journal unbound to incarnation** (`resetSyncState` ignores
  it; a rebind can point the key at a different repo). Adopted: journal
  records stream id + state nonce + resolved gitdir/commonDir realpaths +
  worktree identity; mismatch retires without mutation; reset disposes the
  journal dir under the same lock.
- **F3 [BLOCKER] clean-materialization wipe outside the journal field model**
  (non-current refs unrecoverable after crash-mid-wipe). Adopted: wipe
  variant journals the complete pre-wipe syncable ref map; rollback restores
  it; quarantine bundle stays defense-in-depth.
- **F4 [BLOCKER] created-fresh rollback could rm-rf post-crash human work.**
  Adopted: delete only after proving the gitdir is still exactly
  rbox-authored; any doubt → quarantine-defer, `.git` left in place.
- **F5 [MAJOR] arbitration lacked exact expected-new identities** (published
  index is transformed; wire `indexSha` is the wrong comparand). Adopted:
  journal records the staged candidate's exact hash + per-op-state new-hash/
  absence map + new ref/HEAD values.
- **F6 [MAJOR] index.lock rename released the writer reservation before ref
  commit** (human `git add` in the window could be rolled back). Adopted:
  reorder — ref commit while index.lock held, then publish index; the held
  lock proves no human index write exists in any crash window; transient
  new-refs/old-index visibility pinned by test; op-state races restated as
  the accepted §43 local-attacker boundary.
- **F7 [BLOCKER] content-addressed pins collapsed tracking and human
  provenance** (30d tracking retention could prune an OID that later became
  human-work protection; residual section contradicted retention). Adopted:
  multi-origin sidecar with monotonic promotion (human dominates, permanent);
  prune only tracking-only-origin pins, re-reading origins under the
  common-dir lock; residual wording fixed.

Also folded this round (founder guidance, normative direction): new
**§UX: irreconcilable divergence** — ambient surfacing on menu bar
(`RboxBarAmbientStatus`), `rbox status`, and design-46 `shell.line`; the
file plane never freezes for a divergent repo (explicit `.git`-isolation
trade); and `rbox git resolve <repo>` with `show-me`/`take-theirs`/
`keep-mine` verb semantics (snapshot-CAS confirmation, quarantine-first,
receiver-side no-drop unweakened). Round 4 must attack the verb semantics.

## Round 4 (codex, 2026-07-13) — CHANGES-REQUIRED

4 BLOCKER + 5 MAJOR + 2 MINOR; r3 F2/F3/F5/F6 verified closed (F6 with an
empirical git-2.51 repro that `update-ref --stdin` commit succeeds while
`index.lock` is held); r3 F1/F4/F7 reopened and rebuilt. keep-mine's
receiver-side trace verified loss-free/livelock-free conditional on the pin
fixes. All eleven adjudicated and adopted, folded as `(r4 Fn)`:

- **F1 [BLOCKER] `published` recovery replayed a stale save packet** (could
  overwrite newer same-sequence lane transitions; double-advance repoGen).
  Adopted: journal stores intended post-record + expected repoGen; recovery
  does a semantic already-applied check, else composes a fresh lane-wise
  merged CAS packet — never a replay.
- **F2 [BLOCKER] created-fresh "exactly rbox-authored" proof undecidable**
  (hooks/loose objects/scan-to-delete race → rm -rf of human state).
  Adopted: post-crash recovery never deletes — atomic rename of the whole
  partial `.git` into quarantine; in-process same-call cleanup keeps its §43
  contract.
- **F3 [BLOCKER] human-origin pin promotion not crash-ordered vs the ref
  transaction** (crash window left tracking-only provenance on the sole
  protection of displaced human work). Adopted: durable sidecar promotion
  BEFORE the destructive ref commit; orphan human-origin records are
  harmless over-protection.
- **F4 [BLOCKER] keep-mine pinned incoming human commits with age-bounded
  provenance** (expiry could orphan another human's unique commit). Adopted:
  incoming heads/tags/checkout tips/stash roots pin human-origin permanent;
  only tracking entries take tracking provenance.
- **F5 [MAJOR] take-theirs snapshot CAS underdefined.** Adopted: snapshot
  identity enumerated (incarnation, incomingKey, repoGen, full refs + reflog
  tips, HEAD, semantic index, op-state, stash, oracle receipt); revalidated
  under checkout locks at the second-proof boundary; waiver limited to
  snapshot-enumerated divergences; episode journaled.
- **F6 [MAJOR] keep-mine cleared deferral before fallible import/capture/
  push.** Adopted: protect-then-clear; clear rides the accepted-commit state
  transition; 409 re-fetch/re-show/re-confirm; unfetchable pending refuses
  (explicit loud override only).
- **F7 [MAJOR] take-theirs pointer/kill-switch undefined.** Adopted: stash
  pins scoped to owning dir repos; sibling-worktree collision is an
  actionable named refusal; `=0` kills automatic follow only — confirmed
  manual resolve works (stated in both sections).
- **F8 [MAJOR] design-46 `shell.line` cannot route per-subtree.** Adopted:
  versioned sidecar extension with a repo-routing table + `$PWD` lookup;
  old plugins ignore unknown fields.
- **F9 [MAJOR] stale-porcelain publish makes a cross-plane incoherent
  manifest read as in-sync.** Adopted: `bytes-changed-during-defer` marker on
  the deferral record, rendered everywhere, blocks the clean aggregate on
  both sender and receivers; LWW bytes + version-history recovery stated
  explicitly; design 50 non-coverage stated.
- **F10 [MINOR] show-me not physically read-only.** Adopted: defined as the
  `rbox status` footprint (no user-visible state mutation; write-tree
  objects/scratch imports allowed).
- **F11 [MINOR] command grammar unpinned.** Adopted: `rbox git resolve
  <repo> [verb]`, default show-me, `--json`, `--confirm <token>` using the
  printed snapshot identity.

## Round 5 (codex, 2026-07-13) — CHANGES-REQUIRED

1 BLOCKER + 3 MAJOR, all in the r3/r4 UX/visibility additions; the entire
core follow machinery (journal phases, non-replay recovery, quarantine-rename
fresh recovery, pin promotion ordering, take-theirs CAS, keep-mine ordering,
kill-switch semantics, grammar) verified closed. All four adopted, folded as
`(r5 Fn)`:

- **F1 [BLOCKER] keep-mine could not preserve incoming index/op-state-only
  human work** (they are artifacts, not refs — pins can't hold them; scratch
  cleanup + server expiry could orphan a conflict-resolution index that
  existed only in the discarded section). Adopted: protect step retains
  quarantine-grade durable copies of the decrypt-verified incoming
  index/op-state bytes and pins commit-bearing incoming op-state roots
  human-origin, recorded in the episode.
- **F2 [MAJOR] bytes-changed marker was neither persisted nor honestly
  transportable** (receiver shape indistinguishable from a legitimate
  unstaged sender edit). Adopted: `bytesChanged` persisted on the
  `GitDeferral` schema, sender-local by design; receiver-transport claim
  withdrawn with the rationale recorded.
- **F3 [MAJOR] retained genuine checkpoints went ambiently invisible**
  (checkpoint cleared the apply age while suppression early-returns).
  Adopted: `conflict` joins the closed reason enum; new and re-proved
  checkpoints hold an apply-lane deferral with continuous age until real
  resolution.
- **F4 [MAJOR] shell.line v1 parser cannot carry routing data** (trailing
  fields become the workspace name; new versions are rejected; default path
  may spawn no subprocess). Adopted: separate versioned `shell.deferrals`
  sidecar, percent-encoded tab-separated rows, pure-shell `$PWD` prefix
  matching, old plugins untouched, ≤5 ms budget preserved.

## Open review work

- Confirm the Phase-0 incident reproduction and actual failing control-flow
  seam.
- Adversarially prove or reject the schema-5 common-store tracking convergence
  rule; if rejected, ship config-only remote tracking and split actual
  `refs/remotes/*` into a separate design.
- Verify the checkout linearization contract against real Git lock behavior and
  injected concurrent file/Git operations.
- Run formal arbitrage rounds to alignment before implementation dispatch.
