# Design 187 — choose where to save the recovery phrase

**Status:** IMPLEMENTED — GPT round 6 PASS; two-reviewer post-implementation
round 7 fixed 2 blockers + follow-ups on PR #408 (see REVIEW-187.md)

**Owner:** Codex, founder-directed 2026-07-23

**Origin:** `docs/audits/2026-07-22-onboarding-feedback.md`, recovery-phrase
storage feedback from a GitHub-capable non-developer who preferred 1Password.

## Problem

Fresh setup currently shows the 24-word recovery phrase and then asks a macOS
yes/no question:

> Save this recovery phrase to the macOS Keychain now (view later in Keychain
> Access — search "rbox")?

That interaction has three onboarding failures:

1. It presents Keychain as the only product-supported destination even when the
   user already trusts a password manager.
2. Declining does not make the next step obvious. A beta tester was unsure
   whether the phrase would remain viewable and copyable.
3. Keychain is local to that Mac and is not iCloud-synchronized, so the default
   does not itself provide the off-machine copy that the recovery model needs.

The user explicitly preferred 1Password. rbox should support that preference
without requiring 1Password, silently installing anything, or turning an
optional backup integration into a setup blocker.

## User and onboarding outcome

The target audience is developers and GitHub-capable non-developers. The
interaction should feel calm, direct, and trustworthy.

The “aha moment” remains a first successful encrypted workspace sync. This step
is successful when the user has deliberately completed one recovery path and
understands that rbox cannot reset it. It is not successful merely because an
external command was launched.

## Decision

Use the existing Inquirer ANSI checkbox prompt for a true multi-select:

```text
First, save your recovery phrase.

Your files stay normal and usable on this computer. Before rbox uploads a copy,
it encrypts that copy using this phrase. That keeps your files private in the
cloud — even from us.

GitHub and other source control keep working normally. This phrase protects
rbox's separate cloud copy, including work you have not committed or pushed yet.

If you lose every signed-in device, this phrase is the only way back in.
rbox cannot reset it.

? Where should rbox save your recovery phrase?
Instructions:
  ↑/↓ move · Space select · Enter continue

◯ Save to 1Password
◉ Save to macOS Keychain
◯ Save to a plaintext file
◯ Copy it to my clipboard
```

Descriptions:

- **1Password:** `creates a secure item in a vault you choose`
- **macOS Keychain:** `saves on this Mac; it does not sync through iCloud`
- **plaintext kit:** `writes the phrase in plaintext to <display path>
  (readable only by your user account)`
- **clipboard:** `copies the 24 words temporarily; clipboard tools or history
  may retain them until cleared`

The rows are conditional:

- Show 1Password only when a bounded, non-authenticating `op --version` probe
  proves a supported 1Password CLI 2.x is installed.
- Show Keychain only when the current macOS Keychain preflight is actionable.
- Plaintext and clipboard remain available on every interactive platform.
- When the 1Password CLI is absent, print one non-blocking line above the menu:
  `1Password CLI not found — choose Clipboard to paste the phrase into
  1Password yourself.`

The order is optimized for off-machine recoverability, not platform
convenience. The current platform default remains preselected so pressing Enter
does not make onboarding longer: Keychain on macOS, plaintext file elsewhere.
1Password and clipboard are never preselected because each launches a separate
user-visible action. Validation requires at least one selected destination.
If macOS Keychain preflight is not actionable, plaintext file is preselected
instead.

Founder ruling (2026-07-23): this is intentionally multi-choice/multi-select.
The implementation must model the selected set honestly rather than reducing it
to one primary destination. Design 185 is not required: the pinned
`@inquirer/prompts` package already ships the checkbox interaction, and this
remains a linear wizard rather than a dashboard-class TUI.

### Completion rule

rbox attempts every selected destination in the fixed on-screen order. A
selection is not represented as an atomic cross-provider transaction.

- If all selected destinations succeed, setup completes.
- If some succeed and some fail, show the exact result for each and offer
  `Retry failed choices`, `Continue with the successful copies`, or
  `Change incomplete choices`.
- Continuing after partial success requires explicit confirmation and is
  allowed only when at least one selected destination has a verified completion
  record. Failed extras become a concise non-blocking warning.
