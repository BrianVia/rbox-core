# Adversarial review — design 137

## Verdict: CHANGES-REQUIRED

The incident anchors are real, but the proposed recovery mechanism is not yet safe enough to implement. In particular, a failed manual join is not a side-effect-free validation failure in the current code: it can overwrite the local binding and reset the previous sync baseline before remote access is tested. The create-new preflight also does not establish that the resolved target is a usable directory before minting the server workspace.

Anchor verification:

- **F1 confirmed.** `setup-cmd.ts:451` takes the prompt answer unchanged and `setup-cmd.ts:498-502` passes it as `root`; only `init-plan.ts:168-170` calls `path.resolve(cwd, ...)`. Thus `~/proj` becomes `<cwd>/~/proj`, not the user's home directory.
- **Manual blank semantics confirmed.** `workspace-picker.ts:175-184` trims the answer and maps blank to `undefined`; `setup-cmd.ts:443-447` treats that as an exit from Step 2.
- **R2 anchor confirmed.** `auth-cmd.ts:222-228` uses `process.env.RBOX_APP ?? PROD_WEB`, so `RBOX_APP=""` produces the hostless `/cli-login?...` string. `|| PROD_WEB` gives the requested empty-as-unset behavior.
- **F2 ordering confirmed.** A new plan calls `createRemoteWorkspace` at `init-cmd.ts:156-168`; only afterward does mutex acquisition create `<root>/.rbox/state` (`init-cmd.ts:170-173`, `sync-mutex.ts:140-142`), followed by config persistence (`init-cmd.ts:175-212`, `config.ts:654-659`).
- **Dashboard deletion is not available.** The devices/workspaces route imports no workspace mutation (`apps/web/src/routes/devices/+page.svelte:5-12`) and renders display-only workspace rows (`apps/web/src/routes/devices/+page.svelte:246-298`). The web client exposes only `GET /v1/account/workspaces` (`apps/web/src/lib/api.ts:150-161`); its delete operation is whole-account deletion (`apps/web/src/lib/api.ts:203-220`). A one-workspace purge exists only behind the platform-admin secret (`apps/api/src/routes/admin.ts:84-88`). F2 must therefore use the **contact-support** copy, and user-facing workspace deletion remains a follow-up.

## Findings

1. **CRITICAL — A bad-ID re-prompt can destroy the previous local binding state.** `manualEntry` accepts any nonblank string without validation (`src/cli/workspace-picker.ts:175-184`), and setup sends it through `runInit` (`src/cli/setup-cmd.ts:438-451`, `src/cli/setup-cmd.ts:491-502`). The join path merely adopts that ID (`src/cli/init-cmd.ts:156-164`), then may reset the old stream baseline and writes the new binding (`src/cli/init-cmd.ts:170-212`) before remote ownership/access is exercised (`src/cli/init-cmd.ts:217-226`, `src/cli/init-cmd.ts:283-305`, `src/cli/e2ee-client.ts:263-281`). Catching the later error and re-prompting would leave the typo bound locally and can erase the former baseline. Reset also journals/retires prepared artifacts and removes the encryption-address cache, activity, shell-line, and deferral state (`src/cli/config.ts:1088-1115`); the failed join can then write shell status for the typo stream (`src/cli/populate-status.ts:39-59`, `src/cli/populate-status.ts:93-117`). Require either a non-mutating membership/access preflight before mutex/reset/save, or fully specified transactional rollback. Add tests proving a failed manual join preserves the complete prior binding artifact set, not merely config and `state.json`. Also add an error taxonomy: generic HTTP translation collapses 403/404 to strings (`src/cli/remote/errors.ts:156-163`), so network, crypto, and sync failures cannot safely be counted as “bad id” attempts.

2. **HIGH — `undefined` cannot carry the specified “back” navigation through the shared picker.** Blank currently returns `undefined` (`src/cli/workspace-picker.ts:175-184`), but its three callers assign different meanings: setup exits (`src/cli/setup-cmd.ts:443-447`), interactive `rbox init` falls through to create-new (`src/cli/init-cmd.ts:48-58`, `src/cli/init-plan.ts:164-166`), and interactive `rbox track` also creates a server workspace (`src/cli/track-cmd.ts:60-75`). Changing `manualEntry` to blank-blank without a tagged result could therefore turn “back” into a billable create outside setup. Specify a discriminated result such as `picked | back | empty-account | unavailable`, and either update every caller's menu loop or explicitly scope the new behavior to setup.

