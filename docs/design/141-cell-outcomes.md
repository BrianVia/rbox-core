# Design 141 exact expected outcomes

This file is the implementation contract requested by the Round-2 review. It
describes the behavior of the current tree, not a desired engine fix. Fixture
paths below are normative so log and status assertions can be literal:
`s1-a`, `s1-a/mod`, `s1-b`, `s1-c`, `s2-configured`, `s2-unconfigured`,
`s3-unicode`, `s3-case`, `s4-shallow`, `s4-partial-online`,
`s4-partial-offline`, `s5-merge`, `s5-rebase`, `s5-cherry-pick`, and
`s5-bisect`.

## 1. Shared interpretation of the six fidelity clauses

The following distinction is load-bearing.

- A **materialization cell** gets a native Git section on B. Clauses 1-5 run,
  with the per-cell values in section 6. The plain-file plane always runs
  before native Git apply (`src/cli/sync/pull.ts:201-207,252-266`).
- A **native-refusal cell** may still publish ordinary worktree files, but B
  gets no native Git section. Clauses 1, 2, 4, and 5 do not run against a
  nonexistent B repo. Clause 3 becomes the plane-specific artifact check and
  clause 6 pins the refusal. The replacement lifecycle is: exact source
  precondition; exact plan/result; exact A durable deferral; exact B
  plain/native split; remote-sequence and local-state settlement; and an
  unchanged next remote sequence. The engine represents local Git lanes in
  `RepoRecord.deferrals`, independently of the file-only global manifest
  (`src/cli/config.ts:260-281`; `src/cli/sync-state.ts:49-84,112-115`).
- A **receiver-manifest refusal** (S3 case collision) has no B apply at all.
  Clauses 1, 2, 4, and 5 are replaced by: enrollment on an empty workspace,
  A's accepted colliding manifest, the exact B validation error, no B sequence
  consumption or mutation, and the same rejection on retry. Manifest
  validation rejects the second case-fold-equivalent entry
  (`src/engine/manifest-validate.ts:146-161`), and snapshot/delta encoding calls
  that validator before producing the envelope
  (`src/engine/manifest-delta.ts:298-304,324-346`).

For every materialization cell, “clause 4 settled” means all of the following,
not merely equal sequence numbers:

1. `rbox status --json` has the exact `git.deferrals` and `git.deferredRepos`
   sets stated below; those fields are emitted from durable per-lane state
   (`src/cli/status-cmd.ts:486-503`; `src/cli/sync-git/git-deferral-json.ts:14-39`).
2. A and B have consumed the accepted remote sequence. A successful publisher
   ACK installs `advertised` and `publisher-ack` authority only after the
   accepted response (`src/cli/sync/push.ts:683-735`).
3. No repo has `pending`, `partial`, or `resolutionKey`; no checkout journal or
   `refs/rbox-incoming/*` remains; and no branch P/K recovery refs remain after
   settlement. Pull saves pending/partial/deferral state and then runs branch
   settlement (`src/cli/sync/pull.ts:271-305`); exact P settlement state-CASes
   BASE before deleting P/K (`src/cli/sync-git/p-settlement.ts:76-157`).
4. One further full cycle does not advance the remote sequence. A no-op exits
   before commit and before the forensic Git plan line
   (`src/cli/sync/push.ts:503-552`).

Dynamic fields are asserted by shape: ISO timestamps parse; `ageSeconds` equals
the status clock; `<age>` uses the exact coarse bucket function; and `<VERSION>`
is the probed guest Git version (`src/cli/sync-git/git-deferral-json.ts:14-32`;
`src/cli/status-view.ts:128-138`).

## 2. S1 — submodules

### S1(a): initialized submodule; parent refused, child captured

Construct `s1-a` as an ordinary superproject with committed `.gitmodules` and
gitlink `mod`, and initialize `s1-a/mod`, creating
`s1-a/.git/modules/mod` and the child pointer `s1-a/mod/.git`. Discovery sees
both directory and pointer repos before pruning their raw `.git` entries
(`src/engine/manifest.ts:557-560`).

The parent preflight result is exactly
`.git/modules present — unsupported`, with `structural:true`
(`src/engine/git/preflight.ts:57-62`). The child is not an in-tree-worktree
policy skip: submodules are expressly exempt, and a pointer whose parent is not
sectioned remains capture-eligible (`src/engine/git/shared.ts:350-365`;
`src/cli/sync-git/plan.ts:757-768`). Therefore the fresh-cell plan is exactly:

```text
git-sync: captured 1 (s1-a/mod) · carried 0 · skipped 0 · deferred 1 (s1-a: .git/modules present — unsupported — section not captured) · removed 0
```

The live CLI emits this first-capture line during `rbox init --new`'s implicit
Git attach. A rig cell must retain and assert that init result; a later explicit
push is already a no-op and does not re-emit the line.

