# Design 185 — Migrate the complete interactive CLI to a component TUI

**Status:** v4 ALIGNED — GPT adversarial review round 3 PASS.

This supersedes design 07c §0's framework deferral for interactive prompts. It
does **not** turn ordinary command output into a full-screen application.

## 1. Problem

rbox's interactive surface has outgrown a collection of unrelated linear
questions:

- setup branches between new and existing accounts, encryption enrollment,
  workspace selection, directory selection, and first-sync behavior;
- recovery-phrase setup now supports a true multi-select followed by dependent
  account/vault choices and per-destination completion;
- workspace and directory pickers already have search/typeahead behavior;
- future onboarding needs progress, context, and recoverable substeps without
  printing an ever-growing transcript.

The production implementation is smaller than the number of callers suggests.
All interactive widgets already pass through `src/cli/prompt.ts`, the sole
`@inquirer/*` importer enforced by `scripts/guards.ts`. Callers mostly provide
choices and consume typed answers. The migration therefore replaces one deep
module rather than rewriting every command.

The current seam still leaks Inquirer through
`Parameters<typeof select<V>>[0]` and related types. That makes the interface
framework-shaped instead of rbox-shaped and prevents a clean adapter swap.

## 2. Decision

Migrate **every interactive prompt primitive** from Inquirer to one
component-based TUI runtime in a single PR:

1. select;
2. multi-select;
3. searchable select;
4. visible single-line input;
5. non-echoing secret input;
6. confirm;
7. path input with directory typeahead;
8. single-key actions, including abort while external work continues;
9. prompt cancellation and Ctrl-C cleanup.

The target runtime is exactly **Ink 7.1.1 + React 19.2.8**, subject to the Stage 0
binary/runtime gate in §10. Ink has an established component and input-hook
model and keeps rbox's pure planners/projectors independent of rendering. Its
published package declares Node `>=22`, while rbox runs Bun `1.3.x`, and its
dependency graph includes `yoga-layout`; those are compatibility risks the
spike must prove rather than explain away. rbox owns the small prompt components
rather than adding a second third-party widget kit; this avoids another
compatibility layer and lets the existing key contracts remain exact.

If Ink fails the compiled Bun, cross-target, raw-input, or startup gates, stop
and revise this design. Do not ship a mixed Inquirer/Ink prompt stack. OpenTUI
remains the fallback candidate, but its Zig/native artifact model must pass the
same downloadable-single-binary release contract before selection.

## 3. “Complete interactive CLI” boundary

### In scope

- all exports and production callers of `src/cli/prompt.ts`;
- the separate raw-mode `waitForKeypress` implementation in
  `src/cli/browser-open.ts`;
- setup, init, front-door, recovery, key, doctor, ignore, adopt, track, and
  workspace-selection prompts;
- the existing directory typeahead projection;
- all onboarding prompt text, descriptions, checked/disabled states, defaults,
  pagination, and key behavior;
- shared terminal lifecycle, cancellation, and error translation.

### Out of scope

- one-shot `console.log` / `console.error` command output;
- `status-view.ts`, including brief, verbose, and JSON output;
- `spinner.ts`;
- daemon logs and sidecars;
- shell-prompt integration;
- changing setup business logic, enrollment semantics, or recovery durability;
- building a persistent dashboard in this PR.

Those surfaces are text or machine contracts, not interactive widgets.
Converting them would reduce scriptability without adding component leverage.

## 4. Non-negotiable terminal contracts

The new runtime preserves these contracts from designs 07c, 135, and 140:

1. **stderr only.** Interactive rendering goes to `process.stderr`; stdout
   remains pipe-clean.
2. **TTY gate.** Both stdin and stderr must be TTYs. Non-TTY and
   `--no-interactive` paths never mount the runtime, enter raw mode, prompt, or
   hang. Requiring a visible interactive output is an intentional tightening of
   the old stdin-only check.
3. **Exit 130.** Ctrl-C unmounts, restores the terminal, and exits through the
   existing SIGINT convention without a stack trace.
4. **Cleanup on every settlement.** Success, validation failure, abort,
   exception, and Ctrl-C restore the prior raw-mode state and ensure the cursor
   is visible exactly once. Terminals do not expose the prior cursor visibility
   state for reliable introspection.