3. **HIGH — The F2 local preflight does not prove that minting can safely proceed.** An “existence check” accepts a regular file, FIFO, inaccessible directory, or read-only directory. The current rebind probe swallows every `loadConfig` error (`src/cli/setup-cmd.ts:457-459`), so an `ENOTDIR`/permission error can look unbound; remote creation then succeeds and either mutex acquisition (`src/cli/sync-mutex.ts:140-142`) or `saveConfig` (`src/cli/config.ts:654-659`) fails while trying to create under `<root>/.rbox`. The mechanism must require `stat().isDirectory()` for existing targets, make the rebind probe catch only absence rather than every error, and perform a non-destructive local writeability/binding preflight before the server call, with defined race behavior if the path changes. The operation list in the mechanism also omits `mkdir`, while its mandatory test says accepted-missing must do `mkdir` before create. Make the canonical order unambiguous: resolve/display -> validate existing directory or confirm+mkdir missing -> rebind guard -> non-destructive local-write preflight -> remote create.

4. **HIGH — The “seen resolved on screen” invariant is not met for an existing relative path.** The only specified display of the absolute path is the missing-directory confirmation. An existing `foo` can pass the existence/rebind checks and mint without ever showing the user the absolute resolution; resolution itself is silent in `resolveInitPlan` (`src/cli/init-plan.ts:168-170`). Require the absolute path to be rendered for every create, or narrow the invariant. The missing-path prompt alone does not satisfy the stated guarantee.

5. **HIGH — Pairing errors are not necessarily state-free and cannot all be blindly retried.** The server consumes an accepted token before several later authority/mint failure points (`apps/api/src/auth/pairing.ts:119-177`). On the client, device secrets may be persisted before admission (`src/cli/e2ee-client.ts:100-118`) and credentials are saved before admission completes (`src/cli/e2ee-client.ts:130-155`). A thrown redemption can therefore mean “malformed with no effects,” “token burned,” or “credentials/local enrollment partially changed.” The loop must re-check credentials and enrollment after each error, distinguish pre-consumption input errors from post-redeem verification/admission failures, and avoid asking for another token when the first attempt actually enrolled or left a recoverable partial admission. Tests must cover a failure after `saveCredentials`, not only malformed tokens.

6. **HIGH — The token loop has two different parent menus, but the design names only one.** Setup accepts a pairing token before authorization in `stepAccount` (`src/cli/setup-cmd.ts:249-262`) and after authorization in `resolveEnrollment` (`src/cli/setup-cmd.ts:330-381`, `src/cli/setup-cmd.ts:398-417`). After three failures, the former should return to the authorization-method menu; the latter must return to the encryption-enrollment menu. Sending the latter back through authorization would re-authorize an already-authorized machine and violates the state-preservation requirement. Specify separate attempt budgets and typed transitions for these two contexts. The same policy decision is needed for a bad recovery phrase, which is another recoverable enrollment input at `src/cli/setup-cmd.ts:406-417` but is omitted from F3.

7. **HIGH — R3 cannot distinguish a successful empty listing from an unavailable listing.** `promptWorkspacePick` initializes `sorted=[]`, catches and discards every fetch failure, and then sends any empty array to manual entry (`src/cli/workspace-picker.ts:147-155`). That erases the exact distinction R3 needs: successful-empty should return to/create-new, while offline/no-token must preserve manual entry. Carry a tagged fetch outcome through the picker and test successful-empty, non-2xx/offline, and no-token independently.

8. **HIGH — R4 targets an output branch a newly created workspace cannot reach.** New workspaces always resolve to `firstSync: "push"` (`src/cli/init-plan.ts:172-176`) and execute the push branch (`src/cli/init-cmd.ts:228-282`). The `"0 pulled, 0 conflict(s)"` text is emitted only by the join/sync branch (`src/cli/init-cmd.ts:283-298`). Therefore “only when the workspace was created this run” cannot select that line in the current flow. Identify the actual observed flow and state that should change, or remove/rewrite R4 and pin the corrected branch with a test.

9. **HIGH — Menu return needs an explicit state machine, including one-shot preselection.** `runSetup` invokes `stepWorkspace` once and exits on `undefined` (`src/cli/setup-cmd.ts:160-168`); declined rebind returns exactly that (`src/cli/setup-cmd.ts:457-470`). Merely adding an outer loop is insufficient when `preselectedKind` is present, because `setupOpts.preselectedKind ?? promptSelect(...)` will bypass the menu on every iteration (`src/cli/setup-cmd.ts:426-434`). Bare `rbox` supplies that preselection from the untracked menu (`src/cli/main-dispatch.ts:516-525`, `src/cli/front-door.ts:85-111`). Require preselection to be consumed once and cleared on return, and test decline from both ordinary setup and the preselected/via-untracked path. Loop Step 2 in place so auth, enrollment, and trial state remain intact.

