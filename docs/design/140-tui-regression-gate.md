# 140 — TUI regression gate: deterministic walkthrough assertions as a release gate

v2 — all fourteen Round-1 findings accepted (f1/f6/f7 modified); rulings at
end. Round 1's assertability audit is the contract baseline.

## Problem

Persona walkthroughs find UX defects but are exploratory, judgment-based,
and not a gate. A fixed defect's non-regression must be provable like code:
deterministic, cheap, exit-code semantics, run per release candidate.
Design 137's six failing persona flows are the first payload.

## Mechanism

### Layer split (pinned)

Deterministic scripted flows = THE gate (this design). Persona/clarity agent
workflows = exploratory tools, out of scope.

### Flow DSL — a discriminated step union (f3)

`scripts/ux/flows/*.flow.ts` export typed flows. Step kinds (every
machine-owned step REQUIRES `on`):

- `{on, exec: string[]}` — rbox argv via the machine's printed prefix.
  Optional `assertStdout: RegExp[]`, `assertStderr: RegExp[]`,
  `expectExit?: number` (default 0; nonzero mismatch fails the step).
  Assertions bind to THIS step's result only.
- `{on, guest: string}` — arbitrary shell INSIDE the container via the
  harness exec layer (fixtures: `git init`, file creation; inspection:
  `test -d`, `ls`). Same assert fields. Guest steps are a
  deterministic-runner privilege; PERSONAS.md keeps forbidding them for
  judgment agents.
- `{on, tui: string}` — start a tmux session (one live session per machine;
  starting a new one with a session still live is a flow-definition error).
  `{on, keys: string[]}`, `{on, typeVar: name}` — typeVar delivers the
  value via `tmux load-buffer` (stdin) + `paste-buffer`, NEVER argv (f4:
  argv leaks secrets to process lists; the harness gains this tui.ts
  subcommand as a rider).
- `{on, waitFor: RegExp, timeout?: s}` — wait-idle + pattern poll (default
  60s); timeout fails with the final screen attached. `{on, assertScreen:
  RegExp[], assertNotScreen?: RegExp[]}` reads the machine's live session.
- `{on, pollUntil: {exec: string[], pattern: RegExp, timeout?: s}}` — re-runs
  the NAMED exec argv until the pattern matches its stdout or timeout (f14;
  Round-2: the polled command is part of the step, never inferred).
- `{on, captureVar: {name, pattern}}` — captures from the previous step's
  output; captured values are redacted from every artifact, log line, and
  error message (schema test proves it).

Assertions are explicit regexes on stable fragments — never full-screen
goldens, never pids/ids/paths/durations (f14).

### Server-side oracle (f5, f7 — harness riders)

`fresh-machine.ts` gains two thin authenticated helpers (using the
machine's stored dev credentials): `workspaces --run-id X --name a` (list
ids — the non-creation oracle for flow 7) and `workspaces-create --run-id X
--name a --label <l>` (mint a workspace WITHOUT any push — the never-pushed
fixture for flow 11). Both are dev-URL-guarded like everything else.

### Account hygiene (f9)

Flow teardown deletes each flow's bootstrap account exactly once via the
rig's owner-authenticated deletion helper (`scripts/rig/lib/account.ts:149-161`),
BEFORE revoking the last owner credential. Deletion failure does not fail
the gate (avoid cleanup-flakes) but is reported per-flow in the summary and
recorded in a `leaked-accounts.txt` artifact for manual sweep.

### Plan default (f10)

`fresh-machine.ts create` gains `--plan <solo|pro|none>`; **default with
`--enrolled` is `solo`** (opt-out `--plan none`), rejected without
`--enrolled`. Both host and container paths. PERSONAS.md invocation
contract updated to inherit the default.

### Runner

`bun scripts/ux/regress.ts [--flow <name>…] [--list] [--jobs N]`:

- One run-id + container per flow (existing `ux=1` machinery); default
  parallelism 4; teardown ALWAYS.
- Residue audit is DELTA-BASED (f11): only resources belonging to THIS
  invocation's recorded run-ids count as leaks (containers `docker ps -a`,
  volumes by label; the shared image never counts). Concurrent persona
  runs/other worktrees are invisible to it.
- Outcomes (f8): `PASS`, `FAIL`, `PENDING-FAIL` (expected-fail flow failed
  — the healthy pending state), `XPASS` (a pending flow PASSED — fails the
  run loudly: it means the awaited design merged and the flow must be
  flipped to pass, or the assertion is broken).
- Exit nonzero iff any FAIL or XPASS. No retries by default; `--retry-flaky
  1` exists but the documented gate command runs without it.
- Artifacts under `scripts/ux/runs/<timestamp>/` — `.gitignore` gains the
  rule (f12); retention: delete run dirs >30 days old only when no live
  lockfile (each runner writes `run.lock` with its pid; stale-pid locks are
  reclaimable).

### Initial flow set

Pass flows (encoded against CURRENT main; acceptance runs ALL five live —
f13):

1. `front-door`: exec bare `rbox` → assertStdout section headers +
   `--help` pointer, exit 0.
2. `fresh-setup-to-handoff`: virgin machine through the wizard to the
   waiting-for-approval screen; asserts step counter, new-vs-existing
   prompt, the code line and expiry text. **No host-URL assertion** (f1:
   the harness's RBOX_APP='' safety blanking stays; the URL-host behavior
   is 137-R2's unit test's job). Wrap-tolerant regexes.