The structural suffix is `section not captured` because the fresh parent has
no BASE; the formatter and emission gate are literal
(`src/cli/sync-git/plan.ts:506-536,833-844`;
`src/cli/sync/push.ts:550-553`). This cell must not use the replacement-base
topology, whose different correct suffix is `section dropped` and whose
`removed` set contains the parent (`src/cli/sync-git/plan.ts:531-535`).

The file plane sends `.gitmodules`, ordinary parent files, and checked-out
`mod/*`, but never the parent `.git/modules` tree or child pointer: `.git` is a
hard exclusion at every depth (`src/engine/ignore.ts:231-245`), while ordinary
regular files remain scan entries (`src/engine/manifest.ts:548-572,595-615`).
The parent has no wire section, so B has no `s1-a/.git`, no parent index, and no
parent gitlink. `git -C s1-a status --porcelain` exits 128 with the guest's
not-a-repository fatal. The child section is scoped and excludes shared stash
(`src/engine/git/capture.ts:161-175,224-245,284-296`); fresh apply runs
`git init`, making `s1-a/mod/.git` a directory, and logs exactly
`git-sync applied s1-a/mod` during `rbox init --workspace`'s implicit initial
pull (`src/engine/git/apply.ts:253-268,406-424`;
`src/cli/sync-git/apply.ts:1433-1439`).
On B the child is clean, `fsck --no-dangling` exits 0, and the independently
pinned pointer-to-directory behavior is covered by
`src/engine/git-nested.test.ts:216-243`.

On A, the refusal persists as one capture-lane `unsupported` deferral: plan
maps structural/unsupported text to that typed reason and push saves it before
commit/no-op disposition (`src/cli/sync-git/plan.ts:159-166,189-209`;
`src/cli/sync/push.ts:423-438`). JSON must contain exactly one lane row with
`repo:"s1-a"`, `lane:"capture"`, `reason:"unsupported"`,
`bytesChanged:false`, and no checkout; `deferredRepos[0].displayReason` is
`unsupported` (`src/cli/status-cmd.ts:486-503`). ANSI-stripped human output is:

```text
git-sync: 1 repo synced · 1 deferred
git deferred <age>: needs Git >= 2.46 transactional symref-update; found git version <VERSION> on checkout unavailable (s1-a)
```

The misleading capability wording is today's contract: status probes checkout
capability for every projected `unsupported` reason and substitutes that text
without distinguishing structural capture refusal
(`src/cli/status-cmd.ts:425-427,600-611`;
`src/cli/status-view.ts:296-315`). The daemon row, which receives no capability,
is instead `git deferred <age>: unsupported git state on checkout unavailable
(s1-a)` (`src/cli/daemon/daemon.ts:197-224`;
`src/cli/status-view.ts:155-170`).

The parent refusal replacement is: parent native section absent; B parent not a
repo; child section present and clean; plain files present; source capture
deferral present; A/B/remote sequences settled; next cycle does not republish.
A B parent commit is impossible. This cell does not run a child clause-5
roundtrip: the independent S1(b) pointer cell owns that bidirectional proof.

### S1(b): independently discovered pointer materializes standalone

Make `s1-b` a pointer repo whose common store is outside the sync root, so it
has no sectioned in-tree parent. The parent resolver returns no in-tree owner,
therefore it captures normally (`src/engine/git/shared.ts:350-372`). A's exact
line is:

```text
git-sync: captured 1 (s1-b) · carried 0 · skipped 0 · deferred 0 · removed 0
```

B logs `git-sync applied s1-b` (`src/cli/sync-git/plan.ts:833-844`;
`src/cli/sync-git/apply.ts:1433-1439`). The plain plane sends worktree bytes but
not the pointer; native fresh apply creates a real `.git` directory
(`src/engine/ignore.ts:231-245`; `src/engine/git/apply.ts:253-268,406-424`).
Assert B's HEAD branch and OID equal A's, only the scoped current branch is
present, other common-store branches and stash are absent, porcelain is empty,
and fsck exits 0 (`src/engine/git/capture.ts:161-175,224-245`).

The B-side branch commit must reach A's pointer and then settle without an echo.
The dir receiver may publish an all-scope section; the pointer sender compares
an all-scope BASE on the scoped projection and carries it
(`src/cli/sync-git/plan.ts:568-583`; the two-machine precedent is
`src/cli/sync-git/git-sync.test.ts:713-746`). Final JSON deferral sets are empty
and human status says `git-sync: 1 repo synced`
(`src/cli/status-cmd.ts:571-601`).

### S1(c): uninitialized gitlink is a normal capture

Construct `s1-c` with committed `.gitmodules`, a mode-160000 `mod` index entry,
no `.git/modules`, and only an empty `mod/` directory on A. It passes preflight
because the sole superproject structural test is physical `.git/modules`
(`src/engine/git/preflight.ts:57-69`). Exact lines are:

```text
git-sync: captured 1 (s1-c) · carried 0 · skipped 0 · deferred 0 · removed 0
git-sync applied s1-c
```

(`src/cli/sync-git/plan.ts:833-844`;
`src/cli/sync-git/apply.ts:1433-1439`).

