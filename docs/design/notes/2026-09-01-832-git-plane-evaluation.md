# #832 + #837 — can fetch-into-namespace + ff-only adoption replace the git proof plane?

Founder decision document. Evidence, not a decision. Opinions are marked **[opinion]**.

## Executive summary

1. **Never litigated in the design corpus — but rejected in code, with a reason.** The corpus (91, 93,
   105, 236, 271, 273, 283, 283-res, 284, 285, 286, notes-286) has **zero** hits for `refs/remotes`,
   `fast-forward`, or `ff-only`; 286 keeps the door open (`286:118-119`). But `reachability.ts:16-18`
   is three-valued — `owned`/`unowned`/`indeterminate{shallow|missing-object|walk-error}` — because
   `--ff-only`'s binary answer cannot express *indeterminate*, which must **hold**. **That is the real
   counter-argument, and it lives in code (§7.4), not in any design doc.**
2. **The field is not divergence-limited; it is proof-limited.** Six days of FM daemon logs
   (08-27 → 09-02, read-only): **zero** non-fast-forwards or true divergences, against 1,851–4,629
   deferral lines/day whose causes are all proof-plane inventions.
3. **The only live fleet wedge is a capability the candidate lacks.** FM now: 4 repos deferred, all
   `local-index`, `oldestDeferralAgeSeconds: 474078` = **5.49 days**, each `remediationClass:
   "transient"`.
4. **Cost is concentrated.** 21 modules / **6,387 LOC** exist only to mint and settle proofs (25% of
   non-test `sync-git` = 25,167 LOC / 85 modules; `sync-git`+`git` are 23.9% of `src/`). August 2026
   filed **15 git-plane wedge classes — ~1 in 4.5 of every issue that month**.
5. **The rig's boring plane is 29 lines of git**, handling 9 of 11 classes — including deferring on a
   sideways-rewritten ref **with no BASE record consulted**. It also has four honest defects (§7.2).
6. **Counter-evidence is real.** #837 (08-27): a fresh re-adoption *re-diverged* (22 local files), so
   it is no universal cure; the candidate does nothing for the manifest plane (the two costliest
   incidents); and it must keep sibling-worktree ownership, reachability, and quarantine regardless.
7. **Recommendation [opinion]: do not swap the plane, do not close #832. Shadow-mode it for one week**
   — compute both verdicts per pull, change nothing, log disagreement. ~1 day of work turns this whole
   argument into a table. **Note the post-v2.0.1 observation window is ~0 days** (tagged today). §10.

---

## 1. Scope corrections that change how the evidence reads

- **No 8-month window exists.** The repo dates from 2026-06-26; the first issue is #456 on 2026-07-26.
  The census below covers 3 calendar months, two of them partial. Anything read as a multi-month
  trend is over-reading the data.
- **v2.0.0 tagged 2026-08-26; v2.0.1 tagged 2026-09-01** (`docs/STATUS.md:35`), i.e. *today*.
  **The post-2.0.1 observation window is approximately zero days.** No claim about whether the 2.0.1
  fixes lowered the wedge rate is currently supportable in either direction.
- Read-only discipline: all fleet data below is `ssh flat-meadow-prod-main-01` log/status reads. The
  FM daemon was not touched; the desktop live workspace was not touched; the rig ran on scratch
  repos under `mktemp -d`.

## 2. Binding constraints the candidate must meet (corpus archaeology)

