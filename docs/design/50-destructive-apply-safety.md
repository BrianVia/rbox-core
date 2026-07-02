# 50 — Destructive-apply safety: type-flip conflicts + the local trash tier

Status: draft (spec only — codex design review pending)
Origin: two 2026-07-02 events. (1) flat-meadow's pulls halted for ~5 hours on
EISDIR: the Mac had a Conductor *symlink* (`savvy-core/pr-5-plat-1282-snapshot-list`
→ `amarillo-v1`) where flat-meadow had a materialized *directory* — the pull
writer can't handle a type flip and aborted every pump. (2) The founder asked
the right follow-up: "part of me worries about an `rm -rf` on a second machine
wiping out the first — do we move files to .trash before removing?"
`src/engine/apply.ts` has been carrying the answer as a promissory note since
M6: *"real trash tier is M6"*. This design pays that note.

## 1. What protects machine A from machine B's `rm -rf` today

Walking the actual code (`sync.ts:144`, `apply.ts:183`):

1. **Pull-side mass-delete guard (design 44)** — a pull that would delete
   `≥ MASS_DELETE_MIN_FILES (100)` files AND ≥ half the baseline fails closed
   before touching disk; the daemon halts with the ⚠ surface (design 45/46)
   and only an explicit `--allow-mass-delete` applies it. A full `rm -rf` on B
   therefore does NOT wipe A — A refuses, loudly, with its files intact.
2. **Concurrent-edit preservation** — a propagated delete that finds locally
   *changed* bytes moves them to a visible conflict copy instead of removing.
3. **Remote history** — commits are retained in R2 until GC, so the server
   holds the deleted bytes (this is what made the design-44 recovery total).
4. **`.git` is never synced** — repos are re-derivable regardless.

The real gaps, and they're exactly what the founder's instinct smelled:

- **Sub-threshold deletions propagate silently and unrecoverably-in-practice.**
  `rm -rf` of a *subdirectory* (< half the tree), or of a whole *small*
  workspace (< 100 files never trips the guard at any ratio), applies on A as
  plain `fs.rm` — clean-matching files are simply gone. Remote history holds
  the bytes, but the E2EE `versions`/`restore` UX is deferred (fail-closed),
  so practical recovery today is "none".
