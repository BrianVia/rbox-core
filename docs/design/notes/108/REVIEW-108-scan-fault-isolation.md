# Design 108 review rounds — scan fault isolation + mass-delete breaker + dev-install hygiene

Adversarial loop: Claude (fable-5) spec/adjudication ↔ codex (gpt-5.6-sol medium) review.

## Round 1 — codex adversarial review of the initial implementation

Verdict: CHANGES REQUIRED (2 CRITICAL, 4 MAJOR, 2 MINOR).

| # | Sev | Finding | Adjudication |
|---|-----|---------|--------------|
| 1 | CRITICAL | `statHashEntry` maps every lstat failure (incl. EACCES/EPERM/EIO on an unreadable parent) to `gone`, which `applyWatchEvents` converts to a manifest deletion; `unlinkDir`'s lstat catch drops the whole `rel/**` subtree on the same fault. | VALID — fixed (round 2, Fix A): ENOENT/ENOTDIR = gone; deferrable faults → `midwrite`/defer, entries retained. |
| 2 | CRITICAL | `purgeIgnored` scans with NO deferred set: a scan-faulted path is silently omitted, counted as purged, and published as a deletion (below breaker threshold). | VALID — fixed (Fix B): deferred set + `deferManifest` carry before computing the purge candidate. |
| 3 | MAJOR | Pull's counting-only deferral can resurrect a remotely-deleted file that was locally unreadable during the pull scan (base advances; once readable it re-publishes). | DECLINED — pre-existing, deliberate semantic (same window exists for mid-write churn since design 85); the failure direction is resurrection, never deletion. Feeding base-carried entries into reconcile would instead plan disk deletes against unreadable paths. Documented in code. |
| 4 | MAJOR | `sync-git` `dirPresent` `.catch(() => false)`: a permission/IO fault on the repo dir lstat reads as "gone entirely" and drops the git section fleet-wide, invisible to the file breaker. | VALID — fixed (Fix C): ENOENT/ENOTDIR = absent; other faults carry the base section via `deferOne`. |
| 5 | MAJOR | `rbox recover --allow-mass-delete` sets only pull-side consent, but recover repair-publishes — the push guard can block it despite the flag. | VALID — fixed (Fix D): recover's one flag grants both consents (same pattern as `rbox sync`); env push-consent honored. |
| 6 | MAJOR | No real-filesystem coverage of the incident shape (mode-000 file/dir). | VALID — fixed (Fix E): real chmod-000 file-defers + dir-fails-loud tests (skipIf root) + watcher stale-unlink EACCES regression. |
| 7 | MINOR | Permanently-unreadable file re-triggers a bounded 15×200ms retry burst after every safety scan. | ACCEPTED as-is (bounded; errno-only log once per scan). Noted in design doc. |
| 8 | MINOR | dev-install's changed compile mode not smoke-tested end-to-end. | DECLINED — a real `--compile` smoke embeds the Bun runtime (~90 MB binary) per CI run; scratch-cwd mechanics and cleanup are unit-tested, bun's temp behavior verified manually on bun 1.3.14. |

Also confirmed by round 1 (no action needed): all commit routes (normal push, daemon,
purge, init, repair, 409-rescan, 422-reupload) converge on the pre-upload breaker;
encrypt-time disappearance defers and carries base (no TOCTOU growth of the delete set
between breaker check and commit); hashFile's small-file→stream fallback preserves errno
codes; `src/engine/generated` output is ignored.

## Round 2 — codex re-review of the fixes + rebase interaction

Verdict: **ALIGNED** (no blocking findings).

Verified: all five round-1 fixes correctly implemented (statHashEntry's three fault
sites incl. readlink; unlinkDir subtree preservation; purge deferred-carry; sync-git
deferOne carry; recover dual consent; real chmod-000 + stale-unlink tests). Rebase
interaction with main's darwin getattrlistbulk walker (#241) checked: `BulkStat`
satisfies the `FileStatLike` contract, bulk-statted files funnel into the normal
hash queue (EACCES hash faults still defer), and every bulk failure mode returns
`null` → ordinary readdir path → unreadable dirs still fail loudly. Design-105
daemon changes (#242) undisturbed; manifest seeding and errno tally correctly placed.

Non-blocking caveat (accepted): not every lstat/readlink branch has direct fault
injection; the chmod-000 + stale-unlink regressions cover the incident shapes and
the uncovered branches are safety-directed.

## Round 3 — /simplify (4-angle cleanup) + scoped /antislop sweep

Four parallel quality reviews (reuse / simplification / efficiency / altitude),
fixes applied via codex:

- Reuse: `envPosInt` replaced with the fleet-wide `envInt` (stricter parsing);
  daemon's inline errno tally replaced with `makeDeferErrnoReporter(log)` via a
  new optional sink param (format drift eliminated).
- Efficiency: the breaker's duplicate `diffManifests(appliedBase, local)` hoisted
  to share the `filesUnchanged` diff — one O(n) diff per push attempt, not two.
- Altitude: the absence-vs-fault distinction named ONCE as
  `isPresentButUnreadableError` ({EACCES, EPERM, EIO}) in the engine, used by
  statHashEntry (three sites; dead ENOTDIR clause removed), applyWatchEvents
  unlinkDir, and sync-git's dirPresent classifier (was a parallel hand-rolled
  copy). `deferWalkFault` dedups the three walk() catch bodies.
- Tests: env save/restore boilerplate hoisted to beforeEach/afterEach.

Deliberately skipped (noted): a `scanManifestWithCarry` wrapper for the four
scan+carry call sites (worthwhile follow-up, not an urgent-PR refactor); a
`cliPushConsent` helper (the flag||env triplication at the three CLI entry
points IS the deliberate B2 boundary design); a shared hash-mock test factory
(divergent injection semantics). Scoped antislop sweep: clean (no debug
leftovers, no `as any`, new files well under the size bar).

Final validation: tsc clean; `bun test ./src/` = 1413 pass / 6 skip / 2 fail —
both fails are the known host-only flakes (shellStateOf status --json, same-SHA
metadata heal), identical pre-branch.
