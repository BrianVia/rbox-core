# Design 43 — Nested-Repo Git Sync (per-repo GitSections)

**Status:** DRAFT (v1, pre-codex).
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

- `GitSection` itself is **unchanged** (bundle/index/op-state artifact refs, refs, head,
  indexTree — §28 shape). All §28 properties (encrypted artifacts, blobRef charging, cipher
  sizes) carry over per repo.
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

For each `gitRepos` key: `isSafeRelPath(key) || key === "."` (no `..`, no absolute, no NUL);
key must not collide case-insensitively with another key; each value passes the existing
`validateGitSection`. Bound: `MAX_GIT_REPOS = 256` (raise-on-measurement; a loud error, not a
silent drop, at the boundary — §30's lesson). The client additionally refuses to *apply* a
section whose key resolves into an **ignored** subtree (defense vs a hostile manifest planting
a repo under `node_modules/`).

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
- The walk result is capped at `MAX_GIT_REPOS`; over the cap → capture the first N by path
  order and log loudly which were skipped (no silent truncation).

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

## 5. Worktree/submodule capture — standalone semantics (the honest contract)

A pointer repo's git state lives in a main clone that may be outside the sync root or gone
tomorrow. So we capture it **as if it were a standalone repo**:

- **Bundle:** `git -C repoDir bundle create tmp.bundle HEAD <current-branch> [refs/stash,
  rbox-wip]` — bundles are self-contained (objects come from wherever git finds them), so the
  result reproduces this worktree's line of history with no dependence on the main clone.
  Deliberately **not `--all`**: a main repo's full branch set through the eyes of 17 Conductor
  worktrees would be 17 near-identical full-history bundles (§28 notes savvy-core's bundle is
  ~17 MB; ×17 every capture cycle is absurd). A worktree's *work* is HEAD + its branch + stash
  + op-state; that is what transfers.
- **refs:** only the current branch (plus `refs/stash` if present) — the shared branch
  namespace belongs to the main repo, not to each worktree.
- **index/op-state:** from the resolved per-worktree gitdir (`.git/worktrees/<n>/index`,
  `MERGE_HEAD`, `rebase-merge/**` …) — this is exactly the state that makes "continue the
  rebase on the other machine" work.
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
2. Per repo, **carry-forward check first** (unchanged fast path): `gitIdentity(repoDir)` vs
   `baseGitRepos[relPath]` via `gitIdentityKey` — identical → reuse the base section without
   bundling (this is what makes N-repo scans affordable per push cycle).
3. Changed repos: `captureGitState(repoDir, …)` under **bounded concurrency**
   (`GIT_CAPTURE_CONCURRENCY = 4` — bundling is CPU/IO heavy).
4. **Churn discipline (PR #38 philosophy):** any per-repo failure — dir vanished mid-capture
   (Conductor archived it), git errored, preflight flipped — **defers that repo**: keep its
   base section if one exists (never regress a synced repo to nothing because of one bad
   cycle), or omit it if never synced. Log `git-sync: deferred <relPath>: <reason>`. The push
   itself proceeds. A repo deleted locally *on purpose* stays carried in the manifest until §9's
   removal rule applies.
5. The assembled map becomes `manifest.gitRepos`; every artifact encSha joins the commit's
   blobRefs (per §28 step 3 — now summed across repos).

## 7. Apply orchestration on pull — per-repo bases, design-02 discipline each

The pull-side git block iterates `remote.gitRepos ∪ base.gitRepos` per key:

- **remote changed vs base** (`gitIdentityKey` differs):
  - local repo also diverged from base → **per-repo conflict**: `preserveGitConflict(repoDir)`
    (recovery bundle + `refs/rbox-conflict/*`), checkpoint base to remote, loud log. Other
    repos are unaffected.
  - local == base → `applyGitState(repoDir, …)` — the existing transactional flow (decrypt-all
    first, quarantine, fetch to `rbox-incoming`, publish refs, fsck, rollback on failure)
    scoped to that repo dir. `git init` materializes the repo if the dir/`.git` doesn't exist
    (including the standalone materialization of a worktree-origin section). Deferred/failed →
    **that repo's base does not advance** (retry next pull); others advance independently.
- **remote lacks a key the base has** (§9 removal): no local mutation — never delete a local
  `.git` — but the base entry is dropped so we don't push it back.
- The per-repo applied identities are folded into
  `saveState(lastSyncedManifest.gitRepos[relPath])` — base-advance-only-on-success now holds
  **per repo** instead of globally (one busy repo no longer blocks the other 16 from advancing,
  which design 02's single-section model would).
- Receiver quiescence (`gitBusy`) is checked per repo; a busy repo defers only itself.

## 8. E2EE / server surface — zero change

Artifacts remain convergent-encrypted blobs by encSha; refs/heads/paths live only inside the
encrypted manifest; blobRefs charge/GC-root every git encSha (union across repos). The server
never learns how many repos there are (`gitRepos` is inside the ciphertext) — only total blob
count/sizes, the §28-documented leakage. No worker/API/D1 change of any kind.

## 9. Repo lifecycle rules

- **New repo appears** → discovered next scan → captured → syncs. (Conductor creating a
  worktree on machine A materializes it standalone on machine B.)
- **Repo deleted locally** (dir gone or `.git` gone): the *working files*' deletion propagates
  through the ordinary file path already. For git state: if the repo dir is **gone entirely**,
  the pusher drops `gitRepos[relPath]` (with a forensic log line); receivers drop their base
  entry but **never touch local `.git`** — a receiver's materialized repo becomes untracked
  residue for the user to delete, which is the conservative choice (deleting a repo remotely
  must not destroy committed local work — design 02's prime directive outranks tidiness).
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
| `src/cli/sync.ts` | `captureGitForPush` → map orchestration (carry/capture/defer per repo, bounded pool); pull git block → per-repo loop with per-repo base advance; blobRefs union |
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
