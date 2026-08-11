# Design 230: Folder-first CLI surface

**Status:** implemented and validated
**Snapshot:** `origin/main` at `321bf75991ceedd1d95a20108d6e7a580b5ed4ab`
**Scope:** guided setup policy plus ordinary human-readable CLI presentation

## 1. Problem

rbox's durable and remote model is a workspace, but that implementation term is
also the first concept taught to a new user. The result is unnecessary product
work: users have to understand whether a workspace is a repository, a local
directory, a remote object, or all three before they can start syncing.

The product promise is simpler: choose a folder and rbox keeps it synchronized.
Git repositories inside that folder retain their existing rbox behavior, but are
not the unit a user must configure or reason about during setup.

This cycle changes the presentation model without changing the synchronization
model. A first-time user can accept `~/rbox`, put anything inside it, and be done.
A user who already has a development directory can choose it instead. A user
adding another machine can choose an existing remote folder and a local
destination.

## 2. Outcome

The ordinary product vocabulary is **synced folder**. `workspace` remains the
internal identity and compatibility vocabulary for persisted records, API
routes, flags, JSON, advanced recovery details, and source names.

Interactive setup offers these ordered choices:

1. **Sync `~/rbox` (recommended)** — create the directory when absent.
2. **Sync another folder on this machine** — preserve the current editable path
   and directory-validation flow.
3. **Sync a folder from another machine** — preserve existing-workspace pick,
   join, adoption, and collision behavior.

The first choice is the default only for un-preselected first-run setup. Bare
`rbox` in an untracked directory still preselects that directory when the user
chooses to sync it. A tracked folder's “add another” action still opens the
custom-folder path rather than silently selecting `~/rbox`.

The rest of the ordinary surface follows the same model:

- setup steps and completion say `Folder` / `folder`;
- the bare-rbox menus say `Sync this folder`, `Add another synced folder`, and
  `Sync a folder from another machine`;
- the account picker calls its rows synced folders while retaining manual
  `ws_…` entry as an advanced escape hatch;
- top-level help and machine-wide human status use synced-folder language;
- ordinary “not inside” errors say `synced folder`.

## 3. Ownership and architecture

This changes only CLI Adapter policy and presentation.

- `setup-cmd.ts` owns the guided prompt ordering and presentation, plus the one
  new filesystem policy: explicit selection of the recommended root authorizes
  creating `~/rbox`. It then delegates to the existing init/binding path.
- `front-door.ts`, `workspace-picker.ts`, `help-registry.ts`,
  `doctor-machine.ts`, and ordinary errors in `main-dispatch.ts` own human CLI
  presentation only.
- Existing workspace binding/configuration owners retain all identity,
  persistence, validation, rebind, adoption, and first-sync transitions.
- Existing FileReplica, GitReplica, remote, encryption, upload, and daemon paths
  remain untouched.

No Adapter may create a second binding or sync implementation. The `~/rbox`
choice resolves to an absolute path and enters the same fenced create-new path
as any other directory.

The recommended-root policy branch may be deleted when a future authoritative
machine folder-intent Module owns root selection and creation and setup delegates
to that Interface, or when the product explicitly retires the recommended root.

## 4. Detailed behavior

### 4.1 Default folder

`defaultSyncFolder()` returns `path.join(homeDir(), "rbox")`. It uses rbox's
existing home-directory helper so test and supported environment overrides stay
consistent.

When the recommended choice is selected:

- an existing directory continues normally;
- an absent directory is created recursively without a second confirmation—the
  explicit menu choice is consent;
- a non-directory or creation/stat error is explained, then setup falls back to
  the editable custom-folder prompt;
- no remote workspace is created until the local root has passed all existing
  validation and the sync mutex has been acquired.

The custom-folder choice retains the current explicit confirmation before
creating an absent path.

When “Add another synced folder” is opened from an already-bound root, setup is
given that root as an exclusion. It may suggest `~/rbox` only when that differs
from the current root; otherwise it supplies no path default. After directory
validation, canonical physical paths are compared so symlinks and equivalent
spellings of the already-bound root are rejected before any rebind prompt or
remote effect. This keeps “another” literal instead of routing the user into an
unnecessary reset.

### 4.2 Display name

The optional server-visible workspace name cannot be deleted in this cycle
because it affects the dashboard and existing status labels. The prompt becomes
`Display name`; it still states that the value is optional, server-visible, and
not end-to-end encrypted. Storage semantics do not change.

### 4.3 Compatibility vocabulary

Technical compatibility surfaces remain workspace-based:

- `--workspace` and all existing commands/aliases;
- `workspace.json`, `workspaces.json`, workspace IDs and API routes;
- JSON fields such as `workspaces` and existing schema versions;
- serialized JSON error text, including the legacy workspace-required message;
- internal types, module names, protocol errors, quotas, and E2EE boundaries;
- verbose/advanced diagnostics where the distinction between a local folder and
  remote workspace identity is necessary.

This avoids a misleading source-wide rename and keeps automation byte-compatible.

### 4.4 Completion and machine status