- If none succeeds, setup remains pending with the recovery key staged. The
  user must retry or change selections.
- Clipboard counts only after the clipboard child exits zero and the user
  confirms they pasted/saved the phrase somewhere durable.

The persisted plan, attempt state, and per-destination locators make crash
resume monotone:
already verified artifacts are reconciled, not recreated; incomplete
destinations are retried only under their provider-specific safety rules.

The lead-in deliberately explains the security model before asking the user to
make a storage decision. It avoids “client-side key,” “E2EE,” “escrow,” and
other implementation language. The required comprehension is simply:

1. the phrase encrypts files before upload;
2. local files stay normal and usable on the device;
3. encryption keeps cloud copies private, including from rbox;
4. GitHub/source control remain separate and unchanged;
5. rbox also protects work not yet committed or pushed to source control;
6. the phrase is needed only if every signed-in device is lost;
7. rbox cannot reset it.

## 1Password interaction

Selecting 1Password is the explicit consent boundary. rbox then says:

```text
1Password may ask you to sign in or approve access.
```

The adapter performs bounded account and vault discovery. A zero-account result
returns to the destination menu with:

```text
No 1Password account is available to the CLI. Sign in or add an account in the
1Password app/CLI, then try again.
```

If there is one account, it advances directly; otherwise rbox presents an
account select. It then presents:

```text
? Choose a 1Password vault:
❯ Personal
  Work · Example Corp
  ← Choose another save method
```

Display labels are sanitized for ANSI/control characters and disambiguated
with account context. Authorization and authoritative targeting use stable
account and vault UUIDs, never labels. Selecting a vault is the save consent;
there is no redundant confirmation.

Success copy:

```text
✓ Recovery phrase saved to 1Password
  Vault: Personal · Item: rbox recovery phrase
  You'll need access to this vault if you lose every signed-in device.
```

Partial-result copy:

```text
Saved recovery phrase to 2 of 3 selected places:
  ✓ macOS Keychain
  ✓ Clipboard — confirmed saved
  ! 1Password — couldn't complete the save
```

Then offer:

```text
? What do you want to do?
❯ Retry failed choices
  Continue with the successful copies
  Change incomplete choices
```

No failure silently adds an unselected destination. `Change incomplete choices`
is an explicit pre-receipt witnessed plan replacement that carries every
still-valid completion forward unchanged. When a create outcome is ambiguous,
rbox reconciles the persisted operation marker before presenting results and
never blindly repeats a create.

## 1Password subprocess contract

Add `src/cli/recovery-kit-1password.ts`. It owns only 1Password CLI discovery,
account/vault projection, item creation/reconciliation, exact verification,
and safe error classification.

Every subprocess call:

- resolves and invokes one executable directly with `shell: false`;
- puts no recovery phrase or rbox credential in argv, environment variables,
  shell text, filenames, or temporary files;
- builds an allowlisted child environment from the minimum process/locale
  variables plus exactly `OP_ACCOUNT`, `OP_BIOMETRIC_UNLOCK_ENABLED`,
  `OP_CONFIG_DIR`, and keys matching
  `OP_SESSION(?:_[A-Za-z0-9][A-Za-z0-9_-]{0,63})?`; strips
  `OP_SERVICE_ACCOUNT_TOKEN`, every `OP_CONNECT_*`, `OP_DEBUG`, `OP_FORMAT`,
  every `RBOX_*`, cloud-provider credential, CI token, and unrelated
  secret-bearing variable;
- treats inherited `OP_SESSION` / `OP_SESSION_*` values as secret-bearing: they
  are passed only to `op`, never logged, persisted, or included in errors;
- pins machine-readable output with explicit argv flags, never environment
  defaults;
- bounds runtime, stdout, and stderr;
- treats stdout and stderr as secret-bearing and never forwards or logs them;
- closes stdin after one bounded payload;
- terminates on cancellation/timeout with a bounded grace period;
- zeroes every mutable secret-bearing input/output copy on all exits;
- returns redacted typed outcomes whose messages never contain child output.

The install probe is `op --version` with a short timeout and a separate minimal
environment containing only process/locale variables—no `OP_ACCOUNT`,
`OP_SESSION`, suffixed session, biometric, or config variables. It does not
authenticate and runs only to decide whether the checkbox row exists.