| Constraint | Binds at | Does the candidate meet it? |
|---|---|---|
| Server never runs git, never sees plaintext; repo travels as an **encrypted bundle** | `93:16-19`; non-goal "server-side anything" `93:438-439` | **Yes, untouched.** The candidate changes *adoption*, not capture/transport/crypto. |
| Notify channel is never data, never correctness; every WS failure degrades to polling | `105:55-59`, `105:60-63` | **Yes, untouched.** |
| Head never regresses; fail closed, never guess | `91:45-47`, `91:52-54` | **Yes** — ff-only is strictly monotone by construction; defer *is* fail-closed. |
| One head authority / one persisted-BASE site / one outgoing-git enforcement point | `91:40-44`, `271:103-105`, `283:338-342` | **Yes, and it reduces them** — ff-only needs no BASE site at all (§7.1, rig W9b). |
| Exclusion is by ref-lock reservation, not by the workspace mutex (external git writers exist) | `285:103-107` | **Partly.** `git update-ref <ref> <new> <old>` is a CAS with the same guarantee; `git merge --ff-only` takes the index lock. But the candidate must still reserve, not assume. |
| `removed_key` is the only durable memory preventing **resurrection of remotely-deleted repos**; not reconstructible from disk | `283:203-208`, `283:254-258` | **No — and this is out of scope.** It is repo-record state, not ref state. It survives either way. |
| Op-state is conformed to incoming on every apply; one deletion authority | `236:127-129`, `236:159-160` | **No.** The candidate has no op-state authority. See §3. |
| Quarantine copies syncable refs + `git stash create` + index/op-state; never untracked/ignored | `273:463-465`, `273:452-453` | **No.** Must be preserved as-is (it is the set-aside door, §6). |
| Config invalidity is NEVER manifest-fatal | `93:58-60` | Orthogonal; preserved either way. |
| **A sibling worktree's checked-out branch must never be moved under it** — `update-ref` does this silently where `git branch -f` refuses | `git-state-apply.ts:88-93` (codex repro, design 43 §7); ownership re-read per destructive ref `:645-648` | **No — the rig gets this wrong.** See §7.2(4). A real implementation must keep `branchesCheckedOutElsewhere` (`:95`) and its strict variant (`:101`). |
| **An indeterminate reachability answer must HOLD, never refuse and never force** (shallow store, missing object, walk error) | `reachability.ts:16-18`; `preflight.ts:10-18` — structural faults *drop* the section, transient ones *defer with base carry* | **Not for free.** `git merge --ff-only` returns a binary answer; the candidate must map its failure modes to hold-vs-drop itself, or a shallow-authored section "would retry-defer forever" (`preflight.ts:10-18`). |
| `refs/remotes/*` is already excluded from sync | `src/engine/manifest-validate.ts:326-331`; `116:116` | **Structural fit.** `refs/remotes/rbox/*` can never be re-published or reach the wire, by construction, with no new code. |

**Net:** no constraint in the corpus rules the candidate out, but two constraints found only in *code*
(sibling-worktree ownership, three-valued reachability) are load-bearing and the naive candidate fails
both. Three further capabilities (op-state, index, stash/quarantine) sit outside what ff-only adoption
provides and must be answered separately (§3). **[opinion] the honest summary is not "the simple thing
was never tried" but "the simple thing was never written down, and the code that replaced it grew
25 kLOC without anyone re-checking whether the original simple thing had gotten cheaper."**

## 3. Capability inventory — what the current plane does that ff-only does not

Measured (`git ls-files … | xargs wc -l`): `src/cli/sync-git/**` = **57,477 LOC** (85 non-test modules,
**25,167 non-test LOC**); `src/cli/git/**` (the `rbox git …` resolve adapter) = 2,752 (**2,582**
non-test). Both dirs = **23.9 % of all tracked `src/`** (251,615), **21.9 %** non-test.