B gets `.gitmodules`, a normal `.git` directory, and the captured index. Assert
`git ls-files --stage mod` is exactly
`160000 <SUBMODULE_OID> 0\tmod`. Capture copies/uploads the index, and receiver
publication renames it directly without checkout
(`src/engine/git/capture.ts:207-221,274-295`;
`src/engine/git/checkout-txn.ts:743-756`). The manifest contains files and
symlinks, not empty directories, so B has no `mod` path
(`src/engine/manifest.ts:548-615`). Consequently B's exact porcelain is
` D mod`, `git submodule status` is `-<SUBMODULE_OID> mod`, and fsck exits 0.
This non-clean status is the required materialization outcome, not a deferral.

For bidirectional proof, B commits an explicitly added unrelated file and never
stages `mod`. The commit reaches A; B remains ` D mod`, A keeps its empty
uninitialized directory and remains clean, and deferral sets remain empty. Git
identity is HEAD/refs/semantic-index/op-state, not plain worktree status
(`src/engine/git/identity.ts:17-35,87-100`).

## 3. S2 — Git LFS

The rig uses one image for both devices, so after `git-lfs` is added the binary
exists on both (`scripts/rig/rig.ts:120-141`). A runs `git lfs install --local`
and tracks `*.bin`. Let `PAYLOAD` be fixed bytes, `OID=sha256(PAYLOAD)`, and
`N=byteLength(PAYLOAD)`. In both arms B must receive:

```text
git cat-file -p HEAD:asset.bin
version https://git-lfs.github.com/spec/v1
oid sha256:<OID>
size <N>
```

The committed blob is that pointer through the bundle/native plane, while the
worktree `asset.bin` is byte-for-byte `PAYLOAD` through the plain plane;
`.gitattributes` is identical in commit and worktree. Plain apply precedes Git,
capture sends bundle/index/op-state rather than `.git` interiors, and receiver
publishes the index without checkout or a smudge filter
(`src/cli/sync/pull.ts:201-207,252-266`;
`src/engine/git/capture.ts:207-221,229-295`;
`src/engine/git/checkout-txn.ts:743-756`).

The after-pair LFS fixtures cross a files-only first boundary and materialize
native Git on the follow-up push/pull. Pin that boundary to zero command exits,
the exact formatted `git-sync: captured 1 (<rel>) · carried 0 · skipped 0 ·
deferred 0 · removed 0` plan, exact `git-sync applied <rel>` log, and B's native
`.git` directory. Do not require `capturing git state 0/1`: it is a throttled
non-TTY spinner update and may be absent when capture finishes in under one
second (`src/cli/spinner.ts:24-37`).

Immediately after pull, before any Git command that reads worktree content,
`.git/lfs/objects/<OID[0:2]>/<OID[2:4]>/<OID>` is absent in both arms. Raw `.git`
content is hard-excluded and native capture has no LFS-cache artifact
(`src/engine/ignore.ts:231-245`;
`src/engine/git/capture.ts:207-221,274-295`). In both arms
`git config --local --get-regexp '^filter\\.lfs\\.'` exits 1 with empty output:
only remote url/fetch and branch remote/merge/rebase can travel
(`src/engine/git/config-sync.ts:13-21`).

### S2 configured receiver

Before B materializes, run `/usr/bin/git-lfs install --skip-repo` on B; Git LFS
installs global filters by default and has no `--global` flag. Do not create B
repo-local LFS config. The effective filter entries are pre-seeded fixture
state, not synced state. Cache absence must be asserted before status. Then:

- `git status --porcelain=v1` exits 0 with empty stdout/stderr.
- That status clean-filter side effect creates
  `.git/lfs/objects/<OID[0:2]>/<OID[2:4]>/<OID>` with exact `PAYLOAD`.
- The recreation is explicitly recorded as `git-lfs recreation, not rbox
  fidelity`; rbox itself never invokes a filter in index publication
  (`src/engine/git/checkout-txn.ts:743-756`).
- `git fsck --no-dangling` exits 0.

For clause 5, B modifies and commits `asset.bin`. Pin the new committed pointer,
new plain worktree payload, and B's cache object. A receives pointer and payload;
A's new cache object is absent immediately after pull and appears only when A's
configured Git reads/cleans the worktree. Filter config remains independently
local/global, never rbox-authored (`src/engine/git/config-sync.ts:13-21`).

### S2 unconfigured receiver (not PATH-masked)

Before pull, remove B's local/global/system `filter.lfs.*` entries but leave
`git-lfs` on PATH. This deliberately chooses the unconfigured contract and does
not exercise the distinct configured-but-missing executable failure. After
pull, pointer, payload and `.gitattributes` match the common assertions; config
and cache are absent. Then:

- `git status --porcelain=v1` exits 0, stdout is exactly ` M asset.bin`, and
  stderr is empty.
