# 224 — Ignore-plane stranded bytes: the index-less repo defeats every ignore rule

Status: **SELF-CERTIFIED FOR IMPLEMENTATION** (round 3 of a hard 3-round cap
folded; no round 4).
Branch: `fix/ignore-plane-quota-bloat`

Three small things: a tracked-repo availability taxonomy split (§2.1), a
directory-form check at the two symlink producers (§2.2), and returning a value
already computed (§2.3). Every round-3 remedy REMOVED mechanism — §5 is the
provenance record for what was proposed and killed along the way.

**Every file:line in this document was re-verified against the worktree on
2026-07-29.** All paths are fully prefixed from the repo root.

## 0. Level-set — what "helped" means for this cycle

**Helped (falsifiable):** after this lands, a workspace containing a git repo
with no `.git/index` no longer syncs that repo's `node_modules`, `venv`,
`__pycache__`, `.env`, `*.pem`, or any other builtin-ignored path. The
reproduction in §3.1 fails today and passes after. Second: `rbox status` reports
how many already-synced entries are stranded behind the ignore plane, on daemon
and computed hosts alike, by default, at zero added cost.

**This cycle recovers zero bytes** (ruling F2). Purging frees nothing until
retention expiry (Pro = 365 days; nothing the founder holds ages out before
mid-2027). The value is PREVENTION — stopping new workspaces, and every future
user, from accumulating this. Any claim of byte recovery in this doc is a bug in
this doc.

**What could get worse:**
- Widening an ignore predicate silently un-syncs a path a user legitimately
  holds today. Silent un-syncing is worse than over-syncing. §3.2's negative
  twins are the guard, and they are why §2.2 fixes the symlink case at the two
  producers rather than by relaxing the rule set itself.
- Relaxing the tracked-path predicate on the wrong plane deletes user data.
  §2.1 relaxes it only for a positively-identified case (git answered, the index
  is genuinely ENOENT, and the repo has no commits) and leaves every ambiguous
  case fail-open.
- **Residual, stated honestly: the existing strand persists.** This cycle makes
  it VISIBLE (§2.3) and stops new ones (§2.1, §2.2). It does not remove the
  31,828 entries already in the base manifest. Those come out only through an
  explicit `rbox ignore --purge`, with its confirmation ceremony and its
  mass-delete breaker, run by a human.

## 1. Problem

### 1.1 Root cause — a repo with `.git/` but no `.git/index` fails OPEN into the sync plane

`git init` with nothing ever added produces a `.git/` directory with no `index`
file. Every path in such a subtree becomes "possibly tracked", and "possibly
tracked" currently *un-ignores*. Verified chain:

1. **The repo is classified unavailable.** `loadTrackedRepoSet`
   (`src/engine/ignore.ts:669-686`): `git rev-parse --git-path index` succeeds
   (git prints the path whether or not the file exists — verified exit 0,
   `.git/index`, in a freshly `git init`ed dir), then `safeStat(resolvedIndex)`
   returns undefined → `unavailable()` → `available: false`, `known: true`.
2. **Unavailable means "possibly tracked", which means tracked.** `isTracked`
   (`:460-471`) is `if (!repo.available) return true;` at `:467`;
   `dirMayContainTrackedPath` (`:473-487`) has the same shape at `:478-480`, and
   `prunes` (`:516-529`) consults it at `:523` and returns false — so directory
   pruning is disabled for the whole subtree and the walker descends into
   `node_modules`.
3. **A tracked path un-ignores.** `ignores` (`:502-514`) has two routes: `:510`
   `protectTrackedPaths` (purge-only — `src/cli/sync/policy.ts:114`,
   `src/cli/ignore-cmd.ts:128`), and the live one at `:511`,
   `respectGitignore && decision.source === ".gitignore" && tracked`. The
   founder's Mac has `respectGitignore: true`, and each project's own nested
   `.gitignore` names `node_modules/`, which makes `fullDecision` (`:489-500`)
   restamp the decision `source: ".gitignore"` at `:496` even though
   `BUILTIN_IGNORE` matched first. Result: scanned, hashed, encrypted, uploaded,
   billed, and — because the entry now lives in the base manifest — carried
   forever.

