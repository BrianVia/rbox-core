# Design 43 — Nested-Repo Git Sync (per-repo GitSections)

**Status:** v5 — four codex design rounds (v1: 5 BLOCKER/4 MAJOR; v2: 3 BLOCKER/2 MAJOR;
v3: 2 BLOCKER; v4: 1 BLOCKER/1 MAJOR — several verified with local git repros); every
resolution folded in inline, marked **[v2]…[v5]**. Full history in §14.
**Builds on:** design 02 (git-mirroring v3 — bundle-based capture/apply), §28 (git artifacts under
E2EE), PR #38 (defer-churning-files partial-progress philosophy).
**Supersedes:** the "repo toplevel === sync root" scope restriction of design 02 §3.

## 1. Problem

rbox's mission is "Dropbox for devs": point it at a **folder of projects** and everything —
including git state — follows you across machines. Today git-sync only engages when the sync
root **is** the repo (`--show-toplevel === root`), and the preflight rejects worktree/submodule
pointer files outright. The founder's real layout (`~/conductor/workspaces`: several projects
plus Conductor-managed git *worktrees* of a main clone that lives outside the tree — sometimes
deleted entirely) gets `git-sync: skipped — no .git`, and only untracked residue syncs. The
machine on the other end receives orphaned working files with no history, no branches, no
staged state.

**Goal:** every git repo *inside* the synced tree — ordinary nested repos and worktree/submodule
checkouts — transfers its git state E2EE, with design 02's guarantees intact per repo: never a
corrupt repo, never lost committed work, base-advance only on successful apply.

**Non-goals (v1):** syncing a main clone's `.git/worktrees/*` administrative linkage (worktrees
materialize as *standalone* repos on the target — see §5); incremental encrypted packs (still
the documented future optimization from §28); cross-repo dedup of bundle bytes.

## 2. Schema — `gitRepos` map, clean break

`Manifest.git?: GitSection` is **replaced** by:

```ts
interface Manifest {
  generatedAt: string;
  files: FileEntry[];
  /** manifest schema version. Absent (v1) = pre-§43. gitRepos requires >= 2. */
  manifestSchema?: number;          // 2 when gitRepos is present
  /** POSIX relPath of the repo dir (sync root = ".") → its git state. */
  gitRepos?: Record<string, GitSection>;
}
```

- `GitSection` keeps the §28 shape (bundle/index/op-state artifact refs, refs, head, indexTree;
  encrypted artifacts, blobRef charging, cipher sizes all carry over per repo) **plus one new
  field [v2, B1]:**

  ```ts
  /** Which ref semantics this section carries.
   *  "all"    — the section's refs are the repo's COMPLETE syncable ref set (dir-repo
   *             capture; design-02 semantics: apply may delete absent refs).
   *  "scoped" — the section carries only HEAD's line of work (pointer-repo capture);
   *             apply must ONLY update the listed refs, NEVER delete others. */
  refScope: "all" | "scoped";
  ```
- The root-repo case becomes `gitRepos["."]` — one code path, no special casing.
- **Clean break, stated honestly.** Pre-launch, single user; nothing in prod carries a legacy
  `git` section (the founder's only workspace has no root repo). So: the `git` field is deleted,
  no migration, no dual-format reads. New clients **refuse** manifests carrying a legacy `git`
  section (`error: workspace synced by an older rbox — re-init`) and refuse
  `manifestSchema > KNOWN_MANIFEST_SCHEMA` ("upgrade rbox"), so *future* breaks fail loudly too.
- **The stale-client hazard is real and accepted:** `validateManifest` ignores unknown fields,
  so an un-upgraded 0.5.7 client pulling a schema-2 manifest would apply files fine and then
  **silently strip `gitRepos` on its next push**. Retrofitting old binaries is impossible;
  mitigation is operational (the only deployed clients are the founder's two machines; their
  daemons are stopped for the rollout and both upgrade with the release). The `manifestSchema`
  gate makes every *future* schema break loud instead of silent — this is the last silent one.

### Validation (`validateManifest` + `validateGitSection`)

For each `gitRepos` key: `isSafeRelPath(key) || key === "."` (no `..`, no absolute, no NUL —
note `isSafeRelPath` itself rejects `"."`, hence the explicit disjunct [v2]); key must not
collide case-insensitively with another key; **a key must not equal any manifest FILE/symlink
entry's path [v2, B5]**; each value passes the existing `validateGitSection` (extended to
require `refScope ∈ {"all","scoped"}`). Bound: `MAX_GIT_REPOS = 256` (raise-on-measurement; a
loud error, not a silent drop, at the boundary — §30's lesson). The client additionally refuses
to *apply* a section whose key resolves into an **ignored** subtree (defense vs a hostile
manifest planting a repo under `node_modules/`), and enforces realpath containment at apply
time (§7 [v2, B5]) — validation-time string checks alone can't see symlinks.

## 3. Discovery — which repos sync

`discoverGitRepos(root, matcher): Promise<Array<{ relPath: string; kind: "dir" | "pointer" }>>`

- Walk the tree reusing the scan's ignore pruning (never descends into `node_modules/`, `.git/`,
  etc. — a vendored repo inside an ignored dir does not sync).