| Capability | Owner (file:line) | LOC | Who uses it (evidence) | Rebuildable on the namespace primitive? |
|---|---|---|---|---|
| **Index sync** (three-way index compare) | `follow-classify.ts:162-165` — `liveValue !== baseValue && liveValue !== incomingValue` → `local-index` | ~87 (`index-identity.ts`) + classifier | **This is the only live fleet wedge**: FM's 4 repos, 5.49 days, all `local-index` | **Yes, as a plain synced FILE.** Ship `.git/index` as payload; on divergence, leave the local index alone. Never a proof. |
| **Op-state sync** (MERGE_HEAD, rebase dirs, ORIG_HEAD) | `follow-classify.ts:168-175`; classification `236:60-64`; deletion authority `236:159-160` | ~122 (`breadcrumb-veto.ts`) + classifier | Real: mid-rebase repos must not be stomped | **Yes, and mostly by deletion.** The rig gets this right in 3 lines: any in-progress marker → defer everything (W7). `236:121-123`'s own net predicate is exactly that. |
| **BASE records** | `base-composer.ts` (667), `base-artifacts.ts` (525), `base-artifact-scan.ts` (137), `base-proof-selection.ts` (107) | **1,436** | Divergence detection | **Deletable.** Rig W9b: `git merge-base --is-ancestor` is a *stateless* predicate that gets the same answer with no stored BASE. |
| **R/P/K artifacts, standing proofs** | `p-settlement.ts` (178), `p-repair.ts` (461), `p-repair-transaction.ts` (508), `p-repair-state.ts` (204), `standing-branch-proof.ts` (246) | **1,597** | Wedge classes 1-4 of #837 are *all* failures of this machinery | **Deletable** — it exists to prove what ff-only makes unrepresentable. |
| **Witnesses** | `follow-ref-witness.ts` (78) | 78 | #830/#836 | **Deletable.** |
| **Episodes / breadcrumbs** | `breadcrumb-veto.ts` (122); `deferral-hygiene.ts` (543) | 665 | Diagnosis surfaces (273) | Partly — keep the *legibility*, drop the proof. |
| **Locked proofs / ref-plane txn** | `ref-plane-transaction.ts` (415), `ref-plane-boundary.ts` (224), `ref-plane-publication.ts` (346), `checkout-txn.ts` (1,061) | **2,046** | Atomic ref installs | **Mostly deletable.** `checkout-txn.ts:159-228` hand-rolls a FIFO-driven `git update-ref --stdin` child under `sh -c`; `git merge --ff-only` is the same transaction, already written, upstream. |
| **Held-skip / divergence cache** | `held-skip.ts` (416), `divergence-cache.ts` (413) | 829 | Perf: #775, #814 | Largely unnecessary — the ancestry check is one `merge-base` call. |
| **Take-theirs quarantine** | `quarantine.ts` (105); semantics `273:463-465` | 105 | The set-aside door | **KEEP.** This is the fallback's whole safety story (§6). |
| **Stash sync** | publish-with-reflog `git-state-apply.ts:611-618`; seed `follow-ref-witness.ts:14` | ~30 | Anyone who stashes | **NOT free — I was wrong to assume it was.** `refs/stash` "is only usable through its REFLOG (`git stash list`/`pop` read stash@{N}, never the bare ref)" (`:611-614`). A plain fetch + `update-ref` yields a stash that exists but is invisible to `git stash list`. The candidate must keep the `--create-reflog -m <subject>` publish. |
| **Config sync** | `config-txn.ts` (535), `config-sync.ts` | 535 | `93` — repos are born `git init`-grade without it | **KEEP, orthogonal.** Note FM logs 22 `config disabled: parse-error` deferrals on 2026-09-01. |
| **Conflict copies** | `quarantine.ts:81-104` → `refs/rbox-conflict/<ts>` + bundle; 90-day retention `conflict-retention.ts:9-11` | 169 | Real divergences | **KEEP** — this *is* "defer with the peer tip preserved", which the candidate needs anyway. |
| **Branch deletion propagation** | wire tombstones `publisher-tombstones.ts` (225), attestation `tombstone-attestation.ts` (122), delete `git-state-apply.ts:640-660` gated on `deleteAbsent` `:284` | 347 | Deletion propagation | Rig W6: needs an **explicit `fetch --prune`** — not free, and my first rig run got it wrong. Tombstones do more than prune (resurrection guard); not a clean swap. |
| **Sibling-worktree ownership** | `branchesCheckedOutElsewhere` `git-state-apply.ts:95`, strict `:101`, classify `:124-198`, defer `:317` | ~100 | Anyone with linked worktrees | **KEEP — the candidate has no substitute.** `update-ref` moves a sibling's checked-out branch silently (`:88-93`). |
| **Three-valued reachability** | `reachability.ts:16-18`, `:141-154`; preflight disposition `preflight.ts:10-18` | 368 | Shallow clones, corrupt stores | **KEEP or re-derive.** This is the reasoned rejection of `--ff-only`; see §7.4. |

**Proof-only subtotal: 21 modules, 6,387 LOC** (BASE + P/K + witnesses + breadcrumbs + locked proofs +
held-skip/divergence-cache + keep-pins 767 + pending-supersession 292 + follow-journal 89) = **25% of
non-test `sync-git`.**

## 4. Cost accounting (#837 Q1)

**Wedge census.** Judged by subject = "the git plane failed to apply/publish/settle/resolve refs or
proofs". Meta issues (#832/#837), perf-on-healthy-repos, and manifest-plane issues excluded from strict.

| Month | Strict git-plane wedges | Issue numbers | Adjacent | Manifest-plane | All issues filed |
|---|---:|---|---|---|---:|
| 2026-06 | 0 | tracker not in use | — | — | 0 |
| 2026-07 (from 07-26) | 1 | #526 | #462, #470 | — | 35 |
| 2026-08 | **15** | #647 #659 #665 #669 #672 #702 #752 #761 #781 #788 #792 #793 #828 #829 #831 | #658 #762 #764 #775 #814 | #813 #838 | 67 |
| 2026-09 (01 only) | 0 | — | #863 | #847 | 8 |