- Cache remains absent after status because no filter ran.
- `git fsck --no-dangling` exits 0; the committed object is a valid pointer and
  receiver apply itself requires connectivity fsck
  (`src/engine/git/apply.ts:701-724`).

For clause 5, B explicitly stages and commits only an unrelated ordinary file.
It must not run `git add -A` or stage `asset.bin`, which would intentionally
commit a raw binary and define a different cell. The commit reaches A; B remains
` M asset.bin`; pointer, payload, absent config, and absent cache remain
unchanged. Worktree dirt is not part of Git identity
(`src/engine/git/identity.ts:17-35`).

## 4. S4 — shallow and partial clones

### S4(a): fresh shallow clone is “not captured,” not “dropped”

Clone `s4-shallow` with `--depth 1` from a `file://` source. Its exact preflight
result is:

```text
shallow clone — unsupported (git fetch --unshallow to sync history)
```

with `structural:true` (`src/engine/git/preflight.ts:43-50`). Because this is a
fresh cell with no prior section, the exact planner reason appends
` — section not captured`; `captured`, `carried`, and `removed` are empty and no
wire Git section exists (`src/cli/sync-git/plan.ts:506-536`). The design must not
call this a “drop.” The existing replacement-base unit topology is a different
arm: it appends `section dropped`, sets `repoAbsent`, and reports `removed 1`
(`src/cli/sync-git/git-sync.test.ts:1884-1928`).

Plain worktree files sync, but `.git/shallow` and all raw Git state do not, so B
has worktree bytes and no `.git` (`src/engine/ignore.ts:231-245`;
`src/cli/sync-git/apply.ts:289-320,344-348`). A persists one capture-lane
`unsupported` deferral (`src/cli/sync-git/plan.ts:159-166,189-209`;
`src/cli/sync/push.ts:397-439`). JSON is exactly one capture/unsupported lane,
`bytesChanged:false`, no checkout, and one projected `displayReason` of
`unsupported` (`src/cli/sync-git/git-deferral-json.ts:14-32`;
`src/cli/status-cmd.ts:486-503`). Human output is:

```text
git-sync: 0 repos synced · 1 deferred
git deferred <age>: needs Git >= 2.46 transactional symref-update; found git version <VERSION> on checkout unavailable (s4-shallow)
```

The capability substitution is the same current status bug as S1(a)
(`src/cli/status-cmd.ts:425-427,600-611`;
`src/cli/status-view.ts:296-315`; pinned generally at
`src/cli/status-cmd.test.ts:324-345`). Health detail separately says
`git deferral: oldest <age> · unsupported git state`
(`src/cli/status-view.ts:494-505`).

Do **not** require a forensic plan line in the natural files-first cell. Once
plain files have committed, the later failed native attempt is files+Git
commit-no-op and returns before line emission
(`src/cli/sync/push.ts:503-552`). If the same attempt also has a file diff, the
exact line is:

```text
git-sync: captured 0 · carried 0 · skipped 0 · deferred 1 (s4-shallow: shallow clone — unsupported (git fetch --unshallow to sync history) — section not captured) · removed 0
```

Fresh first refusal persists the deferral; the next plan sees the new record,
sets local `repoAbsent:true`, and the no-op path saves that bookkeeping without
a remote commit (`src/cli/sync-git/plan.ts:531-535`;
`src/cli/sync/push.ts:516-548`). Replacement lifecycle: B no repo, plain files
present, A capture/unsupported standing, advisory Git divergence count 0 because
there is no BASE to drop, and the next cycle leaves remote sequence unchanged
(`src/cli/sync-git/status.ts:178-183`).

### S4(b): partial clone, origin available

Create three commits C1/C2/C3 that overwrite the same `payload.bin`; let O1/O2/O3
be each commit's blob OID. Clone with `--filter=blob:none` from an origin with
`uploadpack.allowFilter=true`, checking out C3. With lazy fetch disabled only for
the probe, assert the exact sorted missing set is `{O1,O2}`:

```text
GIT_NO_LAZY_FETCH=1 git rev-list --objects --all --missing=print
```

At the corrected observation boundary the exact post-push missing set remains
`{O1,O2}`. The push output contains no `git-sync:`, `capturing git state`, or
`attaching git history` line; its Git-plan metrics are empty
(`hit0m0u0 pps0 sp0 prc0`). A remains the fixture's promisor clone with
`remote.origin.promisor=true`, `remote.origin.partialclonefilter=blob:none`, the
exact fixture `file://` origin URL, and no `extensions.partialClone` key.

B receives the plain `payload.bin` bytes (`payload-three\n`) but no Git section:
pull metrics report `repos=0`, `.git` is absent, and `git rev-parse --git-dir`
returns the exact not-a-repository failure. Both devices have empty public and
durable deferral/pending/partial/resolution state, but there is no advertised
Git checkpoint and no B-to-A Git commit roundtrip at this first boundary.