10. **MEDIUM — `expandUserPath` has contradictory grammar and no specified reusable re-prompt boundary.** The mechanism rejects only `~user/...`, while the mandatory test names bare `~user`. Define all leading-tilde cases explicitly (`~`, `~/...`, bare `~user`, `~user/...`, and other `~foo` forms). The only path-valued `promptInput` sites are setup (`src/cli/setup-cmd.ts:451`) and interactive init (`src/cli/init-cmd.ts:64-67`); the inputs at `setup-cmd.ts:486` and `init-cmd.ts:82` are workspace names, not paths. A thrown helper error will otherwise reach the top-level catch and set failure status (`src/cli/index.ts:23-31`, `src/cli/style.ts:65-69`). Specify a shared path-prompt loop (expand -> resolve -> validate/re-prompt) and tests for unsupported-tilde re-prompt on both interactive path prompts. The claim that flag paths come “from a real shell that expanded `~`” should be softened: quoted/programmatic `--root '~/x'` is not shell-expanded, even if its unchanged behavior remains a non-goal.

11. **MEDIUM — R1 has no reliable ambient wizard-context signal.** `redeemPair` unconditionally prints the two success messages (`src/cli/auth-cmd.ts:402-410`) and is shared by setup (`src/cli/setup-cmd.ts:261`, `src/cli/setup-cmd.ts:404`), standalone connect (`src/cli/main-dispatch.ts:362-370`), and `login` through `RBOX_PAIR_TOKEN` (`src/cli/auth-cmd.ts:195-201`). TTY state, argv, or call-stack inference would misclassify valid paths. Specify an explicit presentation/context option, defaulting to standalone behavior, and thread it through both direct setup calls and setup's calls to `login`. Test both wizard redemption locations, setup with `RBOX_PAIR_TOKEN`, standalone `rbox connect`, and standalone `rbox login`.

12. **MEDIUM — R7 needs atomic dead-pane retention and a real immediate-exit test.** `start` currently performs one `tmux new-session` invocation (`scripts/ux/tui.ts:101-105`, `scripts/ux/tui.ts:150-157`). Setting `remain-on-exit` in a second invocation races a fast-exiting child—the exact case this rider is intended to capture. Require it to be active as part of session creation (without changing unrelated host tmux defaults), then integration-test an immediately exiting `rbox` command. Both `screen` and `wait-idle` use `capture-pane`, with `wait-idle` repeating it (`scripts/ux/tui.ts:158-161`); assert both succeed against the retained dead pane, and update the stale stop comment at `scripts/ux/tui.ts:163-166`.

## Required revision before alignment

Address every finding above. At minimum, revise the design to define: (1) non-mutating join validation or rollback; (2) tagged picker outcomes that preserve successful-empty versus unavailable and safe navigation across every caller; (3) absolute-path rendering plus directory-type and local-write preflight before remote mint; (4) phase-aware pairing recovery with context-specific token return menus and an explicit recovery-phrase policy; (5) one-shot consumption of `preselectedKind`; (6) the complete `expandUserPath` grammar and shared re-prompt boundary; (7) explicit wizard context for R1; (8) contact-support quota copy; (9) a reachable R4 branch; and (10) atomic retained-dead-pane behavior for R7. Add the state-preservation and failure-after-mutation tests identified above.

**Verdict: CHANGES-REQUIRED.**

## Round 2 — review of v2

## Verdict: CHANGES-REQUIRED

V2 accepts the shape of all twelve Round-1 findings, and three rulings are now
complete at the design-contract level. The remaining rulings are not safe to
implement yet. The principal blocker is still Rule 0: the proposed listing
validator is neither an exhaustive absence proof nor a validation of the actual
`(workspaceId, projectId)` stream that `runInit` will mutate toward. The new
pairing taxonomy also labels transport failures as pre-consumption even though
the server can consume the token before the response is lost.

### Round-1 ruling verification

1. **NOT RESOLVED.** Validate-before-mutate is the correct direction, but the
   listing proof is incomplete and validates the wrong resource identity
   (Round-2 findings 1-2). The join is correctly specified as one-shot after
   validation; that part resolves the unsafe retry itself.
2. **NOT RESOLVED.** A tagged picker result is required, but `unavailable` has no
   defined manual-entry payload/ownership and the init/track mappings introduce
   automatic create paths (findings 3-4).
3. **NOT RESOLVED.** Directory type, narrowed config probing, mkdir placement,
   and preflight order are specified. Post-mint local failure and race recovery
   can still mint a second workspace, and `loadConfig` has no typed absence error
   to narrow today (finding 5).
4. **RESOLVED.** Every create renders the resolved absolute path before acting.
5. **NOT RESOLVED.** Separate phases are the right model, but transport and
   several HTTP failures cannot prove non-consumption, while the proposed state
   recheck can falsely report enrollment (findings 6-7).
6. **NOT RESOLVED.** The two pairing parents and attempt budgets are now explicit.
   Recovery is not non-mutating for every failure, so its blanket retry policy is
   still unsafe (finding 7).
