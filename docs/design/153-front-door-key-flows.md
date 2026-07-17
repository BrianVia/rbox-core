# 153 — Front-door key flows: task-complete menus, honest browser handoff, and a three-line status brief

Status: **ALIGNED v6** — five review rounds (15→13→7→9→ALIGNED with four
fully-prescribed LOWs applied). All founder input and all rulings in
`REVIEW-153.md` are binding here; where an earlier version differs, the later
ruling (especially ACCEPT-MODIFIED) wins.

Source: the founder's 2026-07-18 report that bare `rbox` did not expose
"set up a new device" or "start syncing a new workspace"; the promoted
2026-07-16 TUI persona walkthrough; the founder's bare-`rbox` status screenshot;
and the web-first, GitHub-sign-in, plan-`none` production signup.

## 1. Re-verified implementation anchors

These are current-source anchors, not line references inherited unchecked from
v1:

- `track-cmd.ts:1-9,38-44,105-148` explicitly defines `rbox track` as
  **bind-only**. It resolves the supplied path, takes the sync mutex, saves the
  binding, and says the first sync waits for `rbox sync` or `rbox start`. It has
  no existence/type/create-confirm preflight.
- `setup-cmd.ts:172-187` is the enrolled-account skip and account-result join;
  the plan step currently runs only when `result.created`. The existing plan
  machinery is at `setup-cmd.ts:388-424`. `setup-cmd.ts:663-688` is the
  create-new path preflight: prompt/tilde resolution, stat, explicit create
  confirmation, then confirmed `mkdir -p`.
- `prompt.ts:31-38` owns awaited-prompt `ExitPromptError`, but currently exits
  130 without context or copy; `prompt.ts:49-58` separately handles the
  cancelable select. `front-door.ts:58-69` is a second, silent cancellation
  owner that must disappear.
- `front-door.ts:19-31,34-46,71-112` contains the tracked choices, three-way
  bare-command target, and `WorkspaceKind | undefined` untracked result.
  `main-dispatch.ts:518-529` confirms the TTY gate and target dispatch; lines
  530-533 show why any truthy untracked result currently falls into setup.
- `auth-cmd.ts:203-205` is the string-concatenating approval URL builder;
  `auth-cmd.ts:250-259` prints and offers it; `auth-cmd.ts:334-339` handles only
  open/copy, so "I'll approve it another way" has no action.
- `auth-cmd.ts:231,287-291` are the two authorization commit seams. Line 231
  awaits the bootstrap credential write before starting genesis enrollment. In
  the device-code path, lines 287-291 validate approval, await the credential
  write, print authorization, and immediately
  enter the internal encryption continuation. Those are distinct commit
  boundaries today, but there is no authorization-only wizard return between
  them.
- `track-cmd.ts:63-84` owns an interactive create/existing choice inside the
  bind-only command. When the existing-workspace picker returns blank/back,
  `workspaceId` remains absent and line 84 falls through to remote creation.
  This is the picker-back→remote-create defect fixed at the guided menu
  orchestrator seam in A2; the scripted command remains bind-only.
- `scripts/ux/lib.ts:23-26` deliberately scrubs and then blanks `RBOX_APP` while
  pointing the harness at DEV. `scripts/ux/WALKTHROUGH.md:89-95` documents that
  browser automation stops at the handoff and the blank prevents a DEV login
  from opening production. The old bare `/cli-login` observation was therefore
  a harness artifact. Design 137-R2 already hardened empty-as-unset and unit
  tested the full-host result; it is not an outstanding live URL-builder defect.
- `browser-open.ts:85-108` documents and implements `waitForKeypress`; its raw
  Ctrl-C path restores stdin and then calls `process.exit(130)` directly at
  lines 101-103. Its pins still live in `browser-open.test.ts:158-199`, outside
  the shared cancellation owner.
- `usage-cmd.ts:5-14,22-33` defines the account-usage DTO and fetches
  `/v1/account/usage`; its `plan: string` is the existing authenticated plan
  probe. `subscribe-cmd.ts:26-38` exposes the existing checkout seam and its
  four rejection classes: billing-disabled 501, other non-OK, malformed or
  missing-URL response, and network rejection.
- `credentials.ts:38-52` makes any truthy `RBOX_TOKEN` shadow the credential
  file, synthesizes `deviceId: "env"` when the companion value is absent, and
  exposes no credential provenance. The wizard must therefore classify the
  environment tuple before calling this lossy loader.
- `init-plan.ts:172-176` already pins the safe first-populate distinction:
  create pushes, while join pulls/reconciles (`sync`, or `pull` when explicitly
  pull-only). Guided track must carry that distinction instead of erasing it.
- `status-view.ts:21-51,450-487` shows that `StatusSnapshot` omits several
  brief-kept states and that behind-remote rendering currently exposes local
  and remote sequence numbers, including as a suffix on simultaneous upload.
  `status-cmd.ts:273,305` bracket the split: line 273 begins the pre-state-load
  reset-halt branch, while line 305 is the full path's first `loadState`; a
  single all-fields snapshot cannot honestly span that boundary. Lines 586-659
  are the unconditional legacy
  daemon/locking/git/metrics/footer block. `activity.ts:72` stores a free-form
  halt reason, so brief copy must classify known reasons and contain unknown
  strings rather than printing them.
- `account-cmd.ts:63` begins the complete best-effort account discriminant:
  `ok | signed-out | unavailable`. The brief identity contract must render all
  three arms, not only the successful email case.
- All eleven `scripts/ux/flows/*.flow.ts` files are now `status: "pass"`.
  `status-healthy.flow.ts:20-21` is pinned to the soon-suppressed healthy daemon
  line, and `tilde-expansion.flow.ts:24-28` is pinned to the legacy workspace
  heading. Design 140 freezes those assertions and therefore needs the explicit
  in-unit amendment in Unit D below.
- `api-base.ts:3-8` compares the raw `RBOX_API` string and echoes the complete
  override in its warning, including possible URL credentials. It has no URL
  parsing or origin normalization. `contrib/swiftbar/rbox.5s.sh:16,196-208,258-288`
  independently chooses a web origin, falls back to identifiers, and renders
  sequences; it is the named out-of-scope rider in B1, not part of this CLI
  approval/status implementation.
- `.github/workflows/ci.yml:116` begins the structural rule that
  only `src/cli/prompt.ts` may import `@inquirer`; the custom select adapter in
  C3 is covered by that existing boundary. `scripts/ux/flow.ts:6,113` shows the
  asymmetry: the command assertion interface begins at line 6 with positive
  stdout/stderr only; live-screen negative validation closes at lines 110-111,
  immediately before line 113 starts the next (`pollUntil`) branch. D1 adds the
  missing command analogue, `assertNotStdout`.

Two downstream recursive mkdirs explain why the shared path preflight is an
invariant, not presentation polish: mutex acquisition at `sync-mutex.ts:135-142`
and config save at `config.ts:704-709` can manufacture `.rbox` and its missing
parents. They may run only after the user has accepted the resolved target.

## 2. Unit A — context-valid, task-complete menus