- **Type flips abort the whole pull forever.** `currentEntryAt` returns
  `undefined` for a directory ("we never delete/overwrite a dir as if it were
  a file") — so `writeEntry` skips the conflict-copy branch and runs
  `fs.rename(tmp, abs)` straight into EISDIR. No heal, halt every pump, and
  the workspace stops taking ALL remote changes (the 5-hour flat-meadow
  outage). Conductor manufactures this case routinely (per-task symlinks over
  paths that were once real directories).

## 2. The trash tier

One rule: **the pull writer never destroys bytes it can't get back; it moves
them into a local, unsynced trash.**

- Location: `.rbox/trash/<pull-ISO-timestamp>/<relpath>` inside the workspace
  root. `.rbox` is already in `ALWAYS_NATIVE_PRUNE` — trash never scans,
  never syncs, never echoes. Same filesystem as the tree by construction, so
  every move is one atomic `fs.rename` (the §28 EXDEV lesson: never stage
  across mounts) — trashing 10k files costs 10k renames, no byte copies.
- What routes through it:
  - **Propagated deletions** (`deleteEntry`'s clean-match branch): `fs.rm` →
    rename into trash. The dirty-match branch (concurrent edit) KEEPS its
    visible in-workspace conflict copy — cross-machine visibility is the
    point there, and those are rare and small.
  - **Type-flip evictions** (§3): an obstructing *directory* moves to trash
    wholesale. Explicitly NOT a visible conflict copy: renaming a materialized
    repo to `<name>-conflict-…` inside the workspace would re-push its entire
    tree as new files — a churn bomb. Trash is local-only by definition.
- Retention (daemon-owned, on the deep-scan tick): prune trash batches older
  than **30 days**, and enforce a total-size cap of **2 GiB** oldest-first.
  Both overridable in `.rbox/workspace.json` (`trash: { days, maxBytes }`,
  `days: 0` = classic immediate delete for the space-constrained).
- Surfacing: `rbox status` gains one line when trash is non-empty
  ("trash: N files, X MB — `rbox trash list`"). New minimal command group:
  `rbox trash list | restore <path> [--at <ts>] | empty`. Restore is a
  rename back (collision → visible conflict name, never overwrite).
- The mass-delete guard **stays exactly as is**. Fail-closed still beats
  recoverable-but-applied for half-the-tree events; the trash is the net for
  everything under the threshold. With the net in place the guard's
  `MIN_FILES=100` blind spot on small workspaces becomes acceptable rather
  than scary.
- Security posture unchanged: trash holds plaintext inside the same root the
  plaintext already lives in; zero-knowledge is a server property.

## 3. Type-flip conflict handling (the EISDIR fix)

Manifests record only `file` and `symlink` entries (directories are implicit),
so the incoming side of a flip is always file-or-symlink; the local
obstruction is a directory (or a file squatting on an ancestor path).

- **`writeEntry`, obstructing directory**: lstat the target; if it's a dir,
  move the whole directory into trash (one rename), log it as a type-flip
  conflict (forensic daemon-log line + `lastPull.conflicts++`), then publish
  the staged entry normally. The pull completes; the dir's contents are
  recoverable via `rbox trash`.
- **`writeEntry`/`mkdir`, obstructing ancestor FILE**: `fs.mkdir(dirname,
  {recursive:true})` throws ENOTDIR when a parent component is a file (remote
  has `a/b`, local has file `a`). Walk to the offending component, move that
  *file* aside as a **visible conflict copy** (files are cheap and the
  existing conflict mechanism fits), mkdir, proceed.
- **`deleteEntry`, local dir where a file entry is being deleted**: keep
  today's skip (`currentEntryAt` → undefined → "already gone") — the dir's
  files are untracked-or-new and will push as adds; nothing to destroy.
- **Symlink↔file flips**: already atomic via rename-over; no change.
- Ordering note: type-flip eviction happens at APPLY time per entry, after
  the mass-delete guard has passed on the whole plan — an eviction is never
  counted as a "delete" for guard purposes (it destroys nothing).

## 4. Push-side mass-delete guard (closing the loop on the founder's worry)

Today B publishes its `rm -rf` freely; A's pull guard saves A's *disk*, but
the remote head now says "everything is deleted" — every other device halts
⚠ on its next pull, and un-wedging requires a human on some machine. Cheap
symmetry: apply the SAME threshold check on push (`plannedDeletes >= 100 &&
deletes*2 >= baseline` → refuse to COMMIT, halt with the existing op-keyed
halt surface, `rbox push --allow-mass-delete` to consent). Stops the bad
state at its source; the daemon never self-consents (design-44 rule). The
one-shot interactive commands print the exact consent command, same UX as
pull.

## 5. Scope & order

1. Type-flip handling (§3) — smallest, fixes the live outage class; its
   directory-eviction target IS the trash, so it lands with §2's move+prune
   core.
2. Trash tier core + retention + status line (§2).
3. `rbox trash` command group (§2, can trail by a release).
4. Push-side guard (§4) — independent, tiny.

Out of scope: E2EE `versions`/`restore` server-history UX (deferred D11 item
— the trash makes local recovery cheap precisely so that stays deferrable);
syncing trash between machines (explicitly never).

## 6. Test plan sketch

- Engine: dir-obstruction write (flip applies, dir lands in trash, pull
  completes), ancestor-file obstruction (conflict copy + mkdir succeeds),
  clean-delete → trash rename, dirty-delete → conflict copy unchanged,
  collision of two same-path trashings in one batch.
- Retention: prune by age and by size cap, oldest-first, never prunes the
  in-progress batch.
- Guard symmetry: push refusal at the same thresholds; daemon halt op-keyed
  as `push`; consent flag applies once.
- Live validation: reproduce the Conductor symlink-over-directory flip on a
  second device and watch the pull heal instead of halt.