7. **PARTIAL.** Success-empty and failed-fetch are conceptually distinguished,
   but the picker result contract does not say where unavailable manual entry
   occurs or how its unvalidated pick is represented (finding 3).
8. **NOT RESOLVED.** R4 now targets the reachable join branch, but an empty
   manifest does not prove that nothing was ever pushed (finding 9).
9. **PARTIAL.** One-shot preselection is correctly required. The containing
   Step-2 loop still needs a typed navigation/terminal boundary so it cannot
   re-enter `runInit` after mutation (finding 8).
10. **PARTIAL.** The tilde grammar and reusable re-prompt boundary are complete,
    but `promptPath` does not preserve the injected-cwd resolution contract
    (finding 10).
11. **RESOLVED.** Explicit wizard presentation context, defaulting to standalone,
    covers the shared redemption/login call graph without ambient inference.
12. **RESOLVED.** Creation-time, session-scoped dead-pane retention plus both
    dead-pane capture tests closes the tmux race at the contract level.

### Findings

1. **HIGH — The bounded workspace listing cannot prove that an id is absent.**
   `fetchAccountWorkspaces` stops after `maxPages = 10` and returns the accumulated
   array even when the last response still has `nextCursor`
   (`src/cli/workspace-picker.ts:186-212`); the existing bounded-pagination test
   pins that behavior (`src/cli/workspace-picker.test.ts:140-149`). The API default
   is 50 rows per page (`apps/api/src/auth/account-surface.ts:15-22`), while paid
   plans allow unbounded workspaces (`apps/api/src/plans.ts:22-27`). A valid id
   after the first 500 rows would therefore be reported as absent and rejected
   three times. The validator must receive `complete | truncated | unavailable`
   and may infer absence only from `complete`, paginate to exhaustion with cycle
   protection, or use an exact account-scoped lookup. Add a matching-id-beyond-
   the-cap test.

2. **CRITICAL — Listing presence validates only an id, not the stream `runInit`
   will bind.** Workspace authority is keyed by `(workspace_id, project_id)`
   (`apps/api/src/authz.ts:23-38`), and account-list rows expose both fields
   (`apps/api/src/auth/account-surface.ts:158-166`). `WorkspacePick` drops
   `projectId` (`src/cli/workspace-picker.ts:118-123`), setup hard-codes `root`,
   and init/track obtain their project separately (`src/cli/setup-cmd.ts:42-52`,
   `src/cli/init-cmd.ts:48-63`, `src/cli/track-cmd.ts:34-44`). Thus a listed
   `ws_X/other-project` can validate manual id `ws_X`, after which `runInit`
   resets the old baseline and saves a binding for nonexistent `ws_X/root` before
   first remote access (`src/cli/init-cmd.ts:170-226`). Carry and validate the
   full tuple, define how a picked row interacts with init/track project flags or
   prompts, and test non-root rows at all three callers.

3. **HIGH — The picker union does not define the unavailable-to-manual
   transition.** The public result is specified as `picked | back |
   empty-account | unavailable`, but `unavailable` carries no pick. The same text
   says a failed fetch maps to `unavailable`, degrades to manual entry, and keeps
   a nonblank id as today's one-shot join. Those cannot all be caller semantics
   without another transition: returning `unavailable` loses the entered id,
   while returning `picked` loses the fact that it was not validated. Define a
   separate internal listing outcome, or give a picked result explicit validation
   provenance, and pin which layer prints the warning and performs the one-shot
   manual prompt.

4. **HIGH — `back` and `empty-account` create workspaces after the user chose
   existing.** Today a successful empty listing first opens manual entry
   (`src/cli/workspace-picker.ts:147-155`); init and track create only after that
   prompt returns blank (`src/cli/init-cmd.ts:48-58`,
   `src/cli/track-cmd.ts:60-75`). V2 instead maps `empty-account` directly to the
   old `undefined`, so creation becomes immediate. The new “three rejected ids →
   back” path does the same even though the user supplied three nonblank existing
   ids. This contradicts the claim that the matrix adds no billable-create path.
   Init and track must re-render their create/join menu or stop on these outcomes;
   they must not fall through to create. Tests must assert zero create calls after
   successful-empty and validation exhaustion.