There is no universal "same actions everywhere" rule. Each menu exposes the
tasks that are valid in its state. The ordered inventory is a product judgment
from the founder gripe plus the Round-1 orchestrator call; it is not claimed as
an empirical characterization of the old audit.

| Context | Visible rows, in order | Rationale |
| --- | --- | --- |
| Tracked directory + enrolled machine | 1. Sync now (`rbox sync`)<br>2. Pause syncing / Start syncing (`rbox stop` / `rbox start`, state-dependent)<br>3. View logs (`rbox logs`)<br>4. Track another folder<br>5. Add another device (`rbox pair`)<br>6. Nothing, I'm good | The current root supports sync, daemon, and log operations. Tracking another root and minting a pairing token are valid account-level tasks. Recovery is deliberately absent: this enrolled machine already has working keys. |
| Untracked directory + enrolled machine | 1. Track this directory<br>2. Sync an existing workspace<br>3. Add another device (`rbox pair`)<br>4. Nothing, I'm good | There is no bound root on which sync/log/start can operate. Create/join and account-level pairing are valid. Recovery is deliberately absent because the machine is already enrolled. |
| Not enrolled | Setup Account step: 1. Create a new account<br>2. Log into an existing account<br>3. Recover access with my 24-word phrase | Root and device-pair operations require enrollment first. Recovery is visible here, but server authentication still precedes key recovery. |

"Nothing" is last in the two steady-state menus. Rows retain the command-tutor
descriptions where an equivalent command exists. Ordered choice-array pin tests
are **new coverage**, including labels, values, descriptions, and the
start/pause substitution.

### A1. Typed dispatch and pair completion

Replace the ambiguous untracked `WorkspaceKind | undefined` contract with:

```ts
type UntrackedMenuResult =
  | { kind: "workspace"; workspace: "new" | "existing" }
  | { kind: "pair" }
  | { kind: "dismissed" };
```

The untracked menu executes the real pairing flow before returning `{kind:
"pair"}`. The dispatcher exhaustively switches the result and calls `runSetup`
only for `{kind:"workspace"}`; pair and dismissed terminate the menu path and
can never fall through to setup. The tracked menu likewise invokes the real
pair machinery and leaves the complete token + new-machine paste instruction
visible.

Pin the `main-dispatch.ts:523` TTY gate: bare interactive `rbox` dispatches the
typed result; non-TTY bare `rbox` still renders help and never opens a prompt.
Also pin the routing edge the context table implies: a FOUND root whose machine
is NOT enrolled routes to setup, not the front door (enrollment is
authoritative over root presence). Round-5 pins: non-TTY planless
`rbox subscribe` retains the current usage error and never prompts; the
concurrent approval select is aborted IMMEDIATELY when approval lands (before
credential/enrollment continuation), not in the outer finally; daemon-halt
mass-delete becomes a TYPED producer reason before persistence (raw strings are
never classified), and `haltReason` is a top-level optional JSON field.
Implementation note (round 5, editorial): factor the origin policy into a
pre-device-code classifier (wizard rows/footer) plus a post-start URL
constructor taking `userCode`.

### A2. One acknowledged-path preflight, then a task-complete menu track

Extract the path work at `setup-cmd.ts:663-688` into one shared guided-path
helper used by both setup workspace branches and the menu track flow:

1. Prompt through `promptPath`, so complete leading-tilde expansion and injected
   `cwd` resolution remain exactly design 137's contract; echo the absolute
   `will sync: <path>` result.
2. `stat` it. A directory continues; a non-directory or unreadable path prints
   the local error and re-prompts.
3. A missing target requires the explicit default-No
   `"<path> doesn't exist — create it?"` confirmation. Decline re-prompts;
   accept performs design 137's confirmed `mkdir -p`.
4. Only after the helper returns may track, mutex, config, or init machinery
   touch the root. Thus downstream recursive mkdirs never create a root or its
   parents implicitly; any such creation was covered by the user's explicit
   target confirmation.

The tracked-menu row is not a thin call to the bind-only command. The menu
orchestrator owns this submenu; it does not delegate navigation to
`trackCmd`:

| Guided-track submenu row | Result |
| --- | --- |
| Create a new workspace | Select the create disposition, then continue to the pre-bind plan gate and remote create. |
| Sync an existing workspace | Open the existing-workspace picker. A selection returns here as the join disposition; picker back returns to this submenu without creating anything. |
| Back | Return exactly one level to the tracked or untracked front-door menu that opened guided track. |

Every back edge is local and explicit: picker → create/join/back submenu →
calling front-door menu. It never becomes an absent `workspaceId`. The current
`track-cmd.ts:63-84` behavior, where picker back leaves `workspaceId` empty and
therefore enters remote creation at line 84, is a named fall-through defect.
Fix it at the orchestrator seam and add a no-create/no-bind pin: factor the
binding primitive to require an explicit create/join disposition, let guided
menu track supply its own submenu result, and make the interactive `rbox track`
orchestrator return to its create/existing choice (or cancel cleanly) when its
picker backs out. Neither caller may translate back into create. Do not broaden
the bind-only command into a task-complete wizard.

Its sequence is:

```text
prompt → shared path preflight → create/join/back submenu
       → tri-state plan probe/chooser → create or select remote → bind with explicit path
       → initial populate-sync → offer background start
```

The plan probe occurs after a final create/join choice (and, for join, after a
read-only picker selection) but synchronously before the first mutating remote
create or local bind call. `active` proceeds, `none` offers A4's chooser, and
`unknown` proceeds silently. Back before that boundary performs no probe,
remote create, or bind; confirmed directory creation from the preceding shared
preflight may already have completed and is reported by C2's effect-aware
cancellation contract. This extra gate applies only to interactive menu-track;
scripted `rbox track` remains probe-free.

After bind, `active | unknown` proceeds to initial populate and the background-
start offer; an attempted activation that remains inactive binds in no-sync mode
and skips both initial populate and the background-start offer.

The shared guided bind seam returns its decision rather than making the caller
infer it from an id, output string, or prior menu value:

```ts
type TrackDisposition = { disposition: "created" } | { disposition: "joined" };
```

That typed disposition drives initial population. `created` runs the existing
first-publish push primitive; `joined` runs the existing pull/reconcile
primitive and never blind-uploads the local tree. This matches the already
pinned `init-plan.ts:172-176` first-sync contract. The result is carried through
the shared binding machinery to the menu orchestrator; it is not reconstructed
after binding.

Factor a guided completion seam from setup so the menu uses the same initial
populate semantics/presentation and the same Step-3 `START_SYNC_CHOICES`,
`startSyncActions`, daemon start, and autostart machinery. The menu's completion
copy reports bind, populate, and start outcome end to end.

The `rbox track <path>` **command remains bind-only**, including its scripted
and noninteractive contract and its current "First sync runs on ..." output.
Command tests continue to prove it performs no initial sync. Only the menu
orchestrator calls the guided completion seam after shared binding machinery.
Primitive-level tests pin created→push and joined→pull/reconcile, and an
orchestration test pins that the returned disposition selects the primitive.

### A3. Recovery is auth-first, then preselected recovery

