# Review 140 — TUI regression gate

## Verdict: CHANGES-REQUIRED

The proposed runner is directionally sound, and several individual screen
checks are observable, but the design does not yet map to the harness it pins.
Four of the eleven flows are not encodable as written, one pass flow proves a
weaker property than it claims, and the normative pairing example cannot pass.

## Findings

1. **BLOCKING — `fresh-setup-to-handoff` requires an environment state the
   pinned harness cannot produce.** Design 140:80-84 requires `RBOX_APP` to be
   unset so the captured approval URL contains a host, while design 140:51-53
   forbids new container/tmux plumbing. Every current execution path instead
   sets `RBOX_APP` to the empty string: host isolation in
   `scripts/ux/lib.ts:23-26`, the host prefix in
   `scripts/ux/fresh-machine.ts:63-65`, container exec in
   `scripts/ux/container.ts:95-107`, and TUI startup in
   `scripts/ux/tui.ts:101-105`. This distinction is material because login uses
   `process.env.RBOX_APP ?? PROD_WEB`; an empty string therefore produces the
   hostless `/cli-login?code=...` form (`src/cli/auth-cmd.ts:224-228`). The
   walkthrough also deliberately requires blanking the variable as a DEV safety
   boundary (`scripts/ux/WALKTHROUGH.md:89-95`). Specify and test a safe,
   flow-scoped **unset** policy (including why pointing DEV at the production web
   host is acceptable), or drop the host assertion. A “full URL line” is also
   brittle at the fixed 100-column TUI width (`scripts/ux/tui.ts:64,101-105`);
   the assertion must tolerate terminal wrapping.

2. **BLOCKING — the normative pairing flow is internally contradictory and
   omits the first required interaction.** On a virgin B, `rbox setup` first
   stops at “Are you new here…” (`src/cli/setup-cmd.ts:232-239`); the
   authorization prompt does not appear until “existing” is selected
   (`src/cli/setup-cmd.ts:249-253`). Design 140:32 waits for the latter without
   sending `Down Enter`, so it times out. Its final step then requires “Sync an
   existing workspace” while forbidding `Run \`rbox setup\`` (design 140:35),
   but successful redemption prints the design-134 line verbatim:
   `Run \`rbox setup\` and choose "Sync an existing workspace"...`
   (`src/cli/auth-cmd.ts:30-31,402-410`). Design 140:85-86 explicitly says flow 3
   must assert that same line. Correct the navigation and remove/invert the
   negative assertion.

3. **BLOCKING — the flow DSL does not define the executable contract it asks
   schema tests to enforce.** Design 140:42-44 promises assertions over exec
   stdout, stderr, and exit code, but the example defines no `assertStdout`,
   `assertStderr`, or expected-exit fields. The final screen assertion has no
   `on` in a two-machine flow (design 140:35), so its pane is ambiguous. TUI
   session creation, lifetime, command restart, and whether assertions bind to
   the current or previous result are likewise unstated. This is not merely a
   type-detail omission: flows 1 and 5 depend on exec-result assertions. Pin a
   discriminated step union, require `on` for every machine-owned operation,
   define session lifecycle, and define nonzero-exit handling.

4. **BLOCKING — “exec via the printed prefix” is rbox-only, but flows 4-6 need
   arbitrary guest fixtures/inspection.** The example establishes
   `exec: ["pair"]` as rbox arguments (design 140:31), and both printed prefixes
   end in literal `rbox` (`scripts/ux/fresh-machine.ts:63-65` and
   `scripts/ux/container.ts:100-107`). The walkthrough says to use that prefix
   as a complete unit (`scripts/ux/WALKTHROUGH.md:27-32`). Consequently flow
   6's proposed `exec ls` becomes `rbox ls`; flows 4 and 5 also cannot create a
   repository, `.gitignore`, ignored file, or tiny workspace fixture. Define a
   separate safe guest-command/file-fixture step backed by the existing
   `execUx`, distinct from rbox argv. Also define a non-argv route for
   `typeVar`: the current `tui.ts keys ... <text>` interface puts the pairing
   token in a child argv, contrary to the harness rule that pairing tokens must
   not be put in a command (`scripts/ux/WALKTHROUGH.md:34-35`). Artifact
   redaction alone does not fix process-argument exposure.