5. **Color precedence.** `NO_COLOR` wins. `FORCE_COLOR` remains the only way to
   force ANSI through a pipe. Interactive prompts inherit rbox's stderr color
   decision rather than independently guessing.
6. **Secrets.** Pairing tokens and bootstrap secrets are never echoed.
   Recovery-phrase input retains its deliberate visible-input warning where
   currently configured. Secret values never enter rendered test artifacts,
   errors, or debug logs.
7. **No alternate screen.** Prompts use inline rendering and leave a concise
   completed answer in the transcript. Shell scrollback remains useful.
8. **Small terminals.** Lists page or truncate deterministically; descriptions
   wrap without hiding the selected row or submission hint.
9. **Accessible fallback.** Stable text labels carry meaning without color or
   glyph shape. The tmux harness continues asserting content, never cursor
   coordinates or full-screen goldens.

### Interactivity truth table

`isInteractive()` becomes
`interactionPolicy.enabled && process.stdin.isTTY === true &&
process.stderr.isTTY === true`. Redirecting the only prompt display must not
leave an invisible input wait. `NO_COLOR` and `FORCE_COLOR` affect styling, not
eligibility.

| stdin TTY | stderr TTY | `--no-interactive` | Ordinary prompt | `promptPath` | `promptKeypress` |
|---|---|---|---|---|---|
| no | either | either | typed `PromptUnavailableError` before dynamic import | injected/plain fallback only; otherwise the same error | resolves `undefined` |
| yes | no | no | typed error before dynamic import | injected/plain fallback only; otherwise the same error | resolves `undefined` |
| yes | yes | no | mounts normally | directory prompt | reads one key |
| yes | either | yes | typed error before dynamic import | caller-selected plain path only | resolves `undefined` |

`NO_COLOR` always disables style ANSI. `FORCE_COLOR` never overrides the
two-TTY gate. Every unavailable row asserts no dynamic import, raw mode, or
listener attachment.

The entry point wraps dispatch in an `AsyncLocalStorage<InteractionPolicy>`
context derived by an exact argv preflight:
`process.argv.slice(2).includes("--no-interactive")`. That flag currently
belongs to `rbox init`; command parsing still decides whether it is valid, while
the earlier preflight guarantees it can never be ignored by a prompt.
`--no-interactive` sets `{enabled:false}` before command code runs; the default
for library/unit callers is enabled. `prompt.ts` reads that context synchronously
before its dynamic import. The wrapper's scope ends automatically on
resolve/reject, so concurrent tests and embedded invocations cannot leak policy.
A test invokes a normally prompting path with fake TTY streams inside the
disabled context and proves the typed error occurs before Ink evaluation.

## 5. Deep module and interfaces

Replace the framework-leaking interface with rbox-owned types:

```ts
type PromptChoice<V> = {
  name: string;
  value: V;
  description?: string;
  checked?: boolean;
  disabled?: boolean | string;
};

type SelectPrompt<V> = {
  message: string;
  choices: readonly PromptChoice<V>[];
  default?: V;
  pageSize?: number;
};

type InputPrompt = {
  message: string;
  default?: string;
  validate?: (value: string) => boolean | string | Promise<boolean | string>;
};
```

Equivalent owned types cover search, checkbox, confirmation, and secret input.
Only options used by rbox belong in these interfaces.

The complete remaining owned configs are:

```ts
type Validation = boolean | string;
type MaybeAsync<T> = T | Promise<T>;

type CheckboxPrompt<V> = SelectPrompt<V> & {
  validate?: (values: readonly V[]) => MaybeAsync<Validation>;
};

type SearchPrompt<V> = Omit<SelectPrompt<V>, "choices"> & {
  source: (term?: string) =>
    MaybeAsync<readonly PromptChoice<V>[]>;
};

type ConfirmPrompt = { message: string; default?: boolean };
type SecretPrompt = { message: string };
```

`InputPrompt.validate` and `CheckboxPrompt.validate` keep the component mounted
when they return a string or `false`. A thrown/rejected validator or search
source settles the prompt as an error after cleanup; it is not converted into a
possibly sensitive inline message. Enter is ignored while validation is
pending. Search assigns a monotonically increasing generation before each
source call; only the newest live generation may update rows. Abort/unmount
invalidates all generations.

Before cutover, an executable parity test inventories every prompt option used
by production call sites. Removing Inquirer-derived types may not silently drop
an option.

