# TUI UX walkthrough report — 20 persona×scenario flows (2026-07-16)

20/20 flows completed by developer-calibrated persona agents driving the real
wizard in isolated containers against the DEV API (v1.6.8 candidate source).
Raw: 19 blockers / 47 majors / 16 minors / 38 copy issues / 71 delights.
After dedup, code verification, and harness-artifact attribution, the real
product findings rank as follows.

## P0 — real, confirmed, ship-a-fix

**1. Tilde is never expanded at the directory prompt** (flows 11, 18 — code-
confirmed at `setup-cmd.ts:451`, raw string used verbatim). Typing `~/proj`
creates a literal `./~/proj` directory and binds a workspace to it. Ryan's
exact goal path (get my folder syncing on machine B) dies here. Fix: expand
`~`/`~/` at the prompt boundary (and reject bare `~` ambiguity).

**2. A typo'd directory silently mints a phantom workspace that consumes the
plan's only workspace slot** (flow 18). The wizard accepted a misspelled dir,
created it on disk AND server-side, then every clean retry failed with
"Workspace limit reached — upgrade with `rbox subscribe solo`". A typo →
pay-to-fix message, with no user-facing workspace delete/free path shown.
Fixes: (a) confirm before creating a directory that doesn't exist ("myproect
doesn't exist — create it?"), (b) a user-facing workspace remove/rename
command or at minimum quota-error copy that names the recovery path.

**3. The wizard exits where an engineer expects a re-prompt** (flows 2, 4, 7,
19 — all four "silent crash" reports are this). Empty workspace-id, declining
the rebind confirm, and malformed pairing tokens all END the wizard (some by
design, printing a final message the closing pane hides; the malformed-token
path needs verification of whether it re-prompts or exits). Every one forces
a full `rbox setup` re-run. Fix: re-prompt on invalid/empty input; on decline
paths return to the choice menu instead of exiting. (Idempotent re-entry was
praised — "skipping account setup" — but re-entry isn't a substitute for not
being ejected.)

## P1 — real, high-value

**4. Workspace-id manual entry is a bare prompt** (flow 2). When the account
has no (or unknown) workspaces the picker degrades to "Workspace id to sync"
with no hint, example, or "find it with `rbox list` on your other machine"
pointer — the only prompt in the wizard with no help line. If the account
truly has zero workspaces, say that instead of asking for an id.

**5. No recovery-phrase route from a virgin machine** (flows 8, 15). The
authorize menu offers pair/browser/approve only; the 24-word recovery option
only appears after authorization. A lost-all-devices user cannot see how
their phrase helps. Fix is copy/routing: a "lost access to your other
machines?" line pointing at the browser-signin→recover path.

**6. First-machine browser handoff has no true no-browser path** (flows 5,
13). "I'll approve it another way" just re-renders the same waiting screen;
the only alternative requires an already-signed-in machine — circular for a
genesis user. Also "Copy URL to clipboard" gives no visible confirmation.

## P2 — polish

**7. Design-134's next-step line prints mid-wizard** (flows 2, 11): "Run
`rbox setup` and choose…" appears while the user is INSIDE setup, one line
above that exact menu. Suppress when invoked from the wizard.
**8. RBOX_APP='' robustness**: `?? PROD_WEB` doesn't catch empty-string env
(`auth-cmd.ts:226`) — the bare `/cli-login?code=…` URL every persona flagged
is a harness artifact, but `||` hardening is one character. Secops persona
also wants the target host named on the approve screen.
**9. "0 pulled, 0 conflict(s)"** on a brand-new empty workspace reads as a
result when nothing was expected to transfer (flow 7); one clause fixes it.
**10. Merged Enter/bootstrap-secret prompt** (flows 1, 15): "Press Enter to
sign up in your browser (advanced: enter an account bootstrap secret)" does
double duty in one masked line.

## Harness artifacts (not product bugs)

- Bare relative approve-URL: caused by the harness blanking RBOX_APP (see #8).
- "Silent" wizard deaths: panes close on child exit before the final screen
  can be captured. Harness fix: tmux `remain-on-exit on` + final-screen
  capture in `tui.ts`, then re-test flow 19's malformed-token behavior.

## What the personas loved (keep these)

- The bare `rbox` front door: dense, unix-style, zero hand-holding (Max
  persona: "exactly what a 20-year CLI veteran wants").
- Design-134's pairing-token provenance line, verbatim praised: "answers
  'where does this token come from' in one manpage-terse line, no doc link".
- Step N-of-M headers with checkmarked prior answers; masked token input;
  idempotent setup re-entry; the 600s expiry stated up front; the builtin
  secret-pattern layer (.env protected even when gitignore syncing is on).

## Suggested next cycle (design 137: setup-wizard resilience)

P0 items 1–3 + P1 item 4 as one codex bundle with wizard-level tests; items
5–10 as riders. Harness remain-on-exit fix rides any PR. Transcripts:
scratchpad/ux-transcripts/flow-*.txt (some agents wrote to the worktree —
flow-1.txt noted its own path).