5. **BLOCKING — `typo-no-phantom` relies on a command that does not exist.**
   Design 140:95-96 says to prove no server workspace was created with
   `rbox list`. There is no top-level `list` dispatch; unknown commands fall
   through to grouped help and a nonzero exit (`src/cli/main-dispatch.ts:511-534`).
   The repository already records this gap explicitly
   (`docs/design/54-workspace-registry.md:18-27`). The prompt/re-prompt portion
   is screen-assertable, but the server-side non-creation invariant needs an
   authenticated API oracle, a fixture helper, or a real supported CLI surface.

6. **HIGH — `gitignore-default` does not assert that ignored files were
   skipped.** `rbox ignore --list` proves only `respectGitignore: on` and labels
   `.gitignore` rules active (`src/cli/ignore-cmd.ts:38-55`); it does not expose
   snapshot membership. Thus design 140:87-88 can pass while an ignored file is
   actually published. Add an end-to-end absence oracle, preferably a
   second-machine join plus a filesystem assertion, or narrow the stated
   property to configuration/default-choice behavior.

7. **HIGH — `empty-join-copy` has no supported way to create its never-pushed
   fixture.** The planner can represent `firstSync: "none"` only when
   `flags["no-sync"]` is true (`src/cli/init-plan.ts:172-176`), but `init
   --no-sync` is rejected because it is absent from init's hidden flags
   (`src/cli/flags.ts:48-52`). Setup accepts hidden `--no-sync`, yet
   `runSetup` never reads that flag; `stepWorkspace` receives only the
   subscription-derived `noSync` and then writes it back at
   `src/cli/setup-cmd.ts:160-166,498-502`. The eventual fact line is
   screen-assertable, but flow 11 needs an explicit API/fixture primitive or
   corrected CLI plumbing to establish the precondition.

8. **HIGH — pending semantics cannot prove the acceptance condition.** The only
   specified state/output is `PENDING`, and pending failures never affect the
   exit code (design 140:54-58,67-73). Acceptance nevertheless requires flows
   6-11 to “FAIL-as-pending” on current main (design 140:137-138). There is no
   distinction between expected failure and unexpected pass, so a stale or
   broken assertion that always passes can still be reported as pending. Define
   `PENDING-FAIL` versus `XPASS`/`PENDING-PASS`, require the former in this
   acceptance, and state whether XPASS fails the run or at least produces a
   separately actionable result.

9. **HIGH — teardown removes local resources but leaks durable DEV
   accounts/workspaces.** Each enrolled machine bootstrap creates a new account.
   Fresh-machine teardown stops daemons, revokes devices, removes machine HOME,
   and destroys the container (`scripts/ux/fresh-machine.ts:194-223`), but never
   deletes the account. These are bootstrap-origin accounts, not disposable web
   shells, and repeated gate runs will accumulate control-plane state. The rig
   already has an owner-authenticated account-deletion helper
   (`scripts/rig/lib/account.ts:149-161`). Require exactly-once per-flow account
   cleanup before the last owner credential is revoked, and specify cleanup
   failure reporting. A Docker residue audit cannot detect this leak.

