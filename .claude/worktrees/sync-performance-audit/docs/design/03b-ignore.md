# Design 03b — Configurable Ignore Patterns (Milestone 3b)

**Status:** ✅ IMPLEMENTED & VERIFIED (forward-only). Reviewed; the valid findings are resolved: carry-forward implemented, daemon rebuilds its matcher + full-rescans on `.gitignore`/`.rboxignore` change, precedence example corrected, `--purge` dropped (use delete-then-ignore). Verified 5/5 end-to-end (forward-only keep + no-edit-propagation + `.rboxignore` shared). Known accepted limitation: carried-forward ignored entries persist in the manifest (no tombstone GC yet).
**Implements:** roadmap M3b.

## 1. What already works
- `BUILTIN_IGNORE` (dev-aware defaults) + `.gitignore` + `.rboxignore` are combined by `buildIgnoreMatcher` (`src/engine/ignore.ts`). `buildIgnoreMatcher(root, extra)` already accepts an `extra: string[]`.
- **`.rboxignore` is a normal synced file** — it's NOT in `BUILTIN_IGNORE`, so it syncs across machines like any source file, and each machine's matcher reads it. So a *shared, cross-machine* ignore list already exists with zero new infra. It just isn't surfaced/managed.

## 2. What M3b adds
1. **Precedence, documented + tested.** Order: `BUILTIN_IGNORE` → `.gitignore` → `.rboxignore`, later rules overriding earlier (the `ignore` package applies in add-order). `.rboxignore` is last so a user can re-include something an earlier rule excluded — **but only for file patterns, not files inside a pruned directory** (a builtin `dist/` prunes the whole subtree, so `!dist/keep.txt` cannot resurface it; you'd have to re-include the dir). Correct example: builtin/gitignore ignores `*.log`; `.rboxignore` `!important.log` re-includes that one file.
2. **`rbox ignore` commands** (sugar over editing `.rboxignore`):
   - `rbox ignore <glob>` — append a pattern to `.rboxignore` (create if absent), de-duped.
   - `rbox ignore --list` — print the *effective* rule set (builtin + .gitignore + .rboxignore), labeled by source.
3. **The safety decision — ignoring an already-synced file (the sharp edge).** When a new ignore pattern matches files already in the synced manifest, the naive result is: they vanish from the next manifest → reconcile on every other machine sees them as **deleted** → they're deleted everywhere. That's a surprising, potentially destructive side effect of "add to ignore."

   **Decision: forward-only by default, explicit opt-in to purge.**
   - Default: newly-ignored files **stop syncing future changes but are NOT deleted** from other machines. Their last-synced copies remain (now untracked by rbox). No destructive surprise.
   - `rbox ignore <glob> --purge` (or `rbox unsync <glob>`): the destructive variant that DOES propagate deletion of the already-synced copies, after a **diff-preview + confirmation** (CLI) showing exactly what will be deleted on other machines.

   **Implementation of forward-only:** the push path computes the manifest from the scan (ignored files absent). To avoid those absences reading as deletions, `push` carries forward the last-synced entries for paths that are absent *only because they are now ignored* (not because the user deleted them). Concretely: when diffing scan vs lastSynced, a path present in lastSynced and absent in scan is a deletion **only if it is not currently ignored**; if it's now ignored, it's carried forward unchanged (forward-only). A real `rm` of a non-ignored file is still a deletion. `--purge` flips this to treat ignored-and-absent as deletion.

## 3. Files touched
| File | Change |
|---|---|
| `src/engine/ignore.ts` | export an effective-rules lister (source-labeled); confirm precedence order |
| `src/cli/ignore-cmd.ts` | **new** — `rbox ignore` add/list, `.rboxignore` append (deduped) |
| `src/cli/sync.ts` | forward-only: carry forward last-synced entries for now-ignored paths (don't emit as deletes) unless `--purge` |
| `src/cli/index.ts` | wire `ignore` command + `--purge` flag |

## 4. Verification
- Unit: precedence (a `.rboxignore` `!negate` re-includes a builtin-ignored path); forward-only (adding an ignore for a synced file yields no deletion in the pushed manifest); `--purge` does emit the deletion; `rbox ignore <glob>` dedupes.
- Integration: two dirs; sync a file; add it to `.rboxignore` on A; confirm B still has it (forward-only) and edits to it stop propagating; then `--purge` and confirm B deletes it.

## 5. Open question
- Is forward-only the right default (vs the roadmap's earlier "deletes propagate")? It's the safe/least-surprising choice; `--purge` keeps the destructive path available with a preview. Confirm.
