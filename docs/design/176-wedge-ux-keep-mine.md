# 176 — Wedge UX: `keep-mine`, legible deferrals, and the held-skip eligibility defect

Status: DRAFT v1 — ready for review round 1
Relates: 174 (livelock self-heal; this ships its manual escape hatch),
130 (manual resolution authority — the arm keep-mine lands through),
128 (show-me/take-theirs token flow — the scaffolding keep-mine completes),
173 (two-writer divergence — still reserved; 176 does not touch it)

## 0. Founder mandate (2026-07-21, direct)

Not an algorithm redesign. A LOCAL manual fix is acceptable for the live
savvy-core wedge — the product requirement is LEGIBILITY: "git language is
verbose in a way that's not readable… our log messages aren't always easily
grokkable." Three deliverables:

- **A. `keep-mine`** — the missing resolve verb: "my local git state is the
  truth; publish it and drop the stale pending section."
- **B. Plain-English deferral surfacing** — a user can understand WHY a repo
  is held and WHAT to do, without reading git plumbing.
- **C. Held-skip eligibility defect** — field-observed on the idle Mac:
  `skippedHeld=0` on every pull of a held repo overnight. Root-cause and fix.

## 1. Live evidence

- The Mac's savvy-core wedge (174 §1) persists post-1.7.15: pulls 43–44s,
  `git-apply ~31s`, `skippedHeld=0` across an idle night. `show-me` output:
  28 local-only reflog commits across rewritten PR branches + the rbox-minted
  2026-07-16 stash. v6 supersession correctly refuses (non-FF branch lane).
- `keep-mine` is already a parsed verb returning
  `{status:"unsupported", code:"not-yet-supported"}` (git-cmd.ts:64,150,536),
  with `--force-discard-incoming` reserved for it in the usage text.
- The founder's first instincts under the wedge — "can I reset to
  origin/main?", "should I delete the workspace?" — are the UX bug in vivo:
  nothing surfaced told him the repo was fine and rbox's bookkeeping was the
  stuck part.

## 2. A — `keep-mine`

### Semantics
For a repo with a pending (unapplied incoming) section and/or apply deferral:
confirm a snapshot of CURRENT LOCAL git state; publish it as the new remote
truth through the EXISTING capture path; drop the pending section and its
sidecars in the same accepted-ACK transition 174-B already uses. Local refs,
index, stash, worktrees: untouched — keep-mine never mutates the repo, it
mutates rbox's belief.

### Mechanism (all existing machinery, wired end-to-end)
1. **Snapshot + token**: reuse show-me's snapshot/token flow verbatim
   (128). `rbox git resolve <repo> keep-mine` prints the snapshot summary +
   confirmation command; `--confirm <token>` binds the action to exactly the
   state the user saw (token mismatch → re-show, same as take-theirs).
2. **Incoming-artifact acknowledgment**: the pending section may carry
   artifacts local does not (the non-subsumed branch tips, a remote index/
   stash). keep-mine REQUIRES `--force-discard-incoming` whenever any pending
   lane is not subsumed by local (the 174 v6 proof, reused as a REPORT):
   the confirmation output lists, in plain English, exactly what the stale
   snapshot contains that local does not (per lane, bounded count), e.g.
   "the old snapshot has branch codex/deploy-stack-matrix at a version your
   repo rewrote — confirming discards the old version's sync metadata; your
   local branch and its history are untouched (git reflog still has
   everything)." With every lane subsumed, the flag is not required.