**Field evidence (founder Mac, 2026-07-29).** 6 of 328 subtrees have this exact
shape (`.git` present, `index` MISSING, `HEAD` unresolvable, `node_modules` on
disk), accounting for **31,828 stranded manifest entries**: transaction-analyzer
11,108; dev-server-menubar-monitor 6,314; faceswap-video-api 5,511; LLM-brain
3,530; twitter-list-adder 3,096; proof-of-concepts 2,269. The other **319
subtrees have ZERO ignored entries.** The distribution is not long-tailed; it is
six point sources.

**Not node_modules-specific.** The same subtrees stranded `venv/` (1,195),
`__pycache__/` (894), `.wrangler/`, `.DS_Store`, `*.pem`, `*.sqlite`, and
**2 real `.env` files**. The secrets patterns that `BUILTIN_IGNORE` exists to
enforce (`src/engine/ignore.ts:77-85`) were bypassed by the same predicate. This
is a confidentiality defect, not only a quota one.

**Contrast — the feature works.** `Personal/notes` is a healthy repo that
genuinely commits 12 files under `node_modules`; rbox syncs exactly those 12 and
nothing else. The tracked-path override is correct behaviour. Only its
*unavailable* branch is inverted.

**Accounting is correct.** `used_bytes` equals `SUM(size_bytes)` over
`blob_refs ⋈ blobs` exactly, for every account (verified by query). This was
never a metering bug. Every charged byte is a real, entitled blob.

### 1.2 Demoted — trailing-slash builtin patterns do not match symlinks

Every `BUILTIN_IGNORE` entry except `.git` and the file/secret patterns carries a
trailing slash (`src/engine/ignore.ts:12-93`). In gitignore semantics a trailing
slash matches directories only, and a symlink is not a directory. So a symlink
named `node_modules` is synced. Faithful to git; not what rbox means.

**This is hygiene, not cost.** A symlink manifest entry stores only the target
string and the linked tree is never traversed (`src/engine/manifest.ts:595-612` —
the `child.type === "symlink"` arm reads the link, emits
`size: Buffer.byteLength(target)`, and does not recurse); E2EE ref building skips
non-file entries (`src/cli/e2ee-remote.ts:144`). Measured in the founder's
manifest: **3 `node_modules` symlink entries = 178 BYTES**; **all 301 symlinks
together = 11.1 KB**. Round 0 implied this explained the quota; it does not.
Still worth fixing — founder ruling F1 requires the builtin list to work on
symlinks across every ecosystem, and §2.2 does that in two lines.

### 1.3 The forward-carry is correct, invisible, and stays exactly as it is

`projectLocalManifest` (`src/cli/local-file-projection.ts:19-27`): a base entry
absent from the fresh scan and matched by `matcher.ignores()` at `:22` is
re-appended to the push candidate, so it never becomes a delete. This runs before
`diffManifests` (`src/cli/sync/publish-candidate.ts:234`).