**~1 in 4.5 of every issue filed in August was a git proof-plane wedge.** Filings clump around triage
sessions (5 filed on 08-13 alone), so read the month, not the day.

**Measured burn, each cited to its issue:**

- #836: the #835 ceiling raise "turned a CYCLING repair into an **18-CPU-minute spin** on a 195-file repo".
- #838: the desktop fold-retry loop "reached **13 GB RSS / 100%+ CPU**"; flat-meadow "looped for **~2 days**".
- #683: zero-backoff push conflict-retry — "Mac 45+min @120% CPU, RSS 22.7GB".
- #659: "FM sat at **103 wedged repos for 20+ hours** … `oldestDeferralAgeSeconds=72596`".
- #781: five repos failed the connectivity proof "on every pull for **>32h**".
- #775: three consecutive **zero-change** pulls, `files=127,086, wire=0B, changed=0B`, still paying
  `fetchDecryptMs` 13,606 / 12,476 / 17,291 per pull, inside 51-63s pulls.
- #829: "every one of FM's **45 'uncommitted work here' repos** shows the same 'the index differs'
  pause line" — one proof gap, most of the fleet.

**The asymmetry number (#837 body):** *"moving the two repos' .git aside and letting fresh adoption run
— five minutes, zero proofs, first try, exact desktop tips"* — against eight rounds over two days of
proof repairs, on repos of 195 and ~1,300 files.

**Common shape of every expensive incident [opinion]:** a bound or a proof that refuses *without a
progress test or a fallback door*. That is a fallback-shaped problem, not necessarily a ref-plane-shaped
one — which is why §6 and §8 matter more than a plane swap.

## 5. Live field evidence (flat-meadow, read-only)

`~/.rbox/daemons/Development-a64d35fe/daemon-2026-*.log`, grep counts:

| Log | defer lines | "index differs" | "operation state differs" | "did not supersede" | non-ff / diverged |
|---|---:|---:|---:|---:|---:|
| 2026-08-27 | 812 | 40 | 39 | 94 | **0** |
| 2026-08-28 | 1,982 | — | — | — | **0** |
| 2026-08-29 | 2,957 | — | — | — | **0** |
| 2026-08-30 | 4,629 | — | — | — | **0** |
| 2026-08-31 | 3,414 | — | — | — | **0** |
| 2026-09-01 | 1,851 | 88 | 88 | 218 | **0** |
| 2026-09-02 | 146 | — | — | — | **0** |

Representative lines:

```
git-sync deferred Personal/rbox-core: index differs from both base and incoming;
  current tip has receiver-only commits; operation state differs at ORIG_HEAD
git-sync: captured 0 · carried 125 · skipped 0 · deferred 3 (… final candidate did not
  supersede pending section — carrying pending verbatim; …)
git deferred 1d: local index changes on branch main (Personal/rbox-core)
```

`daemon.status.json` (2026-09-02T01:46Z, daemonVersion 2.0.1, state `synced`, 198,321 files):
`deferredRepos: 4`, `deferredNeedsYou: 4`, `oldestDeferralAgeSeconds: 474078` (**5.49 days**);
every entry `reason: "local-index"`, `reasonText: "The Git index changed here."`,
`remediationClass: "transient"` — deferred since 2026-08-27, still "transient" on 2026-09-02.
Repos: Dfinitiv/pegasus, Dfinitiv/savvy-core, Personal/rbox-core, Personal/rbox-home-page.

**Reading it honestly.** These deferrals are not *false*: the founder really does have local index
state in those repos. The finding is narrower and still strong — **the fleet's entire live deferral
set is produced by a capability the candidate does not implement, and in six days the one thing the
candidate must handle (a true divergence) never occurred once.** The counter-reading, stated fairly:
a plane that ignores the index might have *stomped* those repos rather than deferring; the rig (W3/W4)
says it would have fast-forwarded the 3 without file collisions and deferred the 4th. Whether that is
better is a product judgement, not a measurement.

## 6. Fresh adoption as the automatic fallback (#837 Q2)

**The `.git`-moved-aside primitive already exists in code.** `journal.ts:889-908` renames `.git` to
`uniqueRetirePath(workspaceRoot, "git-quarantine", …)` and clears the checkout journal, guarded by
`journal.ts:897-898`: "post-crash freshness is undecidable; never rm -rf. Preserve the entire partial
repository (including hooks/objects a human may have added)." Re-adoption then runs through
`clean-materialization.ts`. So #837 Q2 is asking to *widen an existing door*, not build one.

The set-aside already exists and already has the right semantics: `quarantine.ts:105` bundles syncable
refs + `git stash create` of tracked modified/staged content + index/op-state copies (`273:463-465`).
So "set aside + adopt fresh" loses **nothing that is committed or tracked-and-modified**. It does lose
**untracked and ignored files**, which quarantine explicitly does not copy (`273:452-453`) — that is
the honest gap and it must be stated in any UI that offers this door.

Two hard limits from the corpus and the tracker:

- **Restore must never land in the live checkout** — it must materialize into an isolated
  `git worktree add .rbox/git-restored/<ts>` (`273:469-473`), and batch take-theirs *depends on that
  undo landing first*: "batch without an undo is a one-way door" (`273:473-474`).
- **#847's refuse-rule caps it.** `rbox recover` now REFUSES peer-authored supersede, with no override,
  by founder ruling (`docs/STATUS.md:9`, PR #859) — the rule lives inside `repairChain`. So an
  *automatic* fallback may not be allowed to reset across a peer-authored boundary. **Any automatic
  fresh-adoption door must inherit that refusal, which means it cannot be fully automatic in exactly
  the case that motivated it.** [opinion] This is the single most under-appreciated constraint on Q2.
- **And fresh adoption is not a cure-all**: #837 (2026-08-27) records FM savvy-core still bouncing
  take-theirs "after a full fresh re-adoption (its scorched-earth rebuild re-diverged: 22 local files)".

## 7. The rig experiment (#832 rule 3) — RUN, not just planned

Scratch repos under `mktemp -d` on this host; no product code, no live workspace, no FM daemon.
Script: `boring.sh` + `w9b.sh` (the mechanism is reproduced in full below). The *entire* candidate plane
is **29 non-blank lines** of git:

```sh
publish(){ git -C "$PEER" bundle create "$B" --all; }
fetch_ns(){ git -C "$WS" fetch --prune "$B" '+refs/heads/*:refs/remotes/rbox/*'; }
adopt(){   # defer everything if MERGE_HEAD / rebase-merge / rebase-apply present
  # per ref: new=rbox/<b>, old=heads/<b>
  #   no old            -> update-ref (new branch)
  #   old == new        -> noop
  #   !is-ancestor      -> DEFER (diverged)
  #   b == current HEAD -> git merge --ff-only   (git owns index+worktree+ref atomically)
  #   else              -> git update-ref <ref> <new> <old>   (CAS)
  # heads/<b> with no rbox/<b> -> report GONE, keep local
}
```

### 7.1 Results

| # | Class | Verdict | Data preserved? |
|---|---|---|---|
| W1 | plain fast-forward (the 95% case) | `ADOPT main (ff checkout)` | file landed |
| W2 | local divergence, both sides committed | `DEFER main (diverged)` | local commit intact |
| W3 | dirty tree, ff available, no overlap | `ADOPT main (ff checkout)` | uncommitted file intact |
| W4 | dirty tree colliding with incoming file | `DEFER (ff blocked: would be overwritten)` | local content kept |
| W5 | upstream history rewrite (amend/force-push) | `DEFER main (diverged)` | untouched |
| W6 | peer deleted a branch | `GONE feature (peer deleted; local kept)` | **only after adding `--prune`** |
| W7 | mid-merge, MERGE_HEAD present | `DEFER all: operation in progress` | nothing touched |
| W8 | detached HEAD | `ADOPT main (CAS)` | HEAD stays detached |
| W9 | race on a non-checked-out branch | `ADOPT other (CAS)` | — (see 7.2) |
| W9b | **concurrent sideways rewrite (non-ancestor)** | `DEFER other (diverged)` — **no BASE record consulted** | preserved; peer tip still reachable at `refs/remotes/rbox/other` |
| W10 | crash between ref write and worktree write | ref moved, worktree stale (1 dirty line) | recovered by `git reset --hard HEAD`, **not** by `git checkout -- .` |

### 7.2 Four honest negatives from the rig

1. **W6 needed `--prune`.** My first run reported `NOOP` on a branch the peer had deleted. Deletion
   propagation is *not* free in the candidate; it is one flag, but it is a flag you must not forget.
2. **W9 did not exercise what I intended.** Reading `old` at adopt time means a race that happened
   *before* the read is invisible to the CAS. W9b was written to close that hole and does: safety comes
   from the **ancestry predicate**, not from the CAS. `git update-ref`'s old-value guard only closes the
   microsecond window between our own read and write.
3. **W10 is a real crash window** — but only on the hand-written `update-ref` path. `git merge --ff-only`
   updates index+worktree and then the ref under the index lock, so the checked-out branch has no such
   window. **[opinion] this is an argument for using git's own porcelain rather than
   `checkout-txn.ts`'s hand-rolled FIFO `update-ref --stdin` child (`checkout-txn.ts:159-228`).**
4. **The rig has no sibling-worktree check, and would corrupt a linked worktree.** Its CAS arm
   (`update-ref <ref> <new> <old>`) is exactly the operation `git-state-apply.ts:88-93` documents as
   unsafe: it "silently moves a branch a sibling has checked out, leaving that sibling dirty
   (`git branch -f` refuses; `update-ref` does not)". The rig never tested a linked worktree, so its
   9-of-11 score is flattering. **Any real candidate must keep `branchesCheckedOutElsewhere`.**

### 7.3 Representability against #837's eight classes

#837's classes 1-7 are *all* failures of proof machinery: missing branch proofs (1), CREATE-P vs absent
BASE (2), UPDATE-P vs absent BASE (3), an 8-pass settle bound exhausting (4), an 18-CPU-minute repair
spin (5), a connectivity proof poisoned by a stale commit-graph cache (6), a consent boundary rejecting
its own reflog appends (7). **None of the seven is representable in the rig plane** — there is no BASE,
no P, no settle loop, no connectivity proof, and no consent boundary to poison. Class 8 (operational
scar: SIGKILLed daemons leaving marker locks, git auto-maintenance tripping the busy probe) **is still
representable** — it is a locking/lifecycle problem the candidate does not address.

**Score: the candidate structurally eliminates 7 of #837's 8 classes and leaves class 8 untouched.**
The correct caution [opinion]: it eliminates them by *not offering the capabilities whose proofs those
were*. Index and op-state fidelity is the price; §3 argues it can be repaid with plain synced files.

### 7.4 The strongest counter-argument, which lives in code and not in any design doc

`--ff-only` has **no production use** in the tree (only tests, a display string in `adopt-cmd.ts:270`,
and a renderer comment). That is deliberate. Fast-forwardness is decided by `reachability.ts:16-18`:

```ts
| { status: "owned" } | { status: "unowned" }
| { status: "indeterminate"; marker: "shallow-store" | "missing-object" | "walk-error" }
```

with `reachability.ts:127` noting a walk failure "is indeterminate, never evidence that a tip is
unreachable (r1 F5)". `preflight.ts:10-18` then splits the disposition: **structural** faults (shallow /
bare / alternates / superproject) *drop* the section, because "a shallow clone's `bundle --all` silently
omits history — the receiver fail-closes, but a carried shallow-authored section would **retry-defer
forever** since identity can't see shallowness"; **transient** faults defer with base carry.

**Why this matters for #832:** `git merge --ff-only` conflates all three answers into one non-zero exit.
A candidate that maps "ff-only failed" → "defer" reintroduces exactly the forever-defer loop
`preflight.ts` was written to prevent — the same shape as every expensive incident in §4.

**The candidate's honest answer [opinion]:** keep `reachability.ts` (368 LOC) and `preflight.ts` as the
*disposition* layer, and use ff-only only as the *executor* once reachability has returned `owned`.
That is a smaller, cleaner claim than "replace the plane", and it is what §10 recommends measuring.
It also means `reachability.ts` is **not** in the deletion inventory.

## 8. Kill criteria — both directions

**What kills the candidate:**
- A founder ruling that **index and op-state must converge across machines**, not merely not-be-stomped.
  ff-only adoption cannot deliver that; it is the one capability the primitive structurally lacks.
- Shadow mode (below) showing the ff-only verdict would have **stomped or lost** work the current plane
  held — i.e. any case where "ff was available" but the current plane was right to refuse.
- A divergence rate high enough that "defer, resolve with ordinary git" becomes a daily chore. Current
  evidence: **zero true divergences in six days**, so this is not presently in play.
- #847's refuse-rule (`STATUS.md:9`) proving that the fallback door cannot be automatic where it matters.

**What kills the current plane:**
- The wedge rate not falling with a *real* observation window. **Today there is none** — v2.0.1 shipped
  today. The honest test: if 2026-09 closes with ≥5 new strict git-plane wedge classes, the 2.0.1 fixes
  did not change the class and the argument for a plane swap becomes much stronger.
- Another incident of the #836/#838 shape (a proof or bound that refuses without a progress test) after
  the 2.0.1 fixes.
- FM's `oldestDeferralAgeSeconds` continuing to climb past ~7 days on `remediationClass: "transient"`
  deferrals. A "transient" class that is 5.49 days old is already a naming defect at minimum.

## 9. Deletion inventory (#837 Q4) — only if the candidate survives

Candidates, with the AGENTS.md retirement bar. **Nothing below is cleared for deletion by this document**
— each still needs command/alias, import, export, build, package, generated-load, automation,
documentation, owner, and support-window evidence.

| Retires | LOC | Blocker to clearing it |
|---|---:|---|
| `base-composer.ts`, `base-artifacts.ts`, `base-artifact-scan.ts`, `base-proof-selection.ts` | 1,436 | `271:103-105` names `composeFollowAuthority` the ONE persisted-BASE site; design-130's allowlist counts it. Both must be retired together. |
| `p-settlement.ts`, `p-repair.ts`, `p-repair-transaction.ts`, `p-repair-state.ts`, `standing-branch-proof.ts` | 1,597 | P/K live in `refs/rbox-local/base-present/v2/*` on real fleet disks (`notes-286-diagnosis.md:3`). Retirement needs a **cleanup migration**, not just code deletion. |
| `follow-ref-witness.ts` | 78 | Referenced by #830/#836 receipts. |
| `ref-plane-transaction.ts`, `ref-plane-boundary.ts` | 639 | Replaced by `git merge --ff-only` + `update-ref` CAS. Needs the `285:103-107` reservation story re-proved. |
| `held-skip.ts`, `divergence-cache.ts` | 829 | Both are perf caches for a predicate that becomes one `merge-base` call. Retire only after the perf differential is measured (#775 is the live perf issue). |
| `keep-pins.ts`, `pending-supersession.ts`, `follow-journal.ts` | 1,148 | Entangled with resolve UX (273) and the published-journal recovery rule (`285:114-118`). |
| **Total** | **~5,727** | — |

**Stays regardless:** `quarantine.ts` (the set-aside door), `config-txn.ts`/`config-sync.ts` (93),
`capture.ts`, the encryption/transport path, `removed_key` handling (`283:203-208`).

## 10. Recommendation and the smallest next step

**[opinion] Do not swap the plane on this evidence, and do not close #832.** The evidence that the
current plane is expensive is strong and measured. The evidence that the candidate is *sufficient* is
a 29-line rig on synthetic repos — encouraging, but it has never met a real 127,086-file repo, a
crossover-genesis record, or the founder's actual index state.

**Smallest next step — one week of shadow mode.** In `follow-classify.ts`, alongside the existing
verdict, compute the ff-only verdict (`git merge-base --is-ancestor` on the already-staged
`refs/rbox-incoming/*` namespace that `follow-staging.ts:68` creates today) and log only the
disagreement. Change no behavior. This is cheap because the incoming namespace **already exists** —
the candidate is a small delta on shipped machinery, not a rewrite. After one week the question stops
being architectural taste and becomes a table: how often would ff-only have landed what the plane
deferred, and how often would it have moved a ref the plane was right to hold?

**If shadow mode favours the candidate:** promote ff-only to the default *executor* for the ref plane
once `reachability.ts` returns `owned` (§7.4) — not a replacement for the disposition layer; demote
index/op-state from proofs to plain synced files; keep quarantine, sibling-worktree ownership, and
three-valued reachability; then work §9's deletion inventory with its evidence bar.

**If shadow mode favours the current plane:** close #832 with the shadow data as the recorded negative
result (the way `283-state-regenesis-resolution.md:12-14` preserved 283), and spend the effort instead
on the fallback door of #837 Q2 and on the `remediationClass: "transient"` naming defect — the two
places where the measured field pain actually is.