design 147 supersedes design 146's fixed-point no-hydration conclusion. The
next complete fixed-point cycle captures A's native repo and applies it on B.
After settlement A's missing set is exactly empty, while its promisor/filter/URL
config remains unchanged. B still has exact `payload-three\n`, now with a
standalone `.git` and `rev-parse --git-dir` exactly `.git`. A's structural repo
record has source sequence 2, base, advertised checkpoint, publisher-ack
provenance, and no pending/partial/resolution/deferral state. B's has source
sequence 2, base, pull provenance, no advertised checkpoint, and the same empty
transient state.

### S4(c): partial clone, origin unavailable, lazy fetch disabled

Use the same exact precondition `{O1,O2}`, then make the origin unavailable and
run rbox with `GIT_NO_LAZY_FETCH=1`; `cleanGitEnv` preserves that inherited
variable (`src/engine/git/shared.ts:75-93,124-127`). Pin the current runtime as
`git version 2.54.0`; the Dockerfile installs a moving PPA package, so a version
change requires re-ratification (`scripts/rig/Dockerfile:12-18`).

The first push is files-only. Its Git-plan metrics are exactly
`hit0m0u0 pps0 sp0 prc0`, combined output has no `git-sync:`, `capturing git
state`, or `attaching git history`, public deferral/deferredRepos arrays are
empty, and A's missing set remains exactly `{O1,O2}`. ANSI-stripped status is:

```text
↑ git changes to sync (git changes in 1 repo) — background sync stopped; run `rbox start`
git-sync: 0 repos synced
```

with no `git deferral:` detail or `git deferred` row. Plain files reach B, which
has exact payload bytes and no `.git`.

The next A push is the first native Git attempt. It holds remote sequence 1 and
creates one fresh durable capture episode with reason `worktree-ownership`.
Public JSON contains one capture row and one projected repo row, both with
`bytesChanged:false`, no checkout, the same valid episode timestamp, and exact
display reason `worktree-ownership`. The durable row has the same
`deferredSince`, `reasonSince`, and `lastSeen`; durable false may be omitted but
must never be true. This pins today's observed behavior rather than the obsolete
artifact-stderr expectation, and no bidirectional Git operation runs.

## 5. S5 — in-progress operations, real precedence, and bisect

### Deterministic supported-operation fixture

For all three supported operations, build a one-file conflicting graph before
the clean shared BASE and let B start the ordinary conflict on `conflict.txt`.
For **merge and cherry-pick**, A's post-BASE change is an `--allow-empty` commit
on the operation holder's/incoming branch plus one new tag. For **rebase**, A's
incoming delta is the new tag only: it does not advance the branch being
rebased. This split is mandatory. Rebase has detached HEAD, and only the live
current ref is withheld from pre-classification safe publication
(`src/cli/sync-git/follow.ts:604-606,690-692`); advancing the rebased branch
would publish it through the branch-transition/P path before the veto
(`src/cli/sync-git/follow.ts:816-852`) and `git rebase --abort` would then move
it back, invalidating the recorded partial proof
(`src/cli/sync-git/apply.ts:803-815`). The tag-only rebase arm still delivers a
new incoming section. In every arm A's plain tree stays BASE while B has
conflict markers and an unmerged index.

All three cells simultaneously trip:

- `local-edits`, because the applied-manifest oracle sees B's conflict bytes
  (`src/cli/sync-git/follow.ts:408-410`);
- `local-index`, because B's semantic unmerged index equals neither BASE nor
  incoming (`src/cli/sync-git/follow.ts:417-432`); and
- `local-operation`, because recognized live op state differs from both BASE
  and incoming (`src/cli/sync-git/follow.ts:435-447`). Recognized roots are
  exactly those enumerated/classified at
  `src/engine/manifest-validate.ts:226-248`.

The persisted and displayed reason is **`local-edits`**. Checkout classification
precedence is exactly:

```text
local-edits > local-index > local-operation > local-commits > local-stash >
worktree-ownership > git-busy > unreadable > artifact > containment >
unsupported > other
```

and only the first is returned/persisted
(`src/cli/sync-git/follow.ts:384-390,501-504`;
`src/cli/sync-git/apply.ts:1198-1202`). Tests already pin local-edits over index
dirt and local-index over simultaneous op-state dirt
(`src/cli/sync-git/follow.test.ts:890-900`;
`src/cli/sync-git/follow-matrix.test.ts:454-492`).

The tag is required to publish before checkout classification. Safe-ref/config
work precedes the proof; merge/cherry's current symbolic branch is withheld,
and the rebase arm deliberately has no branch delta
(`src/cli/sync-git/follow.ts:938-1002,690-692`). Assert the tag witness in
`partial.appliedRefs` is `{kind:"safe-ref",proof:"expected-old-transaction",
beforeOid:null,afterOid:<incoming-tag-oid>}`
(`src/cli/sync-git/follow.ts:856-864`).
Mid-deferral state is exactly: incoming section in `pending`;
`partial.checkoutPending:true`; `partial.heldRefs:{}`;
`partial.configApplied:true`; the tag witness; and one apply/local-edits lane
(`src/cli/sync-git/apply.ts:633-643,1198-1200`). Do not demand that every ref or
config byte remain fixed.