5. **HIGH — A race or local failure after mint cannot re-enter step 1 without
   minting again.** The preflight does not acquire the real mutex. Current init
   creates remotely, then `acquireWorkspaceSyncMutex` creates/locks
   `.rbox/state`, and only afterward resets/saves config
   (`src/cli/init-cmd.ts:156-212`, `src/cli/sync-mutex.ts:140-160`). Contention,
   an obstructed state path, or a path race can therefore fail after the workspace
   exists. Re-entering the five-step loop invokes create again; the create helper
   deliberately has no retry because repeating a possibly successful mint orphans
   another workspace (`src/cli/remote/api.ts:211-224`). Acquire and retain the
   actual mutex before mint, and define a post-create completion path that carries
   and reuses the minted id rather than returning to creation. Also introduce a
   typed config-absence result: `loadConfig` currently converts ENOENT to an
   ordinary message-only `Error` (`src/cli/config.ts:639-650`), so the proposed
   narrowed catch has no reliable discriminator. Test lock contention/state-path
   obstruction and failure after mint, asserting one remote call total.

6. **CRITICAL — A redeem transport failure is not provably pre-consumption, and
   HTTP status does not recover that phase.** `fetch()` can reject after the server
   processed the request but before the response arrived. The server burns the
   token at `apps/api/src/auth/pairing.ts:119-126`, then can reject authority at
   lines 135-150, mint successfully at 152-168, or fail at 169-177. Even status is
   ambiguous: 401 occurs both before and after consume, and 409 has both a
   pre-consume cap check and a post-consume backstop. The client collapses these
   cases to ordinary errors (`src/cli/e2ee-client.ts:36-45,130-155`). Only local
   input grammar/shape checks completed before `fetch` may count toward the retry
   budget. Treat transport/ambiguous HTTP failures as possibly burned and return
   to the correct parent, unless the server gains an idempotent redeem/status
   proof. Require typed phase results from the redemption layer and test a
   consumed-success/lost-response case.

7. **CRITICAL — Local enrollment state is a false-positive after admission
   failure, and recovery attempts can mutate.** `alreadyEnrolled` ultimately uses
   `hasDevice`, which checks only whether local `device.json` exists
   (`src/cli/setup-cmd.ts:214-222`, `src/cli/e2ee-keystore.ts:54-57`). Pairing
   saves credentials before admission, and `admitWithRetry` saves device secrets
   before its remote admit request (`src/cli/e2ee-client.ts:100-118,153-155`). A
   failed admission can therefore look enrolled locally although the signed server
   roster lacks the device. Recovery uses the same pre-admit persistence
   (`src/cli/e2ee-client.ts:161-185`), so the assertion that phrase failures are
   non-mutating is false after a valid phrase reaches admission; retry can generate
   another `rec_*` identity. Forward continuation requires usable local key
   material plus confirmed membership in the authenticated signed roster.
   Credentials-only or local-device-only states go to enrollment recovery without
   another token/phrase attempt. Only typed, pre-write invalid-phrase failures may
   re-prompt; post-write/admission failures reconcile state and return immediately.

8. **HIGH — The one-shot preselection loop needs a discriminated Step-2 result.**
   `stepWorkspace` currently uses `undefined` both for navigation/declined rebind
   and because it directly returns `runInit` (`src/cli/setup-cmd.ts:420-470,498-502`).
   `runInit` can return `undefined` for terminal errors and can do so after config
   mutation if enrollment disappears (`src/cli/init-cmd.ts:151-155,170-224`). An
   outer loop over falsey outcomes would then re-enter a mutating create/join in
   violation of Rule 0. Specify `menu | completed(outcome) | terminal` (or
   equivalent), clear the local preselection before its first invocation, and loop
   only on an explicit pre-`runInit` menu transition. Test a terminal undefined
   after binding and assert no menu loop or second remote call.

9. **MEDIUM — An empty fetched manifest does not mean that no machine ever
   pushed.** A sequence greater than zero may have an empty current manifest after
   an empty publish or deletion of all content. The proposed sentence would then
   be false. The actual “nothing ever pushed” predicate is a genesis head
   (`sequence === 0`), not structural emptiness alone. `pull` observes the fetched
   sequence and manifest, but `sync` discards both and returns only actions plus the
   later pushed sequence (`src/cli/sync/pull.ts:74-83`,
   `src/cli/sync/sync.ts:9-20`). Plumb the initial remote sequence to init and test
   empty-at-sequence-0 versus empty-at-sequence-greater-than-0.

10. **MEDIUM — `promptPath` lacks the cwd needed to preserve relative-path
    semantics.** The proposed signature has only `{message, default}` but performs
    `path.resolve`, which otherwise uses ambient `process.cwd()`. Interactive init
    deliberately resolves relative roots against injected `opts.cwd`
    (`src/cli/init-plan.ts:168-170`), and setup also carries an explicit `opts.cwd`.
    Give `promptPath` a `cwd`/`base` argument at both call sites (or leave final
    resolution to the existing planner) and add a test where injected cwd differs
    from process cwd.

### Required v3 changes

