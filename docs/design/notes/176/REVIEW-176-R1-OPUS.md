# REVIEW-176-R1-OPUS — adversarial review of `docs/design/176-wedge-ux-keep-mine.md`

Reviewer: Opus 4.8. Scope: keep-mine (A), legible surfacing (B), held-skip defect (C).
Read against `git-cmd.ts`, `sync-git/apply.ts`, `held-skip.ts`, `pending-supersession.ts`,
`base-composer.ts`, `sync-git/follow.ts`, and `docs/design/130-follower-branch-hygiene.md`.

Summary counts: 1 BLOCKER, 4 MAJOR, 3 MINOR, 1 EDITORIAL.

Verified up front — the §4 defect diagnosis is CORRECT (see F6). The keep-mine
mechanism claims (§2) are where the design breaks.

---

## F1 — BLOCKER — keep-mine cannot "reuse existing machinery, wired end-to-end"; the take-theirs follow path checks out INCOMING, and manual composer authority has no locked proof over un-mutated LOCAL refs

§2 Mechanism (176:47-74) and §2.3 (176:62-69) assert keep-mine "lands the confirmed
LOCAL snapshot as the manual candidate" through "the design-130 `manual` authority,"
and §2.1 says "reuse show-me's snapshot/token flow verbatim." That is not buildable
with the cited machinery.

Evidence:
- The only manual-authority producer, `gitResolveCmd` → `followDivergedRepo`
  (`git-cmd.ts:939-973`), CHECKS OUT INCOMING: it passes `incoming` and derives
  `branchWitnesses`/`manualBranchTerminals` from an actual locked checkout transaction
  that moves refs to the incoming values. keep-mine performs no checkout — local is
  already the truth — so this path produces witnesses for the wrong side.
- The composer's `manual` no-p branch decision (`base-composer.ts:386-398`) only
  validates when `locked.liveOid === requested && locked.artifactsClear &&
  locked.ownershipStable && locked.reflogStable && !locked.siblingOwned`. That
  `lockedProof.branches[ref]` is populated only by a real prepared Git ref
  transaction inside `followDivergedRepo`. keep-mine runs no such transaction over the
  local-retained refs, so it has no locked proof to present; every branch decision would
  fall to `manual-proof-mismatch` (`base-composer.ts:393-395`).
- Design 130 line 306-309 scopes no-p manual to "an already-terminal positive branch …
  for which the confirmed episode performed NO ref mutation." The wedge's branches are
  "rewritten … non-FF" (176:26-28), i.e. live ≠ BASE. Landing live≠BASE as BASE is a
  positive-BASE advance that 130 says "requires a valid current-lineage P witness."
  keep-mine creates no P (it mutates nothing), so the composer cannot authorize the very
  branches keep-mine exists to resolve.

