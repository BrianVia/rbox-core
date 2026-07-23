# Design 185 — TUI component framework (revisiting the 07c deferral)

**Status:** PROPOSED — pre-arbitrage. Supersedes design 07c §0's "defer
OpenTUI" call *only if* a trigger surface (below) is actually built; otherwise
07c stands. This doc's job is to decide the framework and prove it on one real
surface, not to port the existing (fine) status-line/spinner code.

## Problem

Design 07c deliberately shipped zero-runtime-dependency terminal rendering
(`style.ts` + `spinner.ts` + one `@inquirer/*` wrapper in `prompt.ts`) and
deferred OpenTUI, on the explicit condition that we revisit "when there's
genuine non-linear UI value (multi-workspace selection, conflict preview, a
live transfer table, resumable first-sync inspection)." None of those surfaces
exist yet. The interest in "a better component structure" is really the
question 07c parked: **have we reached a trigger surface, and if so, which
framework do we build it on?**

The honest framing matters because there is no sprawling render layer to
refactor. A full inventory (2026-07-23) confirms:

- No alternate-screen buffer, no cursor-grid positioning, no live multi-line
  dashboard anywhere in `src/cli`. Grep for `\x1b[` finds raw escapes in
  exactly two production files: `style.ts` (SGR color) and `spinner.ts`
  (`\r\x1b[K` single-line repaint). Everything else is `console.log` of plain
  strings.
- `status-view.ts` (912 lines) is a **one-shot** renderer, not a live view —
  no `--watch`, no poll loop. It is already pure: a function of a
  `StatusSnapshot` with `now` injected.
- The only "component-like" code is `directoryPickerPrompt` (`prompt.ts`
  109–163), a hand-built `@inquirer/core` typeahead widget over the pure
  `directory-picker.ts` matcher.

So this is not "convert the TUI." It is "build the first dashboard-class
surface on a component framework instead of hand-rolling another repaint loop,
and pick that framework deliberately."

## Non-negotiable constraints (inherited, must survive any choice)

These are load-bearing from 07c/135/140 and are acceptance gates, not
preferences:

1. **Startup / module-resolution cost (07c §0, §4).** The CLI is invoked
   constantly and the daemon (`daemon/daemon.ts`, 12+ timers) is long-lived.
   A framework that resolves React + Yoga (or a native core) on *every* `rbox
   status` hot path is a regression. The existing lazy-import boundary
   (`workspace-picker.ts` lazy-imports `prompt.js` so `status` never pulls
   inquirer's graph) is the pattern to extend: the framework loads only inside
   the interactive/dashboard surface, never on the scriptable hot path or in
   the daemon.
2. **Scriptability / headlessness (07c §2).** stdout stays pipe-clean; prompts
   and animation go to **stderr**; non-TTY / `--no-interactive` never prompts,
   never hangs, exits with a precise `InitError`. `NO_COLOR` wins over
   everything; `FORCE_COLOR` is the only way ANSI survives a pipe.
3. **tmux harness stays drivable (135/140).** `scripts/ux/tui.ts` drives real
   `rbox` via `tmux send-keys` / `capture-pane -p` and asserts **content
   regexes on rendered plain text** — never full-screen goldens, never
   cursor coordinates (140 f14). A framework swap that preserves the same
   labels/prompt wording keeps the gate green *even if layout changes* — with
   two caveats the pilot must check: (a) a layout engine that reflows/wraps a
   line the current renderer keeps whole can break a single-line regex, and
   (b) the pilot must reproduce the exact keymap the `keys` flow steps assume
   (directory picker: Enter selects highlighted, Tab completes-then-resets,
   Up/Down wraparound).
4. **The pure/impure seam is the real deliverable (07c §1).** 07c's whole
   point was that `resolveInitPlan()` is pure and any UI drives it. The
   framework touches only the impure shell. Pure logic (`init-plan.ts`,
   `status-view.ts`, `directory-picker.ts`, `workspace-picker.ts` projections)
   is not rewritten — it is *rendered differently*.

## Framework options

### A. Ink (React + Yoga) — Claude Code's base

- Pure JS; React peer dep + Yoga (Flexbox, ships as WASM/prebuilt, no native
  toolchain at install). Proven in Wrangler, Shopify CLI, GitHub Copilot CLI;
  works under Bun today.
- Fit: component model matches the "render a snapshot" shape of
  `status-view.ts` cleanly. Reproducing the directory-picker keymap is a
  straightforward `useInput` handler.
- Cost against constraint 1: React + Yoga always resolve when the surface
  imports them. Must stay behind the lazy boundary; must never be imported by
  the daemon or the `status` hot path.

### B. OpenTUI (`@opentui/core` + `@opentui/react`) — opencode's current base

- Native Zig core with C ABI, TS bindings, optional React/Solid reconcilers.
  Higher rendering ceiling (opencode repaints at high frequency). **Open
  question the spike must answer:** does consuming `@opentui/core` from npm
  ship prebuilt per-platform binaries, or does it need a Zig toolchain at
  install/build? The README says Zig is required *to build the packages* —
  unresolved whether that hits consumers. If it does, it's disqualifying for a
  `curl | sh` binary-swap install model (DEPLOYMENTS.md) and a fleet that
  upgrades via `rbox upgrade`.
- Fit: strongest if we expect a genuinely high-frequency live surface (a
  live transfer table that repaints many times/sec). We do not have one yet.

### C. Do nothing / extend the seam only

- Keep zero-dep. If the only near-term surface is another linear wizard or a
  one-shot table, 07c's reasoning still holds and a framework is unjustified
  weight. This is the null hypothesis the arbitrage loop should try to reject.

## Decision (proposed — for arbitrage)

**Pick Ink, prove it on one pilot surface, keep it behind a lazy boundary, do
not touch `style.ts`/`spinner.ts`/the daemon.**

Rationale: Ink clears the install-model and Bun-compat bars that OpenTUI has
an open question on, and rbox has no high-frequency repaint surface that would
justify OpenTUI's native ceiling. If the pilot reveals a real high-frequency
need, OpenTUI stays on the table as a follow-up — the pure/impure seam means
the second swap is also cheap.

**Reject C** only if the pilot surface below is genuinely built; if product
priorities don't produce a trigger surface, C wins and this doc closes
unimplemented (that is an acceptable outcome).

## Pilot surface

One surface, chosen to exercise the seam and the constraints without a risky
blast radius. Candidates, in preference order:

1. **Directory picker → Ink component.** Highest-value: it is already the most
   component-like code, its logic (`directory-picker.ts`) is pure and stays
   untouched, and it has existing tmux flow coverage that pins the keymap — so
   the migration is directly gated by the regression suite. Risk: reproducing
   the inquirer keymap exactly.
2. **A new live transfer table for `rbox status`** (the named 07c trigger).
   Higher product value but larger: needs a subscription/poll model that
   `status-cmd.ts` does not have today (it is a one-shot snapshot read). Defer
   unless product wants the live view now.

Recommend piloting (1): it proves Ink under Bun, behind a lazy boundary, with
the harness as the correctness gate, at minimal blast radius, and leaves
`style.ts`/`spinner.ts`/all 24 static-styled command files untouched.

## Surfaces (pilot 1)

- `package.json`: add `ink` + `react` as deps (measure resolved cost; confirm
  they never enter the daemon or `status` import graph — a guard in
  `scripts/guards.ts` should assert this, mirroring the existing `@inquirer/*`
  single-importer guard).
- `src/cli/prompt.ts`: replace `directoryPickerPrompt`'s inquirer wiring with
  an Ink render, lazily imported; `promptPath`'s non-interactive fallback
  (plain `promptInput` + validation loop) is unchanged.
- `src/cli/directory-picker.ts`: **unchanged** (pure logic stays).
- `scripts/guards.ts`: new guard — `ink`/`react` importable only from the
  designated picker module; never from `daemon/`, `status-cmd.ts`,
  `status-view.ts`, or `activity.ts`.
- No change to `style.ts`, `spinner.ts`, `status-view.ts`, the tmux harness,
  or the 24 static-styled command files.

## Acceptance criteria

1. The directory picker renders via Ink and reproduces the existing keymap
   exactly: Enter selects highlighted, Tab completes-to-best-child-then-resets
   highlight, Up/Down cycle with wraparound, any other key re-projects against
   new input. Pure `directory-picker.ts` is unmodified.
2. All existing `scripts/ux` flows that drive the picker
   (`status-healthy.flow.ts` et al.) stay green with **no assertion changes**;
   if any regex breaks, it is because of reflow/wrap and the fix is the
   renderer, not the assertion.
3. Scriptability holds: non-interactive / non-TTY `promptPath` still takes the
   plain-input fallback, never loads Ink, never hangs; picker output is on
   stderr; `NO_COLOR`/`FORCE_COLOR` precedence unchanged.
4. Startup-cost guard proves `ink`/`react` are not in the import graph of
   `rbox status`, `rbox prompt-status`, or the daemon. Measure and record cold
   `rbox status` startup delta (target: zero, since Ink is lazy).
5. Ink runs correctly under Bun (the shipped runtime), not just Node.
6. The OpenTUI install-model question (prebuilt binaries vs Zig toolchain for
   npm consumers) is resolved in writing here, so the framework choice is
   justified rather than assumed.
7. `bun test`, both `tsc` projects, and the `bun scripts/ux/regress.ts` gate
   pass; `/simplify` + `/antislop-codebase` clean.

## Explicitly out of scope

- Porting `style.ts` / `spinner.ts` / the 24 static-styled command files —
  they are single-line status output; a component framework buys nothing there
  and 07c §4's zero-dep reasoning still holds for them.
- Any daemon rendering (there is none; the daemon writes logs and sidecars).
- The shell-prompt sidecar protocol (`activity.ts` `renderShellLine` /
  `renderShellDeferrals`) — a stable text contract read by an external zsh
  hook, not terminal UI.
- Committing to OpenTUI before its install-model question is answered.
