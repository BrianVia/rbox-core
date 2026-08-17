# 273 — Git-lane legibility: one evidence model, plain-English surfaces

Status: DRAFT (feasibility recon in flight)
Issues: closes #764; carries #762 (quarantine pointer) and the
resolve-command.ts ratchet split as its vehicle. Feeds #659 field close.
Origin: founder session 2026-08-17 (docs/papercuts.md git-lane entry) plus
Max's report that "keep-mine / take-theirs meant nothing".

## Product bar (verbatim requirement)

A user WITHOUT an LLM must be able to go from the status warning to a
confident resolve decision using only rbox's own output. Every surface
answers three questions: **what happened** (story), **what do I do**
(action), **what could I lose** (risk). Copy reads like a person explaining
it to a friend — no internal vocabulary ("index drift", "deferral",
"held refs") ever reaches a human surface.

## Defects being fixed (founder-hit, 2026-08-17)

1. `rbox status --git` ellipsizes repo paths — the one identifier the user
   needs to act.
2. Headline count (103) ≠ listing count (52): held repos are counted but
   never listed anywhere, human or JSON.
3. Reason labels are jargon minted by regex-parsing human message strings
   (`doctor-cmd.ts` `gitReasonOf`) — doctor and status can drift.
4. No dry-run, no batch resolve: a fleet-scale unwedge is N hand-typed
   commands with no preview.
5. "keep-mine / take-theirs" names neither machine (Max): the user cannot
   tell whose work each verb keeps.
6. No evidence: neither side's actual changes (files, commits, overlap) is
   shown, though the facts exist locally.

## Design

### D1. One evidence model, adapters render it

A single builder (the git-triage evidence Module) produces, per paused
repo, a typed record:

- `path` (workspace-relative, never truncated on any surface)
- `story`: one of a closed set (below) — typed data, not regex-derived
- `pausedSince` (oldest deferral/hold timestamp)
- `local`: branch; up to 5 changed files `{rel, mtime, +adds, -dels}` vs
  the last-synced BASE, plus `moreCount`; or local commit count + newest
  subject/date when the divergence is commits
- `incoming`: sender device (cached label, id fallback), branch, commits
  ahead, newest/oldest subject+date, touched-file count, overlap count
  with `local` files — served from the `incomingSummary` cached at
  deferral/hold time (F3); degrades field-by-field to branch/oid/date
  when no summary exists (older-binary deferrals)
- `actions`: the two resolve commands with machine-named consequence copy

`rbox status --git`, the status headline, `rbox doctor`'s git check, and
`rbox git resolve --dry-run` are Adapters over this one Module. Doctor and
status may differ in depth, never in facts. The `gitReasonOf` regex parse
is deleted once both consumers read typed stories.

### D2. Story vocabulary (closed set)

| story (code/JSON) | human copy |
|---|---|
| `local-edits` | "you have edits here that were never synced" |
| `local-commits` | "this machine has commits the others never saw" |
| `conflict-copies` | "only conflict copies remain here, so the comparison was skipped" |
| `sync-interrupted` | "a sync stopped partway through" (self-healing family: incomplete-checkout, journal-recovery) |
| `settle-failed` | "the last sync couldn't finish settling — your prior state is in the backup" (artifact) |
| `other` | raw curated detail passes through (bounded, from GitDeferral.detail) |

Story codes are code symbols + JSON fields only (shape-names ruling: no
persisted/wire renames; existing wire reasons stay as-is, mapping happens
at render).

### D3. Headline

```
⚠ rbox paused git sync in 103 repos to protect changes you made here · rbox status --git
```

One number; the listing accounts for all of it (deferred + held in the
same population, grouped by story). Singular/plural handled.

### D4. `rbox status --git` — grouped listing with two-sided evidence

Grouped by story; explanation + the two commands printed once per group;
full paths always; per-repo evidence lines beneath:

```
rbox paused git sync in 103 repos. Your files are safe — rbox stops
syncing a repo rather than overwrite work you did on this machine.

98 repos — you have edits here that were never synced
     keep this machine's work (flat-meadow):   rbox git resolve keep-mine <repo>
     take the newer version from via-desktop:  rbox git resolve take-theirs <repo>
       (flat-meadow's edits are backed up first — nothing is deleted)

   conductor-workspaces/acme/checkout-flow        paused 3 days
     This machine (flat-meadow, on main):
       - src/routes/pay.ts            (edited Aug 14, +123 -24)
       - src/lib/stripe-session.ts    (edited Aug 14, +8 -0)
       ... and 9 more files · rbox status --git conductor-workspaces/acme/checkout-flow
     Incoming (via-desktop, on main — 4 commits ahead):
       newest: "fix stripe webhook retry"  (Aug 16)
       touches 12 files, 3 overlap with your edits ⚠
```

