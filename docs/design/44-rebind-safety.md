# 44 — Rebind safety: state ownership + the mass-delete guard

Status: SHIPPED (2026-07-01, same-day response to a live data-loss incident)

## 1. The incident

2026-07-01, ~03:16Z, on the founder's Mac. A re-run of `rbox setup` over the
already-synced `~/conductor/workspaces` (to give the workspace a display name)
chose "Create a new workspace from a directory". The flow:

1. `runInit` created a brand-new, EMPTY workspace (`ws_6c51…`) and rewrote
   `workspace.json` to bind the root to it.
2. The old workspace's `state.json` — an 8,600-file baseline at sequence 75 —
   **survived the rebind untouched**.
3. The initial "populate" push diffed disk against that stale baseline, found
   nothing changed, uploaded **zero bytes**, and printed
   `✓ published → sequence 75` (the STALE sequence). No spinner, no upload —
   the success message was a lie.
4. The daemon started, pulled the genuinely-empty new workspace, reconciled it
   against the stale 8,600-file baseline — every baseline file read as
   "remotely deleted" — and **deleted 8,603 local files** in one apply.

Recovery was clean (the old workspace still held everything server-side; `.git`
dirs are never touched by design), but only because the deletions were never
pushed anywhere. The failure mode is a **poisoned reconcile base**: a baseline
is only meaningful against the manifest stream it was built from.

## 2. Mechanism 1 — state ownership (the root-cause fix)

`SyncState` now carries `workspaceId`: the workspace the baseline belongs to.

- `saveState` sites always stamp it (`cfg.remoteWorkspaceId`).
- `loadState(root, workspaceId)` requires the expected id. A stored state whose
  stamp differs is treated as **no baseline at all** (logged, never deleted from
  disk by the loader): the rebound root pulls without deleting (empty base = no
  delete diffs) and pushes its full tree — exactly right for a fresh binding.
- A legacy pre-stamp state file (no `workspaceId`) is adopted as-is; every save
  since stamps it. (Pre-launch: the only two live machines are correctly bound.)
- `runInit` additionally resets the state file explicitly when it rebinds a root
  to a different workspace (`resetSyncState`), so the on-disk state is truthful
  and the transition is announced to the user.

Defense-in-depth ordering matters: the LOADER guard is the invariant (any future
caller is covered); the init reset is hygiene + UX.

## 3. Mechanism 2 — the mass-delete guard (the safety net)

Even with ownership stamps, a catastrophic delete wave can arrive for other
reasons (server-side accident, a hostile/buggy peer device, a future bug). Pull
now refuses — BEFORE any action touches disk — to apply a reconcile that deletes

- ≥ 100 files, AND
- ≥ half of the current baseline.

The refusal is a thrown error, so the whole pull fails closed (nothing partial).
The daemon never consents, so background sync halts loudly (the error lands in
the daemon log via the existing error path) instead of destroying the tree.
A human applies a legitimate mass deletion once with
`rbox pull --allow-mass-delete` (also on `rbox sync`).

Thresholds: normal dev churn (deleting a vendored dir, pruning a subtree) stays
far under half the tree; the two-condition AND keeps small workspaces (where
"half" is a handful of files) from tripping on routine cleanups.

Known over-trigger (accepted, fails CLOSED): the guard counts reconcile deletes
BEFORE the local-ignore filtering, so a remote commit that both adds ignore
rules and deletes >100 of the newly-ignored paths can trip the guard even
though those deletes would never touch disk. Counting after the filter would
require applying the remote rule files first (a partial mutation before the
fail-close) — refusing loudly and letting the human `--allow-mass-delete` once
is the safer trade.

## 4. Mechanism 3 — honest publish reporting

`push` (and `PushResult`) now reports `committed`: true only when a commit
actually advanced the sequence. The setup/init flow says
`already in sync — nothing to upload (sequence N)` on a no-op instead of
`published → sequence N`. A user watching the first publish of a large tree
must see upload progress; its absence was the tell that something was wrong,
and the old message actively hid it.

## 5. Mechanism 4 — the setup rebind guard (UX)

`rbox setup → Create a new workspace from a directory` over a directory that is
already bound warns with the current workspace's name/id and asks for explicit
confirmation (default NO), steering the user to "Track an existing workspace" /
`rbox start` instead. The incident's trigger — re-running setup to *name* a
workspace — should never silently mint a second workspace.

## 6. What was deliberately NOT done

- No interactive confirm inside `pull` itself (the CLI is also driven headless;
  consent is an explicit flag, prompting belongs to the caller).
- No baseline versioning/undo journal — the server's immutable manifest history
  (design 12 §15 versions/restore) already provides restore; local trees are
  additionally protected by never-synced `.git` dirs.
- Workspace deletion/GC of orphaned empty workspaces (the incident's `ws_6c51…`
  was purged by hand) — a `rbox workspace delete` is future work.

## 7. Regression coverage

`src/cli/sync.test.ts` (design-44 section): the full incident regression
(rebind → pull deletes nothing → push publishes all), state ownership
(mismatch/fresh, match/kept, legacy/adopted), guard trip + consent, guard
non-trip at normal scale, and `committed=false` on no-op pushes.