- A dir containing `.git` as a **real directory** → `kind: "dir"` (ordinary repo).
- A dir containing `.git` as a **file** (gitfile pointer: worktree or submodule checkout) →
  `kind: "pointer"`.
- Discovery does **not** stop at a repo boundary: a repo vendored inside another repo's working
  tree is discovered and captured independently (its files are already synced as plain files;
  its git state is its own).
- The walk result is capped at `MAX_GIT_REPOS`; over the cap → **newly-discovered repos beyond
  the cap are deferred (not captured, loudly logged) — but repos with an existing base entry
  are ALWAYS carried [v2, M4]**: the cap bounds capture *work*, never the manifest carry, so
  over-cap can never read as mass deletion on receivers.
- A repo under an **ignored parent** is not discoverable (the walk prunes before descent) —
  matching file behavior; re-include the parent via `.rboxignore` negation to sync it
  [v2, minor: documented semantic, no negation-aware descent in v1].

## 4. Per-repo preflight (generalizing design 02 §3)

`gitPreflight(repoDir)` — same checks, one relaxation and one split:

| Check | dir-repo | pointer-repo (worktree/submodule) |
|---|---|---|
| `--is-inside-work-tree`, not bare | keep | keep |
| `--show-toplevel === repoDir` | **relaxed:** `=== repoDir` (was `=== sync root`) | same |
| `.git` real dir | required | n/a (pointer expected) |
| `objects/info/alternates` | refuse (unchanged) | refuse if the *resolved* gitdir's object store uses alternates |
| `.git/worktrees/` present (repo is a primary with linked worktrees) | refuse (unchanged, v1) | n/a |
| `.git/modules/` present | refuse (unchanged, v1) | n/a |
| hooks never captured | unchanged | unchanged |

The resolved git directory comes from `git -C repoDir rev-parse --absolute-git-dir` — for
pointer repos this lands in the main clone's `.git/worktrees/<name>/` (or `.git/modules/…`),
and **all small-file reads (HEAD, index, op-state) use that resolved dir**, not
`repoDir/.git`. If the pointer dangles (main clone deleted — the Conductor incident), preflight
fails cleanly → that repo is skipped this cycle (reason surfaced in `rbox status`/daemon log).

**Submodule superprojects: explicitly UNSUPPORTED in v1 [v2, M1].** A dir-repo with
`.git/modules/` present stays refused (its branch/index/gitlink state does not sync), while its
submodule *checkouts* sync independently through the pointer path. This is asymmetric and
stated plainly: the v1 target is the multi-repo folder + Conductor-worktree layout;
superproject support (bundle capture that excludes module object stores) is deferred until a
real layout needs it.

## 5. Worktree/submodule capture — standalone semantics (the honest contract)

A pointer repo's git state lives in a main clone that may be outside the sync root or gone
tomorrow. So we capture it **as if it were a standalone repo**:

- **Bundle [v2, B2/B3]:** scoped to HEAD's line of work, with an explicit **object-closure
  pin**: before bundling, every commit the section will reference is pinned under a
  **capture-unique scratch namespace** `refs/rbox-wip/<captureId>/…` — the detached-HEAD sha
  (bundle `HEAD` advertisement is NOT imported by `git fetch 'refs/*:…'`, verified), the WIP
  dirty-state commit (`git stash create`), and **every pseudo-ref sha the op-state references**
  (`MERGE_HEAD`, `REBASE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `ORIG_HEAD`, rebase
  `orig-head`) — codex repro'd that `bundle create HEAD refs/heads/x` omits a `MERGE_HEAD`
  commit from another branch, which would restore a pseudo-ref pointing at a missing object.
  Then `git -C repoDir bundle create tmp.bundle refs/heads/<branch>` plus the **enumerated
  exact scratch refs** (each `refs/rbox-wip/<captureId>/<n>` listed explicitly — codex verified
  a literal `…/*` wildcard arg fails with `Refusing to create empty bundle`; `--glob=` also
  works but we know the exact refs we just created, so enumerate them) [v3]. The unique
  namespace also fixes the **shared-gitdir race**: linked worktrees share one ref store, so a
  single global `refs/rbox-wip` raced under concurrent sibling captures (B2). The namespace is
  deleted in `finally`; stale `rbox-wip/*` leftovers from crashed captures are pruned at
  capture start **age-guarded [v3]**: `captureId = <epochMs>-<rand>`, and the pruner only
  deletes entries older than 1 hour — a blind prune in a SHARED gitdir would delete a
  concurrent sibling capture's live pins. **The same pinning applies to dir-repo captures**
  (the pseudo-ref hole is latent in design 02 today — `--all` usually reaches those commits
  via a branch, but nothing guarantees it).
- **refs [v2, B1/B2]:** only `refs/heads/<current-branch>` (full ref name). **`refs/stash` is
  NOT captured for pointer repos** — codex verified it lives in the SHARED gitdir: capturing it
  per-worktree would fan one global stash stack out into N standalone repos and any divergence
  could never round-trip into the one shared ref. Stash syncs only for dir-repos ("all" scope),
  where it is genuinely repo-local. (Uncommitted dirty state still transfers — that rides the
  WIP commit + index, not the stash ref.)
- **index/op-state:** from the resolved per-worktree gitdir (`.git/worktrees/<n>/index`,
  `MERGE_HEAD`, `rebase-merge/**`, and **`AUTO_MERGE`** [v2, minor: git ≥2.38's ort writes it;
  added to `OP_STATE_FILES`]) — exactly the state that makes "continue the rebase on the other
  machine" work.
- **`refScope: "scoped"`** is stamped on the section; apply-side consequences in §7 [v2, B1].
- **On the receiving machine it materializes as a full standalone repo** (real `.git` dir,
  `git init` + bundle fetch + refs/HEAD/index/op-state publish — the *unchanged* design-02
  apply flow). The target loses worktree-ness: it is not linked to any main clone, and pushing
  upstream from it requires its own remote config. That is the accepted, documented semantic —
  the alternative (reconstructing main-clone linkage) requires the main clone to exist on the
  target, which Conductor's lifecycle explicitly does not guarantee.
- Round-trip asymmetry follows: Mac worktree → flat-meadow standalone → (edits) → Mac applies
  those edits back into the *worktree's* branch state. The identity/conflict machinery (§7)
  treats both shapes identically because identity is refs+HEAD+indexTree, not disk layout.

Capture-side implementation detail: `git stash create` (the dirty-state WIP ref trick) and
`write-tree` both work from a worktree context unchanged; the `rbox-wip` scratch ref is
namespaced per capture and deleted after, exactly as today.

## 6. Capture orchestration on push — bounded, deferred, never aborting

`captureGitForPush` generalizes to:

1. `discoverGitRepos(root, matcher)` (cheap: piggybacks on directory walk).
2. Per repo, **carry-forward check first** (unchanged fast path) — per the normative
   shape×scope matrix in §7 [v5]: matching scope + matching identity at that scope → reuse the
   base section without bundling (pointer repos may also carry a WIDER base whose scoped
   projection matches; a dir-repo with a scoped base always captures fresh). A repo with a
   pending unapplied remote section carries THAT, and is not captured (§7 [v5]). This is what
   makes N-repo scans affordable per push cycle.
3. Changed repos: `captureGitState(repoDir, …)` under **bounded concurrency**
   (`GIT_CAPTURE_CONCURRENCY = 4` — bundling is CPU/IO heavy).
4. **Churn discipline (PR #38 philosophy):** any per-repo failure — dir vanished mid-capture
   (Conductor archived it), git errored, preflight flipped — **defers that repo**: keep its
   base section if one exists (never regress a synced repo to nothing because of one bad
   cycle), or omit it if never synced. Log `git-sync: deferred <relPath>: <reason>`. The push
   itself proceeds. A repo deleted locally *on purpose* stays carried in the manifest until §9's
   removal rule applies.
5. The assembled map becomes `manifest.gitRepos`; every artifact encSha joins the commit's
   blobRefs (per §28 step 3 — now the **union** across repos; two repos referencing the same
   convergent encSha contribute one ref, which the §33 GC roots exactly once).
6. **Identity under unmerged indexes [v2, M3]:** `git write-tree` FAILS on an index with
   unmerged entries (codex repro), so `indexTree` alone would freeze the identity mid-conflict
   and staged conflict-resolution progress would never re-capture. Fallback: when `write-tree`
   fails, identity uses `raw:<sha256 of the index file bytes>` — volatile (stat refreshes can
   over-capture) but conservative: during the rare, transient unmerged window we'd rather
   re-capture than silently carry stale state.
7. **Per-repo 422 recovery [v2, M5; v3]:** when a commit bounces `unsatisfiedBlobs` containing
   git encShas, ONLY the repos whose sections reference those missing encShas are recaptured
   (`forceGitRecapture` becomes a per-relPath set, not the current boolean) — deferred/carried
   repos keep their base sections; a naive "recapture everything" would drop exactly the repos
   the defer machinery is protecting. **Non-looping failure path [v3]:** if a missing encSha
   belongs to a CARRIED repo that cannot currently recapture (deferred, ineligible, vanished),
   that repo's section is dropped from THIS commit (deferred like any churner, loudly logged)
   rather than retrying a 422 the client can never satisfy — the daemon re-captures it once the
   repo is capturable again.

## 7. Apply orchestration on pull — per-repo bases, design-02 discipline each

The pull-side git block iterates `remote.gitRepos ∪ base.gitRepos` per key:

- **Ref-publish semantics are scope-gated [v2, B1; tightened v3].** Design 02's "publish refs
  to exactly the remote set, deleting absent locals" (`git-state.ts:301`) is only sound when
  the section carries the complete ref set. Rules:
  - ref **deletion** happens ONLY when `section.refScope === "all"` AND the local repo is a
    dir-repo (both sides speak "complete set").
  - a `"scoped"` section applied into a dir-repo is **update-only**: create/update exactly the
    listed refs, never delete others. A standalone receiver's extra local branches survive a
    scoped apply; they simply don't propagate back through a worktree source (its main clone
    owns that namespace) — accepted and documented.
  - ANY section applied into a local *pointer* repo touches a ref store SHARED with sibling
    worktrees and the main clone, so it is stricter than update-only [v3; hardened v4]:
    `refs/stash` and `refs/tags/*` are FILTERED (a standalone receiver's stash/tags must never
    overwrite the shared stash stack or tag namespace), and `refs/heads/*` publication is
    **ownership-guarded**: codex repro'd that `git update-ref refs/heads/x` from one worktree
    silently moves a branch CHECKED OUT by a sibling worktree, leaving that sibling dirty
    (`git branch -f` refuses; `update-ref` does not). So the publishable set is the section's
    `refs/heads/*` entries **minus any branch checked out by a different worktree** (from
    `git worktree list --porcelain`), which in practice projects publication to the target
    worktree's own line of work. Filtered refs are logged. If the section's HEAD branch itself
    is filtered (the source switched to a branch a sibling here has checked out), the whole
    apply DEFERS with a clear reason — applying a HEAD that points at a branch we refused to
    move would be incoherent.
- **Deferred applies carry the PENDING REMOTE section outbound, never the stale base [v5].**
  Codex traced the hazard: "defer + base-doesn't-advance" alone means a later file-only push
  republishes the OLD git section over remote git state this machine hasn't applied yet —
  silently regressing the other machine's work. Rule: when an apply defers (ownership block,
  receiver busy, decrypt failure, …), the unapplied remote section is recorded as
  `gitPendingRemote[relPath]` in local state; while pending, outbound pushes CARRY that pending
  remote section for the repo (the newest known truth), capture is suppressed, and apply
  retries each pull. Pending clears on successful apply. If the LOCAL repo's identity changes
  while pending, both sides have diverged → the normal per-repo conflict path runs. A mutual
  ownership stall (each machine's section names a branch a sibling worktree holds on the other)
  is therefore a visible, stable, non-destructive standoff surfaced in `rbox status` — an
  operator condition, not data loss.
- **Identity comparison is scope-projected — with precise sides [v2, B1; fixed v3].**
  *Projection* = HEAD + the refs the narrower side carries + indexTree + opState.
  - **Pull-side** (remote section vs base section vs local): compare after projecting onto the
    NARROWER of the two scopes involved. This is what makes worktree→standalone→worktree
    round-trips converge (an unchanged branch/HEAD/index compares equal no matter how many
    extra branches the standalone side grew).
  - **Capture-side carry-forward — normative rules per shape [v3; disambiguated v4]:**
    - *dir-repo, base "all"* → carry when full identities match (design-02 semantics).
    - *dir-repo, base "scoped"* → ALWAYS capture fresh (an all-capture): codex's repro showed
      a projected comparison would otherwise hide a genuinely new local branch forever. Cost:
      one extra capture cycle after a scope-crossing apply.
    - *pointer repo, base "scoped"* → carry when scoped identities match.
    - *pointer repo, base "all"* (**the explicit wider-carry exception**) → carry when the
      base's SCOPED PROJECTION matches the local scoped identity — the pointer side's whole
      identity is contained in the wider section, so carrying it loses nothing and is what
      terminates the convergence loop.
    Convergence trace (Mac worktree W, flat-meadow standalone D): W captures scoped S1 → D
    applies update-only, base=S1 → D's next push hits *dir/scoped-base* → captures all-A1 →
    W pulls A1, projected(A1)==projected(S1) → base advances, no apply → W hits
    *pointer/all-base*, projection matches → carries A1 → quiescent. Pointer↔pointer stays
    scoped/scoped throughout (no bounce). Real change on either side re-enters and converges
    the same way.
- **remote changed vs base** (projected `gitIdentityKey` differs):
  - local repo also diverged from base → **per-repo conflict**: `preserveGitConflict(repoDir)`
    (recovery bundle + `refs/rbox-conflict/*`), checkpoint base to remote, loud log, **and mark
    the repo `needsResolution` in local state with its conflict-time local identity [v2, M2]**:
    capture SKIPS a `needsResolution` repo (carrying the checkpointed base) until its local
    identity CHANGES from the recorded conflict-time value — i.e. the user actually worked in
    it, which makes republishing intentional. Without this, `sync()`'s immediate push-after-pull
    would republished the conflicted local state right over the remote it just preserved.
  - local == base → `applyGitState(repoDir, …)` — the existing transactional flow (decrypt-all
    first, quarantine, fetch to `rbox-incoming`, publish refs per the scope rules above, fsck,
    rollback on failure) scoped to that repo dir. `git init` materializes the repo if the
    dir/`.git` doesn't exist (including the standalone materialization of a worktree-origin
    section). Deferred/failed → **that repo's base does not advance** (retry next pull); others
    advance independently. (A deferred git apply while file actions advance leaves working
    files ahead of git state until the retry lands — transient, self-healing, and internally
    coherent since the bundle is self-contained; same window design 02 ships today.)
- **remote lacks a key the base has** (§9 removal): no local mutation — never delete a local
  `.git` — the base entry is dropped and a **removal memory** is recorded (§9 [v2, B4]).
- The per-repo applied identities are folded into
  `saveState(lastSyncedManifest.gitRepos[relPath])` — base-advance-only-on-success now holds
  **per repo** instead of globally (one busy repo no longer blocks the other 16 from advancing,
  which design 02's single-section model would).
- Receiver quiescence (`gitBusy`) is checked per repo; a busy repo defers only itself.
- **Apply-time containment [v2, B5; v3]:** before `git init`/apply at `join(root, key)`, the
  resolved realpath of the target (and every parent component, `lstat`-checked so no component
  is a symlink) must be inside the root realpath — the same `assertWithinRoot` discipline file
  writes already have (`apply.ts:107`); a symlinked parent smuggled via the file manifest
  cannot redirect a repo materialization outside the workspace. The realpath is re-verified
  immediately after `git init` (cheap belt-and-braces); a *local*-attacker race between check
  and init is explicitly out of the threat model (it's the user's own machine — the manifest,
  not the local fs, is the untrusted input). A key that collides with an existing manifest
  FILE/symlink entry is rejected before any mutation.

## 8. E2EE / server surface — zero change

Artifacts remain convergent-encrypted blobs by encSha; refs/heads/paths live only inside the
encrypted manifest; blobRefs charge/GC-root every git encSha (union across repos). Repo paths
and the `gitRepos` structure ride the ciphertext; the server's view stays the §28-documented
leakage — blob counts, ciphertext sizes, and timing, from which a repo-count *lower bound* is
inferable but never paths/refs/contents [v2, nit: no over-claim]. No worker/API/D1 change of
any kind.

## 9. Repo lifecycle rules

- **New repo appears** → discovered next scan → captured → syncs. (Conductor creating a
  worktree on machine A materializes it standalone on machine B.)
- **Repo deleted locally** (dir gone or `.git` gone): the *working files*' deletion propagates
  through the ordinary file path already. For git state: if the repo dir is **gone entirely**,
  the pusher drops `gitRepos[relPath]` (with a forensic log line); receivers drop their base
  entry but **never touch local `.git`** — a receiver's materialized repo becomes untracked
  residue for the user to delete, which is the conservative choice (deleting a repo remotely
  must not destroy committed local work — design 02's prime directive outranks tidiness).
- **Resurrection guard [v2, B4; completed v3].** Codex traced the ping-pong: B's leftover local
  repo would be rediscovered as "new" on B's next push (base entry gone) and re-add the section
  A just deleted. Rule: when a receiver drops a base entry for a repo whose local `.git`
  survives, it records a **removal memory** in local state — `gitReposRemoved[relPath] =
  <local identity key at removal>`. Discovery consults it: a repo whose current identity still
  EQUALS the removal memory is **not re-added** (it's the untouched leftover); a repo whose
  identity has since CHANGED is re-added (the user did new work there — resurrection is now
  intentional). The memory is pruned when the local `.git` disappears or the repo is re-added.
  No manifest tombstones (nothing grows unboundedly, nothing new is server-visible).
  - **Fresh re-create at the same path [v3; completed v4]:** if A later creates a NEW repo at
    the deleted path and pushes a section for it, B's conflict gate treats a local repo whose
    identity still equals its removal memory as **absent** (clean apply target), not as
    diverged-from-nothing. The apply is a **clean materialization**, not an update-only merge
    into the leftover [v4] — codex traced that a scoped update-only apply would leave the
    leftover's old refs live, and B's next all-scope capture would republish the deleted repo's
    refs (resurrection through the side door). **Shape-split [v5]:**
    - *dir-repo leftover:* quarantine first — a bundle with the same HEAD/pseudo-ref pinning
      discipline as capture, PLUS copies of index/op-state (full recovery, not refs-only) —
      then DELETE its syncable refs + index/op-state (reset to empty), apply the fresh section
      at any scope, clear the memory.
    - *pointer-repo leftover:* **never ref-wipe** — its refs live in the SHARED main-clone
      store, and a wipe would delete sibling/main-clone branches, tags, or stash. Apply through
      the pointer ownership/filter rules (update-only, guarded) instead. Stale sibling branches
      that survive are NOT a resurrection vector here: a pointer repo's next capture is scoped
      (current branch only), so they never re-enter the manifest.
    (If the leftover's identity CHANGED after the memory was recorded — the user worked in a
    "removed" repo — it is NOT absent: the normal per-repo conflict path runs instead.)
- **Repo becomes ineligible** (preflight fails: turned bare, gained alternates, pointer
  dangles): treated as deferred-with-base-carry (§6.4), surfaced in `rbox status`, never
  deleted from the manifest — transient states (mid-`git gc`, mid-archive) heal themselves.

## 10. Observability

Daemon forensic lines (extends PR #42's format):
`git-sync: captured 3 repos (savvy-core/daegu, savvy-core/rome, pegasus) · carried 12 · deferred 1 (savvy-core/lusaka: vanished mid-capture) · removed 0`
plus per-repo apply lines on pull (`git-sync applied savvy-core/daegu (ff)`, `git-sync CONFLICT
savvy-core/rome — recovery at …`). `rbox status` gains a `git-sync:` summary per workspace
(`16 repos synced · 1 deferred`).

## 11. Files touched

| File | Change |
|---|---|
| `src/engine/types.ts` | drop `Manifest.git`; add `manifestSchema?`, `gitRepos?` |
| `src/engine/manifest-validate.ts` | schema gate; gitRepos key/value/count validation |
| `src/engine/git-state.ts` | `gitPreflight(repoDir)` relaxation; resolved-gitdir reads (`--absolute-git-dir`); pointer-repo capture mode (HEAD+branch bundle, per-worktree op-state); everything else already takes `root` as a param and generalizes for free |
| `src/engine/git-discover.ts` | **new** — ignore-aware repo discovery |
| `src/cli/sync.ts` | `captureGitForPush` → map orchestration (carry/capture/defer per repo, bounded pool); pull git block → per-repo loop with per-repo base advance + scope-gated ref publish; blobRefs union; per-repo 422 recapture set |
| `src/cli/config.ts` (state) | `gitReposRemoved` removal memories [v2, B4]; `gitNeedsResolution` conflict suppressions [v2, M2]; `gitPendingRemote` unapplied-remote sections [v5] — all local-only, never synced |
| `src/cli/e2ee-remote.ts` | commit blobRefs: iterate `gitRepos[*]` artifact encShas |
| `src/cli/daemon.ts` / `index.ts` | forensic log lines; `rbox status` git summary |

## 12. Verification

- **Unit:** discovery (nested, ignored-subtree exclusion, pointer detection, cap); preflight
  matrix (dir/pointer × bare/alternates/dangling); worktree capture produces a bundle that
  reconstructs HEAD+branch standalone; per-repo base-advance (one repo deferred ≠ others
  blocked); schema validation (legacy `git` refused, bad keys refused, over-cap loud).
- **Two-machine e2e (FakeRemote/e2ee harness):** fixture tree with 2 nested repos (one with
  staged changes + a stash + a paused rebase) + 1 real `git worktree` of an out-of-tree main
  clone → push → pull on B → `git fsck` clean, `git log`/`status`/`stash list` match, rebase
  continuable, worktree materialized standalone; churn test — delete one repo mid-push →
  push succeeds, repo deferred; zero-plaintext grep over stored bytes.
- **Live validation (goal Step 4):** dev binaries, Mac push of `~/conductor/workspaces` →
  flat-meadow pull; ≥2 repos fsck-clean with matching HEAD/refs; a Conductor worktree usable
  standalone on flat-meadow; R2 spot-check ciphertext-only.

## 13. Risks / honest costs

- **First-push weight:** each worktree ships its branch's full history once (savvy-core-scale:
  ~17 MB × N worktrees). One-time; identity-key skip prevents re-bundling unchanged repos.
  Incremental packs stay the future fix (§28 prior-art note).
- **Worktree standalone-ness** is a semantic change users must understand (§5) — documented in
  the README section this ships with.
- **Silent-strip window** exists only for un-upgraded pre-§43 clients (§2) — operationally
  closed for the single-user pre-launch reality, permanently closed for future breaks by the
  `manifestSchema` gate.
- **N × git subprocess cost per push cycle** — carry-forward check is `show-ref`+`write-tree`
  per repo (~tens of ms); at 17 repos ≈ sub-second. Bounded capture pool prevents bundling
  storms when many repos change at once.

---

## 14. Review history

- **v4 → codex round 4 (2026-07-01): FAIL, 1 BLOCKER + 1 MAJOR + 1 MINOR** — (a) clean
  materialization's ref-wipe on a POINTER leftover would delete shared main-clone
  branches/tags/stash → v5 shape-split (dir: quarantine incl. index/op-state + pinning, then
  wipe; pointer: never ref-wipe, guarded update-only apply — stale siblings aren't a
  resurrection vector since pointer captures are scoped); (b) defer-with-old-base-carry lets a
  later push republish stale git over unapplied remote state → v5 `gitPendingRemote` (outbound
  pushes carry the pending remote section, capture suppressed, retry until applied; mutual
  ownership stall = visible non-destructive standoff); (c) §6 generic carry-forward wording
  contradicted the matrix → now references it.
- **v3 → codex round 3 (2026-07-01): FAIL, 2 BLOCKER** — (a) `git update-ref` from one worktree
  silently moves a branch checked out by a SIBLING worktree (repro'd; `branch -f` refuses,
  `update-ref` doesn't) → v4 ownership-guarded pointer-target publication (`git worktree list`
  consulted; sibling-checked-out branches filtered; HEAD-branch filtered ⇒ defer whole apply);
  (b) removal-memory clean apply via a SCOPED section left the leftover's old refs live →
  resurrection through B's next all-capture → v4 clean-materialization rule (quarantine → wipe
  syncable refs/index/op-state → apply → clear memory). Plus: the pointer-wider carry exception
  made normative (was only in the trace), header status fixed. Round 3 confirmed: scratch-ref
  enumeration + age-guarded prune, B4 changed-after-memory conflict path, B5, M5 all closed;
  pointer↔pointer converges scoped/scoped.
- **v2 → codex round 2 (2026-07-01): NEEDS-WORK** — 3 BLOCKER (bundle wildcard arg not
  implementable → enumerate exact scratch refs; scoped-apply base-identity underdefined → the
  v3 scope-matched carry-forward rule + convergence trace; pointer-target apply could write a
  shared stash/tag → strict refs/heads-only filter), 2 MAJOR (blind wip-prune races sibling
  captures → age-guarded prune; fresh re-create after removal deadlocks → removal-memory match
  = clean apply target), 1 MINOR (local TOCTOU → lstat components + post-init reverify; local
  attacker out of threat model). **All folded into v3**, marked `[v3]` inline. Codex also
  confirmed: scratch refs land under `refs/rbox-incoming/…` on receivers and are never
  published (publish writes only `section.refs`); M2 suppression, M3 fallback, M4 cap-carry
  sound; M5 needed the non-looping path (added).
- **v1 → codex round 1 (2026-07-01): NEEDS-WORK** — 5 BLOCKER (pointer ref-scope unsound /
  shared-ref deletion; shared `refs/stash` + `rbox-wip` race; scoped bundles missing
  pseudo-ref/detached-HEAD objects; deletion-resurrection ping-pong; apply-time root
  containment), 4 MAJOR (superproject asymmetry; conflict republish without suppression;
  `write-tree` identity freeze on unmerged index; cap-as-deletion; N-repo 422), 2 MINOR
  (ignored-parent semantics, `AUTO_MERGE`), 1 NIT (wording). Codex verified the git-layout
  claims with local repros (git 2.50.1). **All folded into v2**, marked `[v2, <finding>]`
  inline: `refScope` + scope-gated ref publish + projected identity (B1), capture-unique
  `refs/rbox-wip/<captureId>/*` pinning of HEAD/pseudo-refs/WIP + per-scope stash rules
  (B2/B3), removal memories (B4), realpath containment + key/file collision rejection (B5),
  superprojects explicitly unsupported (M1), `needsResolution` suppression (M2), raw-index
  identity fallback (M3), cap-never-drops-carry (M4), per-repo 422 recapture (M5).