The new Step-1 recovery row is derived from Unit B's resolved approval
presentation. When a validated browser URL exists, it carries this description
exactly:

> sign in with your browser first — your phrase then unlocks your data.

For command-only non-production presentation, it instead carries this
description exactly:

> approve this machine from another signed-in machine first — your phrase then unlocks your data.

Selecting it runs device-code login first. `login` gains an explicit wizard
authorization-only continuation:

```ts
type WizardLoginResult = { kind: "authorization-only" };
```

In that mode the approved device credential is saved and the result is returned
to the Step-1 orchestrator; `login` does not call
`handleDeviceCodePostApprovalEncryption`, prompt for genesis, or otherwise
continue enrollment internally. Standalone `rbox login`, bootstrap login, and
pairing keep their settled behavior. A3 consumes `{kind:"authorization-only"}`
and jumps directly to the existing recovery continuation with `recover`
preselected, skipping the enrollment-method menu. The phrase is never treated
as an account-authentication credential.

After any authorization-only result, Step 1 enters an explicit
`already-authorized` state and probes server keys once, producing the closed
`absent | present` result. When keys are absent, retain the existing
first-machine genesis offer, `This is my first machine — set up encryption
now`, ahead of the three rows below; selecting it runs the existing genesis
continuation and recovery-phrase presentation. When keys are present, its copy
is `This machine is signed in but encryption isn't set up.` and its ordered menu
is:

1. `Paste a pairing token`
2. `Recover with my 24-word phrase`
3. `I'll do this later`

It contains no create-account, browser-sign-in, approve-code, or other
authorization row. A back from pairing/recovery enrollment lands on the
matching server-key arm of this exact state; it never replays device-code
start/poll, re-saves credentials, or returns to the pre-authorization account
picker. A later setup invocation with valid credentials but no local enrollment
starts in the same discriminated state. A3's preselected recovery is a child of
the `present` arm, so backing out of phrase entry reveals the three rows above.
Tests pin both arms and prove an `absent` first device is never stranded without
the genesis offer.

A user with neither a browser nor another already-signed-in machine cannot
authenticate to the server at all. That is a server-auth invariant and is out
of scope for this CLI design. Unit B therefore does not advertise phrase
recovery as an "approve it another way" alternative. The authorization-menu
rows, its lost-access footer, and this recovery-row description share one
origin-policy result; ordered choice-array pins cover production default,
non-production command-only, and valid override so stale `app.rbox.to` copy
cannot survive in only one entrance.

### A4. Every enrolled plan-`none` account sees the plan step

The create-only condition at `setup-cmd.ts:185-187` is removed. Immediately
after enrollment resolves, inspect the authenticated account plan regardless of
whether the path was bootstrap creation, browser signup, existing-account
login, pairing, recovery, an already-authorized resume, an already-enrolled
account skip, or entry through the untracked menu. The probe therefore sits
after the whole account/enrollment gate, not inside today's
`!viaUntrackedMenu`/new-account branch.

The probe is a typed `"active" | "none" | "unknown"` result over the existing
authenticated `/v1/account/usage` endpoint at `usage-cmd.ts:24`:

- `active`: continue without another prompt;
- `none`: offer the same trial/plan chooser inline;
- `unknown`: continue silently—no plan prompt, no refusal copy, and no claim
  that the account is planless. Server enforcement speaks at push time.

Any non-OK, network, parse, absent-plan, or unrecognized probe response maps to
`unknown`; it does not collapse to `none`. Factor the current checkout/poll
machinery rather than create a second plan flow. Add an explicit "Not now"
choice so the step is skippable. Choosing it, timing out after a launched
checkout, or polling a still-inactive account preserves the existing no-sync
setup behavior and prints the same fallback the push refusal uses:

> no active plan — run `rbox subscribe`.

The silent `unknown` probe is not one of those attempted-activation outcomes.

Bare interactive `rbox subscribe` reuses this same plan chooser and checkout
machinery. An explicit plan (`rbox subscribe solo` or `rbox subscribe pro`)
retains the existing scripted contract, including `--annual`; only the missing-
plan form changes from a usage error to the chooser. Therefore every CTA in
this design remains exactly `rbox subscribe` and is executable as printed.

The interactive menu-track entrance is the one exception to the physical
placement of the common post-enrollment gate: it is already enrolled, so it
runs the same tri-state probe and chooser at A2's pre-bind boundary. This keeps
the product invariant true for every interactive enrolled plan-`none` account
without adding a network probe to scripted `rbox track`. Probe/chooser outcomes
and environment-credential handling are identical at both entrances.

Checkout launch is fail-open for setup. Catch each rejection class exposed by
`subscribe-cmd.ts:26-38`—billing-disabled, other non-OK, malformed JSON or
missing URL, and network—and print exactly one actionable line:

> Checkout couldn't start — setup will continue; choose a plan later with `rbox subscribe`.

Then continue setup in no-sync mode without retrying checkout or printing an
exception/stack. This checkout line replaces, rather than precedes, the generic
no-plan fallback so there is exactly one plan-related line. Tests pin one line
and continuation for every rejection class.

Environment credentials are a separate gate before this probe. If a non-empty
(truthy) `RBOX_TOKEN` is present, it continues to shadow file credentials, but
the guided wizard accepts it only with both `RBOX_DEVICE_ID` and
`RBOX_ACCOUNT_ID`; token only or any incomplete tuple is unsupported and stops
before prompts or mutation with guidance to supply the full tuple or unset it
and use login.
Missing tuple members are never filled from the shadowed file. `RBOX_API`
remains optional and defaults normally. A complete environment tuple skips the
plan probe and chooser and prints exactly one note:

> Plan check skipped for environment credentials; syncing will verify access when it starts.

This avoids treating ambient CI credentials as an interactive billing
identity. Tests pin token-only rejection, a full tuple, and environment-over-file
shadowing, including that the shadowed file cannot silently re-enable the plan
step. No API, schema, or other server change is required.

## 3. Unit B — remote-aware browser handoff with no dead end

The 2026-07-16 bare approval path is attributed to the intentionally blanked
`RBOX_APP` harness state described above. Empty-as-unset was fixed and tested by
137-R2. This unit verifies that hardening, makes origin selection remote-aware,
and closes the still-real no-action and cancellation gaps; it does not redesign
the device-code protocol.

### B1. Origin policy and URL postconditions

Approval presentation receives both `remoteUrl` and `userCode` and returns a
discriminated `url | command-only` result:

- a non-empty, validated `RBOX_APP` override always wins for every remote;
- with no override, production API origin (`PROD_REMOTE`) uses `PROD_WEB`;
- with no override, every non-production remote prints **no URL** and leads
  with `rbox device approve <CODE>` instead of sending a DEV code to production;
- an invalid override prints one warning and is then treated as unavailable,
  so the same production/non-production rule applies. Empty remains unset.

Production classification is an origin comparison, not raw string equality:
parse `remoteUrl` and `PROD_REMOTE`, require absolute HTTP(S), and compare their
normalized `URL.origin` values. Host casing, default ports, path, query,
fragment, and trailing slash therefore cannot misclassify the production
origin. A malformed or non-HTTP(S) remote is classified as non-production and
gets command-only presentation. The classifier never throws user input back in
an error.

