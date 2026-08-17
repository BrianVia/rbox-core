# Field-state fixtures (real fleet captures)

Captured 2026-08-17 (UTC ~12:05-12:10) from the founder fleet's live
`repo_records` tables (every row carrying deferrals/partial/attempt/pending),
by founder request: "grab the state of FM and my current hosts and make the
divergences into a test suite."

One JSON object per line: `rel`, `deferrals` (per-lane GitDeferral),
`partial` (GitPartialApply incl. heldRefs), `attempt` (GitHeldAttempt),
`repoAbsent`, `hasPending`/`pendingHead`/`pendingGeneratedAt` (from
pending_cjson), `hasBase`. Paths are the founder's real workspace paths —
private repo, deliberately kept legible.

| file | rows | shape |
|---|---|---|
| 2026-08-17-flat-meadow.jsonl | 52 | 43 local-index + 5 artifact + 2 unreadable + 2 local-edits apply deferrals; 47 attempts; 4 repos with heldRefs (85 refs, all local-commits); all 52 have pending |
| 2026-08-17-mac.jsonl | 3 | 3 local-index apply deferrals (one mid-rebase with a large op-state blocker detail) |

(via-desktop captured clean — 107 records, zero paused — so it has no file.)

Recorded human output at capture time, for reconciliation tests:
- FM `rbox status` headline (night of 2026-08-16): "103 git repos need
  attention (oldest: 1 day)" while `--git` listed 52 — the fixture holds 52
  records, so the projection replay must either reproduce 103 (explaining
  the mechanism) or prove the headline defective (GH #764 defect 2).
- Mac at capture: "3 git repos need attention (oldest: 2 days)" — matches
  the 3 rows.
- FM shell sidecar `.rbox/state/shell.deferrals` held 51 lines (50-row
  bound + overflow aggregate).

Intended use (design 273 PR-B): load each file into a SyncState
repo-records shape, run the extended git projection, and assert
- every record maps to a story with no banned jargon rendered,
- headline count == group sums == JSON record count,
- ownership/held populations are visible,
- the FM 103-vs-52 reconciliation above.

These are point-in-time snapshots, not living state; do not "refresh" them
in place — add new dated captures alongside if the fleet state changes.
