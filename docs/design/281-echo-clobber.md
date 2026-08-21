# 281 — Echo pulls: the apply-time conflict copy must be a reported outcome

Status: DRAFT
Issue: #535 ("Echo pulls apply stale content over newer active local edits").
Founder ruling 2026-08-20: fix before the 2.0 tag. Treated as the only
data-loss-shaped open edge.

## TL;DR of the investigation

**On the path #535 actually reports, the bytes were never lost.** Every write
and delete the files plane performs
re-hashes the target immediately before it publishes, and on a mismatch moves
the user's current bytes to a `.conflict` copy first
(`src/engine/apply.ts:292-295` and `:455-460`). Field evidence and a
purpose-built repro both confirm the copy is made.

**What is actually broken is that this outcome is invisible and unattributed.**
`applyActions` returns `Promise<void>`; neither mismatch branch calls a
callback, increments a counter, writes to `warningSink`, or records telemetry
(verified exhaustively — see §2). The daemon's forensic line and the status
trail are both computed from the *reconcile plan*, not from what apply did, so
a pull that moved a user's in-progress file aside reports:

```
pull applied: 1 write, 0 delete, 0 conflict — +Personal/home-dashboard/build.log
```

From the user's chair that is indistinguishable from silent data loss: the file
they were editing now holds older, echoed content, `rbox status` says zero
conflicts, and the newer bytes exist only under a mangled filename nobody
mentioned. Worse, that unannounced copy then wedges the git lane for as long as
it sits there (§1.3, field-proven for ~1 hour).

So #535 is real and worth fixing before 2.0, but it is a **legibility and
outcome-reporting defect**, not a byte-destruction defect. This document fixes
it by making the existing guard report its own verdict (§3.1).

The full-inventory sweep did turn up **two genuine byte-loss edges** off the
#535 path, both small and both fixed here: one writer that defeats the guard by
construction (§3.2, scoped-binding rule files — real, unrecoverable, currently
justified by a falsifiable claim) and one narrow post-hash TOCTOU (§3.3).

## 1. Evidence

### 1.1 The mechanism, end to end

Preconditions, all present on the founder fleet during the #535 nights:

1. A pull's local view omits paths it could not observe cleanly. Two sources:
   the scan's deferred set (torn-read / IO-fault protection,
   `src/engine/manifest-torn-scan.test.ts` pins it) and, on the daemon's fast
   path, design 202's `trustedView.deferred` unsettled set. `src/cli/sync/pull.ts:254-274`
   feeds `local` from whichever arm ran, with the deferred paths **absent**.
2. `reconcile` reads absence as local deletion. For a path with `base=v1`,
   `local=absent`, `remote=v2`, every equality fails and control reaches
   `src/engine/reconcile.ts:72-73`:

   ```ts
   } else if (r && !l) {
     actions.push({ kind: "write", entry: r, expectedLocal: l }); // delete-vs-modify → remote wins, nothing to keep
   }
   ```

   The comment's "nothing to keep" is a **false claim for a deferred path**: the
   file is not deleted, it is being written to right now. The plan says `write`,
   and `write` is what every downstream reporter will count.
3. Apply catches it. `src/engine/apply.ts:289-295` re-hashes the target and, on
   the (inevitable) mismatch against `expectedLocal === undefined`, moves the
   live bytes aside to `conflictName(...)` and lands the remote.

Byte-wise, step 3 produces exactly what `reconcile`'s own `kind:"conflict"`
action produces (local aside, remote in place) — so the *bytes* are right and
consistent with rbox's conflict model. The **plan** that everyone reports from
still says `write`.