Resolve all ten findings above. In particular: make listing validation exhaustive
and tuple-aware; make picker navigation non-billable at every caller; preserve a
minted workspace id across any local completion retry; classify pairing/recovery
at typed mutation boundaries with server-roster reconciliation; discriminate
Step-2 navigation from terminal init outcomes; use remote sequence zero for R4;
and preserve injected-cwd path resolution.

**Verdict: CHANGES-REQUIRED.**

---

## Round 3 — review of v3

## Verdict: CHANGES-REQUIRED

V3 genuinely removes the unsafe automatic post-send retries from Round 2: a
nonblank manual join is once again single-shot, pairing never retries after the
redeem request starts, recovery never retries after local phrase validation, and
only an explicit pre-`runInit` navigation result can re-render Step 2. The local
recovery checksum and remote sequence-zero signal also both exist in current
code.

The rescope is not yet implementable as written, however. Rule 0 contradicts
F2's own disk-mutating preflight loop; the supported degraded mutex path is not a
lock; an ambiguously successful workspace mint cannot provide the promised id;
and the proposed impure picker cannot both emit setup's new warning/two-blank
flow and remain bit-identical for init/track. The token grammar and sequence-zero
copy also need contracts that match the formats and timing current code actually
exposes.

### Round-2 ruling verification

1. **RESOLVED BY RESCOPE.** The incomplete-list absence proof is gone. No
   listing result accepts or rejects a manually entered id, so truncation after
   500 rows cannot cause the proposed false local rejection.
2. **RESOLVED BY RESCOPE.** The list is no longer claimed to validate the
   `(workspaceId, projectId)` join tuple. A nonblank id enters today's one-shot
   join and never returns to the manual-id prompt. This removes the new retry
   hazard, though it intentionally does not make today's one-shot pre-access
   binding mutation transactional; v3 defers that broader join-path work.
3. **PARTIAL.** `unavailable-manual(pick?)` preserves a nonblank entered id, but
   its no-pick outcome and presentation ownership are not completely mapped
   (finding 5).
4. **NOT RESOLVED.** A separate legacy wrapper is the right compatibility
   boundary, but the impure layering described in v3 cannot provide the claimed
   bit-identical behavior (finding 5).
5. **NOT RESOLVED.** Pre-mint acquisition plus a single-shot post-mint
   continuation prevents the Round-2 double-mint loop in the normal lock path.
   The degraded/unlocked path and ambiguous-create result remain unspecified
   (findings 1-3).
6. **RESOLVED.** Only a completed local shape check counts toward the pairing
   budget; transport and every HTTP response are possibly consumed and return to
   the correct parent without an automatic retry. The concrete local grammar is
   still missing (finding 4).
7. **RESOLVED IN POLICY.** The local-device heuristic is removed, pairing and
   recovery post-send/post-write failures are single-shot, and recovery's BIP39
   validation can run locally before the attempt. The checksum's guarantee and
   prevalidated-input seam need tightening (finding 6).
8. **RESOLVED.** `menu | completed | terminal`, with `menu` restricted to
   pre-`runInit` navigation and one-shot preselection, closes the falsey-result
   re-entry hazard.
9. **PARTIAL.** `sequence === 0` is the correct never-pushed predicate and the
   value is available at the pull boundary. The proposed completion copy can be
   stale after the same sync pushes, and its scripted-output scope conflicts with
   the non-goal (finding 7).
10. **RESOLVED.** Required injected `cwd` at both `promptPath` sites preserves
    current relative-root semantics.

### Findings

1. **CRITICAL — Rule 0's claimed proof boundary does not exist.** Rule 0 allows
   a wizard retry only when validation precedes *any* network request or on-disk
   mutation, but F2 accepts `mkdir -p`, then permits config-probe or mutex failure
   to re-enter step 1. Mutex acquisition itself creates `.rbox/state` and lock
   artifacts (`src/cli/sync-mutex.ts:140-160`). Taken literally across the
   wizard, the pairing/recovery checks also occur after earlier account traffic:
   `resolveEnrollment` calls `getAccountKeys()` before it presents either input
   (`src/cli/setup-cmd.ts:352-381`). Define the boundary per submitted input and
   consequential operation, and explicitly permit specified reversible
   preflight artifacts, or make every failure after `mkdir`/lock terminal. Also
   state that existing protocol-level reconciliation retries such as admission
   conflicts are outside this wizard-input rule. As written, the "final form"
   is violated by the mechanism it is supposed to govern.