3. `pairing-second-device` (f2 corrected): machine `a` mints via exec
   `pair` + captureVar; machine `b`: tui setup → waitFor new-vs-existing →
   keys Down Enter → waitFor authorize menu → Enter on pairing token →
   typeVar TOKEN → keys Enter → waitFor `/encryption enrolled/` (Round-2: paste does not submit) → assertScreen the
   workspace menu (`/Sync an existing workspace/`). No assertions on the
   design-134 next-step line in either direction (it changes under 137-R1;
   the flow stays valid across that merge).
4. `gitignore-default` (f6 narrowed): property = CONFIGURATION behavior —
   guest fixture builds the repo + .gitignore; setup default choice; exec
   `ignore --list` asserts respect-gitignore on + rules labeled active.
   (End-to-end absence proof = named follow-up flow using a second-machine
   join; out of scope here.)
5. `status-healthy` (f14): after setup, `pollUntil /background sync:\s+running/`
   on exec `status` within 120s; separately assert the `workspace `
   heading; exit 0; no dynamic-value matching.

Pending(137) flows — acceptance requires each to report **PENDING-FAIL**
on current main (f8), proving they detect today's defects:

6. `tilde-expansion`: guest oracle (f4): after typing `~/proj` in the
   wizard, `guest: test -d '/tmp/rbox-ux/<run>/<name>/proj' && ! test -e
   ...'/~'` proves real expansion AND no literal `~` dir; plus the bound
   root via exec `status` output containing `/proj`.
7. `typo-no-phantom`: wizard declines mkdir of a typo'd dir → re-prompt
   asserted on screen; the `workspaces` helper (f5) prints `count=<n>` plus
   ids and the flow asserts `assertStdout: [/^count=0$/m]` — an explicit
   zero-count contract on the flow's fresh bootstrap account (Round-2: no
   runner-side diff logic).
8. `empty-id-navigation`: blank-blank at workspace id → menu re-rendered;
   liveness proven by one more accepted keypress (f: post-137 semantics).
9. `declined-rebind-menu`: decline → track menu re-rendered + liveness
   keypress.
10. `malformed-token-reprompt`: garbage token → re-prompt visible +
    liveness keypress (network non-attempt is 137's unit-test domain).
11. `empty-join-copy`: `workspaces-create` helper mints a never-pushed
    workspace (f7); joining it prints the pull-time fact line.

### Release-gate wiring (f13, honest scope)

The documented gate command is `bun scripts/ux/regress.ts` (the full pass
set). This design adds it to the release checklist in `docs/DEPLOYMENTS.md`
(one line under the CLI release flow: run the gate before tagging). CI
wiring remains out of scope until the runner has a stable history.

## Tests the implementation MUST write

- Schema: discriminated-union validation errors are named and useful;
  captureVar redaction proven across artifacts AND error messages; typeVar
  never appears in any argv (assert the constructed tmux invocations).
- Runner units (faked harness): parallel scheduling; per-step timeout
  attaches final screen; PENDING-FAIL vs XPASS vs FAIL exit-code truth
  table; teardown + delta residue audit on failure paths; retention honors
  live locks.
- Harness riders: `--plan` matrix (default solo with --enrolled, reject
  without, opt-out none) on host AND container paths; paste-buffer typeVar
  round-trip; `workspaces`/`workspaces-create` helpers dev-guarded.
- Live acceptance: all five pass flows PASS; flows 6-11 each report
  PENDING-FAIL (their outputs recorded in the PR description); `--list`
  names all 11 with status.

## Non-goals

CI wiring; LLM/judgment integration; browser automation; gitignore
end-to-end absence proof (follow-up flow); replacing the rig (engine
scenarios stay in scripts/rig).

## Rulings — Round 1 (14 findings)

f1 ACCEPT-MODIFIED (host-URL assertion dropped; blanking stays; wrap-
tolerant regexes). f2 ACCEPT (navigation fixed; 134-line assertions removed
in both directions so the flow survives 137). f3 ACCEPT (discriminated
union, mandatory `on`, session lifecycle, per-step binding). f4 ACCEPT
(guest step kind; paste-buffer typeVar; personas still forbidden). f5
ACCEPT (`workspaces` API helper — `rbox list` does not exist). f6
ACCEPT-MODIFIED (flow narrowed to configuration property; absence proof =
follow-up). f7 ACCEPT-MODIFIED (`workspaces-create` helper instead of CLI
plumbing). f8 ACCEPT (PENDING-FAIL/XPASS; XPASS fails the run). f9 ACCEPT
(rig account-deletion helper, exactly-once, pre-revocation, reported not
gate-failing). f10 ACCEPT (--plan flag, solo default with --enrolled,
personas contract updated). f11 ACCEPT (delta-based audit on this
invocation's run-ids). f12 ACCEPT (.gitignore rule; lockfile-guarded
retention). f13 ACCEPT (acceptance runs all five pass flows; gate command
documented in DEPLOYMENTS release checklist). f14 ACCEPT (pollUntil;
stable-fragment regexes only).
Round 2 (3 findings): all ACCEPT, folded — token paste followed by Enter;
pollUntil carries its exec argv; flow 7 uses an explicit count=0 stdout
contract. Reviewer verified helpers/paste-buffer/account-cleanup/delta-audit
feasible; residual is implementation-level: SELF-CERTIFIED ALIGNED.