The provider-session allowlist above applies only after the user explicitly
selects 1Password. Account/vault discovery and item operations then use the
longer visible authorization timeout. Non-interactive code never probes,
authenticates, or launches 1Password.

### Item shape

rbox creates one Secure Note through JSON on stdin:

```ts
{
  title: "rbox recovery phrase",
  category: "SECURE_NOTE",
  tags: ["rbox", operationTag],
  fields: [
    {
      id: "rboxRecoveryPhrase",
      type: "CONCEALED",
      label: "Recovery phrase",
      value: phrase
    },
    {
      id: "rboxAccountId",
      type: "STRING",
      label: "rbox account",
      value: accountId
    }
  ]
}
```

`operationTag` is a random, nonsecret, bounded identifier generated before
completion-intent publication. It is not derived from the phrase or a phrase
digest. The exact command shape is:

```text
op item create --account <account-uuid> --vault <vault-uuid> --format=json -
```

Creation output is captured as secret-bearing even when the documented default
conceals fields. rbox parses only bounded item/vault identifiers from it.

### Verification and ambiguous outcomes

Creation does not count as recovery completion until all of these succeed:

1. the item create returns or reconciliation finds exactly one matching item;
2. the exact concealed field is read with stable UUIDs;
3. its bytes exactly match the canonical staged phrase;
4. a nonsecret locator is durably recorded in `kit.json`.

Exact readback uses the equivalent of:

```text
op read -n op://<vault-uuid>/<item-uuid>/rboxRecoveryPhrase \
  --account <account-uuid>
```

The returned phrase is consumed by a bounded byte comparator and zeroed. It is
never rendered or retained as an immutable error value.

Before creating, and after every timeout/lost response, rbox lists metadata in
the exact account/vault by `operationTag`:

- zero matches: no verified artifact exists; do not retry automatically after
  an ambiguous create outcome;
- one match: read and exact-compare the concealed field, then record it;
- multiple matches or any marker/field mismatch: fail closed as ambiguous and
  do not create another item.

1Password does not document an idempotency key or a list-consistency guarantee.
Therefore a zero-result reconciliation after a timeout/lost response means
“no exact match is currently visible,” not “nothing was written.” It is an
ambiguous outcome and never authorizes another create. The user may choose
another save method; rbox warns that an untracked item may still appear in the
selected vault.

An explicit Retry may create only when no attempt reached may-have-dispatched,
or after the prior attempt has the local `op-child-not-started` terminal event.
Every retry still reconciles first. Reconciliation post-filters provider
results for exact `operationTag` equality because 1Password's tag filter also
matches subtags. The design does not assume a provider idempotency or
consistency guarantee that 1Password does not document.

## Durable genesis integration

Designs 179 and 180 remain authoritative for staged recovery-key durability.
This design adds a bounded destination plan and monotone progress record. It
does not claim atomic cross-provider writes.

### Completion intent

The parser continues accepting all exact version-1 intents. A multi-select uses
a new exact version-2 intent:

```ts
type RecoveryDestination =
  | {
      kind: "onepassword";
      accountUuid: string;
      vaultUuid: string;
      operationTag: string;
      fieldId: "rboxRecoveryPhrase";
    }
  | {
      kind: "keychain";
      service: "rbox recovery phrase";
      account: string;
      keychainPath: string;
    }
  | { kind: "kit-path"; path: string }
  | { kind: "clipboard" };

type DestinationSetCompletionIntent = {
  version: 2;
  accountId: string;
  requestSha256: string;
  mode: "destination-set";
  destinations: RecoveryDestination[]; // 1..4, unique, canonical UI order
  successThreshold: 1;
  intentAt: string;
};
```

All strings are strictly bounded and reject control characters. Provider
account/vault identity, operation tag, Keychain identity, and absolute file
path are resolved before intent publication. A valid intent resumes the same
exact selected set without re-prompting or retargeting individual members.

### Monotone destination progress

Add `genesis-destination-progress.json` beside the completion intent:

```ts
type DestinationCompletion =
  | { kind: "onepassword"; accountUuid: string; vaultUuid: string;
      operationTag: string; itemUuid: string; fieldId: "rboxRecoveryPhrase";
      completedAt: string }
  | { kind: "keychain"; service: "rbox recovery phrase"; account: string;
      keychainPath: string; completedAt: string }
  | { kind: "kit-path"; path: string; completedAt: string }
  | { kind: "clipboard"; confirmedAt: string };

type DestinationEvent =
  | { kind: "op-dispatch-prepared"; destinationIndex: number;
      attemptId: string; at: string }
  | { kind: "op-may-have-dispatched"; destinationIndex: number;
      attemptId: string; at: string }
  | { kind: "op-child-not-started"; destinationIndex: number;
      attemptId: string; reason: "spawn-enoent" | "spawn-eacces"; at: string }
  | { kind: "completed"; destinationIndex: number;
      completion: DestinationCompletion; at: string }
  | { kind: "invalidated"; destinationIndex: number;
      priorCompletionSha256: string; reason: "missing" | "mismatch"; at: string };

type DestinationProgress = {
  version: 1;
  accountId: string;
  requestSha256: string;
  intentSha256: string;
  events: DestinationEvent[]; // bounded append-only event log
  updatedAt: string;
};
```

The progress writer uses design 180's hardened exact-readback/fsync contract.
It is bound to the exact canonical intent digest and can only append a valid
state transition for an exact selected destination. It cannot remove, replace,
or reorder an event. A pure fold derives current state.

Event ordering is governed solely by each event's `at`, which must be
non-decreasing (the fold rejects a regressing timestamp). A `completed` event's
embedded completion carries its own authoritative `completedAt`/`confirmedAt`;
the parser does NOT require it to equal the event's `at`. Requiring wall-clock
equality between the two added no integrity — the completion is bound to the
event and the destination — and manufactured a hard failure whenever a durable
write between sampling the two crossed a millisecond during first-run setup
(round 7 blocker). Callers derive the event `at` from the completion's own
timestamp so only one clock sample is taken per completion.

Before spawning `op item create`, rbox durably appends
`op-dispatch-prepared`, then durably appends `op-may-have-dispatched`
immediately before spawn. Both bind one random nonsecret `attemptId`. A crash
after prepared but before the second event may safely dispatch that exact
attempt. A crash after may-have-dispatched is conservative and must reconcile;
even the narrow crash window before the actual spawn is treated as ambiguous
rather than risking a duplicate.

No ordinary `op` response is treated as proof that the provider did not commit:
1Password documents no such guarantee. A terminal `op-child-not-started` event
may be appended only when the local runtime proves process creation failed with
ENOENT or EACCES before a child existed. Those are the complete strict enum;
provider stderr/exit text cannot enter this classification.

A new attempt ID may be prepared only after the prior attempt has this local
terminal event. Timeout, cancellation, signal, output overflow, parse failure,
network/provider rejection, nonzero child exit, and process loss remain
ambiguous after may-have-dispatched and never authorize a new create. Tests
inject crashes before spawn, after spawn, after stdin acceptance, before outcome
persistence, after each enumerated child-not-started failure, and before the
next-attempt preparation.

Provider/local-artifact completion is appended only after exact verification
and durable `kit.json` locator publication. Clipboard completion is appended
only after confirmed clipboard exit, the user's “I pasted and saved it”
acknowledgement, and best-effort clearing or an explicit “I cleared it myself”
acknowledgement.

On resume, completed entries are reconciled against their durable locators and
provider-specific rules immediately before receipt eligibility is evaluated.
Live verification returns exactly `valid | invalid | unverifiable`.

- `valid` counts toward the threshold;
- `invalid` means authoritative missing or exact mismatch; for 1Password,
  durably invalidate the exact locator before appending an `invalidated` event;
  for Keychain and plaintext files, append the event and rely on their existing
  live-probe status rendering to continue reporting missing/unrecognized;
- `unverifiable` covers locked Keychain, unreadable/transient file access,
  expired/cancelled 1Password authorization, offline/network timeout, and
  provider unavailability. It neither counts toward the current receipt nor
  invalidates evidence.

An invalidated completion no longer counts toward `successThreshold`. An
unverifiable member may be retried later, explicitly omitted/replaced while
other live-valid completions are carried forward, or left recorded if the user
continues using other verified destinations. If it is the only completion,
setup cannot continue until it becomes valid or another destination succeeds.