2. **HIGH — `acquireWorkspaceSyncMutex` does not always acquire a real mutex.**
   Unsupported lock identity returns `{ root, degraded: ... }` with no lock and
   is treated as success (`src/cli/sync-mutex.ts:105-119,152-155`); release is then
   a no-op (`src/cli/sync-mutex.ts:167-170`). Two setup processes can therefore
   both pass the claimed **LOCKED** precondition and mint. Setup-create must fail
   closed on `workspaceSyncMutexDegraded(handle)`, or v3 must drop the locked-dir
   invariant and specify the accepted race. Add a degraded-handle test.

   The normal reorder is feasible, but it requires a structured init
   continuation that accepts both the precreated id and the already-held handle.
   Today `executeInitPlan` creates at `src/cli/init-cmd.ts:156-168` and acquires at
   `:170-173`; passing only the id as `--workspace` is not equivalent because the
   planner changes a create/push into a join/sync (`src/cli/init-plan.ts:164-176`).
   Specify that the new seam preserves `workspace.kind === "new"`, skips both
   internal mint and reacquisition, asserts the handle's root, and releases it
   exactly once on every exit.

3. **HIGH — A lost create response cannot print the promised workspace id.**
   `createRemoteWorkspace` deliberately makes zero retries because the server
   may have minted successfully before a socket close
   (`src/cli/remote/api.ts:211-224`). In that branch the client has no `ws_X`, so
   it cannot print v3's exact existing-workspace resume path. Current code already
   distinguishes this uncertainty with "the request may or may not have
   completed — check `rbox status` or your workspaces list before re-running"
   (`src/cli/remote/errors.ts:66`). Preserve a distinct single-shot
   **unknown-create-outcome** message and test response loss separately from a
   later local failure after the helper returned a known id.

4. **HIGH — The pairing-token shape is not derivable from the cited client
   file.** `enrollViaPairing` checks only for a last dot and a decoded 32-byte
   secret (`src/cli/e2ee-client.ts:123-129`). The redeem-id charset/length and
   optional prefix behavior live in the server
   (`apps/api/src/auth/pairing.ts:10-18,91-96`), while current minting constructs
   `t` + 16 random base64url bytes and appends a 32-byte base64url secret
   (`src/cli/auth-cmd.ts:374-390`). A newly guessed wizard-only validator can
   reject a form that the existing redeem path accepts. Define one reusable pure
   parser, including prefix/raw and legacy policy, separator count, id
   charset/length, and canonical secret encoding; call that same parser from the
   local retry gate and redemption. Pin accepted current and compatibility
   vectors plus malformed vectors, with zero fetch calls for every rejection.

5. **HIGH — The legacy picker cannot be bit-identical at the layer v3
   describes.** Today fetch failure is silent and falls into one manual prompt;
   one blank returns `undefined` (`src/cli/workspace-picker.ts:147-155,175-184`),
   after which init and track create (`src/cli/init-cmd.ts:48-58`,
   `src/cli/track-cmd.ts:60-76`). V3 has the internal picker itself warn on fetch
   failure and run manual entry, while setup's manual entry uses a two-blank
   policy. A wrapper around that completed impure operation cannot retract the
   warning or extra prompt. Split the fetch outcome from presentation/manual
   policy, or pass an explicit `setup | legacy` mode before any output or prompt.
   Define how `unavailable-manual(undefined)` maps in setup. Expand the
   bit-identical tests across no token, fetch failure and warning output,
   successful empty, nonempty-list manual escape, prompt count, and blank for
   both init and track; the current mandated pair of cases is insufficient to
   prove bit identity.

6. **MEDIUM — The recovery checksum is real, but it does not catch every
   typo.** `phraseToRk` is a local 24-word BIP39 decoder with word-list and 8-bit
   checksum validation (`src/engine/e2ee/recovery.ts:41-61`). Its own test notes
   that a one-word substitution passes the checksum about 1/256 of the time
   (`src/engine/e2ee/recovery.test.ts:31-39`). Say it catches malformed phrases
   and most typos locally; a checksum-valid wrong phrase proceeds to exactly one
   attempt. Current recovery fetches account keys before parsing the phrase
   (`src/cli/e2ee-client.ts:161-171`), so expose/use a prevalidated recovery-key
   continuation (or explicitly prevalidate once in setup) to make the local gate
   unambiguous and avoid classifying downstream failures as local input errors.

