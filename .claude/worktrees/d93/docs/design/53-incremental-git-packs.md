# 53 — Incremental git packs (bundle chains: push cost O(history) → O(delta))

**Status:** v2 — spec-only rewrite folding the two-review FINAL decisions: design-68 layout split, real bundle-arg threading, schema-3 chain validation, forced/presence-skipped chain apply, MAX_PACK_CHAIN=8, and design-71 refs/422 accounting.
**Builds on:** design 02 (bundle-based git-state sync), design 28 (E2EE git artifacts and the
gcrypt prior-art note), design 43 (`gitRepos`, `refScope`, per-repo defer/422/removal/conflict
semantics), design 68 (main-clone linked-worktree capture and pointer policy-skip), design 71
(large refsets and bounded 422 missing lists), design 72 (gitignore-pruned known repos base-carry),
and §06/§33 (retention → mark → purge reachability GC).
**Non-goals:** server/API/D1/Worker changes; cross-repo or cross-worktree object dedup; receiver to
sender repair signaling; any file-sync change; any change to design-43 per-repo recovery semantics.

---

## 1. Problem — after design 68, the hot cost moved to one dir/all bundle

The current git capture path still emits one full `git bundle` for each captured section. The code
does this in `captureGitState` (`src/engine/git/capture.ts:169`) after reading refs/HEAD, creating
scratch pins, and calling `git bundle create` with a full argument set (`src/engine/git/capture.ts:215-237`).
Change detection (`gitIdentityKey`) correctly skips unchanged sections, but any changed commit,
index tree, op-state, or WIP pin makes capture upload the whole history again. §28 already named
the gcrypt-style future fix: keep an encrypted pack list and bundle only objects not reachable from
already-pushed tips (`docs/learnings.md:583-586`).

The v1 cost model treated every Conductor worktree as an independent full-history upload. That is
now only the secondary layout. Design 68 changed the primary in-tree layout:

- **In-tree main clone + linked worktrees** (for example a main `savvy-core` clone with
  `.claude/worktrees/*` inside the workspace): pointer worktree sections are policy-skipped and
  base-carried when their owning main clone is captured (`src/cli/sync-git.ts:342-367`; design
  68 §3.3, `docs/design/68-worktree-git-sync.md:96-123`). Agent commits made inside those linked
  worktrees still move ordinary `refs/heads/*` in the main clone, so the main clone's single
  `refScope: "all"` section re-bundles the full history. The measured churn shape that triggered
  v2 was 286 recaptures/night, all against one 68 MB dir/all section. Incremental chains target
  this dir/all section first.
- **Out-of-tree worktree clones** (Conductor's original standalone workspace-dir shape, where the
  main clone is outside the synced root): each workspace directory remains its own scoped/pointer
  section because no in-tree main section carries its object store (`docs/design/68-worktree-git-sync.md:121-123`).
  Those sections still chain independently. This is the v1 model, retained as the secondary case.

So the target is not "dedup all worktrees together." The target is: once a section has a base
bundle, subsequent captures for that same section upload O(delta) increments until bounded
recompaction emits a fresh full bundle.

## 2. Manifest shape and schema

`GitSection` currently has one bundle artifact plus optional index/op-state artifacts
(`src/engine/types.ts:55-81`). v2 adds an ordered chain of ancestor bundle links:

```ts
interface GitPackLink extends GitArtifactRef {
  /** One or more commit tips made reachable by this link, used for cat-file presence skips. */
  tips: string[];
}

interface GitSection {
  // unchanged: bundleSha/bundleEncSha/bundleCipherSize describe the NEWEST link
  packChain?: GitPackLink[];
}
```

Ordering is base → older increments → previous increment. The section's own `bundle*` fields are
the newest link. The newest link's tips are derived from the section itself: `Object.values(refs)`
plus detached `head` when `head` is a 40-hex commit. A chain link stores `tips` because a receiver
cannot reconstruct old link tips from the final section refs.

Schema is a clean break for chained sections:

- `KNOWN_MANIFEST_SCHEMA` bumps from 2 to 3 (`src/engine/manifest-validate.ts:17-19` today).
- `manifestSchema >= 3` is required when any git section has a non-empty `packChain`.
- The cross-field rule lives in `validateManifest` (`src/engine/manifest-validate.ts:47-124`),
  not in `validateGitSection`. `validateGitSection` (`src/engine/manifest-validate.ts:147-175`)
  validates one untrusted section body: normal artifact refs, `packChain` artifact shape, link
  `tips`, and the `MAX_PACK_CHAIN` bound. It does not know the manifest schema.
- Capture self-validation remains a section-body check only. `captureGitState` currently calls
  `validateGitSection(section)` before returning (`src/engine/git/capture.ts:268-274`); that stays
  true for the newly captured body before `planGitSections` attaches chain metadata.

Full-bundle sections without `packChain` remain valid schema-2 git sections. A manifest only needs
schema 3 when it actually carries a chain, but old clients still fail loudly on that manifest
instead of silently stripping or mishandling chain links.

## 3. Capture construction

### 3.1 Basis lives at the capture/plan boundary

`captureGitState(repoDir, store, kek, opts)` gains:

```ts
opts.basis?: { tips: string[] };
```

No basis means "emit a full bundle" and clear any chain. Force-recapture paths, recompaction paths,
and all error fallbacks omit `basis`.

`planGitSections` is the only layer that can derive a basis because it has the last synced base
map (`const base = state.lastSyncedManifest.gitRepos ?? {}` at `src/cli/sync-git.ts:127`) and owns
the carry/capture decision (`src/cli/sync-git.ts:319-339`). For a changed, non-forced repo with a
usable base section:

1. Derive `basis.tips` from `Object.values(baseSec.refs)` plus `baseSec.head` when it is a detached
   40-hex commit. This detached-head rule is mandatory: scoped pointer sections can have
   `refs: {}` while the pinned detached HEAD commit still rode the prior bundle.
2. If `basis.tips` is empty, do not build an increment; capture a full bundle.
3. Build the candidate ancestor chain as:
   `candidateChain = [...(baseSec.packChain ?? []), linkFrom(baseSec.bundle*, tipsFrom(baseSec))]`.
4. Pass `opts.basis` into `captureGitState`.
5. Attach `packChain: candidateChain` to the returned section **after** capture and section
   self-validation.

This keeps "the base section is the basis" as the only persistent state. A second machine that
applied a chained section can extend the chain from its saved base without any hidden local pack
database.

### 3.2 Increments use the real design-68 bundle arguments

The increment is not a new bundle path. It is the existing argument set plus basis negations.
Today the dir/all argument set is decided at `src/engine/git/capture.ts:227-237`:

```ts
const decision = decideDirBundleAllArgs(...);
const bundleArgs =
  ctx.kind === "dir"
    ? [...dirAllArgs!, ...(refs["refs/stash"] ? ["refs/stash"] : []), ...pins.refs]
    : [...Object.keys(refs), ...pins.refs];
```

v2 threads `^<basisTip>` through that path:

- **Dir/all sections:** `--single-worktree --all ^<basisTip1> ^<basisTip2> ...` plus the existing
  positive `refs/stash` and scratch-pin refs. `--single-worktree --all` is the design-68 invariant
  that keeps detached linked-worktree HEADs out of the main bundle while still carrying branches
  checked out in worktrees (`docs/design/68-worktree-git-sync.md:54-59`).
- **Pointer/scoped sections:** the scoped positive refs plus `^basis...`, with scratch pins
  unchanged. If the pointer is detached and has no scoped refs, the detached `HEAD` sha in
  `basis.tips` is what makes the next increment valid; no basis means full bundle.
- **Ancient git:** no new branch. `decideDirBundleAllArgs` already returns
  `["--single-worktree", "--all"]`, falls back to `["--all"]` only when no live linked worktrees
  exist, or defers when linked worktrees require `--single-worktree`
  (`src/engine/git/capture.ts:51-58`, `src/engine/git/capture.ts:227-232`). Chains compose with
  whichever argument set that decision returns.