Use the URL API, not string concatenation. An accepted base must be absolute
HTTP(S) with no username or password. Construction replaces any base path with
the exact `/cli-login` pathname, clears inherited query and fragment, then sets
one `code=<userCode>` query parameter. Before returning, assert:

- scheme is `http:` or `https:`;
- pathname is exactly `/cli-login`;
- `code` is the expected value and is not duplicated;
- username/password and hash are empty.

The test table includes ordinary production/override bases plus bases with an
existing query, fragment, userinfo, base path, and with/without a trailing
slash. Userinfo and non-HTTP(S)/relative garbage reject; query, fragment,
base-path, and slash variants normalize to the postconditions without leaking
old components.

Warnings are credential-safe. Invalid `RBOX_APP` and malformed `RBOX_API` or
remote warnings name the variable and the generic reason but never interpolate
the raw value, URL userinfo, token, username, or password. The raw echo at
`api-base.ts:3-5` is therefore sanitized as part of this approval boundary;
approval code must not first leak a credential-bearing override while deciding
that it has no safe URL.

This origin policy is scoped to CLI device approval. The independently shipped
SwiftBar script at `contrib/swiftbar/rbox.5s.sh` still defaults `APP_URL` and
renders its own dashboard links; aligning it is an explicit out-of-scope rider,
not a claim made by this unit.

### B2. "Approve it another way" has an action

The resolved presentation owns these exact ordered wizard authorization rows;
the arrays are complete, not prefixes to which callers may append rows:

| Presentation arm | Ordered rows (`name` — `description`) |
| --- | --- |
| `url` | 1. `Paste a pairing token` — `create one with rbox pair on a signed-in machine`<br>2. `Sign in via browser` — `open <origin> to approve — no second terminal needed`<br>3. `Approve a code` — `show a code to approve on an already-signed-in machine — this authorizes but does not carry encryption` |
| `command-only` | 1. `Approve a code` — `show a code to approve on an already-signed-in machine — this authorizes but does not carry encryption`<br>2. `Paste a pairing token` — `create one with rbox pair on a signed-in machine` |

Here and below, `<url>` is the full validated approval URL, `<origin>` is that
URL's normalized origin, `<CODE>` is the server-issued user code, and `<n>` is
the formatted remaining whole-second count. The `url` arm's concurrent approval
prompt has exactly these ordered rows:
`Open in browser` — `launch the URL above in your default browser`; `Copy URL
to clipboard` — `paste it into a browser on any device`; `I'll approve it
another way` — `show every available approval method`. The `command-only` arm
has no open/copy prompt and therefore has the empty row array.

The lost-access footer is exact per arm. The `url` arm prints `lost access to
your other machines? sign in with your browser first, then choose 'Recover with
my 24-word phrase'`. The `command-only` arm prints `lost access to your other
machines? this remote requires another signed-in machine before phrase recovery
can start`. The A3 recovery description and footer switch from the same
discriminant; no stale browser promise may survive in either.

Selecting `I'll approve it another way` in the `url` arm prints exactly this and
then resumes the same poll:

```text
Approve from any browser:
    <url>
Or run `rbox device approve <CODE>` on an already-signed-in machine.
```

The corresponding alternate-way output for `command-only` presentation is
printed as the primary instruction (there is no selectable open/copy prompt):

```text
No browser approval URL is configured for this remote.
Run `rbox device approve <CODE>` on an already-signed-in machine.
```

Do not print a production fallback, a recovery-phrase line, or imply that a
browser-less single-machine user can authenticate when the server cannot.
Ordered exact choice/copy pins cover production default URL, valid override
URL, non-production command-only, malformed-remote command-only, and invalid-
override fallback.

The waiting line is:

```text
Waiting for approval (expires in <n> seconds) — Ctrl-C to cancel; nothing is changed until approval.
```

`<n>` inflects `second`/`seconds`. Both terminal poll outcomes are also exact in
each presentation arm; presentation changes available methods, not restart
copy:

| Caller | `url` expired / timed out | `command-only` expired / timed out |
| --- | --- | --- |
| Standalone login | ``Approval expired — run `rbox login` to start again.`` / ``Approval timed out — run `rbox login` to start again.`` | ``Approval expired — run `rbox login` to start again.`` / ``Approval timed out — run `rbox login` to start again.`` |
| Setup wizard | `Approval expired — choose the sign-in option again.` / `Approval timed out — choose the sign-in option again.` | `Approval expired — choose the sign-in option again.` / `Approval timed out — choose the sign-in option again.` |

Ctrl-C follows Unit C's single prompt-cancellation owner. Escape during the poll
is swallowed as a no-op; it must not leak a literal escape sequence.

## 4. Unit C — persona residue, with an evidence-bounded gate

### C1. Reclassification and Phase 0

The design-137 items are **source/unit/live-gate proven; exploratory rerun
pending**: tilde expansion, acknowledged missing-path creation/no phantom
workspace, empty-id navigation, ordinary and preselected declined-rebind menu
return, malformed-token local re-prompt, empty-workspace copy, and the
pull-time never-pushed message. Do not reimplement them from the old audit's
pre-137 symptoms. Escape is new ground; centralized cancellation is new v2
work.

Phase 0 runs the current `main` source — what ships next — not v1.7.2 or another
stale installed binary. It has two parts:

1. Run the cheap deterministic 11-flow `bun scripts/ux/regress.ts` gate:
   `declined-rebind-menu`, `empty-id-navigation`, `empty-join-copy`,
   `fresh-setup-to-handoff`, `front-door`, `gitignore-default`,
   `malformed-token-reprompt`, `pairing-second-device`, `status-healthy`,
   `tilde-expansion`, and `typo-no-phantom`.
2. Re-run exactly persona flows **4, 5, 7, 8, 11, 13, 15, 18**, plus the
   browser-handoff-blocked flows **1, 16, 20**. Budget: **11 sessions, 13
   machine homes, and 11 containers total (one per session)**; flows 7 and 11
   use two homes.

Erratum, recorded here rather than rewriting the promoted audit: its header
says 9 completed / 8 abandoned / 3 blocked, while the outcome ledger counts
flow 4 completed after a direct-`rbox ignore` workaround. Its interactive setup
branches were abandoned, so flow 4 remains in this rerun. The ledger arithmetic
is 10 completed / 7 abandoned / 3 blocked.

Phase 0 gates **only Unit C**. Units A, B, and D proceed concurrently because
their gaps are structural and source-verified. Unit C adds no speculative fix
for a 137-proven item; any additional residue must be reproduced by the exact
enumerated rerun and named in its review ledger before implementation.

One named Unit-C rider is mandatory before calling the deterministic gate
green: `scripts/ux/regress.test.ts:44-51` still expects five pass plus six
`pending-137` definitions, while all eleven current flow files are `pass`.
Today that is one failing harness unit test (19 pass / 1 fail), not evidence of
six product failures. Update the catalog expectation and title to all-pass.

### C2. One Ctrl-C owner

