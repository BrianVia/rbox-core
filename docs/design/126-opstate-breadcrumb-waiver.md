# §126 — Op-state breadcrumb waiver (ORIG_HEAD deferral self-heal)

> **Status: 🚧 IN PROGRESS — unparked 2026-07-16 (founder-ordered, "do 2 then 1 then 3").**
> Was a WATCH ITEM since 2026-07-15 (founder: "keep an eye on it"). The watch produced its
> answer fast: the strand class **reproduced twice in one day**, is now *measured* fleet-wide
> (§120 drift telemetry + §127 alerts), and its manual fix is operator surgery. Time to close it.

## Problem — a breadcrumb strands followers FOREVER

The follow path's op-state guard (`src/cli/sync-git/follow.ts:368-374`) three-way-compares
every op-state entry: live value must match **base or incoming**, else the repo defers with
`local-operation` ("operation state differs at <rel>"). The op-state universe
(`src/engine/manifest-validate.ts:169-170`):

- files: `MERGE_HEAD, REBASE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, ORIG_HEAD, MERGE_MSG, AUTO_MERGE`
- dirs: `rebase-merge/, rebase-apply/, sequencer/`

For genuine in-progress state this deferral is exactly right — a follow must never trample a
mid-flight merge/rebase. But **`ORIG_HEAD` is not in-progress state**: git writes it as a
*breadcrumb* (previous HEAD before a drastic op — merge, rebase, reset) and never removes it.
On a rebase-heavy publisher it changes constantly. A follower that misses one sync window
while the publisher rebases twice holds a live `ORIG_HEAD` matching **neither** base nor
incoming — and since nothing ever rewrites a deferred repo's op-state, it is **stranded
forever**. No self-heal exists.

Field record (docs/STATUS.md): the Mac's rbox-core replica sat on a 4-day-old strand;
manually fixed by writing the publisher's `ORIG_HEAD` bytes onto the follower; **reproduced
again the same evening** by the v1.6.4 release rebases (both followers re-aligned by hand).
The §120 fleet-drift panel + §127 alert now *detect* the class in ≤1h; this design *removes* it.

## Design

### Classify op-state entries: in-progress markers vs breadcrumbs

| class | entries | on three-way mismatch |
|---|---|---|
| **in-progress** | `MERGE_HEAD, REBASE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, MERGE_MSG, AUTO_MERGE`, all of `rebase-merge/, rebase-apply/, sequencer/` | defer (unchanged) |
| **breadcrumb** | `ORIG_HEAD` | **waivable** (below) |

Deliberately conservative classifications, with reasons pinned so nobody "cleans this up"
(corrected in review round 1, F6):

- `MERGE_MSG` stays in-progress: it is a pending commit message consumed by the next
  `git commit`. (Round-1 correction: `merge --squash` writes `SQUASH_MSG` + `AUTO_MERGE`,
  not `MERGE_MSG` — `SQUASH_MSG` is not in `OP_STATE_FILES` at all, so a pending squash is
  guarded only via `AUTO_MERGE`; noted, acceptable, and a reason `AUTO_MERGE` may
  false-defer after a squash — safe direction.)