This is not an accident; it is the current pinned contract. `src/cli/sync/sync-scan-defer.test.ts:177-213`
asserts precisely this outcome, and `src/cli/sync/pull.ts:246-253` states the
rationale ("pull intentionally acts on no deferred set … apply's expectedLocal
guard is the protection"). That reasoning is sound about bytes and silent about
reporting.

### 1.2 Field evidence — the guard fired, the log said zero

`~/.rbox/daemons/Development-a64d35fe/daemon-2026-08-15.log`:

- `00:00:26 … 01:10:13` — eight `pull applied: 1 write, 0 delete, 0 conflict —
  +Personal/home-dashboard/build.log` lines against a file a local build was
  actively rewriting.
- `01:37:05` onward — the git lane begins deferring on
  `Personal/home-dashboard/build.dev_3225c3149dbaa1e0d5e755bfca41343c.20260815012048.conflict.log`.
  That copy's own name dates its creation to `01:20:48`, inside the run of
  `0 conflict` pulls above. **No log line, no counter, no status entry ever
  named it.**
- `02:12:31` — a second, larger batch created in a single apply:
  `build…20260815021231.conflict.log`, `apps/api/src/admin…conflict.ts`,
  `apps/api/src/diagnostics…conflict.ts`,
  `apps/api/test/atomic-genesis.test…conflict.ts`. Again the only trace in the
  log is the *git-sync deferral that the copies caused* (`02:12:50`), never the
  copies themselves. This is the event STATUS.md records as "Sync
  echo-clobbered the desktop checkout TWICE during the rebuild".

The behaviour is current, not historical. `daemon-2026-08-17.log` and
`daemon-2026-08-18.log` show whole batches created in a single second on the
Mac and then synced here as litter — `20260817161730` (12+ paths incl.
`src/cli/daemon/daemon.ts`, `docs/design/273-git-legibility.md`) and
`20260818135605` (13+ paths incl. `CHANGELOG.md`,
`src/cli/sync-git/follow.ts`). One apply, dozens of in-progress files moved
aside, nothing reported.

### 1.3 The second-order damage

An apply-time conflict copy is an unannounced new file inside a git repo. The
git lane's working-tree comparison sees it and defers the whole repo:

```
2026-08-15T01:37:05Z git-sync deferred Personal: working tree differs from
applied manifest (differs at Personal/home-dashboard/build.dev_….conflict.log)
```

That deferral repeated every ~70s until `02:12`. Design 272's conflict-copy
oracle can *exclude* conflict-named paths from the comparison, but it is
name-grammar-based and origin-blind (`src/engine/receiver-paths.ts:84-85`,
`src/engine/apply-receipt.ts:406-414`) — it never learns that a copy was just
created, and its output is a downgrade to `indeterminate`, not a report.

### 1.4 Why the echo-publish ring fix (#683/#685, design 244) did not close this

Design 244 removed the *source* of the redundant echo sequences (a pending git
section re-arming push forever). It never touched the apply side. The echo ring
was the amplifier; the reporting hole is the defect. With 244 shipped the
frequency dropped, but 2026-08-17/18 prove single ordinary pulls still produce
mass unannounced conflict copies whenever a peer is editing under churn.

## 2. What is NOT the bug (negative results, so a future reader stops re-deriving)

Each of these was checked and cleared with file:line evidence:

- **`sameContent` is content-exact.** `src/engine/diff.ts:20-30` compares
  sha256 + type + symlink target + mode. It cannot return true for differing
  bytes. Size is deliberately excluded (`diff.ts:32-34`) and cannot cause a
  false match.
- **The scan cache cannot serve stale content into `expectedLocal` undetected.**
  `src/engine/hashcache.ts:59-63` keys on `(mtimeMs, size, ctimeMs)`; ctime is
  unforgeable from userspace on macOS/Linux, and
  `src/engine/manifest-torn-scan.test.ts:52-60` pins the same-size mtime-restored
  replacement case as *deferred*, not mis-hashed.
- **A stale `expectedLocal` is safe by construction.** Apply re-derives the
  truth with `currentEntryAt` (`src/engine/apply.ts:466-486`), which lstats and
  **hashes** the file. A stale expectation therefore mismatches and preserves;
  it never silently matches.
- **A mid-hash edit is safe.** It yields a torn sha that mismatches
  `expectedLocal`, so the live bytes are preserved. The safe direction.
- **A pure echo plans no action.** If `remote == base` then `local == base`
  implies `local == remote` and `reconcile.ts:59` skips. Every `write` action
  therefore reflects a genuine remote change relative to base; apply's
  remote-wins-plus-copy is the correct three-way answer for both-diverged, not
  a wrong winner.
- **The git plane never writes a working-tree file.** Every git-plane mutation
  targets `.git`/common-dir bytes (HEAD, index, refs, op-state, config), which
  `src/engine/ignore.ts:351` hard-excludes from the files plane at any depth.
  There is no `git checkout`, `reset --hard`, `clean`, `stash apply`, or `merge`
  anywhere in `src/`. The follow pipeline is oracle-gated twice
  (`src/cli/sync-git/follow.ts:168-193`, then
  `src/cli/sync-git/ref-plane-transaction.ts:341/351`), and the destructive
  ref-wipe refuses to run without a successful bundle first
  (`src/cli/sync-git/quarantine.ts:66-68`). So the `.claude/worktrees` files in
  #535 were mutated by the files plane, not the git plane.
- **Nested worktrees (`.git` is a FILE) sync as ordinary files.**
  `src/engine/git-discover.ts:50-56` classifies them `kind: "pointer"`; the
  pointer file itself is excluded (`ignore.ts:13-17`), and `.claude/` is not in
  the default ignore set — so `.claude/worktrees/<slug>/**` is a live synced
  subtree handled entirely by `applyActions`. Consistent with §1.1.
- **Trash cannot destroy newer on-disk bytes.** `put` probes and suffixes before
  renaming (`src/engine/trash.ts:75-86`), `pruneTrash` only ever reads its own
  batches (`:163-166`), and `restoreFromTrash` diverts to a conflict name when
  the target exists (`:251-253`).
- **`restoreEntryToPath` is not on the pull path.** It is an explicit overwrite
  by design (`apply.ts:399-401`); its sole production caller
  (`src/cli/versions-cmd.ts:121`) passes a trash batch. Noted as a latent
  footgun (the writer's safety lives in the caller), not a #535 cause.
- **The conflict copy itself is safe on the next pull.** `remote` and `base`
  both lack it, so `reconcile.ts:67` takes the local-ahead arm and it is
  published, not deleted.
- **Directories are never overwritten as files.** `currentEntryAt` returns
  `undefined` for a directory (`apply.ts:485`) and the type-flip branch routes
  it to trash (`apply.ts:305-309`).

## 3. The fix

Two changes. Both strengthen the ONE existing `expectedLocal` guard rather than
adding a second authority. No new flag, no new mode, no new state.

### 3.1 (Primary) The guard reports its own verdict

`applyActions` already has exactly the right precedent for this: `onTypeFlip`,
a per-path callback fired from apply, accumulated by the daemon, folded into
`lastPull.conflicts`, and logged (`src/cli/daemon/daemon.ts:2573-2582`). The
apply-time precondition mismatch is the same kind of event and gets the same
treatment.

- **`src/engine/apply.ts`** — add `onConflictCopy?: (relPath: string, keptAs: string) => void`
  to `ApplyOptions` (sibling of `onTypeFlip`, `:61`). Thread it into
  `WriteEntryOptions` and into `deleteEntry`'s parameters. Fire it from exactly
  the two mismatch branches — `writeEntry`'s `:292-295` and `deleteEntry`'s
  `:458-460` — with the path and the name actually claimed on disk. This means
  `moveAside` must return the claimed relative path (`claimUnclobberedName`
  already computes it for the `~2`/`~3` collision case), so the report names the
  file that really exists.
  - The `keepLocalAs` branch (`:290-291`) is a reconcile-planned conflict and is
    already counted upstream; it does NOT fire the new callback. One event, one
    owner, no double counting.
- **`src/cli/sync/pull.ts`** — thread `deps.onConflictCopy` into `applyOpts`
  (`:349-359`), beside the existing `onTypeFlip`.
- **`src/cli/daemon/daemon.ts`** — wire it exactly like `noteTypeFlip`: one
  forensic log line naming both paths in plain English, and a
  `conflictCopiesSincePull` tally folded into `lastPull.conflicts` and reset in
  `recordPullApplied` (`:2588-2602`).
- **`src/cli/daemon/render.ts`** — `summarizeActions` keeps counting the plan.
  The log line gains the apply-time tally so `pull applied:` tells the truth
  about outcomes, not intentions. (A pull that moved 13 files aside must not
  print `0 conflict`.)

Copy bar (non-developer users, per the prod-customer rule): the log/status
wording says what happened and where the bytes are, e.g.
`pull conflict copy: src/cli/daemon/daemon.ts — your newer local version was saved as src/cli/daemon/daemon.dev_….conflict.ts`.

### 3.2 (Secondary) The one writer that defeats the guard by construction

A full inventory of every workspace mutator on the pull path (files plane, git
plane, trash, scope) found the guard intact everywhere except one site.

`src/cli/scope/rule-authority.ts:79`, on a **scoped binding** only:

```ts
forced.set(entry.path, { kind: "write", entry, ...(here ? { expectedLocal: here } : {}) });
```

`here` is the user's **already-edited** local entry. Setting `expectedLocal` to
the edited bytes makes `apply.ts:292`'s check evaluate false by construction, so
the rename at `:311` lands straight over the user's edited `.rboxignore` /
`.gitignore` with no conflict copy and no trash. The only survivor is the path
*string*, recorded at `rule-authority.ts:78` and persisted to
`.rbox/scope-findings.json` (`pull.ts:466`). The bytes are gone.

The module docstring (`rule-authority.ts:53-57`) justifies this: *"keeping a
local rule file alive as a `.conflict` copy would leave the matcher reading the
losing bytes."* **That justification is false.**
`conflictName(".rboxignore", …)` mints `.rboxignore.<device>.<ts>.conflict`
(`src/engine/conflict-name.ts:8-13`; `path.posix.extname` returns `""` for a
leading-dot basename), and `isIgnoreRuleFile` (`src/engine/ignore.ts:334-335`)
matches only the exact names `.rboxignore` / `.gitignore`, as does the matcher's
own reader (`ignore.ts:394`). A conflict copy is not a rule file and is never
read.

The same module's forced **delete** counterpart (`rule-authority.ts:90`) lands
in `deleteEntry`'s clean branch and is therefore **trash-preserved**. The
overwrite being the only unrecoverable one is an asymmetry, not a decision.

**Fix:** emit a reconcile-shaped `conflict` action instead of a `write` when the
local copy was edited (`wasEdited`, already computed at `:77`) —
`{ kind: "conflict", path, keepLocalAs: conflictName(path, device, now), entry }`.
That reuses `apply.ts:290-291`'s existing mechanism, keeps remote authoritative
in place (the module's actual requirement), preserves the user's bytes, and — a
bonus — makes the event visible in the plan-derived count as a `!` conflict. The
un-edited case (`here` matches base, or absent) keeps the plain `write`.

### 3.3 (Tertiary) Close the post-hash TOCTOU

`writeEntry` hashes the target at `apply.ts:289`, then does an `lstat`
(`:303-304`) and a `rename` (`:310-311`). A write that lands *after* the hash
and *before* the rename is destroyed with no conflict copy — the one genuine
byte-loss window in the files plane. It is narrow but it is executed once per
written path, and an echo pull writes thousands.

Strengthen the same check rather than add another: capture the stat identity
alongside the hash in `currentEntryAt`, and immediately before the rename
re-`lstat` and compare `(mtimeMs, size, ctimeMs)`. Any concurrent write changes
ctime, which userspace cannot restore. On mismatch, take the same
preserve-then-publish path as `:292-295` (and report it via §3.1). This shrinks
the window from "one lstat + scheduling" to "one syscall" using the identity
triple the hash cache already trusts for exactly this purpose
(`src/engine/hashcache.ts:9-15`).

We do NOT attempt to close the window absolutely. Doing so needs a lock or
`renameat2(RENAME_EXCHANGE)`-plus-verify; neither is a boring, portable
primitive here, and the residual is a single syscall. This is a named,
deliberate residual.

### 3.3 Explicitly rejected

- **Make apply defer writes for scan-deferred paths.** Tempting (an unobserved
  path has no reconcile answer, so inventing one is wrong), but it requires the
  pull's base advance to *not* record the un-applied remote entry, or the next
  pull sees `remote == base` and never retries. That reopens design 108's
  hazard, which `src/cli/sync/pull.ts:246-253` documents as the reason pull acts
  on no deferred set. Out of scope for a pre-2.0 data-safety fix; revisit only
  with a proper per-path base-carry design.
- **Invert the conflict copy so the REMOTE lands beside and local stays in
  place.** Better felt UX, but it contradicts `reconcile.ts:71`'s conflict model
  (remote wins in place, local kept aside) and would give the two paths
  different winners. One owner, one rule.
- **Suppress the conflict copy when the incoming bytes came from this device's
  own earlier publish.** Requires per-entry provenance rbox does not carry, and
  §2 shows a pure echo plans no action anyway.
- **Gate on `size` in `sameContent`.** Deliberately excluded (`diff.ts:32-34`);
  changing it would manufacture conflicts for already-correct bytes.

## 4. Invariants

1. Every files-plane overwrite or delete is preceded by a fresh hash of the
   target; on any mismatch the current bytes reach a `.conflict` copy before the
   remote is published. (Existing; unchanged.)
2. **New:** every conflict copy the apply phase creates is reported exactly once
   through `onConflictCopy`, and appears in the pull's forensic log line and in
   `lastPull.conflicts`. Silence from the reporting path means no copy was made.
3. No double counting: a reconcile-planned `kind:"conflict"` action is counted
   by the plan; an apply-time precondition copy is counted by the callback;
   never both for the same path in the same apply.
4. A reporting failure must never fail a pull that has already mutated disk
   (same rule the existing observability hooks follow, `pull.ts:491-498`).
5. `applyActions` remains the sole files-plane mutator with this guard; nothing
   gains a bypass.

## 5. Regression test plan (RED first, deterministic, no rig)

All tests are unit/contract level with an injected clock and a fake remote — no
rig, no fleet, no timing sleeps.

1. **`src/engine/apply-safety.test.ts` — write path (RED first).**
   `expectedLocal` describes bytes that differ from what is on disk; assert
   `onConflictCopy` fires exactly once with the target path and the *claimed*
   copy name, that the copy holds the pre-apply local bytes, and that the target
   holds the remote bytes. RED today: no such option exists / the callback never
   fires.
2. **Same file — delete path (RED first).** A propagated delete whose target
   changed under it must report through the same callback.
3. **Same file — the `~2` collision case.** Two mismatching writes to one path
   in the same second: the reported name must be the one that actually exists
   (`claimUnclobberedName`'s suffixed name), not the unsuffixed base name.
4. **Same file — no false positives.** A clean-precondition write and a
   reconcile-planned `kind:"conflict"` action each fire `onConflictCopy` zero
   times (invariant 3).
5. **`src/cli/sync/sync-scan-defer.test.ts` — the #535 scenario end to end
   (RED first).** Extend the existing pinned test at `:196-213` (churning path
   deferred, remote changed): today it asserts only that the copy exists; add
   that the pull surfaced it. This is the exact field scenario in §1.1.
6. **`src/cli/daemon/daemon-activity.test.ts` (or the nearest daemon activity
   suite) — the field log line (RED first).** Drive a pull whose apply makes one
   precondition copy and assert the forensic line does **not** read
   `… 0 conflict` and that `lastPull.conflicts` is 1. This is the literal
   regression from `daemon-2026-08-15.log`.
7. **`src/cli/scope/rule-authority.test.ts` — §3.2 (RED first).** A scoped pull
   whose local `.rboxignore` was edited must leave those bytes in a conflict
   copy and the remote rules in place; assert the copy's name does NOT satisfy
   `isIgnoreRuleFile`, and that a rebuilt matcher reads the remote rules. Also
   assert the un-edited case still plans a plain `write` (no gratuitous copy).
8. **TOCTOU (§3.3), deterministic.** Using the existing
   `overrideHashFileForTests` seam (`src/engine/hash.ts`, already used by
   `manifest-torn-scan.test.ts`), inject a write to the target *after* the
   precondition hash returns. Assert the injected bytes survive as a conflict
   copy rather than being destroyed by the rename. RED today.

## 6. Protected behavior (must not regress)

- Byte preservation on every mismatch — unchanged, only now reported.
- Reconcile's three-way outcomes and the remote-wins-in-place conflict model.
- The deferred-set policy on pull (`pull.ts:246-253`) and design 108's
  resurrection-not-deletion direction.
- Trash routing for clean propagated deletes and directory type-flips.
- `onTypeFlip` semantics and its existing fold into `lastPull.conflicts`.
- Mass-delete guard, mutation-gate leases, `assertWithinRoot`, atomic-rename
  publish, and the download/decrypt pool's concurrency behaviour.
- Design 272's oracle stays name-grammar-based; §3.1 adds a report, it does not
  change what the oracle excludes.