Unsafe classification returns before journal construction and checkout commit
(`src/cli/sync-git/follow.ts:1002,1138-1174`). Snapshot before pull and perform
two explicit **receiver-only pulls**, with no B push between them. Assert after
each pull: `.git/HEAD`, raw and semantic index, every recognized
op-state file/directory byte, and `conflict.txt` are unchanged. The fixture's
exact porcelain throughout is `UU conflict.txt`; fsck exits 0. Merge and
cherry-pick remain symbolic on the holder branch/pre-op tip; rebase remains
detached at its onto tip. Because the rig image's PPA Git is not version-pinned,
snapshot the fixture-created recognized op-state set rather than hardcoding
whether optional `AUTO_MERGE` exists (`scripts/rig/Dockerfile:6-18`).

Exact JSON immediately after those receiver-only pulls has one apply row with
`reason:"local-edits"`, `bytesChanged:false`, and branch checkout for
merge/cherry-pick or detached checkout for rebase
(`src/cli/sync-git/git-deferral-json.ts:14-32`). If a full daemon cycle includes
a **B push**, that push observes B's conflict bytes under the standing apply
episode and monotonically changes the expected value to `bytesChanged:true`;
an A-side push is irrelevant (`src/cli/sync/push.ts:440-469`). Exact 0m human
rows before such a B push are:

```text
git deferred 0m: local edits on branch <branch> (s5-merge)
git deferred 0m: local edits on detached checkout (s5-rebase)
git deferred 0m: local edits on branch <branch> (s5-cherry-pick)
```

(`src/cli/status-view.ts:296-315`; `src/cli/status-cmd.ts:602-611`). The daemon
log begins exactly
`git-sync deferred <rel>: working tree differs from applied manifest; index
differs from both base and incoming; operation state differs at ...`; phrases
are joined in classifier order (`src/cli/sync-git/follow.ts:405-447,501-504`;
`src/cli/sync-git/apply.ts:1200-1202`). Separately run `rbox git resolve <rel>`
and assert `oracle: dirty; index: diverged; operation state: diverged; stash:
clean`; that surface independently proves the op-state veto hidden behind the
public precedence (`src/cli/git-cmd.ts:430-494`).

Abort deterministically with `git merge --abort`, `git rebase --abort`, or
`git cherry-pick --abort`, then pull. Merge and cherry-pick successfully clear
pending, partial, and apply deferral and log `git-sync followed <rel>`
(`src/cli/sync-git/apply.ts:1205-1232`). Only after their clean settlement does
clause 5 create B's branch commit and prove it reaches A.

Rebase is the observed exception and must record
`engine-gap: rebase-post-abort-epipe`. The corrected fixture starts on clean
symbolic `main`, becomes detached in a genuine conflict, and `rebase --abort`
itself proves the marker absent, porcelain empty, symbolic `main`, and exact
`incoming-side\n` bytes. The next receiver pull exits zero but reports
`results=deferred=1` and exact `git-sync deferred s5-rebase: EPIPE: broken pipe,
write`, with no followed log. Public and durable state has one apply/`other`
deferral on branch `main` with public `bytesChanged:false`; `pending` and
`partial.checkoutPending` remain, while resolution, P/K recovery refs, and the
checkout journal remain absent. The already-applied tag witness, empty held
refs, and `configApplied:true` remain exact.

The gap is an unchanged-symbolic-HEAD checkout transaction after rebase leaves
a stale `ORIG_HEAD`: breadcrumb preservation adds a recovery-ref `create`
before `symref-verify`, but the transaction's single `option no-deref` applies
only to the create, so Git rejects the symref command and the FIFO writer
surfaces EPIPE (`src/cli/sync-git/orig-head.ts:84-103`;
`src/cli/sync-git/follow.ts:1004-1032`;
`src/engine/git/checkout-txn.ts:153-173,322-341,574-578`). After pinning this
state, a B commit probe asserts that the plain receiver file reaches A while
the native commit does not. Do not run the sequence-only fixed-point helper for
this cell: equal remote sequences do not mean native Git convergence.

Repo-level display precedence across multiple lanes is independently:
human-divergence reason rank first (`local-edits`, `local-index`,
`local-operation`, `local-commits`, `local-stash`, then every other reason),
then parsed `deferredSince`, lane, and reason. The displayed reason and oldest
chronic age are selected separately (`src/cli/status-view.ts:185-195,233-293`).

### S5 bisect: no deferral, HEAD/index move, bisect metadata survives

Build the tested range and A's post-BASE advance as empty commits over one
identical tree. Run `git bisect start <bad> <good>` on B so it detaches at an
older candidate. The worktree and semantic index still equal BASE/incoming,
and the candidate is an ancestor of incoming. Semantic index identity ignores
volatile stat data but retains entry/flag semantics
(`src/engine/git/index-identity.ts:54-78`); incoming ownership accepts an
ancestor of an incoming root (`src/engine/git/reachability.ts:106-125`).