Setup completion renders the actual collapsed local root, for example
`folder: ~/rbox`. It never relabels a remote display name as a folder.

The machine-wide table distinguishes the two facts it already projects: the
optional server label is `NAME`, and the local root path is `FOLDER`. Human
headlines say `synced folder(s)`. Internal `workspace.name`, `workspace.root`,
and the JSON `workspaces` array remain unchanged.

## 5. Conflict handling boundary

This cycle does not alter conflict policy. File conflicts and deferred Git work
have different authoritative owners and different resolution mechanisms. The
current CLI does not expose a complete durable index that can honestly back a
single `rbox conflicts` command for both planes.

Adding a partial command under a universal name would make the model simpler in
copy while making recovery less trustworthy. Conflict surfacing and automatic
resolution therefore remain a separate follow-up design grounded in the
authoritative records of both planes. Existing keep-both file behavior, Git
deferral status, repair commands, and safety invariants are protected here.

## 6. Protected functionality ledger

| Protected behavior | Owner/path | Evidence required |
| --- | --- | --- |
| Create-new and join remain distinct remote transitions | setup → existing init/remote primitives | setup branch tests |
| New first sync pushes; join pulls then pushes | existing `runInit` path | existing setup/init tests |
| Typed rebind consent and lineage recheck under mutex | reset/adopt consent + init | existing rebind tests unchanged except copy |
| Non-empty join adoption and collision retention | adopt/init paths | existing adoption tests |
| Custom path validation, explicit creation consent, retry | `stepWorkspace` | path tests |
| Recommended root creation and safe custom fallback | `stepWorkspace` setup policy | new default-root tests |
| “Add another” cannot reuse the current bound root | front door → setup exclusion | routing + path tests |
| Lock degradation warning and continuation | sync mutex path | existing degradation tests |
| TTY-only setup, stderr prompts, exit codes | setup/prompt adapters | existing tests |
| `--workspace`, keyed setup, scripted `init`, manual ID | dispatch/help/picker | registry and picker tests |
| Machine binding enumeration and daemon trust gates | doctor runtime | existing tests |
| Human status changes but JSON stays byte/schema compatible | doctor/status adapters | text + JSON tests |
| File keep-both and Git deferral behavior | existing replica owners | no implementation diff; rig regression |

## 7. Requirements challenged

- **Require all content to live in `~/rbox`: rejected.** It simplifies one story
  by breaking existing developer layouts. `~/rbox` is the recommended default,
  not a mandatory root.
- **Introduce `~/.rbox/config.json` as authority now: deferred.** The current
  binding registry, per-root state, daemon startup, migrations, and recovery
  semantics need a separate ownership/migration design. A new mirror would add
  another authority before deleting one.
- **Rename every workspace symbol: rejected.** Internal and compatibility
  vocabulary carries real identity semantics; a broad rename adds churn without
  reducing concepts.
- **Add a universal conflict inbox now: deferred.** The two conflict planes do
  not yet offer one complete authoritative observation interface.
- **Delete the display name prompt: deferred.** It has dashboard behavior and
  must be retired separately if the product no longer needs it.

## 8. Retirement and deletion statement

No command, alias, flag, output schema, persisted record, module, migration, or
supported behavior is deleted. There are no safe deletion candidates in this
cycle. Workspace terminology is retired only from the enumerated ordinary human
copy; compatibility and advanced identity terminology remain intentionally.

## 9. Validation

1. Unit/golden tests for setup choices, headers, completion, menus, picker copy,
   help, human machine status, and ordinary root errors.
2. Focused default-root tests: existing directory, absent directory, non-directory
   fallback, create failure fallback, and custom-path creation confirmation.
3. Preserve exact routing values, preselected untracked behavior, stderr-only
   prompts, machine JSON fixtures using `workspaces`, and legacy JSON error
   strings while human errors adopt folder-first copy.
4. Typecheck and lint the touched CLI surface.
5. Build and run compiled CLI smoke checks for `rbox --help` and non-TTY setup.
6. Run `bun run rig` as the end-to-end synchronization regression. This is the
   review round that executes the real sync path, not only design inspection.
7. Perform a diff-scoped primitive/simplification review before handoff.

Validation completed on 2026-08-10:

- adversarial design and code review aligned after two rounds;
- 183 changed-surface tests passed with 697 assertions;
- typecheck, lint, and `git diff --check` passed;
- the compiled CLI rendered the folder-first help and preserved non-TTY setup
  behavior;
- `bun run rig run onboard-smoke` passed across two isolated devices: 101 files
  were byte-identical, including the empty-file and symlink cases, and teardown
  deleted the throwaway account.

The repository-wide suite was also sampled. Untouched adoption/Git lifecycle
tests fail on this checkout/platform independently of this diff, so this change
does not claim a globally green baseline. No failing test involved a modified
module or changed contract.

## 10. Follow-up boundary

A later config design may make a user-owned folder list the machine-level source
of intent, but it must explicitly migrate or replace existing binding authority;
it must not add a second durable truth. A later conflict design should first give
file conflicts and Git deferrals one complete read-only observation interface,
then design automatic resolution and a unified inbox on top of that evidence.