- `REBASE_HEAD` stays in-progress (git's docs: the stopped-rebase commit; has lingered after
  aborts historically). `AUTO_MERGE` stays in-progress (ort's conflicted-worktree tree).
  A wrong in-progress classification costs a visible deferral (§124/§127); a wrong
  breadcrumb classification could trample mid-flight state. If field data later shows
  REBASE_HEAD strands, it earns its own review — the table makes that a one-line,
  individually-reasoned change.
- The dirs are in-progress by construction.

Classification lives next to the lists in `src/engine/manifest-validate.ts`, which become
`as const` tuples (they currently infer `string[]` — round-1 F4), with an **explicit
exhaustive map** `OP_STATE_CLASSIFICATION satisfies Record<OpStateRoot, "breadcrumb" |
"in-progress">` keyed by every file and dir root — a future op-state addition fails
typecheck until classified (deriving "in-progress = everything else" would silently
classify new entries).

### The waiver — narrow, structured, and decided at the END of the pipeline

Round-1 F2+F3 reshaped this section. Two facts drive it: (a) "no in-progress *mismatch*" is
NOT "no operation in progress" — live in-progress state that happens to equal base or
incoming adds no reason today, yet `git am --abort` reads `ORIG_HEAD` as recovery state
mid-operation (git `builtin/am.c`), so the waiver must gate on **presence**, not mismatch;
(b) `classifyCheckout`'s reason set is not the final deferral universe — held side-refs
(`publishRefPlane` → `heldRefs` without a checkout reason), boundary/structural/sibling
checks that run later, and `manualResolution` reason-deletion all live outside it.

Mechanics:

1. In the op-state comparison, partition by classification. In-progress mismatches add
   `local-operation` exactly as today. A **breadcrumb mismatch** adds no reason immediately;
   it is recorded as a structured `breadcrumbMismatches` list on the proof result.
2. **Waiver eligibility** (ALL required, else the breadcrumb mismatch converts back into
   `local-operation` + detail line exactly as today, so §124 diagnosis stays truthful):
   - the final post-manual-waiver reason set is empty except for the breadcrumbs,
   - **no live in-progress op-state entry exists AT ALL** — no in-progress file present and
     no op-state dir present, checked by explicit directory existence (`readOpState`
     enumerates only descendant files; empty dirs are invisible to it — round-1 F2),
   - `heldRefs` is empty (no §116 per-ref holds, no receiver-only side refs),
   - the proof is not indeterminate anywhere, and
   - every later gate (boundary re-proof, structural/sibling/incarnation checks) passes.
   Pipeline placement (round-2): provisional evaluation runs after `publishRefPlane` has
   supplied final `heldRefs` and before journal/recovery-plan construction; it is repeated
   inside `commitCheckout`'s second proof under the prepared locks (including the F1
   exact-equality check); the waiver is **finalized only after
   `markCheckoutJournalPublished` succeeds** (round-2 F6: `commitCheckout` returning
   committed is necessary but insufficient — before the published flip, journal recovery is
   rollback-only and the adoption could still unwind). Any later veto defers exactly as today.
3. When finalized, the apply's normal staged-op-state write performs the adoption (writes
   incoming's `ORIG_HEAD`, or deletes the live one if incoming has none — never without
   preservation). One bounded log line is emitted **after the journal's published flip
   only**: `git-sync: adopted stale ORIG_HEAD breadcrumb for <repo> (old value preserved
   at <recovery-location>)`.
4. **Manual resolution is unchanged** (round-2 F7): the presence gate governs the AUTOMATIC
   waiver only; a confirmed `rbox git resolve take-theirs` retains its existing
   quarantine-backed op-state override (it already waives divergent op-state deliberately,
   with human authorization). Tested both ways. A repo with synced mid-operation state AND
   a breadcrumb mismatch defers indefinitely by design — git may still consume `ORIG_HEAD`
   during that operation; completion/abort or confirmed take-theirs is the safe escape.

### Preservation before adoption (round-1 F1 — the loss analysis was insufficient)

`tipOwnedByIncoming` proves the *checkout tip* is publisher-owned; it proves nothing about
what `ORIG_HEAD` names (`ORIG_HEAD` is deliberately excluded from op-state ownership roots
in `reachability.ts`). A receiver can create commit `U`, reset back to a publisher commit,
and retain `U` **only** through `ORIG_HEAD` — every guard above passes, and adoption (or the
incoming-absent delete arm) would destroy the last durable handle to `U`. "It was synced
from the publisher before" is not derivable from local state. Therefore adoption NEVER
discards the old value:

- If the old live `ORIG_HEAD` names a valid object: create-only ref
  `refs/rbox-recovery/orig-head/<worktree-id>/<ms>-<rand>` (round-2 F3/F4: unix-seconds
  collide — use the pins.ts ms+randomness idiom with create-only semantics; `ORIG_HEAD` is
  per-worktree `gitDir` while refs live in the shared `commonDir`, so the name carries a
  stable worktree discriminator — linked-worktree siblings can never prune each other's
  history). Created via `CheckoutPlan.extraTransactionLines` so it commits with the primary
  ref transaction. Keep the **last 8 per worktree**, pruned in deterministic
  parsed-timestamp order — and **prune only AFTER the journal flips to published**
  (round-2 F5: journal recovery arbitrates only recorded refs; pruning inside the
  transaction is irreversible across an intent rollback, while an orphaned create after
  rollback is conservative and acceptable). The ref pins the object against gc.