The semantic is intentional and documented (`src/cli/ignore-cmd.ts` prints
"forward-only: already-synced matches keep their last copy on other machines and
stop syncing"). Without it, adding one ignore line mass-deletes fleet-wide.
**This design does not change it at all** — not for user rules, not for builtin
ones.

The consequence is that the strand is invisible: the daemon filters ignored
deletes out of publishable divergence (`src/cli/daemon/daemon.ts:1401`) and out
of its persisted local snapshot (`:2288`), and
`src/cli/status-projection.ts:365` applies the same filter to `counts.deleted`.
§2.3 is the answer — make it visible, leave the carry alone.

## 2. Mechanism

Nothing here changes the forward-carry, the mass-delete breaker, or the purge
ceremony.

### 2.1 Fix the tracked-repo availability taxonomy

An index-less repo with no commits does not have an *unknown* tracked set — it
has an *empty* one. `git init` with nothing added tracks zero files. The taxonomy
in `loadTrackedRepoSet` (`src/engine/ignore.ts:669-686`) is what is wrong; the
predicates that read it are fine. Two outcomes replace today's single
`unavailable()`:

| case | condition | result |
|---|---|---|
| `indexAbsent` | ALL THREE: (a) `git rev-parse --git-path index` returned **status 0** with a non-empty path; (b) `stat()` on the resolved path failed with **`ENOENT` specifically**; (c) `git rev-parse --quiet --verify HEAD` **FAILED** (unborn branch — no commits) | `available: true`, `paths: ∅`, `dirPrefixes: ∅` |
| `indexUnreadable` | anything else — non-zero or `null` git exit status, empty output, any other stat errno (`EACCES`, `ELOOP`, `EIO`, …), **a resolvable `HEAD`**, corrupt tracked-set cache (`:679`), or `git ls-files` failure (`:682`) | today's `available: false` (unchanged fail-open) |

**Why the HEAD signal is mandatory (round-3 finding T2 — a purge-plane data-loss
hole in this section's own round-2 form).** `git ls-files --cached` reads the
index, so "never committed" and "index deleted from a repo that HAS commits" both
yield ∅ — but the second has a genuinely non-empty tracked set. Without (c) that
repo becomes `available: true, paths: ∅`, so `unevaluatedGitRepoForPath`
(`:539-547`, skip at `:543`) passes over it, the purge refusal at
`src/cli/ignore-cmd.ts:144-149` never fires, and `rbox ignore --purge` deletes
genuinely-committed files fleet-wide. That is the `Personal/notes` shape with a
missing index. Ordinary push stays benign (§1.3's carry); purge does not, and
un-blocking purge for these subtrees is an explicit goal here. The signal is
field-supported and cheap: all six founder subtrees measured `HEAD: NONE`
alongside `index: MISSING` (verified 2026-07-29 — `git -C <dir> rev-parse --short
HEAD` returns `fatal: Needed a single revision`), at one extra spawn per
index-less repo, 6 of 328 in the worst real workspace we have.

Every ambiguous outcome falls into `indexUnreadable` and keeps today's
conservative behaviour. This one change fixes the whole chain, because everything
downstream already reads `available` correctly:

- `isTracked` (`:460-471`) → `repo.paths.has(local)` on an empty set → `false`.
  The `:511` un-ignore route no longer fires. **The ignores plane is fixed.**
- `dirMayContainTrackedPath` (`:473-487`) → empty `dirPrefixes` → `false`, so
  `prunes` at `:523` no longer disables pruning. **The prunes plane is fixed** —
  the walker never descends into `node_modules`, so the scan cost goes away too.
  No change to this function.
- `unevaluatedGitRepoForPath` (`:539-547`) skips available repos, so a
  commit-less index-less repo no longer blocks `rbox ignore --purge`.
- `matcher.tracked` (`:549`) and `opts.protectTrackedPaths` are untouched: a
  genuinely unreadable repo still protects its paths from purge deletion.

**Required plumbing.** `safeStat` (`:704-710`) swallows the errno in a bare
`catch`; it must return the errno (or a discriminated result) so `ENOENT` is
distinguishable from `EACCES`. That is the only helper that changes — the HEAD
probe is an ordinary `gitOutput` call. `gitOutput` itself (`:712-716`) needs no
errno awareness: `indexAbsent` requires `status === 0` on the `--git-path` probe,
so every spawn failure already funnels into `indexUnreadable` via the existing
`res.status !== 0` test, and a failed HEAD probe for any reason is the
conservative direction for signal (c).

**Inherited gap, not widened.** `git rev-parse --git-path index` run in a
directory whose own `.git` is gone but which sits inside an OUTER repo resolves
the outer repo's index — yielding the outer repo's tracked set stamped as this
repo's, `available: true`. The taxonomy only reclassifies the git-succeeded +
index-ENOENT + unborn-HEAD case, so the mis-attribution is pre-existing and
unwidened; §4 records it. A containment check on the resolved index path is NOT
the fix: linked worktrees legitimately resolve their index under the main repo's
`.git/worktrees/<name>/` — git's documented layout, corroborated
**behaviourally** by `src/engine/ignore.test.ts:420-443` (which asserts
per-worktree tracked verdicts and never inspects the directory itself), so
evidence, not proof.

### 2.2 A symlink is ignored iff the same-named directory is

**The rule.** A symlink is ignored iff a directory of the same name would be
ignored. That is founder ruling F1 exactly, and it is what a symlinked
`node_modules` / `cdk.out` / `.venv` actually means. `IgnoreMatcher` keeps its
signature and `BUILTIN_IGNORE` is unchanged; the whole change is at the two
producers that already know the type.

| site | today | change |
|---|---|---|
| `src/engine/manifest.ts:595-596` — the full-scan symlink arm | `if (… ctx.matcher.ignores(childRel)) continue;` | also test the directory form: `… ignores(childRel) \|\| … ignores(`${childRel}/`)` |
| `src/engine/manifest.ts:373` + `:415-430` — the incremental `add`/`change` arm | `if (matcher.ignores(rel)) continue;` runs BEFORE the type is known; `statHashEntry` lstats afterwards and emits a symlink entry at `:430` | after `statHashEntry` returns, drop the result when `res.entry.type === "symlink" && matcher.ignores(`${rel}/`)` |

The second site is a round-3 discovery and the one qualification on this
mechanism: a Parcel event carries no file-vs-symlink fact, so the pre-stat check
at `:373` cannot answer it. The `unlink` arm (`:288-299`) re-derives through the
same `statHashEntry` and takes the same guard; `addDir` (`:365-366`) already
tests the directory form and then recurses through `runWalk` into the `:595`
site, so it needs nothing. Test 10 pins full-scan and incremental agreement.
`src/engine/manifest.ts:613-614` (the file arm) is **unchanged** — a regular file
named `dist` still syncs, which is the point of R1. Negations need no special
handling: `!dist` and `!dist/` behave for a symlink exactly as for a real
directory, same matcher and same rule set on the same string.

**What this deliberately gives up, as a decision and not an oversight.**
`matcher.ignores("path/to/node_modules")` still returns false for the bare
symlink form, so `rbox ignore --purge` will not remove an ALREADY-STRANDED
symlink entry and §2.3's count will not include one. Measured cost: **3 entries,
178 bytes** in the founder's manifest; all 301 symlinks of every kind total
11.1 KB (§1.2 — symlink entries are target-string-sized and never recurse).
Paying a matcher API change, a daemon-facade change, three watcher call sites, an
unknown-type default, and a facade-identity test to reclaim 178 bytes is the
wrong trade. Ingress is what mattered, and ingress is what these two lines close.

**`.rbox/` nested case (R4).** Round 0 claimed `isHardExcluded` covered nested
`.rbox` symlinks. That is **factually wrong**: `isHardExcluded` (`:316-320`) is
`p === ".rbox" || p.startsWith(".rbox/")` at `:318` — root anchored — while the
`.git` clause at `:319` *is* nested-aware (`p.endsWith("/.git") ||
p.includes("/.git/")`). Fix: give `.rbox` the same nested clauses as `.git`. A
nested `.rbox` directory or symlink is never user content.

**`vendor/bundle` (R12)** is a multi-segment root-anchored pattern (`:35`) and
has never matched a nested Ruby project. It stays as-is. If anyone later splits
`BUILTIN_IGNORE` into a bare-name list, it must be named as an explicit literal —
it has no slot in a slash-suffixed spread of bare names and would silently vanish
(finding T5). **`HARD_PRUNE_DIRS` is NOT derived from any such list** (R10): it
encodes a strictly stronger property — "pure directory excludes with no negation
counterpart anywhere in the rule set" (documented at `:95-108`, declared at
`:109`) — contains `.git` and `.rbox`, which are hard-excludes and not
regenerable trees, and `ALWAYS_NATIVE_PRUNE` (`:150`) depends on those specific
members. Hand-maintained literal, guarded by drift test 15.

### 2.3 Detector — read the set the projection ALREADY computes

`src/cli/local-file-projection.ts:22` already builds

```ts
const ignoredBase = base.files.filter((entry) => !present.has(entry.path) && matcher.ignores(entry.path));
```

and the scanner never emits an ignored path (`src/engine/manifest.ts:293`,
`:373`, `:596`, `:614` all `continue`/`delete` on an ignore match), so
`present.has(p) && matcher.ignores(p)` is unreachable. `ignoredBase` is therefore
EXACTLY "base-manifest entries the matcher ignores" — the stranded set. There is
nothing to sweep.

- `projectLocalManifest` returns the ignored-base entries (and hence their count)
  alongside `manifest` and `caseCollisions`. Compute `ignoredBase`
  unconditionally — today it sits inside `if (!purgeIgnored)` (`:20`) — and use
  it for the carry only when `!purgeIgnored`, so the return is total. **Zero
  added matcher calls on the ordinary path**; on the purge path it duplicates a
  filter `src/cli/ignore-cmd.ts:150` already performs, which the purge preview
  can then reuse instead of refiltering.
- **Computed status branch.** `src/cli/status-projection.ts:355` already calls it
  with the workspace matcher built at `:341-342`. Read the returned count. 0 ms.
- **Daemon branch.** `src/cli/sync/publish-candidate.ts:234` calls the same
  function on every push with the workspace's real matcher from `matcherForState`
  (`src/cli/sync/policy.ts:110-116`). The count rides back through the existing
  `recordProjection` seam (`src/cli/sync/publish-candidate.ts:45-48`, impl
  `src/cli/sync/push.ts:625`), is held by the daemon, and is emitted from
  `localSnapshot` (`src/cli/daemon/daemon.ts:2277-2291`) into
  `DaemonActivity["local"]` (`src/cli/activity.ts:54-64`) as a new **optional**
  `uint`, validated in `loadActivity` beside the existing whitelist (`:127-150`).
  `rbox status` reads a number. 0 ms on the branch whose entire purpose is an
  instant response. Optional, and `sourceVersion` stays `1`: an older daemon
  omits it, a daemon that has not pushed since start omits it, and a 422 reupload
  (`local.projected === true`, `src/cli/sync/publish-candidate.ts:233`) leaves the
  previous value standing. Absent → key omitted. No version bump.
- **Staleness needs no new mechanism.** The daemon number is as of that daemon's
  last projection, and `counts.source === "daemon"` + `ageMs`
  (`src/cli/status-contract.ts:131-133`) is already how status says "snapshot,
  not live computation". It carries this field too.
- **Populate branch** (`src/cli/status-projection.ts:318-339`) needs nothing: it
  is selected by `state.lastSyncedSequence === 0` (`:255`) — empty base, so 0.

**Ships default-ON with no kill switch.** At 0 ms there is no cost argument for
staging it, and a number nobody sees by default defeats the detector. Both
branches use `cfg.respectGitignore`, so test 14 asserts EQUALITY rather than a
direction hedge.

Constraints on the reported value:

- **Byte basis.** Report **entry count only.** `cipherSize ?? size` is neither
  the billed nor the reclaimable quantity (R7): `blob_refs` dedupe by `encSha`
  and exclude symlinks (`src/cli/e2ee-remote.ts:144`), so summing per-entry sizes
  double-counts shared blobs and cannot predict any quota delta. A byte number
  here would be a fabricated recovery claim, which ruling F2 forbids.
- **Contract placement.** Top-level optional on `StatusDetailProjection`
  (`src/cli/status-contract.ts:207`), not inside `StatusLocalCountsBase`
  (`:119-129`) — hanging it off `counts` entangles it with `counts.source`. JSON:
  top-level key in `renderStatusJson` (`src/cli/status-render.ts:116`),
  deliberately outside the `local` block, which is emitted only when
  `counts.source === "daemon"` (`:136`).
- **`--all` is not a route to this** (R8). `rbox status --all --json` routes to
  `runMachineTriage` (`src/cli/main-dispatch.ts:441-448`, call at `:447`) and
  never reaches `renderStatusJson`. The fleet signal is per-host
  `rbox status --json`.
- **No `decision.source` attribution.** `fullDecision`
  (`src/engine/ignore.ts:489-500`) restamps a builtin match as `".gitignore"` at
  `:496` whenever a nested `.gitignore` also names it — the common case. The
  detector reports the ignored set as a whole, never "builtin" versus "user rule".
- **Git sections are a second strand class** (R9). `src/cli/sync-git/plan.ts:907-936`
  carries a base git section forward when the repo dir is unreadable (`:917-920`),
  when discovery pruning hides it (`:930-934`), or when there is no usable `.git`
  (`:935`). Outside this count and outside `rbox ignore --purge`, which diffs only
  `state.lastSyncedManifest.files` (`src/cli/ignore-cmd.ts:140-150`). §4.

### 2.4 Purge corrections

1. `policy.massDeleteHint` is never set on the purge path, so
   `MassDeleteGuardError` (`src/cli/sync/publish-candidate.ts:352-356`) tells the
   user to run `rbox push --allow-mass-delete` — the wrong command. Set the hint.
2. `src/cli/ignore-cmd.ts:106` derives `allowMassDeletePush` from the flag only,
   while `src/cli/sync-cmd.ts:90`, `src/cli/main-dispatch.ts:358`, and
   `src/cli/recover-cmd.ts:79` also accept `RBOX_ALLOW_MASS_DELETE`. Purge is the
   outlier; make it consistent.
3. The unevaluated-repo refusal exists verbatim twice —
   `src/cli/sync/publish-candidate.ts:203-213` and `src/cli/ignore-cmd.ts:144-149`.
   Two copies of a refusal drift; extract one.

Purge preview keeps reporting a **path count only**, for the R7 reason above.

## 3. Tests the implementation MUST write

### 3.1 Root-cause reproduction (the gate for this cycle)

1. **Index-less repo does not defeat the ignore list.** Temp workspace with a
   subdir where `git init` has run and nothing has been added (no `.git/index`,
   unborn `HEAD`), holding `node_modules/x.js`, `venv/y`, and `.env`, plus a
   nested `.gitignore` naming `node_modules/`. Build with
   `respectGitignore: true`. Assert all three are ignored and the directories
   `prunes()`. **Fails today**; passes after 2.1.
2. **Healthy tracked override still works.** Same fixture with a real commit
   tracking `node_modules/keep.js`. Assert `keep.js` syncs and its untracked
   siblings do not — the `Personal/notes` shape.
3. **`indexUnreadable` still fails open.** Three fixtures: (a) a corrupt
   tracked-set cache (the shape at `src/engine/ignore.test.ts:393-418`); (b) an
   index present but `chmod 000`, so `stat` fails `EACCES` not `ENOENT`; (c) the
   round-3 purge-safety fixture — `git init`, make a real commit, then
   `rm .git/index`. `HEAD` resolves, so the repo must stay `available: false`;
   assert `ignores()` returns false and `unevaluatedGitRepoForPath` still names
   the repo so the purge refusal (`src/cli/ignore-cmd.ts:144-149`) fires. Without
   signal (c) this fixture silently authorizes purge to delete committed files.
4. **Deliberate re-expression of `src/engine/ignore.test.ts:376-391`** —
   `"missing git index fails closed for a known repo"` is exactly the
   `indexAbsent` fixture (`git init` in `repo/`, nothing added) and asserts all
   three of `unevaluatedGitRepoForPath === "repo"`, `prunes("repo/") === false`,
   `ignores("repo/file.txt") === false`. All three flip. It must be **rewritten
   deliberately** — renamed to state the new contract, asserting the inverse —
   not silently edited to match the implementation. `:465-477` (`broken/`, no
   `.git` at all → exit 128 → `indexUnreadable`) and `:393-418` do NOT change.

### 3.2 Negative twins (assert what must STILL sync)

Scanner-level tests over `scanManifest` (and `applyWatchEvents` for the
incremental arm), not matcher-API tests: §2.2 changes no matcher signature, so
`IgnoreMatcher` verdicts must be bit-identical before and after.

5. A **regular file** named `dist`, `build`, `target`, or `coverage` is still
   EMITTED by `scanManifest` — the R1 regression.
6. A `.rboxignore` `!dist` **and** `!dist/` each re-include a `dist` SYMLINK,
   exactly as they re-include a `dist` directory (R3).
7. Directories named `.vscode`, `.idea`, `wandb`, `mlruns`, `Pods`, `vendor`,
   `.yarn` still sync — the deliberate exclusions named in `BUILTIN_IGNORE`'s
   comment (`src/engine/ignore.ts:36-42`). Coverage today is PARTIAL:
   `src/engine/ignore.test.ts:222` exercises `Pods`, `vendor`, `.vscode`, and
   `wandb` only — `.idea`, `mlruns`, and `.yarn` appear nowhere in that file.
   This test must add those three.
8. **`IgnoreMatcher` verdicts are unchanged** — the existing ignore suite passes
   untouched and no test needs a new argument.

### 3.3 Positive coverage

9. **Symlink at any depth is not emitted by a full scan** — a real on-disk
   symlink named `node_modules`, `dist`, `.venv` at root, nested one deep, and
   nested inside another ignored tree, asserted against `scanManifest` output.
   `src/engine/ignore.test.ts` has **no** symlink test today; use
   `await fs.symlink(target, linkPath)` with relative targets (the convention in
   `src/engine/darwin-bulk-walk.test.ts:82-84`).
10. **Incremental arm agrees with the full scan.** Drive `applyWatchEvents` with
    an `add` for a newly created symlink named `node_modules`; assert it does not
    enter the map (the `statHashEntry` post-stat guard,
    `src/engine/manifest.ts:373` + `:415-430`), then full-scan the same tree and
    assert an identical file set.
11. **Directory behaviour unchanged** — a real directory with the name is still
    `prunes()`d, not merely `ignores()`d.
12. **Nested `.rbox` is hard-excluded** — `a/b/.rbox` as directory and as
    symlink, non-overridably, plus the root assertions at
    `src/engine/ignore.test.ts:22-46`.
13. **Forward-carry is unchanged.** A base entry absent from disk and matched by
    the matcher is still CARRIED, not deleted — for a builtin-only match AND a
    `.rboxignore` match. It must fail if anyone reintroduces a de-carry.
    `src/cli/local-file-projection.ts` has **no coverage of the carry at all**
    today: the one existing call, `src/cli/sync/sync.test.ts:66-85`, is a DIRECT
    call passing an empty base and a stub `{ ignores: () => false }` to exercise
    case-fold collisions, so the carry branch (`:20-27`) never executes. Create a
    dedicated test file.
14. **Stranded count: daemon and computed AGREE.** One base manifest holding a
    strand visible only through a nested `.gitignore` plus one visible to the
    builtin list. Drive the computed branch (`src/cli/status-projection.ts:355`)
    and the push-time producer (`src/cli/sync/publish-candidate.ts:234`) over the
    same base with the same `cfg.respectGitignore`; assert the counts are
    **EQUAL** and both strands appear in both. Also assert the field survives
    outside the `local` JSON block, and that an `activity.json` lacking it still
    validates in `loadActivity` and omits the key. (Scope-projected bindings can
    hand the two sides different BASE manifests — design 212 §3.2; equality is
    claimed over the same base, not across scopes.)
15. **`HARD_PRUNE_DIRS` drift guard** — every entry is a bare directory name
    present in `BUILTIN_IGNORE`, `vendor/bundle/` is still present however
    `BUILTIN_IGNORE` is composed, and the existing watcher-safety tests
    (`src/engine/ignore.test.ts:122-186`) still pass.
16. **Purge honors `RBOX_ALLOW_MASS_DELETE`** (env-var table style of
    `src/cli/sync/push-mass-delete.test.ts:34-38`), and the purge-path
    `MassDeleteGuardError` message does not tell the user to run `rbox push`.
    `src/cli/ignore-cmd.test.ts` (35 lines, one test) has no `purgeIgnored` test
    at all.

Conventions: real temp dirs plus a real `git` subprocess with `try/finally`
cleanup (`src/engine/ignore.test.ts:241-242` for the fixture helpers, `:376-391`
and `:465-477` for the git-subprocess shape); manifest-level symlink fixtures via
`localEntry(path, content, "symlink")` (`src/cli/sync/sync.test.ts:56-64`).

## 4. Non-goals and known gaps

- **No byte recovery is claimed** (F2). rbox will bill on active bytes only;
  history is never charged. That is a separate track and is currently blocked:
  the fair-use scan aborts whenever head pins move mid-scan
  (`apps/api/src/fairuse.ts:961-980` → `markAbortedEpoch`, defined at `:899`,
  status `aborted_pins`). Every `fairuse_scans` row for the founder account is
  `aborted_pins` with `active_bytes = 0`.
- **The existing 31,828 strands stay** until a human runs `rbox ignore --purge`
  (a separate operation after this lands).
- **Unchanged:** retention (365 days), the billing basis, the forward-only carry,
  the mass-delete breaker (predicate `src/cli/sync/policy.ts:27-35`, 1000-delete
  floor at `:23`), and the unevaluated-git-repo purge refusal.
- **Outer-repo index mis-attribution stays a known gap** (§2.1): a directory
  whose own `.git` is gone but which sits inside a parent repo resolves the
  parent's index. Pre-existing, unwidened, not fixed here.
- **Git sections stay a known gap** (R9, §2.3): `src/cli/sync-git/plan.ts:907-936`
  carries base sections neither the count nor purge reaches. A later cycle.
- **`vendor/bundle` stays root-anchored** (R12); multi-segment patterns stay
  non-nested. **Already-stranded symlink ENTRIES stay unpurgeable** (§2.2's
  stated trade — 3 entries, 178 bytes). **No builtin-list prefilter for the
  detector**: proven unsound, finding T1; do not retry it.
- **Not adding a `device_sync_state` column.** That is a five-surface change
  (client contract, `src/cli/telemetry/sync-state.ts`, a D1 migration,
  `apps/api/src/telemetry-ingest.ts` validate + INSERT column list,
  `apps/api/src/fleet-alerts.ts`) for a number the local command already reports.

## 5. Review provenance
Review provenance for rounds 1–3 (what was proposed, what killed it, and the
three rulings an implementer must not re-litigate) lives in
`docs/design/notes/224/REVIEW-LOG.md`.