`prompt.ts` becomes the sole cancellation owner for awaited prompts, cancelable
prompts, and the raw-key `waitForKeypress` path. Move `waitForKeypress` and its
raw-mode cleanup out of `browser-open.ts` under this shared owner; `auth-cmd.ts`
imports it there. A raw Ctrl-C first removes its listener and restores stdin's
prior raw mode, then invokes the same context-aware exit path. Move the existing
keypress pins from `browser-open.test.ts` with the function into the
cancellation-owner suite. External
`AbortPromptError` used to close an obsolete concurrent prompt remains a quiet
abort, never a fake Ctrl-C.

The owner exports one scoped API; entry flows do not mutate a module-global
message directly:

```ts
export type CancellationEffect =
  | "authorized" | "enrolled" | "plan-activated" | "pair-token-created"
  | "directory-created" | "remote-created" | "workspace-bound"
  | "initial-populate-complete";

export function cancellationScope<const E extends CancellationEffect, T>(
  flow: "setup" | "tracking",
  effects: readonly E[],
  body: (scope: { advance(effect: E): void }) => Promise<T>,
): Promise<T>;
```

`cancellationScope` pushes before invoking `body` and pops that exact entry in
`finally`. Each scope owns a `Set<E>` of completed effects. `advance` is a
synchronous, idempotent insertion and accepts only the effect set declared by
that scope; it never replaces an earlier effect. Nested scopes restore their
outer entry, and the innermost active scope supplies cancellation copy. A scope
that completes, throws, or settles through a cancellation abort cannot leave
stale copy for a later command. With no registered context, cancellation
preserves today's behavior exactly: silent exit 130.

Entry flows register before their first prompt and update the active context
immediately after each mutation completes. These are the message states; a row
applies only when its named work has actually completed:

| Completed effect | Exact completed clause |
| --- | --- |
| Device-code account authorization | `sign-in completed` |
| Encryption enrollment | `device enrollment completed` |
| Plan activation | `plan activation completed` |
| Pairing-token mint before a raw-key clipboard prompt | `pairing token creation completed` |
| Confirmed missing-directory creation | `directory creation completed` |
| Remote workspace creation | `remote workspace creation completed` |
| Workspace bind | `workspace tracking completed` |
| Initial populate | `initial sync completed` |

An empty set renders exactly `setup cancelled — nothing was changed` or
`tracking cancelled — nothing was changed` from the scope's `flow`. A nonempty
set enumerates **every** completed clause once, in the table order, separated by
`; `, then appends one final not-started clause after `; `: after authorization
only, `encryption enrollment did not start`; after enrollment or plan activation,
`workspace setup did not start`; after pairing-token creation, `clipboard copy
did not start`; after directory or remote creation, `workspace tracking did not
start`; after workspace bind, `initial sync did not start`; after initial
populate, `background sync did not start`. The furthest applicable suffix wins,
but no completed clause is discarded. Thus enrollment plus plan activation is
exactly `device enrollment completed; plan activation completed; workspace
setup did not start`, while directory creation plus remote creation is exactly
`directory creation completed; remote workspace creation completed; workspace
tracking did not start`.

Every commit boundary calls `advance` immediately after its committing await
resolves and before any later log write, await, prompt, or call into another
continuation. The enumerated boundaries are:

| Completed commit | Required synchronous advance placement |
| --- | --- |
| Bootstrap authorization credential | Immediately after `saveCredentials` at `auth-cmd.ts:231`, before the log and `runGenesisEnrollment`. |
| Device-code authorization credential | Immediately after `saveCredentials` at `auth-cmd.ts:289`, inside the approved branch at `auth-cmd.ts:287-291`, before the authorization log or any enrollment continuation/return. |
| Genesis enrollment | Immediately after `bootstrapNewAccount` returns at the `runGenesisEnrollment` seam, before recovery-phrase acknowledgement or any later prompt. Local key persistence plus server bootstrap has committed even if acknowledgement has not. |
| Pair enrollment | Immediately after `redeemPair`/`enrollViaPairing` returns, before success copy or the next enrollment/workspace prompt. |
| Recovery enrollment | Immediately after `enrollViaPrevalidatedRecovery` returns, before success copy or the next enrollment/workspace prompt. |
| Plan activation | Immediately when the active-plan poll resolves true, before leaving the plan seam. Add both `enrolled` and `plan-activated` when both occurred in this scope. |
| Pair-token creation | Immediately after the create response returns the usable token, before the raw-key clipboard prompt. |
| Confirmed directory creation | Immediately after the confirmed `mkdir` resolves, before config probing or another prompt. |
| Remote workspace creation | Immediately after the remote-create call returns the usable workspace, before a log write, local bind, or any other await. |
| Workspace bind | Immediately after the binding/config commit returns, before populate starts. |
| Initial populate | Immediately after the created→push or joined→pull/reconcile primitive returns, before the background-start prompt. |

This placement is owned at the inner seam that knows the mutation committed;
an outer caller must not advance speculatively around an opaque awaited helper.
Setup and front door do not catch or duck-type the error. Delete
`front-door.ts`'s `promptCancelable`; do not add wrappers elsewhere. Tests pin
every row, one line on stderr, exit 130, no stack, no duplicate through the
concurrent approval prompt, default silent 130, nested push/pop restoration,
restoration after throw or settling abort, stale-context non-leak, idempotent
set insertion, deterministic cumulative-clause ordering, and raw-key cleanup
before delegation. A required boundary race test resolves each committing
dependency and delivers Ctrl-C in the same handoff before the next await/prompt;
it must observe every advanced effect, never the preceding set.

### C3. Wizard-only custom select Escape contract

Escape is scoped to one guided-wizard select adapter built directly on
`@inquirer/core`; standalone/scripted commands do not gain a global navigation
convention, and this unit does not build a custom confirm, text-input, search,
or password suite. The adapter settles with only this union:

```ts
type WizardSelectResult<T> =
  | { kind: "selected"; value: T }
  | { kind: "back" };
```

When a select has a registered parent, Escape returns `back` and the
orchestrator moves exactly one local, pre-network level. When no parent exists,
Escape is consumed **inside the live adapter**: it preserves selection and
state, renders one dim hint to choose a row (including "Not now" where present)
or press Ctrl-C, and keeps waiting. It does not resolve a `no-op` result; that
union arm is deleted.

The settled parent map is authorization→account; enrollment detail entered
before authorization→authorization; post-authorization pairing/recovery
detail→A3's `already-authorized` Step-1 state; existing-workspace picker→A2's
create/join/back submenu; submenu→the calling front-door menu; and
gitignore→workspace details. The account, already-authorized, workspace-kind,
plan, start, and resumed/top-level selects have no parent, so Escape is consumed
and they remain live. The existing workspace search widget is not converted and
acquires no Escape contract; its settled blank/back result is handled by A2's
orchestrator. A completed remote mutation is never replayed by going back.