- If the old content is malformed / names no object: write the raw bytes **directly**
  (plain file write, NOT `quarantineLocal` — round-4: that helper snapshots whole repos
  with bundle+index machinery, wrong shape and uncapped) to the **workspace-root**
  `.rbox/git-quarantine/<repo-hash>/orig-head-<ms>-<rand>.bytes` — the same root directory
  the confirmed `take-theirs` path uses (`git-cmd.ts:645`), which is workspace-root
  hard-excluded (round-3: `<repo>/.rbox/` would be WRONG for nested repos — it would
  surface as a synced/local-edit artifact). Content capped at **64 KiB with declared
  truncation** (a legitimate `ORIG_HEAD` is ≤ a few hundred bytes; anything larger is
  hostile garbage and the truncated prefix is ample forensics). Durable and fail-closed
  (round-5/6): written create-only (`O_CREAT|O_EXCL`, no symlink following), fsync'd bottom-up
  (round-7 — publishing a directory entry requires fsyncing its PARENT): the file, then
  `<repo-hash>/` (always — it holds the file entry), then `git-quarantine/` if
  `<repo-hash>/` was newly created, then `.rbox/` if `git-quarantine/` was new, continuing
  through the first pre-existing ancestor — and the write MUST complete before the adoption
  is eligible; any failure defers exactly as today. Kept indefinitely; no retention machinery. The log line names a generic *recovery
  location* covering both arms.
- **Capture exclusion (round-2 F2 — found by local repro):** capture bundles use
  `git bundle create --all`, which ADVERTISES `refs/rbox-recovery/*` — the receiver-only
  object would travel inside the encrypted bundle to every device. Fix at the root: capture
  adds `--exclude=refs/rbox-*` ahead of `--all` (`src/engine/git/capture.ts`, both call
  sites). This closes the whole internal-ref leak class (any pins/wip refs present at
  capture time leak the same way today) and is a deliberate amendment of v1's
  "no capture-side change" non-goal. Test: recovery ref present → bundle does not
  advertise it; syncable refs unaffected.
- **TOCTOU equality (round-2 F1, extended round 3)**: the boundary re-proof under prepared
  locks must verify the live breadcrumb bytes still equal the exact value the plan
  preserved — a breadcrumb that changed between proofs aborts and retries rather than
  adopting a value nobody preserved. And because the prepared ref/index locks do NOT
  reserve `ORIG_HEAD` (a concurrent `git update-ref ORIG_HEAD` could write B after A was
  re-proved), the plan **acquires `ORIG_HEAD.lock`** (git's own lockfile protocol for
  pseudo-ref writes) at re-proof time and holds it until the staged op-state write
  completes — a concurrent git writer blocks/fails cleanly on the lockfile instead of
  racing the adoption. Round-4/5: the lock carries **exact ownership + crash cleanup**:
  - the checkout journal gains a **`journalId`** (ms + CSPRNG suffix), stored BOTH in the
    journal file and in a tiny **`journal.id` sidecar** written+fsync'd before the lock is
    taken (round-6: corrupt-JSON recovery cannot parse `journal.json` to learn the id — the
    sidecar is the independently durable ownership metadata every recovery exit reads);
  - the lock is acquired **atomically with content**: write `ORIG_HEAD.lock.tmp-<rand>`
    containing the journalId, **fsync it**, then `link()`/rename-if-absent to
    `ORIG_HEAD.lock` (creation and ownership are one step — no empty-lock window, and power
    loss cannot publish an empty/partial lock); after lock REMOVAL, fsync the git directory
    before retiring/clearing the ownership sidecar (round-7: otherwise power loss can
    resurrect a lock without durable matching ownership metadata);
  - **every** journal-recovery exit (published, rollback, binding-mismatch, corrupt) removes
    an `ORIG_HEAD.lock` whose content equals the recovered journal's id; foreign/absent
    content is never touched — process death can never permanently strand git;
  - the lock is **released when the staged op-state write completes**, before the published
    flip (its job — fencing concurrent `ORIG_HEAD` writers between re-proof and adoption —
    is done at that point).
