# "Stupidly simple" clarity audit — 8 flows, every screen graded (2026-07-17)

Scorecard against the bar "so clear a nontechnical person could use it":
**12 instantly-clear · 21 needs-context · 36 confusing** (69 screens graded).

## The audience caveat (read first)

rbox targets developers, and the two audits agree in an instructive way: the
Max-persona *praised* the dense `rbox` front door that this audit grades
"confusing." The takeaway is NOT to flatten the reference for lawyers — it's
that the audit cleanly separates three kinds of words:

1. **Industry-standard dev terms** (gitignore, repo, CLI flags) — fine for
   this audience. No action.
2. **rbox-invented coinage used with zero explanation** — "workspace" (51
   mentions), "pairing token" (14), "kit", "drift", "pull-only", "genesis".
   Even developers meet these words for the first time in our screens. Each
   needs ONE inline gloss at first contact per flow — not renaming.
3. **Debug artifacts leaking into human output** — raw `ws_…`/`acct_…` ids,
   `expires in 600s`, `pid 695`, `seq 4646`, `[input is masked]`, `[builtin]`
   spam in `ignore --list` (63 occurrences). These read as broken to
   EVERYONE, including developers. All should go from human-facing lines
   (keep them in `--json`/`--verbose`).

## Worst screen per flow

1. fresh-setup: the browser-handoff "URL" printed as a bare relative path —
   known harness artifact (blanked RBOX_APP), and 137-R2 hardens it; real
   users see the full URL today.
2. second-device: the gitignore-handling question leaks CLI flag names
   (`--respect-gitignore`, `.rboxignore`) into wizard prose.
3. help-surfaces: bare `rbox` — no one-line "what rbox is/does" above the
   reference table (the table itself should stay dense).
4. status-and-logs: `rbox logs` — sequences, pids, internal ids, engineer
   telemetry presented as the default human view.
5. gitignore-step: same screen as flow 2 (independent confirmation).
6. error-messages: "malformed pairing token (expected `rbox-pair_<id>.<secret>`)"
   — a format spec instead of "where to get a real one".
7. approve-code: the waiting screen has NO visible cancel/back affordance
   (Ctrl-C/Escape swallowed) — overlaps 137-F3's menus but the waiting
   state itself needs an explicit "press q to go back" line.
8. recovery-menus: "Paste pairing token [input is masked]" — bare input, no
   example, no visible way out (137-F3 fixes the way out; the hint line is
   copy).

## What 137 already fixes (in flight — no action)

Full URL with host (R2), the merged Enter/bootstrap-secret prompt (R5),
menu-return instead of dead-ends (F3), workspace-id hint line, burned-token
guidance, "nothing was available to pull" (R4).

## Proposed follow-up: design 139 "plain words pass" (copy-only, ~1 day)

P1 (reads-as-broken class):
- `expires in 600s` → `expires in 10 minutes` (everywhere durations print).
- Strip raw `ws_`/`acct_` ids, pids, and `seq N` from default human output
  (status/logs); keep under `--json`/`--verbose`. (acct_ was already done in
  design 117 for identity banners — finish the job for workspaces/status.)
- `ignore --list`: collapse the [builtin] block to one line —
  "15 built-in secret patterns (.env, *.pem, keys…) — always protected".
- Remove `[input is masked]` annotations; masked inputs get "(typing is
  hidden)" once.
- Waiting-for-approval screen: visible cancel line.

P2 (first-contact glosses, one line each, wizard only):
- workspace → "a folder rbox keeps in sync" at its first wizard mention.
- pairing token error → "get one by running `rbox pair` on your other
  machine" instead of the format spec.
- gitignore choice screen: keep the semantics, drop flag names from the
  prose (flags stay in help).
- Bare `rbox`: one plain sentence above the table ("rbox keeps your project
  folders in sync across machines, end-to-end encrypted.").
- Pick ONE of device/machine and use it consistently (audit found both,
  interchangeably, sometimes same screen).

P3 (defer/judgment): welcome tagline, "kit" naming, deeper logs redesign.

Full per-screen verdicts + rewrites: scratchpad/clarity-findings.md.
Transcripts: scratchpad/clarity-transcripts/.