There is exactly one generic adapter in `prompt.ts`; no caller imports
`@inquirer/core` or `@inquirer/prompts`. Parity with the pinned select widget is
normative, not best-effort: preserve theme/default styling, choice
descriptions, pagination and page-size behavior, initial/default selection,
ordinary keybindings (arrows, vim keys where supplied by upstream, Home/End,
number shortcuts if upstream supports them, Enter), cleanup on settle/abort,
and the existing stderr plus raw-TTY context. The CI imports-only-in-
`prompt.ts` boundary at `.github/workflows/ci.yml:116-124` must remain green.

Masked bootstrap-secret, pairing-token, and recovery-phrase inputs get **no
Escape behavior** in this design. They retain only design 137's blank-submit
and attempt-budget transitions: pairing/recovery blank-submit returns to the
registered parent, while blank bootstrap remains the primary browser-signup
action. Existing confirm and unmasked-input behavior is likewise unchanged.
This deliberate scope cut supersedes v2's clear-on-Escape claims.

Adapter tests pin selected and `back`; parentless Escape non-settlement by
proving the same prompt later accepts a selection; one hint per keypress and
selection/state preservation; each parent mapping; ordinary versus
preselected/resumed entry; the full parity list above; and zero remote calls or
mutation on Escape. One adapter-level test and one orchestrator test cover each
direction so a caller cannot reinterpret consumed Escape as completion.

## 5. Unit D — front-door status brief through progressive disclosure

Bare `rbox` and default text `rbox status` use one brief renderer. Its order is
headline state → attention items → identity → menu. The target shape is about
three lines plus the menu:

```text
Development · syncing normally — 1 change uploading now
⚠ 3 git repos waiting on uncommitted changes (oldest: 1 day) · rbox status --git
Signed in as brian.via.dev@gmail.com · pro

What would you like to do?
```

The binding rules are:

- Every line is either actionable or answers "is it syncing / is anything
  stuck?"
  Healthy subsystem facts print nothing: no locking-ok line, daemon PID, lock
  path, routine crypto detail, or historical trail.
- The headline uses the configured workspace name, then the root basename,
  then `Workspace`; it never falls back to a raw workspace id. It combines the
  current health verdict with live work/pending-change information.
- Attention lines contain only conditions requiring awareness or action, with
  the repair command inline. Per-repository Git deferral detail collapses to
  count + oldest age + `rbox status --git`.
- No raw identifiers (`ws_`/`dev_`/`acct_`/PID/sequence numbers) and no
  wire/HTTP jargon (`commit-409`) appear outside `--verbose`/`--json`.
- Lifetime counters (syncs, conflict totals) leave the default view.
- Identity stays one line (design-117 banner: email · plan).
  If cached email is unavailable, render a non-identifier signed-in fallback;
  never expose `acct_` to fill the gap.
- `rbox status --verbose` retains **EVERYTHING current, unchanged**. `--json`
  retains every existing field and adds only the optional `haltReason` field
  specified below. This is a presentation change, not a data removal.

Behind-remote evidence is always its own sequence-free attention line:

```text
⚠ remote changes waiting to download · rbox pull
```

It never appends `(sequence <local> vs <remote>)` to the headline. Four goldens
pin the same attention line for a running daemon with probe-sourced evidence, a
stopped daemon, daemon-sourced evidence, and simultaneous local upload plus
remote-behind. In the simultaneous case the upload stays in the headline and
the download stays on the separate attention line. The roughly-three-line
target is a common shape, not a maximum.

The complete default-text disposition and copy matrix is binding. Backticks in
the table delimit the string and are not printed; `<n>` uses locale formatting,
`change(s)`/`repo(s)`/`file(s)` inflect normally, and `<size>` uses the existing
decimal size formatter. The brief-only `<age>` formatter spells and inflects
units (`1 minute`, `2 hours`, `1 day`, `7 days`, `14 days`, `30 days`), never
abbreviations such as `1m`, `1h`, or `1d`; `--verbose` keeps its legacy format.
A state not in the keep/translate rows does not acquire a new brief line by
analogy:

| Disposition | Current state or material | Exact brief copy |
| --- | --- | --- |
| Translate | Healthy workspace heading and health verdict | `<workspace> · syncing normally` |
| Translate | Running daemon with local work and fresh active-upload evidence | `<workspace> · syncing normally — <n> change(s) uploading now` |
| Translate | Running daemon with local work but no fresh active-upload evidence | `<workspace> · syncing normally — <n> change(s) waiting to upload` |
| Translate | Other fresh live transfer | `<workspace> · syncing now — <progress>` where `<progress>` uses the plain-words mapping below with no glyph, ids, or sequences. |
| Translate | Initial populate | `<workspace> · initial sync in progress — <done>/<total> files`; when no total exists, `<workspace> · initial sync in progress — starting`. |
| Translate | Paused/stale daemon headline | `<workspace> · sync is paused` |
| Translate | A full snapshot satisfying `headlineBlocked` | `<workspace> · sync needs attention` |
| Translate | Account `ok`, email present | `Signed in as <email> · <plan>` |
| Translate | Account `ok`, email absent | `Signed in · <plan>` |
| Translate | Account `signed-out` | `Signed out · rbox login` |
| Translate | Account `unavailable` | `Signed in · account details unavailable` |
| Keep | Stopped daemon | `⚠ background sync is stopped · rbox start` |
| Keep | Stale daemon/binding | `⚠ background sync is attached to a previous workspace · rbox start` |
| Keep | Behind remote | `⚠ remote changes waiting to download · rbox pull` |
| Keep | Reset/recovery halt | `⛔ sync halted to protect recovery state · rbox doctor reset-journal` |
| Keep | Pull or push mass-delete halt | `⛔ sync paused to protect against a large deletion · rbox sync --allow-mass-delete` |
| Keep | Too-many-refs commit halt | `⛔ workspace has too many files to upload · rbox ignore` |
| Keep | Body-too-large commit halt | `⛔ workspace update is too large to upload · rbox ignore` |
| Keep | Unknown halt | `⛔ sync halted — see rbox logs` |
| Keep | Storage exhaustion | `⛔ storage limit reached · rbox usage · rbox subscribe` |
| Keep | Workspace-count exhaustion | `⛔ workspace limit reached · rbox usage · rbox subscribe` |
| Keep | Account- or daemon-reported no active plan | `⛔ no active plan · rbox subscribe` |
| Keep | Daemon/CLI version skew | `⚠ rbox was updated; restart background sync · rbox stop && rbox start` |
| Keep | Locking `degraded-unlocked/identity-unavailable` | `⚠ safe workspace locking is unavailable; Git config sync is off · rbox doctor` |
| Keep | Locking `starved/foreign` | `⚠ workspace sync is waiting on another lock · rbox doctor` |
| Keep | Locking `starved/identity-drift` | `⚠ workspace lock identity changed · rbox doctor` |
| Keep | Locking `starved/stale-owned` | `⚠ a stale workspace lock is blocking sync · rbox doctor` |
| Keep | Locking `starved/fence` | `⚠ workspace recovery is holding the sync lock · rbox doctor` |
| Keep | Git attention, every row is local-edit deferral | `⚠ <n> git repo(s) waiting on uncommitted changes (oldest: <age>) · rbox status --git` |
| Keep | Git attention, mixed/other reasons | `⚠ <n> git repo(s) need attention (oldest: <age>) · rbox status --git` |
| Keep | Nonempty trash | `⚠ <n> trashed file(s) (<size>) · rbox trash list` |
| Keep | Update available | `⚠ update available: <current> → <next> · rbox upgrade` |
| Suppress | Healthy background reporting, including routine encryption-worker detail | No brief line. |
| Suppress | Last-sync and other history/trails | No brief line. |
| Suppress | Healthy daemon fact | No `running`, PID, or autostart-detail line. |
| Suppress | Healthy locking fact | No `locking: ok` or lock path. |
| Suppress | Healthy Git facts | No synced/pending/conflict-zero totals. |
| Suppress | Lifetime counters | No sync count, lifetime conflict count, or server-conflict jargon. |
| Suppress | Raw footer | No device id, sequence, raw workspace/account id, or files-on-disk footer. |

