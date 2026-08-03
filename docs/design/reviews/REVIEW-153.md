# REVIEW-153 — review ledger

## Founder input (2026-07-18, pre-round-1-fold, BINDING for v2)

Screenshot of bare `rbox` on the Mac fleet host (v1.7.2, ws_2b6e…): ~20-line
status preamble before the menu. Founder: "would you agree this CLI is A LOT
of information at once?" — adopted as a new unit for v2:

**Unit D — front-door status brief (progressive disclosure).** The bare-rbox
preamble is rebuilt around: headline state → attention items → identity →
menu. Rules:
- every line is either actionable or answers "is it syncing / is anything
  stuck"; healthy subsystems print nothing (locking ok, daemon pid, lock
  path);
- no raw identifiers (ws_/dev_/acct_/pid/sequence numbers) and no wire/HTTP
  jargon ("commit-409") outside `--verbose`/`--json`;
- per-repo git-deferral detail collapses to count + oldest age + pointer to
  `rbox status --git`;
- lifetime counters (syncs, conflict totals) leave the default view;
- identity stays one line (design-117 banner: email · plan);
- `rbox status --verbose` and `--json` retain EVERYTHING current, unchanged —
  the brief is a presentation change, not a data removal.

Target shape (~3 lines + menu):

    Development · syncing normally — 1 change uploading now
    ⚠ 3 git repos waiting on uncommitted changes (oldest: 1 day) · rbox status --git
    Signed in as brian.via.dev@gmail.com · pro

    What would you like to do?

## Founder-context addendum (2026-07-18, BINDING for v2)

Real prod signup (web, github, plan none) surfaced a funnel gap: the wizard's
trial/plan step runs only on the create-account path
(`startTrialAfterAccountCreation`, setup-cmd.ts). A web-first account that
logs in via "existing account" is never offered a plan and discovers the gate
as a push-time refusal ("No active plan — run `rbox subscribe`",
`remote/errors.ts:95`). v2 adds to Unit A scope: after enrollment resolves,
if the account plan is `none`, offer the same plan step inline (skippable,
with the refusal-copy pointer as fallback). Server change: none.

Also fold: the clarity audit (docs/audits/2026-07-17-clarity-audit.md)
attributes the bare approval URL to a blanked-RBOX_APP harness artifact,
hardened by 137-R2 — Unit B item 1 narrows to VERIFYING that hardening plus
the dead-end/no-alternatives fixes; do not re-design the URL builder.

---

# Round 1 (v1) — 15 findings, verdict CHANGES-REQUIRED

## Round-1 rulings (orchestrator, binding for v2 — alongside the founder-input sections above)

1. **BLOCKER, circular Step-1 recovery** — ACCEPT. The choice routes
   device-code login FIRST, then jumps straight to recover enrollment
   (preselected, skipping the enrollment menu). Copy: "sign in with your
   browser first — your phrase then unlocks your data." The
   no-browser-AND-no-other-machine user cannot authenticate at all; that is a
   server-auth invariant, stated explicitly, out of scope here. The
   "approve it another way" alternatives text drops the misleading
   recovery line for that user class.