Scratch pins, WIP commits from `git stash create`, pseudo-ref commits, index/op-state artifact
capture, and convergent encryption are unchanged. We shrink the bundle plaintext; we do not make
increment ciphertext dedup.

## 4. Cost model and compaction

`MAX_PACK_CHAIN = 8`. Validation rejects any section requiring more than eight bundle links total
(`packChain.length + 1 > MAX_PACK_CHAIN`), and capture recompacts before publishing a candidate
that would exceed the bound.

The byte trigger is over increment links only:

```ts
incrementBytes =
  sum(candidate.packChain.slice(1).map((l) => l.cipherSize)) +
  candidate.bundleCipherSize;

if (incrementBytes >= candidate.packChain[0].cipherSize) recompactFull();
```

`packChain[0]` is the base full bundle and is excluded from the numerator. Its cipher size is a
drifting conservative proxy for "what a new full bundle would cost"; history grows, so the old base
can be smaller than a fresh full bundle, which makes the trigger recompact earlier rather than
letting chains grow too long.

### 4.1 In-tree layout: one hot dir/all section

Before chains, the measured shape was:

```text
286 recaptures/night × 68 MB full dir/all bundle ≈ 19.0 GiB/night
```

With chains, the initial full bundle or any recompaction is still about 68 MB, but ordinary agent
commits publish one increment whose size is proportional to new objects and pins. The hard fresh-join
apply cost for the hot repo is at most eight bundle links, not 286 historical full bundles. The
length-only worst case forces a full bundle roughly every eighth link; the byte trigger usually
fires sooner if deltas are large. This is why v2 targets the main clone's dir/all section first:
design 68 already removed the redundant in-tree pointer captures by base-carrying them.

### 4.2 Out-of-tree layout: independent scoped chains

For standalone workspace-dir clones, each captured repo keeps its own chain:

```text
N repos × one first full branch-history bundle
  + N independent streams of O(delta) increments
  + per-repo recompaction when length or byte caps fire
```

There is no shared basis across those repos. The old v1 improvement remains valid for this layout,
but it is no longer the primary cost story. Cross-repo or per-origin shared bases would reopen the
per-repo defer, 422, removal, conflict, and GC independence that design 43 established, and remain
out of scope.

### 4.3 Fresh join and stall bounds

Design 71's stress shape is roughly 140 repos; the review's fresh-join bound used 121 chained repos.
At `MAX_PACK_CHAIN = 8`, a fresh receiver imports at most:

```text
121 repos × 8 links = 968 bundle fetch/verify/import steps
```

That is intentional: small enough to test and reason about, and far below an unbounded gcrypt-style
append list. The same cap bounds the receiver missing-link stall in sender capture cycles: if a
receiver cannot fetch a link, it records `gitPendingRemote` and retries later; it heals when the
sender's own length cap, byte cap, or 422 force emits a full bundle. There is no receiver→sender
"please recompact" channel. If the sender never captures that repo again, the receiver remains
honestly pending; preserving per-repo independence is worth that bounded, visible stall behavior.

## 5. Apply, presence skips, and conflict preserve

The existing apply path downloads one bundle and verifies it before mutation
(`src/engine/git/apply.ts:203-236`), then imports it into an apply-unique namespace with a non-forced
refspec (`src/engine/git/apply.ts:292-300`) and publishes filtered refs/HEAD/index/op-state under
the existing rollback rules (`src/engine/git/apply.ts:307-347`). Chained sections replace only the
"get and import bundle" helper.

The helper operates over `packChain` plus the section's own bundle:

1. Unchained full-bundle sections, including schema-2 sections and schema-3 full recaptures, do a
   straight fetch/decrypt/verify/import of the section bundle with no presence probes.