For fresh-transfer `<progress>`, known `progressLabel` prefixes map through this
complete plain-words table while retaining their sanitized counts, sizes, and
detail suffixes: `scanning…` → `checking files…`; `capturing git state` →
`saving git history`; `encrypting` → `encrypting`; `uploading` → `uploading`;
`downloading` → `downloading`. An unknown already-sanitized label passes through
unchanged; the brief does not guess a different operation.

`<workspace>` resolves configured name → root basename → the literal
`Workspace`. `<plan>` is the normalized plan label; plan `none` renders `no
active plan`, while an unrecognized/absent successful-response plan renders
`plan unavailable`, never an id. The healthy headline is exactly
`<workspace> · syncing normally`, including punctuation and casing. The four
identity strings above are exhaustive for `AccountSummary` at
`account-cmd.ts:63-66`; unavailable is safe to call signed in because that arm
is produced only after local credentials exist.

The full snapshot first aggregates entitlement and quota evidence into one
closed discriminant:

```ts
type PlanQuotaAttention =
  | { kind: "no-active-plan" }
  | { kind: "storage-limit" }
  | { kind: "workspace-limit" }
  | { kind: "none" };
```

Construction precedence is plan-none → out-of-storage → workspace-count →
none. In particular, simultaneous plan-none and out-of-storage evidence yields
only `no-active-plan`, so its one line is `⛔ no active plan · rbox subscribe`.
The renderer consumes this aggregate and never independently renders its raw
inputs.

The headline-blocker predicate is closed: `headlineBlocked` is true exactly for
the `reset-halt` snapshot, or for a full snapshot with a sync halt, a non-`none`
`PlanQuotaAttention`, daemon/CLI version skew, or any degraded/starved locking
discriminant. It is false for stale/stopped alone, initial populate, fresh
transfer, pending local work, behind-remote, Git attention, trash, and update
availability. Headline selection is total: `headlineBlocked` → `sync needs
attention`; otherwise stale/stopped → `sync is paused`; otherwise initial
populate; otherwise another fresh live transfer; otherwise running with local
work; otherwise the healthy headline. Each branch uses exactly the corresponding
table string.

`uploading now` additionally requires fresh `activity.active` evidence whose
phase is `upload`; a pending-change count or running daemon alone is
insufficient and uses `waiting to upload`. The simultaneous-upload/behind-remote
golden supplies this active-transfer evidence explicitly.

All applicable attention lines render once in this total order; an earlier row
does not suppress a later row except where the snapshot arms make them
unrepresentable, `PlanQuotaAttention` has already aggregated overlapping raw
evidence, or stopped is omitted in favor of stale as stated below:

1. reset/recovery halt (the minimal snapshot's only attention line);
2. full-snapshot sync halt: mass-delete, too-many-refs, body-too-large, unknown;
3. the single `PlanQuotaAttention` row;
4. stale daemon/binding;
5. stopped daemon (omitted when stale already rendered);
6. daemon/CLI version skew;
7. locking degradation/starvation (one discriminant);
8. behind remote;
9. Git attention;
10. nonempty trash;
11. update available.

Raw `activity.halt.reason` at `activity.ts:72` never goes directly to the brief.
The snapshot boundary produces this closed discriminant:

```ts
type BriefHaltReason =
  | { kind: "mass-delete"; op: "pull" | "push" }
  | { kind: "too-many-refs" }
  | { kind: "body-too-large" }
  | { kind: "unknown" };
```

New daemon writes preserve the producer's typed reason alongside the existing
raw reason: the two `CommitRejectedError.reason` arms map directly, and the
pull/push guards supply `mass-delete` plus `op`. Old, malformed, string-only,
or otherwise unrecognized records map to `unknown`; the renderer does not
guess from substrings. Known discriminants map to the plain copy table above.
Unknown maps exactly to `sync halted — see rbox logs` (with the table's leading
glyph); its raw reason remains available only in `--verbose` and `--json`.
JSON exposes that raw value through the additive optional field
`haltReason?: string`; the field is present exactly when a raw halt reason is
available and absent otherwise. Every pre-v5 JSON field and value is unchanged.

The brief snapshot is itself discriminated, not an all-optional bag:

```ts
type BriefStatusSnapshot =
  | {
      kind: "reset-halt";
      workspaceLabel: string;
      daemonRunning: boolean;
      account: AccountSummary;
    }
  | {
      kind: "full";
      workspaceLabel: string;
      daemonRunning: boolean;
      daemonStale: boolean;
      account: AccountSummary;
      // Existing local/remote/activity/populate evidence plus every full-only
      // kept discriminant: halt, locking, version, Git, trash,
      // PlanQuotaAttention, update.
    };
```

Fields that require `loadState` are typed-absent from `reset-halt`; the caller
never fabricates zero changes, zero tracked files, empty Git, empty trash, a
healthy lock, or a reachable account to satisfy an all-fields interface. The
pre-state-load branch beginning at `status-cmd.ts:273` constructs only the
minimal arm before the full path's `loadState` at line 305. One brief renderer
switches exhaustively over both arms and returns the effective
`daemonRunning`; both arms render headline, applicable attention, and identity
in the common order. `--verbose` retains the old early branch and legacy
renderer byte for byte; `--json` retains every current field and adds only the
optional `haltReason` field above.

Add `--verbose` and `--git` to status dispatch/help. `--git` is the focused
drill-down: render the brief headline/identity plus the current per-repository
deferral reason, age, checkout context, and repair guidance. `--verbose` is the
byte-for-byte legacy text path. `--json` remains machine-readable and does not
inherit brief suppression; its only schema addition is optional `haltReason`.
Reject conflicting presentation flags rather than silently picking one.

The renderer still returns the effective `daemonRunning` boolean used to build
the state-dependent menu. Every state in the closed `headlineBlocked` predicate
stays actionable in the brief; only healthy/no-action counterparts disappear.

### D1. Design 140 status-contract amendment and golden split

This unit explicitly amends design 140's frozen `status-healthy` and
`tilde-expansion` contracts in the same Unit-D implementation; the migration is
not deferred cleanup. `status-healthy.flow.ts` stops polling for the suppressed
`background sync: running` line and instead polls/asserts the healthy brief
golden, including absence of healthy daemon, locking, and Git facts.
`tilde-expansion.flow.ts` keeps its filesystem oracle unchanged but runs the
bound-root legacy-heading assertion through `rbox status --verbose`, because
the brief intentionally hides the absolute root.

The same implementation PR amends design 140's command-step `Assertions` with
`assertNotStdout?: RegExp[]` for both `exec` and `guest`. Validation mirrors
`assertStdout`: nonempty regex array, accepted in the command assertion-key
set, rejected on non-command step kinds, and evaluated against only that
step's stdout. This closes the asymmetry visible at `scripts/ux/flow.ts:6` and
the existing `assertNotScreen` branch at lines 110-111, whose boundary is line
113's following `pollUntil` branch. Runner failures name the forbidden matching
fragment without dumping secrets or unrelated output.

For the amended design-140 contract, a “golden” means a set of positive **and
negative stable fragments**, never a full screen. The healthy brief golden
therefore asserts its headline and identity positively and uses
`assertNotStdout` for the suppressed healthy daemon, locking, Git, lifetime,
identifier, and raw-footer fragments. The amendment is written into
`docs/design/140-tui-regression-gate.md` in the implementation PR; it is not a
follow-up and does not rewrite the historical Round-1 rulings.

Existing status assertions split by intent: exact old text and raw detail move
under `--verbose`; per-repository deferral detail moves under `--git`; and
default text uses positive+negative stable-fragment brief goldens. The
implementation updates both flow files, their runner expectations, and the
design-140 contract reference in the same unit so all eleven deterministic
flows remain a truthful release gate.

## 6. Required tests and end-to-end acceptance

**Unit A**

- New ordered choice-array pins for every context, plus state-dependent
  start/pause and command descriptions.
- Exhaustive untracked-result dispatch; pair completes without setup; interactive
  versus non-TTY bare-command routing.
- Shared path-preflight table: tilde/cwd, existing directory, file, unreadable,
  missing-decline, missing-confirm; assert no mutex/config/bind call precedes
  success and no downstream implicit parent creation occurs.
- `rbox track` remains bind-only and probe-free; menu track pins the ordered
  create/join/back submenu, picker-back→submenu, submenu-back→calling menu, and
  zero remote-create/bind on either back. It proves pre-bind tri-state probe →
  bind → typed disposition → created/push or joined/pull-reconcile → each start
  choice end to end using setup's seams. Both populate primitives and the
  disposition handoff are pinned.
- Recovery choice pins login-before-recover, preselected recovery/no enrollment
  menu, the authorization-only login result, zero internal enrollment
  continuation, zero phrase handling before server auth, exact origin-specific
  copy, server-keys `absent` retaining the genesis-first menu, server-keys
  `present` producing the exact three-row menu, and back to the matching
  already-authorized arm without a second auth call.
  Plan tests cover `active | none | unknown`, with silent-unknown output, `none`
  from every enrollment route, Not now, checkout success/timeout, all four
  checkout rejection fallbacks, full environment tuple, token-only rejection,
  environment/file shadowing, bare-`rbox subscribe` chooser dispatch, and
  unchanged explicit-plan scripted dispatch.

**Unit B**

- Origin/postcondition matrix above, including prod/non-prod with unset, empty,
  valid, and invalid overrides; normalized-origin variants; malformed remotes;
  and generic warnings that cannot echo URL credentials.
- Output tests prove non-prod+unset prints no URL and leads with device-approve;
  prod prints the normalized URL; a valid override always wins.
- Exact-array tests pin both complete wizard row arrays, the URL-arm approval
  rows and command-only empty array, both footers, both alternate-way outputs,
  the inflected waiting line, and all eight expired/timed-out cells. Approval
  can still land; neither arm prints recovery or an echoed Escape.
- Ordered wizard authorization, recovery-row, and lost-access-footer pins for
  prod default, valid override, non-prod command-only, malformed remote, and
  invalid-override fallback. SwiftBar is recorded only as the named rider.

**Unit C**

- Correct the stale all-pass regress catalog unit, run all 11 deterministic
  flows, then record the 11 enumerated persona sessions and the flow-4 erratum
  in `REVIEW-153.md` during implementation.
- Cancellation-owner tests cover pristine and every effect clause, cumulative
  deterministic ordering, idempotent insertion, default silent 130, nested and
  post-throw/settling-abort restoration, stale-context non-leak, raw-key cleanup
  and delegation, one stderr line, no duplicate/stack, typed per-scope effect
  sets, synchronous advance at every enumerated commit seam including remote-
  created-before-bind, innermost-scope wins, and the mutation-resolves/Ctrl-C
  boundary race.
- Custom-select adapter tests cover only selected/`back` settlement, each
  registered parent, parentless Escape consumption followed by a real
  selection, resumed/top-level variants, hint/state preservation, the complete
  parity list, the imports-only-in-prompt boundary, and no post-network replay.
  Masked-input tests retain blank-submit only and assert no new Escape contract.

**Unit D**

- Goldens cover every keep/translate row and suppression assertions cover every
  suppress row in the complete copy matrix, every headline/identity arm, every
  halt discriminant, the closed blocker predicate, the plan-none-over-storage
  aggregate, and the total simultaneous-attention ordering. Add the
  four behind-remote goldens (running, stopped, daemon-sourced, simultaneous
  upload with explicit active-upload evidence), plus positive/negative
  uploading-now evidence, spelled-age units, every progress mapping and unknown
  passthrough, snapshot-input coverage for every kept state, typed absence of
  full-only fields from the reset-halt arm, and reset-halt use of the same brief
  renderer.
  A healthy default is headline + identity before the menu; one attention item
  produces the target roughly-three-line shape. Neither contains forbidden ids
  or jargon.
- `--git` count/oldest/detail consistency; `--verbose` legacy text parity;
  `--json` parity for every existing field plus optional-`haltReason` present
  and absent cases; presentation-flag conflict tests; identity fallback with no
  raw account id.
- In-unit design-140 migration: `status-healthy` uses the healthy brief golden,
  `tilde-expansion` moves only its legacy root assertion to `--verbose`, and old
  status assertions split among verbose, Git drill-down, and positive+negative
  stable-fragment brief goldens. Schema/runner tests pin `assertNotStdout` on
  `exec` and `guest`, its rejection elsewhere, and a matching-fragment failure.

Run `bun run typecheck`, the relevant CLI and UX unit suites, the full
`bun scripts/ux/regress.ts` gate, and `bun run rig`. Ship a dev build to the
local fleet for the tracked-menu founder scenario and the status target-shape
smoke before merge.

## 7. Non-goals

- A server-auth method for a user with no browser and no signed-in machine.
- Server, schema, billing, or dashboard changes; the plan-`none` fix reuses
  existing account usage, checkout, and enforcement.
- Changing the scripted/noninteractive `rbox track` contract.
- Reworking device-code protocol, pairing-token grammar, recovery cryptography,
  daemon/engine behavior, or design 137's proven retry boundaries.
- Aligning `contrib/swiftbar` with the CLI approval-origin or status-brief policy;
  it is a separately shipped follow-up rider.
- The systemic design-139 plain-words pass; this design changes only copy needed
  for these four units.