`BISECT_*` is absent from the op-state universe, and `refs/bisect/*` is outside
the only syncable namespaces (heads, tags, stash)
(`src/engine/manifest-validate.ts:226-265`); ref reads filter through that
predicate (`src/engine/git/refs.ts:6-14`). Therefore no ordinary reason is
added and classification is safe (`src/cli/sync-git/follow.ts:408-460,501-504`).
No deferral fires.

After sync on B:

- HEAD changes from the detached candidate OID to exactly
  `ref: refs/heads/main\n`; the main ref equals A's incoming empty commit.
- The raw index may change and must not be pinned. Its semantic projection
  equals incoming; checkout publishes the captured index atomically
  (`src/cli/sync-git/follow.ts:1081-1088`;
  `src/engine/git/checkout-txn.ts:743-756`).
- Worktree bytes and porcelain remain unchanged/empty because all trees are
  identical; fsck exits 0.
- Every pre-snapshotted `BISECT_*` file byte and `refs/bisect/*` OID is exactly
  unchanged. Checkout restoration enumerates only recognized op roots, and ref
  planning sees only filtered refs (`src/engine/git/refs.ts:31-62`;
  `src/cli/sync-git/follow.ts:551-592`). These are **unmanaged Git metadata**,
  not untracked worktree files. Long `git status` still reports an active
  bisect even though HEAD is back on main.

JSON has `git.deferrals:[]` and `git.deferredRepos:[]`; human status has no
`git deferred` row (`src/cli/status-cmd.ts:486-503,571-612`), and
`rbox git deferrals` prints `no deferred repos`
(`src/cli/git-cmd.ts:287-293`). Record
`engine-gap: bisect-invisible` with the moved HEAD/semantic index and persistent
unmanaged metadata. Clause 5 may commit from B's now-materialized main and send
that commit to A. Successful native apply logs exactly
`git-sync followed s5-bisect` (`src/cli/sync-git/apply.ts:1231`). Clause 6 does
not apply because there was no refusal; its replacement is the explicit absence
of a **deferred** log/status row plus that positive followed log and the
finding.

The incoming-BASE control remains required but is not a separate cell: an
incoming `MERGE_HEAD` that equals BASE is allowed to replace/delete BASE op
state during checkout; only receiver-local bytes unequal to both BASE and
incoming veto (`src/cli/sync-git/follow.ts:435-447`;
`src/engine/git/checkout-txn.ts:742-756`; pinned at
`src/cli/sync-git/follow.test.ts:244-261`).

## 6. Per-cell fidelity-clause applicability matrix

`R` means the refusal replacement from section 1, not a weakened version of
clauses 4/5. `D→S` means assert both the deferred phase and the later settled
phase. Every value below is mandatory.