2. Chained sections run presence-skip only for historical `packChain` links. For each historical
   link, run `git cat-file -e <tip>^{commit}` for each recorded `link.tips` value. If every tip is
   already present, skip fetch and import for that historical link.
3. The newest link, the section's own bundle, is never skipped. It carries the current section's
   WIP/index/op-state object closure, whose scratch-pin objects are not visible in recorded commit
   tips.
4. If a link is not skipped, fetch/decrypt the artifact with `getGitArtifact`
   (`src/engine/git/shared.ts` exports it; callers already use it from apply and conflict preserve),
   run `git bundle verify` after all ancestor links have been imported, then fetch the bundle with:

   ```text
   git fetch --no-tags <bundle> '+refs/*:<incomingNs>/*'
   ```

   The `+` is mandatory. The incoming namespace is scratch; a later increment that rewrites a ref
   the base created must win. Non-fast-forward refusal in scratch refs is not an integrity boundary.
   Integrity comes from decrypt/plaintext-sha verification, per-link `git bundle verify` after
   ancestors are present, and the final design-68 publish/filter/collision rules.

For existing targets, this chain helper runs before `beforeMutate`, preserving the current
decrypt-before-mutate guarantee. For fresh targets, apply may create a removable `git init` target
after artifact decrypt so there is an object store to verify/fetch into; any chain failure removes
the `.git` it created, matching the current fresh-target fail-closed behavior.

Conflict preservation must use the same helper. Today `preserveGitConflict` fetches/verifies only
`section.bundle*` and copies that one bundle to `.rbox/git-conflicts`
(`src/engine/git/quarantine.ts:82-99`). Under v2, a conflict copy of a chained section must
materialize identically to a normal apply: fetch/verify/import the whole chain with the same
presence skip, then preserve a recovery bundle or namespace that contains the remote tips. A
conflict path that preserves only the newest increment is invalid because that increment's
prerequisites may exist only in earlier links.

## 6. Failure, 422, refs, and GC

Every failure degrades to a full bundle or a design-43 defer. No increment path is a new correctness
dependency.

| Failure | Detection | Behavior |
|---|---|---|
| No usable base or empty basis tips | capture planning | Omit `opts.basis`; emit full bundle; no `packChain`. |
| `git bundle create` with basis fails | capture | Retry/degrade as full bundle; if full capture also fails, existing per-repo defer/base-carry applies. |
| Recompaction length or byte trigger fires | capture planning | Omit basis; emit full bundle; chain reset. |
| 422 reports a missing git chain blob | push commit returns `unsatisfiedBlobs` | `sectionEncShas` must include every chain link encSha; `gitForceForMissingBlobs` then forces exactly those repos (`src/cli/sync-git.ts:439-444`). Forced capture omits basis and emits full bundle. |
| Receiver missing/corrupt chain link | `getGitArtifact`, plaintext sha, bundle verify, or forced fetch fails | `applyGitState` returns `{applied:false}` with target untouched; `applyGitSections` records `gitPendingRemote` and retries (`src/cli/sync-git.ts:925-978`). Heal waits for sender recompaction; no receiver signal channel exists. |
| Sender rewrites history between links | next capture changes identity | Increment is still valid: old basis objects are prerequisites from earlier links, fetch uses forced scratch refs, and final publish moves refs under existing rules. Large rewrites grow toward the byte trigger. |
| Busy/defer/needsResolution/removal/policy skip | design-43/design-68/design-72 state machine | Carry the section verbatim; `packChain` does not grow unless capture runs. Removal drops the whole section; retention ages old links out. |

Design 71 changes the accounting math. `blobRefsForManifest` currently adds git bundle, index, and
op-state encShas through the `addGit` helper (`src/cli/e2ee-remote.ts:51-66`; invoked during commit
at `src/cli/e2ee-remote.ts:367-378`). v2 must add every `packChain[i].encSha` through the same
helper. That is both a quota/entitlement requirement and the GC root: if a live chain link is not in
blobRefs, retention/GC can reclaim it.