The production module layout is:

- `prompt.ts` — lightweight public facade, TTY check, shared result/error
  semantics, and lazy runtime import;
- `prompt-types.ts` — type-only framework-independent contracts;
- `prompt-ink.tsx` — production Ink adapter and mount/unmount lifecycle;
- `prompt-components/` — rbox-owned components and pure reducers/projectors;
- `directory-picker.ts` — existing pure directory projection, unchanged except
  for framework-neutral type imports if required;
- `browser-open.ts` — browser/clipboard helpers only; raw-mode key ownership
  moves to the prompt module.

`prompt.ts` remains the only module commands import. The Ink/React graph may be
imported only beneath `prompt-ink.tsx`; a guard enforces this. This gives
callers high leverage and keeps framework locality in one place.

## 6. Primitive behavior

### Select

- Up/Down changes the active enabled row with wraparound.
- Enter resolves the active value.
- Disabled rows remain visible, cannot become the submitted value, and show the
  optional reason.
- The default selects the matching enabled row.
- Completed rendering retains `message answer` and removes unused rows.

### Multi-select

- Up/Down moves; Space toggles; Enter submits.
- Initially checked and disabled choices render truthfully.
- Disabled checked choices remain in the result, preserving recovery-resume
  semantics.
- Enter invokes optional async `validate(values)`. A returned string or `false`
  keeps the same prompt mounted. Recovery's current “Choose at least one place”
  validator therefore remains on the checkbox config.

### Search

- Printable input updates the async/sync source projection.
- Stale async source results cannot replace a newer query.
- Up/Down/Enter follow select semantics.
- Backspace, paste, Unicode, and an empty query work.

### Input and secret input

- Editing supports printable text, paste, Backspace/Delete, Left/Right,
  Home/End, and Enter.
- Validation keeps the prompt mounted and renders the returned message.
- A configured default is editable and submits on Enter.
- Secret input stores the value only as long as needed to settle and renders no
  characters. Its completed frame is `message` plus the fixed word `received`;
  it never renders the value, a mask, length, or prefix. Component and reducer
  buffers are cleared best-effort on every settlement path.
- Deliberately visible recovery-phrase entry remains `promptInput` with its
  shoulder-surfing warning. It is never inferred to be secret from its label.

### Confirm

- `y`/`Y` and `n`/`N` resolve immediately.
- Enter chooses the configured default.
- Other input is ignored.

### Directory typeahead

- Preserve the existing `directory-picker.ts` projection and exact keymap:
  Enter selects highlighted; Tab completes to the projected child and resets
  highlight; Up/Down wrap; typing reprojects.
- `promptPath` retains the injected/non-interactive plain-input fallback and
  `UnsupportedPathError` retry behavior.

### Single-key action

- A `promptKeypress` primitive replaces `browser-open.ts`'s independent
  `readline.emitKeypressEvents` / `setRawMode` lifecycle.
- It resolves the normalized pressed key, resolves `undefined` off-TTY or when
  its `AbortSignal` fires, and applies the shared Ctrl-C/cleanup contract.
- Browser approval mounts it while network polling continues; approval,
  expiration, or error aborts it immediately and idempotently.
- Pair-command copy awaits the same primitive.
- The generated pairing command and approval URL remain ordinary command
  output. Interactive “press c” hints move to stderr so redirecting stdout
  remains useful.

### Cancellation

The currently exported `cancelableSelect` has no production caller. Apply the
deletion test during implementation:

- if it remains unused, delete it and its tests;
- if current-main integration introduces a caller before merge, implement an
  idempotent `AbortController`-backed handle whose abort unmounts without
  invoking the choice callback.

## 7. State ownership

Prompt components own only ephemeral interaction state: active row, checked
values, edit buffer/cursor, validation message, and search generation.

They do not own onboarding workflow state. Setup, enrollment, recovery
durability, workspace fetching, and filesystem projections remain in their
current modules. Existing injected prompt seams in command tests remain valid,
now typed against rbox-owned prompt contracts.

This separation allows a future persistent onboarding screen to compose the
same workflow operations without coupling those operations to Ink.

## 8. Rendering and lifecycle

Each prompt call mounts one root into stderr and returns a promise:

1. `prompt.ts` verifies interactivity before loading Ink.
2. It lazily imports the runtime once and caches the resolved module.
3. The runtime mounts the requested prompt with stderr as output and stdin as
   input.
4. Component submission settles exactly once.
5. The runtime renders the concise completed state, unmounts, waits for the
   final frame, restores terminal state, and resolves the value.
6. Abort/error follows the same cleanup path before rejection.

Concurrent prompt mounts are rejected as a programmer error. Sequential calls
reuse the loaded runtime but never share component state.

The adapter calls Ink with these exact ownership options:

```ts
render(tree, {
  stdin: process.stdin,
  stdout: process.stderr,
  stderr: process.stderr,
  interactive: true,
  patchConsole: false,
  exitOnCtrlC: false,
});
```

The facade reaches this call only after both streams pass the TTY gate. Setting
`interactive: true` prevents Ink's CI auto-detection from disabling input; the
native CI selftest attaches stdin, stdout, and stderr to the same PTY. rbox, not
Ink, owns Ctrl-C. Submit, abort, render error, validation/source error,
and Ctrl-C race through one settle-once state machine. Before mounting it
snapshots stdin's prior raw and paused/resumed state plus cursor visibility. The
settlement order is:

1. reject later updates and remove input/abort listeners;
2. render the completed frame (fixed redaction for secrets) or clear the active
   frame for abort/error;
3. await the frame commit, unmount, and Ink `waitUntilExit`;
4. restore cursor visibility, raw mode, and paused/resumed state exactly once;
5. resolve/reject, or invoke the injected exit seam with 130 for Ctrl-C.

An already-aborted signal never mounts or changes terminal state. PTY tests pin
the ordering for every settlement path.

Console patching is disabled. Commands must not log while a rendered prompt is
mounted. The browser-approval key listener is the intentional overlap: polling
is silent while pending, then aborts/unmounts the key listener before printing
approval or failure output.

## 9. Dependency and release constraints

rbox ships compiled Bun executables for:

- `darwin-arm64`;
- `linux-x64`;
- `linux-arm64`.

Adding a component runtime is acceptable only if:

- all required JavaScript and assets embed in each compiled executable;
- no user needs npm, Node, Zig, a dynamic library, or a postinstall step;
- cross-compilation still works from the release runner;
- native smoke jobs start the binary and drive at least one prompt;
- non-interactive startup and binary size deltas are measured and recorded.

Ink/React must not enter daemon, status, JSON, or other non-interactive runtime
initialization. The dependency is present in the compiled artifact but evaluated
only after a TTY-gated prompt call.

`package.json` pins `ink`, `react`, and `@types/react` exactly. TypeScript gains
the `react-jsx` transform and includes `.tsx`; the compiled entry remains
`src/cli/index.ts`.

## 10. Implementation stages

### Stage 0 — hard-gate spike

Before deleting Inquirer:

1. mount a minimal Ink prompt to stderr under Bun;
2. prove Ink's declared Node engine and `yoga-layout` dependency work under the
   exact pinned Bun runtime rather than relying on npm installation success;
3. drive it in tmux and verify input, paste, Ctrl-C, and cleanup;
4. compile and run the host binary;
5. copy only the executable into a fresh empty directory with no checkout,
   `node_modules`, package cache, or repository cwd, then drive the prompt there;
6. cross-compile all release targets and run each on a native CI host;
7. assert the isolated executable needs no package/WASM/dylib asset outside the
   executable and OS libraries; record SHA-256 and byte size;
8. benchmark non-interactive startup and memory against origin/main;
9. prove dynamic import does not evaluate Ink on non-interactive commands;
10. record versions and results in this document.

Failure stops implementation and reopens the framework decision.

### Stage 1 — owned contracts and runtime

Introduce framework-neutral prompt types, the lazy facade, shared lifecycle,
and pure input/list reducers. Add unit tests before migrating callers.

### Stage 2 — all primitives

Implement select, checkbox, search, input, secret input, confirm, and directory
typeahead, plus the abortable single-key action. Exercise real rendering through
memory streams where possible and PTY/tmux where terminal behavior matters.

### Stage 3 — atomic caller cutover

Move every caller to the owned contracts, remove every `@inquirer/*` import and
dependency, and update the guard to reject Inquirer entirely and constrain
Ink/React imports.

No production branch may contain two prompt runtimes after this stage.

### Stage 4 — live gates

