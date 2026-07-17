# TUI UX walkthrough personas & scenario matrix (v1 — 20 flows)

Every flow = one persona walking one scenario through the scripts/ux harness
against the DEV API. The agent is the user's hands and inner monologue; the
harness is the keyboard and screen.

## Non-negotiable safety rails (every agent, every flow)

- Interact ONLY via `scripts/ux/fresh-machine.ts` and `scripts/ux/tui.ts`.
- Run every rbox command exactly as the emitted prefix dictates (it pins cwd
  into the machine HOME). NEVER run rbox from any other directory.
- DEV API only. Never `api.rbox.to`. Never read or touch `~/Development`,
  `~/.rbox`, or any real workspace.
- Never write secrets/tokens/recovery phrases into transcripts or reports.
- Teardown (tui stop + fresh-machine destroy) ALWAYS runs, even after failure.
- Two-machine scenarios use machine names `a` (owner) and `b` (new device)
  under one run-id; single-machine scenarios use `solo`.

## Personas

- **P1 docs-skipper power user** ("Max"): 20y CLI veteran, reads nothing,
  types fast, expects unix conventions, abandons at the first sign of
  hand-holding that wastes time. Judges copy by whether skimming works.
- **P2 cautious reader**: reads every word before acting, takes each claim
  literally, gets stuck when copy is ambiguous rather than guessing.
- **P3 second-device Ryan**: engineer who set up machine A yesterday, now at
  a second machine, hasn't read docs, remembers roughly that "there was a
  pairing thing". Replays the real Ryan feedback conditions.
- **P4 skeptical secops**: wants to know what leaves the machine, what's
  encrypted, where keys live, before agreeing to anything. Judges every
  screen by "does it earn trust".
- **P5 fumbler**: makes realistic mistakes — typos in tokens, wrong menu
  choice then backs out, Ctrl-C mid-wizard and re-runs, pastes with trailing
  whitespace. Judges recovery paths and error copy.

## Scenarios

- **S1 first machine**: virgin machine → `rbox` (front door) → `rbox setup`
  → genesis/first-machine path, up to (not through) any browser handoff.
- **S2 pairing token**: enrolled machine `a` runs `rbox pair`; virgin `b`
  runs `rbox setup` → "Paste a pairing token". The core Ryan path.
- **S3 approve-a-code**: virgin `b` picks "Approve a code" / device-code
  login; walk to the browser handoff, judge the copy and the dead-end
  behavior, then back out cleanly.
- **S4 existing folder on second machine**: after S2-style enrollment on `b`,
  the user has a project folder that already syncs from `a`; get it syncing
  on `b`. Validates the design-134 next-step chain end-to-end.
- **S5 gitignore step**: seed a git repo with a heavy `.gitignore`
  (node_modules/, .env, dist/) inside the machine HOME; run setup through the
  gitignore choice; judge whether the default and its wording are understood.
- **S6 recovery phrase**: choose "Recover with my 24-word phrase" with a
  plausible-but-wrong phrase; judge prompt copy, error handling, retreat
  paths. (Real phrases are never available to agents by design.)
- **S7 ignore management**: on an enrolled machine with a workspace, use
  `rbox ignore --list`, add a pattern, judge active vs present-but-not-applied
  wording (shipped in 1.6.7).
- **S8 hostile input**: `rbox connect` with garbage token; `rbox setup` with
  mangled pastes; judge every error message by "does it say what to DO next".

## The 20 flows

| # | Persona | Scenario | # | Persona | Scenario |
|---|---------|----------|---|---------|----------|
| 1 | P1 | S1 | 11 | P3 | S4 |
| 2 | P1 | S2 | 12 | P3 | S7 |
| 3 | P1 | S5 | 13 | P4 | S1 |
| 4 | P1 | S7 | 14 | P4 | S2 |
| 5 | P2 | S1 | 15 | P4 | S6 |
| 6 | P2 | S3 | 16 | P5 | S1 |
| 7 | P2 | S4 | 17 | P5 | S2 |
| 8 | P2 | S6 | 18 | P5 | S5 |
| 9 | P3 | S2 | 19 | P5 | S8 |
| 10 | P3 | S3 | 20 | P5 | S8 (setup variant) |

## Per-flow protocol

1. Mint machines (`--enrolled` for `a` where the scenario needs an owner).
   Enrolled creation defaults to the `solo` plan; inherit that default unless
   the scenario explicitly needs a planless account, in which case pass
   `--plan none`. Never pass `--plan` without `--enrolled`.
2. Before EVERY keystroke: write one line of expectation ("I expect this menu
   to tell me where the token comes from").
3. Act only on what the captured screen says. Reading rbox source or docs is
   FORBIDDEN except when the screen itself points at a doc — then say whether
   the pointer was followable.
4. After every screen: capture to the transcript with an action heading.
5. Teardown. Then write the report.

## Report schema (returned as structured output)

- `flow`: number + persona + scenario
- `outcome`: completed | abandoned(where/why) | blocked-by-harness(detail)
- `confusions`: [{screen_excerpt, expectation, reality, severity: blocker|major|minor}]
- `copy_issues`: [{screen_excerpt, problem, suggested_wording}]
- `dead_ends`: [{where, what_was_missing}]
- `delights`: [what worked well — honest, not filler]
- `transcript_path`

## Synthesis (orchestrator, after all flows)

Dedup by (screen, problem); a finding reported independently by ≥2 personas
is auto-promoted; single-persona findings get adversarially checked against
the transcript. Output: ranked UX backlog with severity × frequency, feeding
the next design number.