7. **MEDIUM — Sequence zero is available, but the completion sentence can be
   false by the time it prints.** Pull observes the initial sequence at
   `src/cli/sync/pull.ts:74-83`; `sync` discards it, then may push and advance the
   workspace before returning (`src/cli/sync/sync.ts:17-19`). A sequence-zero
   join with local files can therefore print "no machine has pushed" after this
   machine just did. Plumb an explicit `initialRemoteSequence` through the init
   path without substituting `pushedSequence`, and phrase the message as a past
   pull-time fact (for example, "nothing was available to pull — this workspace
   had no prior snapshot") or additionally require that no push committed. Also
   reconcile "sequence-0 joins print" with the non-goal that scripted flows are
   unchanged: either scope R4 to guided setup presentation or acknowledge and
   test the deliberate `rbox init --workspace` output change.

### Required v4 changes

Make Rule 0 attempt-scoped and consistent with allowed local preflight writes;
fail closed on a degraded mutex; specify the precreated-id/preheld-handle init
seam and its ownership; add an unknown-create-outcome branch; centralize the
pair-token parser; split picker fetch state from setup/legacy presentation;
state the recovery checksum's actual guarantee; and make sequence-zero copy
truthful and explicitly scoped. Extend the mandatory tests with the degraded
mutex, lost create response, full token compatibility grammar, complete legacy
picker matrix, and sequence-zero-with-local-push cases.

**Verdict: CHANGES-REQUIRED.**

---

## Round 4 — review of v4

## Verdict: CHANGES-REQUIRED

V4 genuinely resolves five of the seven Round-3 contracts and most of the mutex
and token-parser contracts. Rule 0 is now attempt-scoped and names the permitted
preflight artifacts; degraded mutexes fail closed; create outcome uncertainty
has its own no-id/no-retry branch; picker presentation is selected before any
output; recovery states the checksum's real guarantee and passes a parsed key to
a prevalidated continuation; and R4 carries `initialRemoteSequence` separately,
uses pull-time wording, and is scoped to guided setup.

Two remaining ownership/grammar ambiguities would cause conforming implementers
to build different behavior.

### Round-3 finding verification

1. **RESOLVED.** Rule 0 is explicitly per submitted input, permits the confirmed
   mkdir target and mutex-created `.rbox/state` artifacts, and excludes both
   pre-prompt traffic and protocol-internal reconciliation retries.
2. **PARTIAL.** Degraded handles now fail closed, and the continuation preserves
   `workspace.kind === "new"`, reuses the held handle, asserts its root, and owns
   release after entry. Ownership before continuation entry is still missing
   (Round-4 finding 1).
3. **RESOLVED.** Known-id local failure and unknown create outcome are distinct;
   the latter preserves the existing uncertainty message, claims no id, and does
   not retry. Its held-mutex cleanup remains part of finding 1, not an outcome-
   classification defect.
4. **NOT RESOLVED.** One shared parser is required at both call sites, but its
   accepted secret grammar is contradictory (Round-4 finding 2).
5. **RESOLVED.** Fetch and presentation are separated, the mode is chosen before
   output or prompting, setup's no-pick mapping is explicit, and the legacy
   matrix covers both init and track.
6. **RESOLVED.** The text accurately limits the checksum guarantee, sends a
   checksum-valid wrong phrase through one attempt, and hands the parsed key to a
   prevalidated continuation without downstream reclassification.
7. **RESOLVED.** `initialRemoteSequence` is distinct from `pushedSequence`, the
   copy describes the pull-time fact, guided setup alone renders it, and the
   same-sync-push plus scripted-init tests pin both timing and scope.

### Findings

1. **HIGH — The pre-mint mutex has no owner when workspace creation itself
   fails.** The structured continuation accepts a *precreated* workspace id, so
   it cannot be entered when `createRemoteWorkspace` throws. Its exactly-once
   release guarantee therefore covers success and post-id continuation failures,
   but not a lost response (`NetworkError`), an ordinary non-2xx create response,
   or response parsing that fails before an id is available. Step 5 makes those
   paths terminal without assigning cleanup to the preflight caller. Specify an
   outer owner that releases on every pre-transfer failure, then transfers
   ownership exactly once only after a validated id is returned. Add create-
   failure tests (including the lost-response branch) that assert one release and
   no continuation entry; retain the existing continuation success/failure
   exactly-once tests.

2. **HIGH — “Canonical secret encoding” conflicts with preserving every token
   form the current redemption path accepts.** `enrollViaPairing` currently
   decodes with `fromB64url` and checks only the resulting 32-byte length
   (`src/cli/e2ee-client.ts:123-129`). That decoder accepts padded base64url and
   standard-base64 `+`/`/` equivalents as well as the unpadded base64url emitted
   by minting (`src/engine/encoding.ts:1-12`, `src/cli/auth-cmd.ts:374-390`). Those
   equivalent secrets can redeem successfully because only the redeem id is sent
   to the server and the decoded secret is used locally. V4 simultaneously says
   the parser uses canonical secret encoding and must accept every form today's
   redeem path accepts, so an implementer can either reject or normalize those
   compatibility forms. State the exact accepted encodings (and whether
   noncanonical equivalents normalize or reject), then include each decision in
   the compatibility/malformed vectors. This determines whether the wizard makes
   a network request for the same pasted token.

### Required v5 changes

Define pre-continuation mutex ownership and exactly-once cleanup for every create
failure, and make the shared parser's accepted secret encodings unambiguous with
explicit vectors. No other Round-3 ruling needs revision.

**Verdict: CHANGES-REQUIRED.**
