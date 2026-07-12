# 108 — Scan fault isolation + mass-delete circuit breaker + dev-install hygiene

Status: implementing. Urgent robustness cycle after the 2026-07-12 near-miss.

## The incident (ground truth)

`bun scripts/dev-install.ts` left a 92 MB, mode-000 temp file
(`.18c18fbfffaeffbf-00000000.bun-build`) inside the synced workspace. The
daemon's next scan tried to hash it and hit `EACCES`, and the WHOLE scan threw.
`rbox status` reported **126,557 local changes to sync (126,557 deleted)** and
the foreground `rbox status` crashed outright with the EACCES.

### Exact pre-fix failure path (how EACCES became 126,557 deletions)

1. **Scan throws, not defers.** `scanManifest` walks the tree; the mode-000 file
   `fs.stat`s fine (stat needs search on the parent dir, not read on the file),
   is a cache miss, and is queued for hashing. In `drainHashes`
   (`src/engine/manifest.ts`) the worker does `const sha256 = await hashFile(...)`
   with **no try/catch** — `hashFile` streams the 92 MB file, the read `EACCES`es,
   the worker rejects, `Promise.all(...)` rejects, `scanManifest` rejects. A
   single unreadable file aborts the entire scan.
2. **Empty manifest → phantom mass delete.** The daemon starts its activity +
   ambient heartbeats (`daemon.ts` `start()` lines ~380-381) **before** the
   initial scan (line ~389). `this.manifest` is initialised empty
   (`{ generatedAt: "", files: [] }`, line 247). Because the scan **throws**,
   `replaceManifestFromScan` never reassigns `this.manifest` (assignment is on
   line 1495, after the scan returns). Every heartbeat then runs
   `localSnapshot()` → **`diffManifests(base.lastSyncedManifest, this.manifest)`
   (daemon.ts line 1168)** = base (126,557 files) vs empty = **126,557 deleted**,
   written to the activity sidecar that `rbox status` reads. The throwing scan
   also crash-loops the daemon (it escapes `start()`, outside the pump's catch).

Had the daemon reached push, the pre-existing push-side mass-delete guard
(design 50 §4) would likely have refused — but it triggered on ≥50% AND ≥100,
and it ran only AFTER encrypt+upload. This cycle hardens all three legs.

## Fix 1 — per-file scan fault isolation (`src/engine/manifest.ts`)

A per-file `open/read/stat/readlink` failure (`EACCES`/`EPERM`/`EIO`/`ENOENT`)
must **DEFER that path** (reuse the existing `deferred` set — the same mechanism
mid-write churn uses) and continue the scan. It must NEVER abort the scan and
NEVER produce a partial/empty manifest silently.

- `drainHashes`: wrap `hashFile` + post-`lstat`; on a deferrable errno →
  `deferred?.add(childRel); continue;`.
- `statHashEntry` (the `applyWatchEvents` hot path): on a deferrable `hashFile`
  error return `{ kind: "midwrite" }` (retry/defer) instead of throwing.
- `walk()` leaf-file `fs.stat` and symlink `fs.readlink`: on a deferrable errno →
  `ctx.deferred?.add(childRel); continue;` (today only a reused-dir `ENOENT`
  continues; broaden to defer on the deferrable set at any level).
- **Scan-level fatal stays loud.** A `readdir`/`lstat` failure on a directory
  (including the workspace root) still throws → `scanManifest` rejects → the sync
  fails loudly. We cannot enumerate an unreadable directory, so failing closed is
  correct; only genuinely per-file faults defer. A mid-scan `ENOENT`/`ENOTDIR` on
  a subdir keeps today's "genuinely gone, continue" behaviour.

Deferral semantics preserve the prior entry: the caller feeds `deferred` to
`deferManifest(local, base, deferred)`, which carries the last-synced entry
forward for a previously-synced deferred path (never a deletion) and omits a
never-synced one. **Critical invariant: a deferred-unreadable file must never
convert to a deletion.**

Privacy: errno-only logging (no paths), via an optional `onDeferErrno(code)`
callback threaded to the catch sites; the daemon aggregates and logs a count +
errno tally (mirrors the `errCode` helper precedent in daemon.ts).

## Fix 1b — daemon phantom-delete guard (`src/cli/daemon.ts`)

Seed `this.manifest = initialState.lastSyncedManifest` in `start()` immediately
after `loadSyncBase()` and before the initial scan, so any heartbeat during the
first-scan window diffs base-vs-base (clean) instead of empty-vs-base (a phantom
full-tree delete). Defence-in-depth independent of Fix 1.

## Fix 2 — mass-delete circuit breaker (`src/cli/sync.ts`, push path)

Move the push-side breaker to run **before any upload/commit work** and
strengthen the thresholds.

- Threshold: refuse when `deletes >= max(PCT% of last-synced count, MIN)` —
  env-overridable `RBOX_MASS_DELETE_PCT` (default **20**) and
  `RBOX_MASS_DELETE_MIN` (default **1000**). Implemented as the two-legged
  predicate `deletes >= min && deletes*100 >= pct*baseCount` (integer-safe,
  equivalent to the `max(...)` form).
- Rationale for `max(pct, min)`: the `MIN=1000` floor means workspaces under
  ~5,000 files (where 20% < 1000) only trip past 1,000 deletes, so a legitimate
  small workspace (50 files, delete 30) is never nagged — its blast radius is
  small. The breaker exists to stop a *fleet-scale* catastrophe (the incident had
  126,557 files); the 20% leg catches large workspaces before a full wipe.
- Placement: compute `diffManifests(appliedBase, local).deleted.length` on the
  pre-upload manifest and abort before `encryptAndUpload`. (Deferral only carries
  base entries back, so pre-upload `local` and post-defer `committed` have an
  identical *delete* count — a churning file shows as a change, not a delete.)
- Override: `rbox push --allow-mass-delete` (→ `deps.allowMassDeletePush`) or env
  `RBOX_ALLOW_MASS_DELETE=1`, wired at the **CLI boundary only** (main-dispatch
  push case + sync-cmd) so the daemon — which never sets it and never reads the
  env for consent — can never override. The op-scoped `allowMassDeletePush` still
  must NOT leak to the 409-recovery pull (design-review B2, preserved).
- The pull-side guard (design 44, 100/50%) is left untouched — different
  direction, smaller blast radius, battle-tested.

## Fix 3 — dev-install hygiene (`scripts/dev-install.ts`)

`bun build --compile` writes its intermediate `.<hash>.bun-build` in the process
CWD (verified: bun 1.3.14 removes it on success but orphans it on
failure/interrupt — exactly the incident). The build runs with `cwd: ROOT`, so
the orphan lands inside the synced repo.

Fix: run the compile in a scratch dir **outside** the workspace
(`fs.mkdtempSync(path.join(os.tmpdir(), "rbox-dev-build-"))`), passing an
absolute entry (`path.join(ROOT, "src/cli/index.ts")`) so module resolution is
unaffected (no bunfig at root; bun resolves node_modules from the entry file),
and `rmSync(scratch, { recursive, force })` in a `finally` so both success and
failure leave the repo clean.

## Validation

- Engine: EACCES-during-hash → path deferred, scan completes, manifest keeps the
  other files; root/dir unreadable → scan rejects (fail loud).
- Push path: deferred-unreadable file → push commits the stable subset, the file
  stays in the committed manifest (carried from base), never deleted.
- Breaker: unit-test the predicate at defaults + an integration push through a
  fake remote (trip + `--allow-mass-delete`/env override); pull B2 non-leak
  regression preserved.
- dev-install: scratch-cwd helper creates outside ROOT and cleans up on throw.

A permanently-unreadable file re-defers on each safety scan (a bounded 15×200ms burst, with one errno-only log per scan); this retry behavior is accepted.