10. **MEDIUM — the `--plan solo` route exists, but the rider does not actually
    guarantee the claimed persona default.** The underlying path maps cleanly:
    enrolled creation invokes bootstrap login on host and container
    (`scripts/ux/fresh-machine.ts:120-136`), dispatch forwards `--plan`
    (`src/cli/main-dispatch.ts:178-184`), login sends it only with bootstrap
    (`src/cli/auth-cmd.ts:194-205`), and DEV accepts `solo|pro` when its feature
    flag is enabled (`apps/api/src/auth/bootstrap.ts:9-27`;
    `apps/api/wrangler.jsonc:99`). However, current `FreshArgs` has no plan field
    (`scripts/ux/fresh-machine.ts:15-20,46-50`), and persona instructions invoke
    `fresh-machine.ts` directly with only `--enrolled`
    (`scripts/ux/PERSONAS.md:75-84`). Saying it is the runner's default does not
    change those direct persona calls. Specify allowed values, reject `--plan`
    without `--enrolled`, cover both host/container commands, and either make
    `solo` the fresh-machine enrolled default (with an explicit opt-out) or
    update every persona invocation contract.

11. **MEDIUM — the residue audit is both under-specified and unsafe under
    concurrent work.** Existing `uxListArgs` uses `docker ps`, not `docker ps -a`,
    so it misses stopped leaked containers and says nothing about volumes/images
    (`scripts/ux/container.ts:91-93,221-224`). The documented manual audit covers
    stopped containers, volumes, and images (`scripts/ux/WALKTHROUGH.md:97-114`).
    Conversely, failing because *any* `ux=1` resource exists would blame this
    invocation for another concurrent worktree/run. Audit the invocation's
    recorded run IDs (or a baseline delta), and pin which stopped containers,
    volumes, and shared images constitute a leak.

12. **MEDIUM — artifact and retention claims are not backed by the tree.** The
    proposed `scripts/ux/runs/<timestamp>/` directory is called gitignored at
    design 140:67-70, but `.gitignore:33-35` ignores only `scripts/rig/runs/`
    and `scripts/ux/.smoke-transcript.txt`. Add the directory rule and define
    concurrency-safe retention ordering so one runner cannot delete another
    active runner's artifacts.

13. **MEDIUM — the acceptance test does not establish the five claimed passing
    flows or an actual release gate.** Acceptance live-runs only `front-door`
    (design 140:134-136), while flows 2-5 can be broken or unencodable and the
    design still passes. The design calls this “THE gate” and motivates every
    release candidate (design 140:5-18), but explicitly excludes CI/release
    wiring (design 140:124-127). At minimum, acceptance must run all five
    current-main pass flows and a documented release command must invoke the
    pass set; otherwise scope the deliverable as a runner rather than an
    enforced release gate.

14. **MEDIUM — `status-healthy` needs a stable, polled contract.** The current
    output is `workspace ...` followed by `background sync: running (pid ...)`
    (`src/cli/status-cmd.ts:518-521,553-562`). Immediately after setup it may
    instead report `initial sync in progress`, and PID/path/id matching violates
    design 140:42-44. Pin an eventual assertion such as
    `/background sync:\s+running/`, poll it within a stated timeout, separately
    match the workspace heading, and assert exit 0 without matching dynamic
    values.

## Initial-flow assertability audit

| # | Flow | As written | Evidence / required correction |
|---|---|---|---|
| 1 | `front-door` | Assertable after DSL completion | Non-TTY bare `rbox` renders grouped help and exits successfully (`src/cli/main-dispatch.ts:511-534`; `src/cli/help-registry.ts:608-624`), but exec assertion fields are missing. |
| 2 | `fresh-setup-to-handoff` | **Not assertable through current harness** | Prompts/screens exist; the required host-bearing URL does not because `RBOX_APP` is blank, and the physical line may wrap. |
| 3 | `pairing-second-device` | Observable, example invalid | Enrollment and next-step copy are emitted (`src/cli/auth-cmd.ts:402-410`), but the example skips a menu and forbids the required line. |
| 4 | `gitignore-default` | **Only partially assertable** | Rule activation is observable; actual omission is not, and fixture creation has no step kind. |
| 5 | `status-healthy` | Assertable after DSL/fixture work | Exec output and exit code suffice once daemon state is polled; fixture creation is currently unspecified. |
| 6 | `tilde-expansion` | **Not encodable** | The prefix can run `rbox`, not `ls`; add a guest filesystem oracle and also prove the bound root, not merely directory existence. |
| 7 | `typo-no-phantom` | **Not fully assertable** | Re-prompt is visible; `rbox list` does not exist, so server non-creation has no oracle. |
| 8 | `empty-id-navigation` | Assertable from screen | Blank manual ID currently returns `undefined` and setup exits (`src/cli/workspace-picker.ts:175-183`; `src/cli/setup-cmd.ts:438-447`); post-137 menu visibility plus another accepted key proves liveness. |
| 9 | `declined-rebind-menu` | Assertable from screen | Current decline exits setup (`src/cli/setup-cmd.ts:453-471`); post-137 menu visibility plus another key proves liveness once the bound fixture exists. |
| 10 | `malformed-token-reprompt` | Assertable from screen | Current redemption error escapes the setup call (`src/cli/setup-cmd.ts:255-262`); a repeated prompt plus a subsequent interaction can prove post-137 liveness. |
| 11 | `empty-join-copy` | Copy assertable; fixture unavailable | The eventual line is screen-visible, but there is no supported never-pushed workspace setup path as specified in finding 7. |