Run the UX regression flows and onboarding rig against the compiled dev binary,
not only source-mode Bun.

The same PR adds:

- a hidden deterministic, no-network `__tui-selftest` that drives select,
  checkbox, text, and secret input and prints only `tui-selftest ok`;
- an exact absolute `RBOX_UX_BINARY` override/mount so the UX harness can
  execute the compiled candidate instead of its source-mode Bun shim;
- an equivalent explicit binary override for the rig guest;
- a pull-request workflow that builds all three release artifacts, uploads
  those exact bytes, and drives `__tui-selftest` through a native PTY on
  darwin-arm64, linux-x64, and linux-arm64;
- the same isolated PTY selftest in `release.yml`.

The PR may not merge on cross-compilation evidence alone. All three native PTY
jobs must pass.

### Startup and size budget

Build baseline and candidate binaries with identical Bun 1.3.14 commands. Copy
each into separate empty directories and alternate 30 measured invocations after
five discarded warmups for `status`, `status --json`, `prompt-status`, and the
daemon startup selftest.

Record wall-clock p50/p95 and peak RSS. For every workload, candidate p95 must
be no greater than the larger of baseline `×1.10` or baseline `+5 ms`; peak RSS
must be no greater than the larger of baseline `×1.10` or baseline `+2 MiB`.
The compiled binary may grow by at most 15 MiB. Changing these gates requires a
new reviewed design revision.

`prompt-ink.tsx` marks evaluation through a test-only runtime sentinel. Each
non-interactive workload runs with an assertion hook that fails if the sentinel
was touched. Timing alone is not proof of lazy evaluation.

## 11. Verification

### Pure/unit

- list navigation, wraparound, disabled rows, defaults, and page window;
- multi-select checked/disabled semantics and empty submission;
- text editing, paste, Unicode, cursor movement, defaults, and validation;
- secret state never appears in rendered frames or thrown messages;
- search generation ordering and source failures;
- directory projection/key parity;
- single-key abort while browser polling settles;
- settle/abort/error/Ctrl-C cleanup is idempotent;
- a second concurrent mount is rejected.

### Integration

- every public prompt resolves through fake streams;
- stderr contains prompts and stdout remains byte-empty;
- non-TTY calls do not import/mount Ink;
- `NO_COLOR` / `FORCE_COLOR` precedence;
- prompt completion leaves a stable concise transcript;
- Bun source execution and host compiled binary behave identically;
- a unique pasted secret sentinel is absent from complete stdout, stderr, tmux
  scrollback, errors, and saved UX artifacts after success, validation retry,
  abort, render error, and Ctrl-C.

### Existing gates

- command tests continue through injected prompts without rendering;
- all `scripts/ux` flows pass without weakening their content assertions;
- add focused flows for multi-select, secret non-echo, search, validation retry,
  small terminal, and Ctrl-C exit 130;
- `bun run guards`;
- `bun run typecheck`;
- `bun test`;
- `bun run typecheck:rig`;
- `bun run rig doctor`;
- `bun run rig run onboard-smoke`.

### Release matrix

Each native release smoke must run an interactive prompt through a PTY. Merely
starting `rbox --version` is insufficient evidence for an embedded TUI runtime.
The smoke runs the copied-isolated artifact, not a binary beside the checkout,
and is required on pull requests as well as release tags.

## 12. Acceptance criteria

1. No production dependency or import of `@inquirer/*` remains.
2. Every interactive prompt uses the component runtime through `prompt.ts`.
3. No second raw-mode/key-reader implementation remains outside the prompt
   module.
4. Existing command callers retain their business logic and injected test
   seams.
5. All terminal contracts in §4 pass under source and compiled execution.
6. The three release targets compile, and native CI drives a prompt.
7. The UX regression suite passes without deleting or weakening assertions.
8. The real onboarding rig reaches a converged two-machine workspace.
9. Startup, RSS, and binary-size measurements satisfy the fixed §10 budgets.
10. No mixed-runtime fallback ships.
11. `/simplify` and `/antislop-codebase` find no remaining issue.

## 13. Rollback

The PR is atomic. Before release, rollback is a normal revert restoring
Inquirer. After release, the previous signed CLI binary remains the operational
rollback. No on-disk state, account state, protocol, or manifest format changes,
so framework rollback requires no migration.