Keychain and file destinations may repair the same exact target and append a
new verified completion. A missing/ambiguous 1Password destination is never
blindly recreated; it may be replaced through the witnessed incomplete-choice
transition below. Clipboard acknowledgement is historical user evidence and is
not re-read after it is durably completed. Incomplete, invalidated, or
unverifiable targets resume in plan order.

The completion receipt adds a strict `destination-set` result containing the
exact intent digest, only the folded **live-valid** completion set,
`finalProgressSha256`, and `continuedAfterPartial: boolean`. Historical
completed-then-invalidated and currently-unverifiable entries never enter the
receipt; their tamper-evident history remains represented by the final progress
digest until receipt-authorized cleanup. Receipt publication is allowed when:

- every selected destination is complete; or
- at least `successThreshold` entries are complete and the user explicitly
  chooses Continue after seeing the failed destinations.

Receipt publication remains forbidden until the progress file itself is
durable. Cleanup removes the progress file under the same receipt authority as
the intent. A crash after receipt uses existing cleanup and does not contact
external providers.

### Retargeting

Generalize the existing hardened pre-receipt RETARGET witness without weakening
its invariants:

- the old value must be the exact canonical intent;
- the active journal must remain receipt-free and
  `committed-this-attempt`;
- the replacement must be an exact supported completion intent selected by the
  user;
- the witness binds complete old/new values and both digests;
- write-new-then-supersede, survivor reconciliation, and witness retirement
  retain design 180's existing fsync/readback rules;
- after any completion receipt, retargeting remains forbidden.

Existing version-1 Keychain-to-file retarget records continue parsing and
resuming unchanged. A version-2 plan replacement may change only incomplete,
invalidated, or currently unverifiable members. Every currently live-valid
completion selected into the new plan is carried forward byte-for-byte; it
cannot be mutated or silently discarded.

The RETARGET witness binds old/new intent bytes, old/new progress bytes and
digests, and the exact carried-completion mapping. The hardened
write-new-then-supersede protocol publishes the replacement intent and its
replacement progress as one resumable two-file transition before retiring the
witness. A crash may expose any old/new pair, so reconciliation accepts only
the exact witnessed combinations and completes the supersession or restores
the old pair; every other combination fails closed.

This transition lets `Change incomplete choices` remain available after partial
success without making a successful copy disappear. It also lets a sole failed
or invalidated 1Password choice be replaced with file, Keychain, or Clipboard.

A locator-write failure after a verified provider write never authorizes a new
provider create. Preserve the plan and reconcile/record that artifact on resume.

## Recovery-kit record and status

Migrate the strict `kit.json` schema from version 2 to version 3, preserving
recognized v2 values exactly:

```ts
type OnePasswordArtifact = {
  rboxAccountId: string;
  accountUuid: string;
  vaultUuid: string;
  itemUuid: string;
  fieldId: "rboxRecoveryPhrase";
  operationTag: string;
  writtenAt: string;
} & (
  | { state: "active" }
  | { state: "invalidated"; invalidatedAt: string;
      invalidationReason: "missing" | "mismatch" }
);
```

`onePasswordArtifacts` is a bounded array so future provider-journal work can
add intentional copies without another schema migration.
Deduplication uses stable account/vault/item UUID identity. Re-recording the
same active item is idempotent: on resume after a crash between the provider
write and the durable progress append, the verified item is re-recorded with a
freshly sampled `writtenAt`; the record layer keeps the original active entry
(tolerating the `writtenAt` drift) instead of failing closed on it (round 7
blocker). A differing operationTag/field for the same item identity still fails
closed. No phrase, phrase digest, session credential, account email, vault
title, item title, secret reference containing labels, or raw CLI response is
persisted.

Before progress appends `invalidated` for a 1Password completion, `kit.json`
must first atomically replace that exact active locator with its strict
invalidated form. The known-invalid locator survives progress cleanup as
honest status history and can never render as an unchecked active save. A
replacement item receives a new active locator; the invalidated entry remains
bounded history.

Ordinary `rbox key status` is read-only and must not open 1Password, trigger an
authorization prompt, or fetch the secret. Human output says:

```text
recovery kit: 1Password item saved 2026-07-23 (not checked)
```

JSON reports the nonsecret locator and `state: "recorded"`. “Recorded” is not
rendered as live-present. Uninstall safety treats an unverified 1Password
locator as unknown, never as proof that removal is safe.

An invalidated locator renders:

```text
recovery kit: previous 1Password item is missing or no longer matches
```

JSON reports `state: "invalidated"` and the nonsecret reason/timestamp.

Live 1Password verification and recovery directly from 1Password are out of
scope. The user can view/copy the item in 1Password and use the existing
`rbox recover` path.

## Other interactive surfaces

Tranche 1 changes fresh genesis only. `rbox key save`, backup, and post-recovery
offers retain design 179 behavior. Extending multi-destination writes to those
surfaces requires a provider-operation journal independent of the genesis
completion intent; doing so without that journal could duplicate a 1Password
item after a crash between provider creation and locator publication.

When Clipboard is selected, rbox copies the phrase without rendering it first,
after first warning:

```text
Clipboard history, other apps, or cross-device clipboard sync may retain this
phrase. Paste it into your password manager now; rbox will clear the clipboard
after you confirm.
```

Then rbox asks:

```text
Did you paste and save the recovery phrase somewhere safe? (y/N)
```

A No answer leaves Clipboard incomplete and returns it in the result summary.
The user may retry Clipboard or continue only if another selected destination
completed.

The clipboard helper for this secret is bounded and asynchronous. It reports
success only after the platform child accepts the complete payload and exits
zero, zeroes mutable payload copies, and classifies spawn, write, timeout, and
nonzero-exit failures. The existing fire-and-forget URL-copy helper is not
reused for recovery phrases. After a Yes answer, rbox best-effort clears the
clipboard and confirms the clearing child exits zero. If clearing fails,
Clipboard remains incomplete until the user explicitly confirms they cleared
it themselves; rbox never reports the clipboard destination as complete while
the known phrase remains there.

## Non-interactive compatibility

No non-interactive behavior changes:

- no flags means phrase display as today;
- `--kit` and `--kit-path` retain their current platform behavior;
- no command auto-selects or authenticates to 1Password;
- stdout remains byte-clean and secrets remain off structured output;
- pending version-1 intents resume under their original exact target.

An explicit headless 1Password flag is intentionally out of scope. 1Password
CLI app authentication, account selection, and vault selection are interactive
dependencies; adding service-account or Connect credentials would create a
different threat model.

## Failure semantics

- Optional 1Password discovery failure removes or fails that choice; it never
  blocks the other selected destinations.
- A clear provider failure leaves that destination incomplete and the other
  selected destinations continue.
- Timeout/lost response first reconciles by operation marker and never blindly
  retries.
- A verified item whose local locator write fails remains the selected intent;
  setup reports that recovery storage needs to be finalized and resumes
  reconciliation later.
- If an incomplete/invalidated choice is replaced after an ambiguous provider
  outcome, a safe orphan item may remain in 1Password. rbox says so without
  claiming it was absent.
- No failure prints the phrase. Clipboard transfers it only through the
  confirmed platform clipboard child.

## Accessibility and terminal contracts

- The checkbox uses Up/Down to move, Space to toggle, and Enter to continue.
  Those keys are written above the choices and remain visible without color.
- Every state has words (`recommended`, `not available`, `saved`, `failed`),
  not only color or glyphs.
- Keep primary rows meaningful within the UX harness's 100-column pane.
- Sanitize every provider-supplied display label before rendering.
- Prompts remain on stderr through `src/cli/prompt.ts`; stdout remains
  script-safe.
- Ctrl-C remains exit 130.
- `NO_COLOR` and `FORCE_COLOR` behavior is unchanged.
- No Ink/OpenTUI dependency is justified for this linear flow.

## Validation

### Unit and process tests

1. New `src/cli/recovery-kit-1password.test.ts`:
   install detection; version bounds; account/vault parsing; duplicate display
   labels; control-character sanitization; exact shell-free argv; phrase only
   on stdin; exact provider environment allowlist (interactive `OP_SESSION` and
   documented suffixed session names plus named supported values retained;
   service-account/Connect/debug/format plus rbox/cloud/CI secrets stripped);
   bounded output/timeouts/cancellation; buffer wiping; create, reconcile,
   missing, ambiguous, and exact-readback mismatch paths; no secret in errors.