Fix direction: stop routing BASE through the manual composer at resolve time. The honest,
simplest keep-mine (matches the founder's "LOCAL manual fix, not an algorithm redesign"):
under the workspace mutex, RETAIN existing BASE and its origins untouched, clear
`gitPendingRemote[rel]`/`partial[rel]`/`attempt[rel]`/apply-deferral, then let the
subsequent push's normal capture advance live≠BASE branches via the ordinary
capture→`publisher-ack` path (130:914-917). No manual A/P/K authorship is needed or
correct here. Rewrite §2.3 to say "retain BASE, drop pending" — not "land the confirmed
LOCAL snapshot as the manual candidate."

## F2 — MAJOR — clearing pending before the republish is guaranteed can lose the wedge bookkeeping and silently re-wedge; a non-FF-divergent REMOTE is reserved-173 territory keep-mine must refuse, not enter

§2.4 (176:70-74) clears pending under the mutex and then merely "request[s] an immediate
push." Two hazards:

1. Ordering/atomicity. After the mutex releases with pending dropped and BASE retained
   (=L), the next PULL sees remote (publisher's advertised N/omission) ≠ BASE=L and
   re-derives pending (`apply.ts:793` remoteChanged → follow/defer), re-wedging — now
   with `attempt`/`partial` already cleared, so the fast-diagnostic path is gone. keep-mine
   must publish WITHIN the same mutex-held resolution (atomic resolve+publish), or clearing
   must be conditional on a successful publish.
2. Non-FF remote. §Non-goals (176:86) reserve 173. But if local main is itself non-FF vs
   the remote's advertised main, "publish local as the new remote truth" IS the two-writer
   force 173 owns; the push will conflict/defer and keep-mine will have cleared the
   deferral without resolving anything. keep-mine must detect this pre-clear and refuse
   with a plain-English "this is a two-writer divergence (173); keep-mine cannot force it"
   rather than clearing and hoping the push lands. State that keep-mine is authorized only
   when the republish is a non-force capture (additive/FF), which is true for the field
   wedge (stale side-branches the publisher deleted) but not for a contested main.

## F3 — MAJOR — §2.2's "v6 subsumption proof, reused as a REPORT" cannot be dropped in as written: it is candidate-bound, boolean, and computes the opposite direction from show-me

§2.2 (176:52-61) wants `--force-discard-incoming` required "whenever any pending lane is
not subsumed by local (the 174 v6 proof, reused as a REPORT)," printing "exactly what the
stale snapshot contains that local does not."

- `provePendingSupersession` (`pending-supersession.ts:157-191`) takes a `candidate:
  GitSection` and returns a BOOLEAN. At keep-mine resolve time NO capture has run
  (capture is step 4, the next push), so there is no candidate section to feed it, and it
  yields no per-lane itemization — it is a yes/no gate, not the "per lane, bounded count"
  list the design promises.
- Direction mismatch. show-me's snapshot computes LOCAL-only commits (local ∖ incoming,
  `apply.ts`/`git-cmd.ts:405-428`, `partitionOwnedByIncoming`) — for take-theirs. The
  keep-mine discard report needs INCOMING-only (pending ∖ local): the pending tips/index
  local does not have. The existing snapshot gives the wrong set; §3.2 even rewrites
  show-me's local-only phrasing, confirming these are different computations.

Fix direction: specify the report honestly as NEW, small per-lane logic: for each
`pending.refs[R]`, compare to live via the existing `equalOrFastForward`
(`pending-supersession.ts:141-154`) — if live is not equal-or-descendant of the pending
OID, R is a discarded/non-subsumed lane; likewise flag a pending index/stash/config local
lacks. Require the flag iff any such lane exists. Do not claim `provePendingSupersession`
is reused verbatim; at most its per-ref FF primitive is.

## F4 — MAJOR — no preservation inventory for the DISCARDED incoming, unlike take-theirs' quarantine+pins; O1's refTombstone lesson is unaddressed

take-theirs preserves the losing side: `quarantineLocal` + `pinDisplaced` over
`protectedOids` (`git-cmd.ts:836-842`). keep-mine discards the incoming pending section
with no symmetric inventory. The pending section is not just branch tips — it carries the
130 wire fields including `refTombstones`/`refTombstoneGeneration` (130:57-65). 174-r1 O1's
lesson is exactly: do not silently drop a refTombstone-carrying pending pointer without an
audit.

The design must, at minimum, explicitly establish (not merely imply via "git reflog still
has everything," 176:61) that: (a) the discarded incoming git objects remain
server-recoverable in the blob store, so no local quarantine is required; and (b) dropping
the incoming tombstones is safe because §2.4's advertised-based normalizer (130:914-917)
re-derives this device's tombstones from its own advertised set — with the caveat that a
publisher-only branch local NEVER advertised produces neither a tombstone nor a
re-advertisement and simply vanishes from this device's view (acceptable for a single-user
fleet, but state it). If any of these does not hold, keep-mine needs a preservation step.
As written the safety argument is asserted, not inventoried.

## F5 — MAJOR — Deliverable B under-delivers on the founder's actual need: it must name keep-mine as the "publish my work" verb and present the two-verb choice; a bare `rbox git resolve` is show-me, not a fix

Founder quotes (176:9-14, 30-35): the in-vivo bug was reaching for git ("reset to
origin/main?", "delete the workspace?") because "nothing surfaced told him the repo was
fine and rbox's bookkeeping was the stuck part." He WANTED to keep his work.

§3.1 (176:90-94) surfaces `Fix: rbox git resolve Dfinitiv/savvy-core`. But bare
`rbox git resolve <repo>` runs show-me (a diagnostic), and today's brief hardcodes
"`keep-mine` is unavailable" and offers only take-theirs (`git-cmd.ts:244-245`). With
keep-mine landing, the surfaced remediation must (a) name the TWO verbs and their meaning
— keep-mine = "publish my local work as truth"; take-theirs = "discard local, follow
incoming" — so the founder can pick the one that keeps his work, and (b) add the missing
reassurance he specifically lacked: "your repository is healthy; only rbox's sync
bookkeeping is paused." The `git-cmd.ts:244-245` copy must be rewritten in the same pass,
or B leaves the exact confusion that motivated the design.

Otherwise B's shape (status second sentence, show-me summary-first, ~12 frozen-prefix glog
lines) is directionally sufficient for the mandate and the frozen-prefix / rig-regex
constraint (176:100-105, test 5) is the right guardrail.

## F6 — MINOR (affirms §4) — the held-skip diagnosis is CORRECT; the fix must key neutralization on `provenance:"composer"`, never on `reason:"artifact"`

Confirmed against code. A successful-but-held follow appends
`{provenance:"composer", reason:"artifact", detail:"BASE composer retained pending
disposition"}` whenever `composedFollow.disposition === "pending"`
(`apply.ts:1316-1321`). Held refs force pending, so this blocker is present for EVERY held
repo. `heldBlockersAllowSkip` requires every blocker ∈ {local-commits, local-stash}
(`held-skip.ts:35-38`), so the artifact blocker permanently vetoes the skip — matching the
field `skippedHeld=0`. The causal held blocker is correctly allowlisted: held refs yield
`{provenance:"ref-plane", reason:"local-commits"|...}` (`follow.ts:1000-1006`). §4 is right.

Guardrail for the fix: neutralize by `provenance === "composer"` specifically, NOT by
`reason === "artifact"`. Protocol holds (`apply.ts:990-997`) and checkout defers
(`apply.ts:1290-1291`) also carry `reason:"artifact"` / non-allowlisted reasons and MUST
keep refusing the skip. A reason-keyed filter would wrongly make protocol-held repos
skip-eligible. The design prose ("composer-pending … is not an independent blocker")
implies provenance-keying; make it explicit so the implementer does not key on reason.
The unit test in test 6 should cover a protocol-hold artifact blocker staying ineligible.

## F7 — MINOR — §6's "pulls ~13s immediately from the skip" ignores the 1-hour safety floor

The skip requires `!priorFloorElapsed` (`apply.ts:1123`), and the floor is
`HELD_SKIP_SAFETY_FLOOR_MS = 60min` (`held-skip.ts:24,128-131`). So an idle held repo does
a full ~43s re-follow roughly once per hour (which rewrites the attempt at=now) and skips
(~13s) in between. Steady state is "skip except one full follow per safety-floor hour," not
uniform 13s. Correct §6 to reflect the hourly re-validation so the field expectation
(test 7) is not read as a regression when an hourly 43s pull appears.

## F8 — EDITORIAL — state the current-checkout-divergence boundary explicitly

§2.5 (176:78-79) refuses on "worktree-ownership holds on the CURRENT checkout ref." If the
divergent/held branch IS the checked-out branch (e.g. local `main` diverged and is
checked out), keep-mine cannot resolve it and refuses — leaving that case to 173/manual
git. The field wedge is stale SIDE branches, so keep-mine works there, but the doc should
name this boundary in Non-goals so the limitation is not discovered in the field.

---

Verdict: CHANGES-REQUIRED
