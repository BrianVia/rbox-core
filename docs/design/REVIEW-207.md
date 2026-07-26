# REVIEW-207 — ledger

Status: ALIGNED r3 (focused re-check verdict: ALIGNED).

## Round 1 (parallel: codex gpt-5.6-sol medium ×1, opus medium ×1) — both CHANGES-REQUIRED

The two reviews independently demolished r1's tier-2 whole-directory
retirement and bundle retention. Divergence-signal call: rather than armor
the mechanism, r2 descopes to the intrinsically safe subset (rmdir-only
sweep + journal key + doctor). Rulings:

| # | Finding | Ruling |
|---|---|---|
| O-H1 / C-1,2 HIGH | Tier-2 predicate self-referential: `removedMem[rel]` is stamped from the SAME live identity in the same branch (`apply.ts:720-741`), so equality always passes — including over a local commit made before the removal arrived. `cleanMaterialize` is not equivalent precedent (its memory comes from an earlier pull, and it quarantines first). | ACCEPT → tier 2 DESCOPED. Successor needs durable materialized-by-rbox provenance maintained across the repo's life. |
| C-3 HIGH | `gitIdentity` omits reflog-only commits, dropped stashes, `hash-object -w`, `.git/config`, hooks, notes/replace/remote refs, unborn-repo state. | ACCEPT → recorded in descope rationale; doctor verdict is `match|mismatch|unknown`, never "proven clean". |
| C-4 / O-M10 HIGH | Validate-then-rename TOCTOU (memoized busy/identity, no fence); crash windows. | ACCEPT → descope. |
| C-5 HIGH | `listWorktrees` fails open (`shared.ts:483-495` → `[]` on any git error); elsewhere-located linked worktrees break too. | ACCEPT → descope. |
| C-6,7 / O-H3 HIGH | Tier-1 bundle deletion + retention can destroy the only recovery copy (hard-held rollback case, `engine/git/apply.ts:748-769`); nothing pins needed bundles (`sync-git/apply.ts:1747` drops `conflictBundle`); `refs/rbox-conflict/*` only written by `preserveGitConflict`; workspace-root `git-quarantine` tree is SHARED with ORIG_HEAD breadcrumbs (design 126) and journal-retired `.git` trees. | ACCEPT → bundle deletion + retention DESCOPED to issue #470; doctor gains a size line. |
| O-H2 / C-8 HIGH | Trash batch is finished (`pull.ts:358`) before git apply (`:394`) and `applyGitSections` has no trash option; reuse after `finish()` is unsafe. | MOOT via descope (no trash use remains); recorded for the successor. |
| O-H4 HIGH | Nested `.git` at depth makes a submodule read "empty" under an any-depth exemption — live data-loss path. | MOOT via descope; rmdir-only needs no exemption (ENOTEMPTY protects). |
| O-M5 | Tier-1/tier-2 disagree on user content in `<repo>/.rbox`. | MOOT via descope. |
| C-9 MED | `trash.days === 0` unspecified. | MOOT. |
| O-M6 / C-1 | Removal branch fires exactly once; vetoed residue strands forever. | ACCEPT-AS-DESIGNED → one-shot documented; doctor + manual command are the remedy; gc verb if field demand. |
| O-M8 | Trash retention (30d AND 2GiB size cap) lossier than claimed. | Recorded in descope rationale. |
| O-M9 / C-12 MED | Doctor byte walks unbounded; ledger phantom rows; privacy split (paths never uploaded); verdict must include `unknown`. | ACCEPT → §3: presence-only default, `--residue-bytes` opt-in, exists-only rows, local-only paths, three-valued verdict. |
| C-10 MED | Path-based sweep can follow swapped symlinks; adopt precedent uses stronger opened-parent+inode checks. | ACCEPT → §1 traversal hardening per `adopt-fs.ts:179-195`; rmdir leaf op is atomic-safe. |
| C-11 MED | Workspace-root quarantine residue unassigned. | ACCEPT → class 4: never auto-deleted, doctor size line. |
| O-L11..L15 / C-audit LOW | trash listing files-only; tier-3 needs root guards; `.rbox`-at-depth not hard-excluded (justification was wrong); anchor drift (trash.ts:85, quarantine.ts:63, trash.test.ts:44 directory case EXISTS, batch open at pull.ts:325); "tier 4" typo; retention test contradiction. | ACCEPT → folded into r2 text/tests (trash items moot). |


## Round 2 — serial gate (codex): CHANGES-REQUIRED, folded into r3

| # | Finding | Ruling |
|---|---|---|
| S1 HIGH | Path-based lstat/rmdir traversal loses to ancestor-symlink swap (out-of-tree rmdir); adopt precedent is anchored (opened parent handle + inode identity + rmdir-relative). | ACCEPT → anchored traversal mandatory; residual race bounded to removing a concurrently created EMPTY dir. |
| S2 HIGH | `match` verdict cannot mean "identical to synced / safe to delete" (memory stamped from live identity at removal; identity blind to config/hooks/reflog; busy path stamps projected base). | ACCEPT → verdict informational only; neutral copy; "safe to delete" removed. |
| S3 MED | `gitReposRemoved` incomplete residue index (needs .git at removal; pruned when .git disappears, `plan.ts:424`); quarantine sizing missed repo-local class 3. | ACCEPT-MODIFIED → honesty clause in §3 (no tombstone index this design); sizing extended to per-repo artifact dirs of current base repos. |
| S4 LOW | Factual: busy-path stamps projected identity; journal keys have normal lifecycle clearing; retired-tree vs sha16 layouts are siblings; 2GiB is default not max. | ACCEPT → text corrected. |

Serial gate confirmed: journal-key clearing on the removal arm is aligned
with recovery/resurrection expectations.

## Round 3 — focused re-check: see REVIEW-207-r3.md