The ref-count impact is small against design 71. At the stress scale:

```text
≤8 extra chain refs × ~140 repos ≈ 1.1k refs
```

That is negligible against the 250k ref cap in design 71 §3.2
(`docs/design/71-refs-at-scale.md:91-103`). It does grow the signed refset and the GC roots walk by
the same count; design 71 already names GC/roots-at-scale as a deferred item
(`docs/design/71-refs-at-scale.md:136-143`), and this is within that budget.

422 recovery must use design-71 paging language. Missing lists are capped at 10,000 shas plus
`missingTotal` (`docs/design/71-refs-at-scale.md:105-111`; current clients surface
`missingTotal` at `src/cli/remote/commits.ts:73-75` and `src/cli/remote/commits.ts:145-147`).
`gitForceForMissingBlobs` only sees the returned page, so any returned encSha matching any chain
link is enough to force a full recapture of that repo. The retry will re-run missing checks; it must
never build another increment against a basis the server just proved incomplete.

## 7. Rollout and build trigger

This ships default-on whenever a repo qualifies for incremental capture; `git.incremental: false`
is the local escape hatch for full-bundle recaptures. The first chained capture flips the manifest
to schema 3, so older clients reject the workspace until upgraded by deliberate clean-break rule
rather than silently corrupting chained sections.

The build trigger is measured steady-state re-upload, not first-clone volume:

- in-tree layout: repeated full uploads of the same dir/all section, like the 286 × 68 MB/night
  churn shape;
- out-of-tree layout: repeated scoped full-history uploads across standalone worktree dirs;
- not a trigger: one-time hydration or first capture, which this design intentionally does not
  solve with shared bases.

## 8. Verification additions

Add the existing v1 tests plus these v2 gates:

- **Argument construction:** dir/all increments are the design-68 `decideDirBundleAllArgs` output
  plus basis negations; stash and scratch pins remain positive. Pointer/scoped increments use
  scoped positives plus basis negations. Ancient-git fallback/defer behavior is unchanged.
- **Detached scoped basis:** a pointer section with `refs: {}` and detached `HEAD` extends from the
  pinned head sha; empty basis emits a full bundle.
- **Schema validation:** `KNOWN_MANIFEST_SCHEMA = 3`; `validateManifest` rejects `packChain` under
  schema <3; `validateGitSection` validates link shape/tips/length but does not inspect schema.
- **Multi-repo fresh join:** N chained repos apply on a fresh receiver with subprocess work bounded
  by `N × MAX_PACK_CHAIN`; a second apply presence-skips historical links but still imports each
  section's newest bundle to preserve current WIP/index/op-state closure.
- **Rewritten-ref chain:** force-push or rebase between links reproduces the non-fast-forward
  scratch-ref blocker; forced refspecs import the later link and final publish lands the rewritten
  tip.
- **Conflict preserve:** local divergence on a chained remote section preserves a complete recovery
  artifact/namespace, not only the newest increment.
- **422 chain link:** missing `packChain[i].encSha` appears in a bounded missing page, forces that
  repo, and the forced recapture emits a full bundle.
- **Compaction:** length cap at eight total links; byte cap sums only increments
  (`packChain[1..]` plus newest bundle) against `packChain[0].cipherSize`.
- **Rig scenario:** extend the two-device live rig with one chained repo and the savvy-core-like
  churn shape; assert before/after cycle time and upload bytes improve from the 286 × 68 MB full
  reupload pattern to full-on-base/recompaction plus O(delta) increments.

## 9. Invariants kept from v1

- Per-repo independence stays. No shared basis across repos or worktrees.
- Every capture/apply uncertainty degrades to a full bundle or a design-43 per-repo defer.
- Per-link verify-after-ancestors ordering is mandatory; v1 got this right.
- The correct orchestration file is `src/cli/sync-git.ts`, not the old
  `src/engine/git/sync-git.ts` path. Current push planning, force recapture, conflict preserve
  calls, and apply loop citations in this document use the current tree.