2. `src/cli/genesis-durable.test.ts`:
   exact destination-set intent/progress/receipt parsing; one-to-four unique
   canonical destinations; wrong account/vault/item/field/marker rejection;
   monotone progress appends; exact intent binding; partial-continue receipt;
   attempt-ID prepared/may-have-dispatched/child-not-started crash boundaries
   for both strict reasons; invalid/unverifiable distinction; provider-locator
   invalidation and local-artifact live-status behavior; repair; receipt
   contains only folded live-valid completions plus the final progress digest;
   cleanup; v1 compatibility; two-file plan/progress replacement crash
   boundaries.
3. `src/cli/genesis-seam.test.ts` and `src/cli/auth-cmd.test.ts`:
   checkbox choice projection and defaults; every combination of the four
   destinations; fixed execution order; `intent -> provider create/reconcile ->
   exact verify -> locator -> progress -> receipt`; crash resume to the same
   UUID targets; partial result retry/continue; incomplete-choice replacement
   carrying valid completions; deleted evidence before receipt; locator failure
   cannot disappear; TTY/platform/availability matrix.
4. `src/cli/recovery-kit.test.ts`:
   v2-to-v3 migration; strict locator parsing; bounds; deduplication; recorded
   status; unknown-record preservation; uninstall safety.
5. `src/cli/recovery-process.test.ts`:
   non-TTY commands never invoke `op`; stdout and stderr contain no phrase in
   suppressed modes; legacy flags remain compatible and nonblocking.
6. `src/cli/browser-open.test.ts` (or a dedicated secret-clipboard test):
   confirmed zero-exit success; async spawn/write/timeout/nonzero failure;
   bounded input and buffer wiping; disclosure acknowledgement; confirmed
   clearing or explicit manual-clear acknowledgement; no optimistic “Copied”
   result.

All provider tests use a deterministic fake `op` executable. Tests assert
stdin/argv/environment at the process boundary and never touch a real vault.

### TUI walkthrough

Add `scripts/ux/flows/recovery-save-multiple.flow.ts` with deterministic genesis
and provider seams. Seed a known test-only staged recovery key through the
harness fixture builder; do not scrape a generated phrase from a recorded
screen. The selected 1Password/Keychain/file paths never render that phrase,
and the fake provider/clipboard helpers discard secret stdin while persisting
only nonsecret fixture metadata.

Drive Space toggles plus Up/Down/Enter, select at least three destinations,
choose a vault, and assert exact all-success and partial-success screens. Add
the flow to the exact catalog in `scripts/ux/regress.test.ts`. Assertions are
text regexes, not cursor-coordinate or full-screen goldens. The artifact gate
also rejects any 24-word BIP39-shaped line independently of known-value
redaction.

### End-to-end validation

The normal two-device rig validates that:

- a fresh account still completes genesis without 1Password installed;
- no `op` process is invoked on noninteractive guests;
- pairing and first sync still converge.

Do not make CI or the rig depend on an authenticated third-party vault.
Perform one documented manual macOS smoke with a disposable 1Password vault:
select provider, authorize, choose vault, save, read the item in the app, then
remove the disposable item/vault.

## Documentation

- Update `docs/usage.md` recovery-kit behavior and interactive destination
  choices.
- Update `docs/audits/2026-07-22-onboarding-feedback.md` status for the
  password-manager path.
- Document the optional 1Password CLI prerequisite and that rbox never installs
  or signs in to 1Password automatically.
- No `docs/CODEMAP.md` change is required: the new provider module is outside
  the sync-engine ownership trees governed by CODEMAP.

## Explicitly out of scope

- All-or-nothing atomicity across selected destinations.
- Installing or configuring 1Password.
- 1Password service accounts, Connect, SDK, or MCP integration.
- Automatic restore directly from 1Password.
- Multi-destination writes outside fresh genesis until those surfaces have a
  provider-operation journal.
- Silent live 1Password probes from `rbox key status`.
- Making 1Password a setup requirement.
- Moving device/MK operational material out of the local keystore.
- A general TUI framework migration.