The harness primitives, bootstrap-plan API, and current CLI output make this
design repairable without replacing the substrate. The blockers are in the
contract between the runner and that substrate, not in the overall split
between deterministic regression flows and exploratory persona review.

## Round 2 — v2

### Verdict: CHANGES-REQUIRED

The round-1 harness rulings are implementable: the rig container seam already
accepts stdin (so `execUx` needs only a thin pass-through for `tmux load-buffer
-`), and the host path can feed the same stdin without placing the value in
argv. Enrolled `credentials.json` supplies the durable device token, account id,
and DEV remote needed by `GET /v1/account/workspaces`, `POST /v1/workspaces`,
and the rig's owner-authenticated `deleteAccount`; raw workspace creation is a
sufficient never-pushed fixture because the E2EE path creates a missing
workspace KEK before its first write. Calling account deletion before the
existing per-device revocations preserves the owner credential. The recorded
run-id labels also support the specified `docker ps -a` audit; the current UX
harness creates no volumes, and the shared image is correctly excluded.

Three remaining contract errors change what the implementer must build:

1. **BLOCKING — the corrected pairing flow pastes the token but never submits
   it.** `typeVar TOKEN` is defined as `load-buffer` + `paste-buffer`, which
   inserts bytes only; `promptPassword({ message: "Paste pairing token" })` in
   `src/cli/setup-cmd.ts:256` still waits for Enter. Design 140:109-113 goes
   directly from `typeVar TOKEN` to `waitFor /encryption enrolled/`, so the pass
   flow stalls at the token prompt. Add `{ on: "b", keys: ["Enter"] }` after
   `typeVar`, or explicitly redefine (and test) `typeVar` as paste-and-submit.
   Keeping submission explicit is the safer general DSL contract.

2. **BLOCKING — `pollUntil` still has no command to poll.** The declared variant
   is `{on, pollUntil: RegExp, timeout?: s}`, yet its semantics say to re-run
   "the given `exec`" and flow 5 requires `status`. There is no exec argv in the
   variant and no stated binding to a prior step, so the discriminated union
   cannot encode `status-healthy`. Put the argv in the step (for example,
   `{ on, pollUntil: { exec: ["status"], stdout: /.../ }, timeout: 120 }`) and
   pin exit/stderr handling, or normatively bind the step to a preceding exec.

3. **HIGH — flow 7's server delta is not expressible by the pinned helper/DSL
   output contract.** `workspaces` is specified only to list ids, while the DSL
   has positive regex assertions and `captureVar` but no equality-to-prior,
   interpolation, or count/diff assertion. Therefore “server count unchanged”
   is not a defined assertion. Either specify a stable count/delta output and
   assert it (the fresh bootstrap account permits an explicit `count=0`
   contract), or add an equality/diff primitive to the DSL. Do not leave this as
   runner-specific comparison logic outside the flow schema.