- **Post-publish actions are best-effort by declaration (round-3)**: the recovery-ref
  CREATE is inside the transaction (crash-safe); the cap PRUNE and the adoption LOG LINE
  run after the published flip and are not replayed on crash — a crash there costs one
  forensic log line. Round-4/5 coherence: the cap is a **self-correcting soft cap** — every
  successful prune deletes down to 8 oldest-first **always excluding the ref created by the
  current adoption** (round-5: a clock rollback could otherwise make the newest ref the
  "oldest" and delete the very preservation this adoption depends on). Crash accumulation is
  bounded by crash count and corrected by the next successful prune. Honest costing
  (round-5): each ref pins a commit **graph**, not 41 bytes — typically publisher history
  already in the store (marginal cost ~zero); a receiver-only chain is exactly the content
  preservation exists to keep. Accepted. No journal replay machinery is warranted.
- **Worktree discriminator**: defined ONCE in the preservation section below (round-5: this
  bullet previously carried a stale basename-based duplicate) — `primary` /
  `wt-<12hex sha256(gitDir realpath)>`.
- `rbox git deferrals --brief` needs no change (the repo is no longer deferred — the point).

### Scope

- Change site: the deferral evaluation around `follow.ts:368` (partition + sole-blocker
  logic). Classification is the **explicit exhaustive map** described above
  (`OP_STATE_CLASSIFICATION satisfies Record<OpStateRoot, "breadcrumb" | "in-progress">`,
  every file and dir root a key — round-3: this section previously contradicted that with a
  derived-set sketch; the explicit map wins, so an unclassified addition fails typecheck).
- No wire/manifest/schema change; no server change. Deferral reasons unchanged (`local-operation`
  simply stops firing for the waived case). §124 presentation and §120 telemetry need nothing.
- Log line on waive (dated daemon log, bounded): `git-sync: adopted stale ORIG_HEAD breadcrumb for <repo> (old value preserved at <recovery-location>)` — the self-heal must be visible in forensics. (One format, defined once — round-5 flagged a drifted duplicate.)

### Tests (expanded in round 1, F5 — the dangerous cases must be pinned)

- The exact field shape: live/base/incoming all-distinct `ORIG_HEAD`, everything else clean
  → no deferral, follow applies, replica op-state equals incoming, **old value present at
  the recovery ref**, one adoption line logged after commit.
- Breadcrumb mismatch + one dirty guard each (local edit / index divergence / receiver-only
  commit / stash / MERGE_HEAD mismatch / unreadable tip) → still defers, detail line present.
- **Presence gate**: live in-progress marker present but EQUAL to base/incoming (adds no
  mismatch reason) + ORIG_HEAD differs → still defers. Each in-progress file and each of the
  3 dirs; **empty op-state dirs** (invisible to `readOpState`) explicitly included.
- **Preservation**: old ORIG_HEAD names receiver-only work (the commit-U scenario) →
  adoption still proceeds (guards can't see U) but U remains reachable via the recovery
  ref; malformed ORIG_HEAD content → quarantined bytes. Recovery-ref cap: 9th adoption
  prunes the oldest. Incoming-absent arm: live ORIG_HEAD deleted from op-state but
  preserved first.
- **Pipeline placement**: breadcrumb-only proof + non-empty `heldRefs` (receiver-only side
  ref) → no adoption; retry of an existing §116 partial apply → unchanged behavior;
  boundary re-proof failure after a provisionally-waived first proof → defers, NO adoption
  log; `manualResolution.waivedReasons` interaction (waived reasons don't unlock the
  breadcrumb path by accident).
- Deferral bookkeeping: a previously-recorded `local-operation` deferral (subjectKey/reproof)
  is cleared by the successful waived follow via the normal success path.
- Fingerprint cache: adopted replacement/deletion invalidates the op-state fingerprint
  (no stale-cache skip on the next cycle).
- Exhaustiveness: the classification map covers every `OP_STATE_FILES`/`OP_STATE_DIRS` entry
  (`as const` + `satisfies`); an unclassified addition fails typecheck.

### Validation

- Full suites + the sync-git unit harness (primary).
- Field dogfood is the real proof and arrives free: this session's own rebase-heavy flow
  reproduces the class within days; with §127 live, a strand would page — silence + the
  waive log line on the followers is the success signal. (Rig two-device scenario is a
  nice-to-have; Mac rig access is founder-gated right now.)

## Non-goals

- Reclassifying anything beyond `ORIG_HEAD` in v1 (the table makes later promotions cheap
  and individually reviewed).
- Any change to capture/publish-side op-state handling.
- A general "op-state repair" tool — §124's brief + `rbox git resolve` remain the manual path
  for non-breadcrumb deferrals.