2. **HIGH, universal rule contradicts menus** — ACCEPT. Replace with a
   context-valid reachability TABLE (menu inventory per context + rationale
   per row). Recovery is deliberately absent from tracked/untracked menus
   (an enrolled machine's keys work); numbering corrected.
3. **HIGH, track delegation** — ACCEPT. Extract the 137 path-preflight
   (tilde-expand, exists-or-confirm-create, no implicit parent mkdir) from
   `stepWorkspace` into ONE shared helper; menu flow = prompt →
   shared preflight → track machinery with explicit path. The implicit
   parent-creation holes (sync-mutex.ts:135, config.ts:704) are closed by
   preflight-before-bind.
4. **HIGH, bind-only track** — ACCEPT-MODIFIED. The MENU flow is
   task-complete: bind → populate-sync → offer background start (reusing
   setup's machinery). The `rbox track` COMMAND stays bind-only (scripted
   contract, unchanged); the menu says what it did end-to-end.
5. **MEDIUM, untracked dispatcher contract** — ACCEPT. Discriminated result
   ({workspace}|{pair}|dismissed); pair consumed inside the menu, never
   falls through to setup; TTY gate pinned by test.
6. **HIGH, Ctrl-C ownership** — ACCEPT. ONE cancellation owner:
   `prompt.ts`'s ExitPromptError handler prints a context-registered
   cancellation line ("setup cancelled — nothing was changed") then
   exit(130). Front door/setup register context, never wrap. front-door's
   promptCancelable migrates to the same mechanism.
7. **MEDIUM, Escape is new ground** — ACCEPT. v2 specifies widget-by-widget
   Escape semantics (selects with a parent: back one level; top-level
   selects: no-op + dim hint; masked inputs: 137's blank-submit pattern is
   the back path, Escape clears the field) + per-widget tests. Wizard scope
   only.
8. **HIGH, residue misclassification** — ACCEPT. 137-fixed items reclassified
   "source/unit/live-gate proven; exploratory rerun pending". Phase-0 scope
   = the enumerated exploratory flows only.
9. **HIGH, stale URL diagnosis** — ACCEPT. Defect claim dropped (137 fixed
   empty-as-unset, regression-tested). URL work is proactive hardening only.
10. **HIGH, PROD_WEB fallback wrong for DEV** — ACCEPT. App origin becomes
    remote-aware: prod API → PROD_WEB; any non-prod remote with RBOX_APP
    unset → NO url printed; the screen leads with `rbox device approve
    <CODE>` instructions instead. RBOX_APP override (validated) always wins.
11. **MEDIUM, URL postcondition** — ACCEPT. URL-API construction; assert
    scheme, expected pathname, code query param, no userinfo/hash; the test
    table covers query/fragment/userinfo/base-path/trailing-slash bases.
12. **HIGH, Phase-0 population** — ACCEPT. Exact enumeration: exploratory
    rerun = flows 4, 5, 7, 8, 11, 13, 15, 18 + blocked 1, 16, 20 (flow 4's
    header/ledger discrepancy noted as an erratum IN THE DESIGN; the
    promoted audit is not rewritten).
13. **HIGH, rerun cost/mechanism** — ACCEPT-MODIFIED. Phase 0 = (a) the
    cheap deterministic 11-flow regress gate, plus (b) the enumerated
    persona sessions, budgeted at 11 sessions/13 homes/11 containers.
    Phase 0 gates ONLY Unit C; Units A/B/D proceed concurrently (their gaps
    are structural and source-verified).
14. **MEDIUM, harness state** — ACCEPT. Phase 0 runs current main source
    (what ships next), stated as such. The stale `regress.test.ts`
    pending-137 expectation (1 failing harness unit test today) is fixed as
    a named rider in Unit C.
15. **LOW, characterizations** — ACCEPT. Menu ordering recorded as product
    judgment (founder gripe + orchestrator call); choice-pin tests recorded
    as new coverage.

---

# Round 2 (fresh eyes, v2) — 13 findings, verdict CHANGES-REQUIRED

Verified: front-door {daemonRunning} contract compatible; all v2 anchors
resolve; baseline 149/149 relevant tests pass.

## Round-2 rulings (orchestrator, binding for v3)

1. **HIGH, phase-aware cancellation** — ACCEPT. The cancellation context is
   UPDATED as phases complete; "nothing was changed" prints only before any
   mutation; after bind/populate/enrollment the message names what completed
   and what did not start. Re-raise of ruling 6 justified.
2. **HIGH, waitForKeypress bypass** — ACCEPT. `waitForKeypress` migrates to
   the same context-aware cancellation owner; browser-open.test.ts pins move
   with it.
3. **MEDIUM, no-context consumers** — ACCEPT. Default context = today's
   silent exit 130; nested push/pop restoration and stale-context tests.
4. **HIGH, Escape implementability** — ACCEPT-MODIFIED. C3 narrows: a
   wizard-only custom select widget (built on @inquirer/core) providing
   back-navigation where a parent exists; masked inputs keep 137's
   blank-submit back path and get NO Escape behavior (deliberate scope cut,
   recorded). Typed `back | no-op` results; no full custom prompt suite.
5. **HIGH, plan tri-state** — ACCEPT. `active | none | unknown`; unknown →
   continue silently, no prompt, no refusal copy; server enforcement speaks
   at push time.
6. **MEDIUM, checkout rejections** — ACCEPT. Checkout errors caught → one
   actionable fallback line, setup continues; tests per rejection class
   (billing-disabled, non-OK, malformed, network).
7. **MEDIUM, ambient RBOX_TOKEN** — ACCEPT. Env-credential sessions skip the
   plan step with a one-line note; token-only declared unsupported for the
   wizard; tests for token-only, full tuple, and env/file shadowing.
8. **MEDIUM, bind disposition** — ACCEPT. Track returns a typed
   `{disposition: "created" | "joined"}`; menu populate = push for created,
   pull/reconcile for joined; both primitives tested.
9. **HIGH, origin-aware wizard copy** — ACCEPT. Authorization menu rows and
   A3 recovery copy become origin-aware; non-prod without a valid override
   leads with device-approve and never promises app.rbox.to; per-origin
   choice pins.
10. **MEDIUM, origin boundary** — ACCEPT. Normalized URL-origin comparison;
    malformed remote → non-prod policy; scope = CLI approval only, SwiftBar
    recorded as an out-of-scope rider; warnings never echo credentials.
11. **HIGH, behind-remote** — ACCEPT. Sequence-free attention line
    ("remote changes waiting to download" + command) with goldens for
    running/stopped/daemon-sourced/simultaneous-upload variants.
12. **HIGH, complete brief model** — ACCEPT. v3 carries the full
    keep/suppress/translate matrix exactly as enumerated (keep: stopped or
    stale daemon, behind remote, halt/storage, version skew, degraded
    locking, git attention, nonempty trash, no-plan, updates; suppress:
    healthy telemetry, history, healthy daemon/locking/git facts, lifetime
    counters, raw footer); StatusSnapshot extended to model kept states.
13. **HIGH, UX-gate migration** — ACCEPT. status-healthy and tilde-expansion
    flows plus design-140's frozen status contract migrate IN THE SAME UNIT;
    legacy status assertions split into --verbose/--git/brief goldens; the
    140 amendment is named in the doc.

---

# Round 3 (fresh eyes, v3) — 7 findings, verdict CHANGES-REQUIRED

Verified: all v3 anchors resolve; 11/11 flows pass; the 140 migration list is
complete; tri-state, behind-remote variants, and keep/suppress inventory
internally consistent.

## Round-3 rulings (orchestrator, binding for v4)

1. **HIGH, phase-advance API** — ACCEPT. Exported scoped API
   (`cancellationScope` with a typed phase set and `advance(phase)`), advance
   is SYNCHRONOUS at each commit boundary before any subsequent await/prompt;
   inner commit callsites enumerated (auth-cmd.ts:231, :287-291, enrollment
   seams); innermost active scope wins; the arrives-as-mutation-resolves
   boundary test is required.
2. **HIGH, authorization-only continuation** — ACCEPT. `login` gains an
   authorization-only wizard result (no internal enrollment continuation);
   A3 = auth-only → preselected recover. C3's back-from-enrollment returns to
   Step 1 in an "already authorized" state that never replays completed
   authorization; that state's menu is specified.
3. **HIGH, menu-track orchestrator** — ACCEPT (probe placement
   ACCEPT-MODIFIED). The menu flow owns its create/join/back submenu; every
   back lands one level up; the picker-back→remote-create fall-through in
   track-cmd.ts:63-84 is named a defect this unit fixes at the orchestrator
   seam. The tri-state plan probe ALSO runs before bind in the menu-track
   flow (interactive, cheap), keeping A4's "every enrolled plan-none account"
   true for all interactive flows; the scripted `rbox track` command stays
   probe-free.
4. **HIGH, reset-halt snapshot** — ACCEPT. Discriminated snapshot
   (`reset-halt` minimal | `full`); absent fields are typed-absent, never
   fabricated zeros; one renderer handles both arms.
5. **MEDIUM, Escape semantics + adapter boundary** — ACCEPT. Escape with no
   parent is consumed INTERNALLY (hint, prompt continues); it settles only as
   `{kind:"back"}` when a parent exists — the settled union is
   `selected | back`, `no-op` is deleted. One generic adapter in prompt.ts on
   @inquirer/core; the parity list (theme, descriptions, pagination, default,
   keybindings, cleanup, stderr/raw-TTY context) is normative; CI's
   imports-only-in-prompt.ts boundary named.
6. **MEDIUM, copy/precedence completeness** — ACCEPT. v4 carries the exact
   copy table for every keep/translate row, a total attention-precedence
   order, halt-reason discriminant mapping (known → plain copy; unknown →
   "sync halted — see rbox logs", raw reason only in --verbose/--json), exact
   healthy-headline and identity-fallback strings, and signed-out/unavailable
   identity rows.
7. **MEDIUM, 140 amendment** — ACCEPT. Design 140 gains `assertNotStdout`
   stable negative fragments; "golden" = positive+negative stable fragments,
   never full screens; the amendment lands in 140's doc within the
   implementation PR.

---

# Round 4 (fresh eyes, v4) — 9 findings (2 HIGH), verdict CHANGES-REQUIRED

Anchors resolve; TrackDisposition, reset-halt union, assertNotStdout clean.

## Round-4 rulings (orchestrator, binding for v5)

1. **HIGH, stranded first device** — ACCEPT. The post-authorization state
   discriminates server keys `absent | present`: absent retains the existing
   first-machine genesis offer; present shows the three-row menu.
2. **HIGH, invalid CTA** — ACCEPT-MODIFIED. Bare `rbox subscribe` becomes the
   interactive plan chooser (reusing the wizard's plan-step machinery); every
   CTA stays `rbox subscribe` and is now valid. Scripted use with an explicit
   plan is unchanged.
3. **MEDIUM, cancellation composition** — ACCEPT. The scope tracks a SET of
   completed effects (composed message enumerates all); a
   remote-created-before-bind phase joins the commit-boundary table;
   "abandoned cannot leak" narrowed to settling aborts.
4. **MEDIUM, precedence totality** — ACCEPT. A closed, enumerated
   headline-blocker predicate; plan/quota aggregation discriminant with
   plan-none outranking out-of-storage when both hold.
5. **MEDIUM, JSON halt reason** — ACCEPT. JSON parity explicitly amended with
   an additive optional `haltReason` field.
6. **MEDIUM, B2 exact strings** — ACCEPT. Complete row arrays, footer,
   alternate-way output, and both expiry messages enumerated per
   presentation arm.
7. **MEDIUM, uploading-now evidence** — ACCEPT. "uploading now" requires
   active-transfer evidence; otherwise "waiting to upload".
8. **LOW, inactive-plan branch** — ACCEPT. One sentence: active|unknown →
   populate/start; attempted-but-inactive → bind in no-sync mode, skip both.
9. **LOW, copy cleanup** — ACCEPT all: "encryption isn't set up"; formatter
   emits "1 day" (spelled units in the brief); "no active plan"; update-row
   punctuation; the telemetry-flavored strings rewritten; known
   progressLabels map through the plain-words table ("capturing git state" →
   "saving git history"), unknown labels pass through.

---

# Round 5 (fresh eyes, v5) — verdict ALIGNED (v6)

Four fully-prescribed LOWs + one editorial, applied directly by the
orchestrator: unenrolled-root routing pin, non-TTY subscribe usage-error pin,
immediate approval-select abort, typed halt reasons + top-level haltReason
JSON field, and the origin-policy factoring note. Design 153 is ALIGNED v6.