| Cell | Clause 1: porcelain | Clause 2: fsck | Clause 3: shape/artifacts | Clause 4: exact convergence | Clause 5: B→A | Clause 6: exact refusal/drop |
|---|---|---|---|---|---|---|
| S1(a) parent | N/A; B parent is not a repo | N/A | Yes: parent plain files present, parent `.git`/index/gitlink absent; child outcome belongs to S1(b) | **R**: A capture/unsupported; B parent no native section; plain and child planes settle; next remote seq unchanged | N/A for parent; child commit is S1(b) | Yes: exact `.git/modules...section not captured`, JSON and misleading status text |
| S1(b) pointer | `""` | exit 0 | Yes: B `.git` directory, same HEAD/current branch, scoped-only refs, no shared stash | Yes: empty deferrals/pending/partial/P/K, ACK/origin checks, no-op next cycle | Yes: B branch commit reaches A pointer; projection stops echo | N/A |
| S1(c) gitlink only | B exactly ` D mod`; A `""` | exit 0 | Yes: `.gitmodules`; mode-160000/OID index entry; B `mod` absent; standalone parent `.git` | Yes: empty deferrals/artifacts and no-op next cycle, with asymmetric status retained | Yes, unrelated explicitly staged file; never stage `mod` | N/A |
| S2 configured | `""` after filter | exit 0 | Yes: pointer in HEAD/index; binary in worktree; local config absent; cache absent pre-status, exact payload object present post-status | Yes: empty deferrals/artifacts and no-op next cycle | Yes: changed LFS pointer+payload reach A; caches recreate locally only | N/A |
| S2 unconfigured | exactly ` M asset.bin` | exit 0 | Yes: same pointer/binary; all filter config absent; cache absent before/after status | Yes: empty deferrals/artifacts and no-op next cycle despite expected worktree mismatch | Yes, unrelated explicitly staged file; expected mismatch persists | N/A |
| S3 NFC/NFD | `""` | exit 0 | Yes: both UTF-8 path byte strings and file bytes hex-equal A/B | Yes: empty deferrals/artifacts and no-op next cycle | Yes: B branch commit reaches A with byte pins retained | N/A |
| S3 case collision | N/A; B unchanged | N/A | Yes: source has `s3-case/README.md` and `s3-case/Readme.md` | **R**: A publish accepted; B does not consume it or mutate; retry same rejection | N/A | Yes: exact `case-insensitive duplicate path: s3-case/Readme.md` |
| S4(a) fresh shallow | N/A; B is not a repo | N/A | Yes: B current worktree bytes only; no `.git`; A shallow file remains local | **R**: capture/unsupported, then local `repoAbsent`; advisory divergence 0; remote seq unchanged on retry | N/A | Yes: exact unshallow hint + `section not captured`; plan line only when emission gate reached; misleading human status pinned |
| S4(b) partial online | post-pull N/A; settled `""` | settled exit 0 | First boundary: PRE=POST `{O1,O2}`, B plain/no repo. Settled: A missing set empty, config retained, B native repo with exact bytes | Yes: empty first plan/state; fixed point materializes structural A/B records with no transient state | N/A | N/A; design 147 supersedes the design 146 fixed-point no-hydration claim |
| S4(c) partial offline | N/A; B is not a repo | N/A | Yes: PRE=POST exactly `{O1,O2}`; B plain bytes/no `.git`; no section/config | **R**: first push files-only/empty rows; next attempt creates capture/worktree-ownership while sequence holds | N/A | Yes: exact first-push empty-plan/pending-human surface and new durable worktree-ownership episode |
| S5 merge | during D exactly `UU conflict.txt`; after abort/S `""` | exit 0 throughout | Yes: HEAD/index/op/worktree snapshots unchanged across 2 receiver-only pulls; new tag advances | Yes, **D→S**: apply/local-edits + pending/partial/tag witness, then all clear/no P/K/no-op | Yes, only after abort+S | Yes: checkout refusal is apply/local-edits; resolve surface separately proves operation-state veto |
| S5 rebase | during D exactly `UU conflict.txt`; after abort/gap `""` | exit 0 throughout | Yes: detached HEAD/index/op/worktree snapshots unchanged; tag advances; abort restores clean symbolic main | **D→gap**: apply/local-edits, then exact post-abort EPIPE with apply/other + pending/partial retained; no P/K/journal; no sequence-only convergence claim | Engine gap: plain file reaches A but B native commit does not; sidecar required | Yes: deferred phase is apply/local-edits; post-abort gap is exact EPIPE/apply-other |
| S5 cherry-pick | during D exactly `UU conflict.txt`; after abort/S `""` | exit 0 throughout | Yes: symbolic HEAD/index/op/worktree snapshots unchanged; new tag advances | Yes, **D→S**: apply/local-edits then all clear/no P/K/no-op | Yes, only after abort+S | Yes: apply/local-edits, not local-operation; resolve veto proof |
| S5 bisect | `""` | exit 0 | Yes: HEAD reattaches/moves; semantic index=incoming; raw index unpinned; BISECT bytes/refs unchanged | Yes: no deferrals/pending/partial/P/K and no-op next cycle | Yes from materialized main | N/A; replace with no deferred log/row, exact followed log, and engine-gap sidecar |

S3's NFC/NFD byte proof must compare guest-emitted hex, not decoded display text:
`Device.exec` returns decoded stdout (`scripts/rig/lib/device.ts:125-135`). S3's
case fixture is exactly `s3-case/README.md` plus `s3-case/Readme.md`. Manifest
sorting places the all-uppercase member first, so validation's second member
and literal error are `s3-case/Readme.md` and
`case-insensitive duplicate path: s3-case/Readme.md`
(`src/engine/manifest.ts:196-199`;
`src/engine/manifest-validate.ts:150-161`).

## 7. Assertions that must not be weakened

- Do not use “whatever happens” or “if hydration occurs.” S1(c), both partial
  arms, bisect, and display precedence above are exact.
- Do not assert the raw preflight string as the human status reason for
  `unsupported`; current status replaces it with checkout-capability prose
  (`src/cli/status-cmd.ts:425-427`; `src/cli/status-view.ts:312-315`).
- Do not require a forensic push-plan line after a files-first native refusal;
  the no-op branch precedes that log (`src/cli/sync/push.ts:503-552`). Durable
  JSON/human deferral visibility is mandatory instead.
- Do not call BISECT metadata “untracked files,” do not require bisect index
  bytes to remain fixed, and do not expect `local-operation` from ordinary
  conflict fixtures. The actual public reason is `local-edits`.
- For merge and cherry-pick, do not run clause 5 while checkout is deferred:
  abort, settle, prove all transient state retired, then create B's commit.
  Rebase's explicit engine-gap probe is the exception: after pinning the clean
  post-abort EPIPE/pending/partial state, create B's commit to prove native
  non-propagation while its plain file still reaches A.
- Do not inspect configured-LFS cache after status and claim it arrived through
  rbox. Cache absence is asserted before status; later presence is a local
  clean-filter side effect. Receiver index publication does not run filters
  (`src/engine/git/checkout-txn.ts:743-756`).