Rules:
- File evidence capped at 5/repo; truncation lines always name the exact
  command that shows the rest (no dead ends). `rbox status --git <repo>`
  shows one repo uncapped.
- Branch mismatch is its own warning line when local ≠ incoming branch.
- Overlap count is the lead risk number; 0 overlap renders as
  "no overlap with your edits".
- Long groups may truncate the repo LIST (`--all` shows every repo), never
  a path, never below the count.
- `--json` carries the full evidence model for every repo (both
  populations) — fixes defect 2 for machines too.

### D5. Doctor's git check

Summary altitude over the same model:

```
git · 103 repos paused
  98 — you have edits here that were never synced
   5 — a sync stopped partway through (self-healing)
  oldest paused: 3 days · full detail: rbox status --git
```

### D6. Resolve: machine-named copy, dry-run, batch

- All resolve prose names actual machines. Verbs `keep-mine`/`take-theirs`
  are stable and unrenamed (scriptable path); the sentences around them
  carry names.
- `--dry-run` per repo: what would be taken/kept, from which machine, the
  file list that would be backed up, and the exact quarantine destination
  path (this delivers #762's pointer):

```
Would take the incoming version from via-desktop (newer by 2 commits).
Would first back up 3 files you edited here to:
  ~/.rbox/quarantine/checkout-flow-2026-08-17/
Nothing was changed (dry run). Drop --dry-run to do it.
```

- Batch: `rbox git resolve <verb> --group <story>` and `--all`. Always
  prints the full per-repo dry-run table first, then requires one typed
  `yes` (interactive) or `--yes` (scriptable twin). Batch never mixes
  stories unless `--all`.

### D7. resolve-command.ts split (ratchet)

resolve-command.ts sits at its size-ratchet ceiling. This design is the
decomposition vehicle: the evidence/dry-run rendering lands in its own
module; the ratchet pin is restored/lowered, not re-pinned upward
(no-ratchet-repins rule).

## Feasibility ledger (recon complete, 2026-08-17)

- **F1 — sender identity: NOT locally available today.** `GitSection` and
  sync state carry no device id; human labels exist only server-side
  (`GET /v1/auth/devices`, never cached). Design response (two optional
  additions, wire-compatible):
  - persist the sender `deviceId` with the incoming section when a pull
    lands/holds it (the wire commit bodies already carry it —
    `e2ee-remote.ts` history/head responses);
  - cache the device-label directory locally, refreshed opportunistically
    whenever `rbox auth devices` or a sync round trip sees it. Render
    fallback chain: label → device id → "another machine". The display
    never blocks on a missing name.
- **F2 — incoming refs/head/branch: YES, offline.** `record.pending` is a
  full `GitSection` (refs, head, `generatedAt`); branch label already
  flows as `deferral.checkout`. "sent Aug 16" = `generatedAt`.
- **F3 — incoming subjects/ahead-count/file list: NOT offline today.**
  Incoming objects are imported into the repo odb during staging, then
  unreferenced (gc-eligible); recomputation requires network re-staging
  from the remote blob store. Design response — **compute the incoming
  summary at deferral/hold time**, the one moment the objects are
  guaranteed local, and persist it as a small optional record field
  (`incomingSummary`: commits ahead, newest/oldest subject+date,
  touched-file list capped, sender deviceId from F1). Render reads the
  cache; no network in `status --git`. Repos deferred by an *older* binary
  have no summary and degrade to the F2 tier (branch/oid/date only).
  Overlap count = cached incoming file list ∩ local numstat list,
  computed at render.
- **F4 — local BASE: YES.** `RepoRecord.base` / `lastSyncedManifest.gitRepos`
  is the diff base; read-only repo helpers exist (`repoCtxFromDisk`,
  `git()` spawn with `GIT_NO_LAZY_FETCH=1`). Local-only commit subjects
  are already computed in resolve (`localOnlyCommits`, cap 50). A
  `numstat` helper is NEW (zero hits in tree) — one `git diff --numstat`
  vs BASE per paused repo, in the manual command only.
- **F5 — held repos: recorded but invisible.** `partial.heldRefs`
  (per-ref hold reason) and `attempt` (typed blockers, `at` timestamp)
  exist on the record, but NO surface reads them, and ownership-only
  holds actively CLEAR their deferral (`follow-repo-transition.ts:349-357`)
  — held repos are unrecoverable from any deferral-driven view. This is
  the root cause of defect 2. `partial` has no timestamp; `attempt.at` is
  optional. Design response: population = deferrals ∪ held
  (pending+heldRefs), with `heldSince` added as an optional field at the
  hold-writing site; missing timestamps render as "paused" without an age.

### Recon corrections to earlier assumptions

- The 103 vs 52 split has TWO mechanisms: (a) the ambient/daemon count is
  unfiltered while the CLI listing applies a 10-minute transient quiet
  filter (`status-projection.ts:60-70` vs `ambient-status.ts:271-275`,
  doctor unfiltered too) — D1 defines ONE shared population rule all
  surfaces use; (b) ownership-only held repos (F5).
- `doctor-cmd.ts` `gitReasonOf` parses daemon LOG tail lines (for
  redaction), whose grammar is byte-frozen against
  `renderGitDeferralLine` (`status-view.ts:461`). The listing rewrite must
  either keep that emitted log-line grammar stable or move the classifier
  onto typed records in the same PR — silent drift breaks log redaction.
  Doctor's user-facing git findings are ALREADY typed
  (`doctor-triage.ts:98-118`); D5 builds on that, not on the regex.
- Current path truncation: `DETAIL_MAX = 40`, tail-keeping
  (`status-view.ts:520-533`) — the thing defect 1 deletes for repo paths.
- resolve-command.ts is at 1155 lines with ~10 BYTES of ratchet headroom
  (`file-size.test.ts:142`); D7's split is a hard prerequisite for any
  resolve copy change, not a nice-to-have. Presentation already lives in
  `resolve-presentation.ts` (156 lines) — the split grows that seam.

## New persisted state (requirement ledger)

All optional, additive, sourceVersion unchanged; older binaries ignore
them; missing values degrade the display, never block it.

| Field | Owner (single writing site) | Deletion condition |
|---|---|---|
| `RepoRecord.incomingSummary` (sender deviceId, commits ahead, subjects, capped touched-file list) | the deferral/hold-writing site in sync-git (same discipline as `GitDeferral.detail`) | if a future design makes incoming objects durably local, render reads git directly and the cache is deleted |
| `heldSince` on the hold record | the hold-writing site (`follow-repo-transition.ts` / `apply.ts` hold paths) | folds into any future unified pause record |
| local device-label cache | one refresh site fed by `GET /v1/auth/devices` | if labels ever join the signed roster, the cache is deleted |

## Protected functionality

- Resolve output sanitization contract (git-cmd.test.ts redaction block):
  no raw Error.message ever printed. All new copy goes through the same
  curated path.
- Existing resolve verbs, flags, exit codes; typed refusal codes and their
  271 copy.
- Wire shapes: no new required fields; sourceVersion stays 1. New JSON
  fields optional. SERVER_GIT_DEFERRAL_REASONS untouched (no new wire
  reasons — stories are render-side).
- Status/doctor sections consumed by telemetry ingest stay parseable.
- The daemon log line grammar parsed by `classifyGitLogMessage` for
  redaction (`doctor-cmd.ts:237-276`) either stays byte-stable or the
  classifier moves to typed data in the same PR — never silent drift.
- Perf: `status --git` is a manual command; one git invocation per paused
  repo is acceptable at ~100 repos, and file evidence degrades to counts
  if a repo's git call fails or exceeds budget. The steady-state sync loop
  is untouched.

## Non-goals

- No sweep/auto-resolve policy change; resolve remains explicit.
- No wire/persisted renames (docs/wire-rename-candidates.md gets any
  candidates).
- Per-commit machine attribution inside git history (git has no such
  fact); "from <device>" means the sender of the held version.

## Validation

- Differential: existing status/doctor/resolve tests updated to the new
  copy; superstring/ordering invariants preserved (272's
  first-includes() lesson).
- Population invariant test: headline count == sum of group counts ==
  human listing accounting == `--json` record count, on a state with both
  deferred and held repos.
- Dry-run invariant: `--dry-run` performs zero writes (state, git,
  quarantine) — asserted by fs snapshot in tests.
- Batch: preview table lists exactly the repos the verb then touches;
  `--yes` twin covered (scriptable-path posture).
- Rig: extend/reuse pull-only-conflict-copies scenario arms for a
  two-sided evidence render; field check on FM's real 103-repo state
  before close (the founder's own decision replayed through the new
  output is the acceptance test).