3. **State transition**: under the workspace mutex — clear
   `gitPendingRemote[rel]`, `partial[rel]`, `attempt`, the apply deferral
   (ordered predecessor-bound clear), through the design-130 `manual`
   authority for any BASE effect (the composer arm exists; keep-mine lands
   the confirmed LOCAL snapshot as the manual candidate — for refs this is
   authority to RETAIN present local truth, never to invent P/A artifacts;
   130's rule "an already-terminal positive branch … receives a new `manual`
   origin rather than invented P authority" is the exact clause this uses).
4. **Republish**: request an immediate push. With pending gone, the ordinary
   plan captures fresh local truth; the 130 normalizer authors tombstones for
   every branch this device previously advertised and has since rewritten
   (advertised-based authoring — ALREADY the shipped behavior), so followers
   converge with the standard preservation guarantees. No new wire semantics.
5. **Refusals (fail closed, plain English)**: journal recovery non-terminal;
   git busy; repo mid-operation (merge/rebase in progress); degraded mutex;
   worktree-ownership holds on the CURRENT checkout ref (the checkout plane
   keeps its own rules — keep-mine resolves the SECTION, not a contested
   checkout). Each refusal states the reason and the retry condition in one
   sentence.

### Non-goals
- No ref mutation, no working-file mutation, no stash mutation.
- No change to automatic supersession (174-B) or its lanes.
- Not a fleet-wide force: exactly one repo per invocation, token-confirmed.
- 173 (two-writer spurious divergence) stays reserved.

## 3. B — Legible deferral surfacing

1. **`rbox status` deferral lines get a second, plain sentence.** Today:
   `git deferred 1h: local commits on branch main (Dfinitiv/savvy-core)`.
   Add: `→ your repo moved ahead of the last synced snapshot; your work is
   safe. Fix: rbox git resolve Dfinitiv/savvy-core` (reason-specific
   templates; bounded set — one per GitDeferralReason).
2. **show-me output rewrite**: lead with a three-line summary (what happened,
   what is safe, what to do) BEFORE the per-ref detail; per-ref lines get
   human phrasing ("branch X was rewritten locally after the snapshot" not
   "local-only heads/X reflog:"). The detail stays (it is the evidence), the
   summary is the interface.
3. **Log-language pass** (bounded): the ~12 highest-frequency git-sync glog
   lines get the same treatment — mechanism stays greppable via a stable
   prefix token, the human clause follows. Grep-compat: existing prefixes
   (`git-sync deferred`, `git-sync followed`, `git deferred`) are FROZEN —
   additions only after the colon. The rig scenarios' regexes must not break
   (test 5 below).

## 4. C — Held-skip eligibility defect (field: skippedHeld=0 on idle Mac)

Hypothesis to verify FIRST (implementation begins with this): a held
"applied" follow records the composer's pending disposition as a merged
blocker (apply.ts merges composer state per 174 r2 finding 1); that blocker
is outside the `{local-commits, local-stash}` allowlist, so every held repo
with a pending section — i.e. EVERY repo the skip was built for — is
permanently ineligible. The rig scenario could not catch it: its skip
observation was opportunistic (run-3 note "skippedHeld observed: false").

Fix direction (pending verification): the composer-pending disposition of the
HELD REPO ITSELF is not an independent blocker — it is the *consequence* of
the allowlisted hold. Eligibility must treat `composer-pending` as neutral
when every CAUSAL blocker is allowlisted, while a composer-pending WITHOUT any
classification blocker (the r2 vacuity case) still refuses via the non-empty
rule. If verification finds a different cause, document and fix that instead.
MUST add: a non-opportunistic rig assertion — with the daemon otherwise idle,
the second held pull MUST report `skippedHeld>=1` (this closes the assertion
gap that let the defect ship).

## 5. Tests (MUST)

1. keep-mine end-to-end on the 174 rig wedge shape: seed → keep-mine with
   token → pending/partial/attempt/deferral cleared → next push publishes →
   follower converges → steady-state unchanged; repo refs/index/stash
   byte-identical before/after on the resolving host.
2. keep-mine with non-subsumed pending lanes refuses without
   `--force-discard-incoming`; the report names each non-subsumed lane; with
   the flag it proceeds; with all lanes subsumed the flag is not required.
3. keep-mine refusals: journal non-terminal, git-busy, in-progress operation,
   contested checkout ref → typed refusal + plain-English line; nothing
   cleared.
4. Deferral templates: every GitDeferralReason renders a plain sentence +
   fix command; snapshot tests.
5. Log-language: frozen prefixes unchanged (rig regexes green against the
   reworded lines); the 174 rig scenario passes unmodified.
6. Held-skip: the C fix verified by the new non-opportunistic rig assertion
   plus a unit test of the exact composer-pending + local-commits merge.
7. Field validation: keep-mine on the LIVE savvy-core wedge (founder
   present) — the dry-run that scripts B's copy.

## 6. Rollout

keep-mine ships enabled (it is explicit-invocation only). C's fix rides the
same release; expected Mac effect once BOTH land: pulls ~13s immediately from
the skip (idle), and the wedge resolvable in one confirmed command.
