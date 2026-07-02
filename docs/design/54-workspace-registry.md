# Design 54 — Machine-wide workspace registry (`~/.rbox/workspaces.json`)

**Status:** draft (not scheduled).
**Depends on:** design 29 (`track`/`untrack`, shipped), design 44 (rebind safety, shipped), design 45 (`status`/health, shipped), design 12 (full E2EE keystore layout, shipped).

## 0. Why this doc exists

rbox has no machine-wide record of which workspaces are tracked on a given
machine. Every binding lives entirely inside its own
`<path>/.rbox/workspace.json` (`src/cli/config.ts:11-47`), and nothing indexes
those paths. So the question *"what does rbox sync on this machine?"* has no
answer short of walking the filesystem hunting for `.rbox/` directories. This
doc proposes a small, purely-local registry under `~/.rbox/` and the two hooks
(bind-time write, untrack-time prune) that keep it honest.

## 1. The gap, concretely

Every rbox command that touches a workspace needs a path *first*:

- `rbox status [path]` resolves a root from the arg or cwd and refuses when
  there's no `.rbox/workspace.json` above it (`src/cli/index.ts:333-334`,
  `resolveRoot` → `findRoot`, `config.ts:119-131`).
- `rbox sync` / `push` / `pull` / `start` all do the same `resolveRoot` dance.
- There is **no top-level `rbox list`**. The command dispatcher in
  `src/cli/index.ts` has no `list` case; every `list` token in the CLI is a
  *sub*command or flag (`device list`, `trash list`, `ignore --list`). The help
  text mentions no machine-wide enumeration because none exists.

The failure this design responds to happened first-hand. The user asked to fully
remove sync state and local login from a dev machine before trying a new login
flow. Global rbox state lives under `~/.rbox/` — but there was no way to
discover that `~/conductor/workspaces` was a tracked workspace except:

```
find ~/conductor -maxdepth 4 -name ".rbox" -type d
```

…and hoping the workspace happened to sit under a guessed root. Separately,
`~/.rbox/e2ee/` held key-cache state for **six different accounts**, most
orphaned from earlier test sessions — and nothing machine-wide recorded which
accounts or workspaces that cache belonged to, or whether any were still live.
Both problems are the same missing primitive: a local index of *what this
machine tracks and for whom*.

## 2. Where global rbox state lives today (survey)

Two distinct global roots exist, with different override envs. This matters —
the registry must land in the right one.

**`~/.rbox/` — the machine home (override: `RBOX_HOME`).** The device-scoped
store; already holds most global state:

| Path | What | Source |
|------|------|--------|
| `~/.rbox/credentials.json` | device token, `deviceId`, `remoteUrl`, `accountId` (mode 600) | `credentials.ts:35-36`, `Credentials` at `credentials.ts:11-18` |
| `~/.rbox/e2ee/<accountId>/` | per-account device key, MK, RK, per-workspace KEK cache | `e2ee-keystore.ts:8`, `e2ee-keystore.ts:25` |
| `~/.rbox/daemons/<basename>-<hash8>/` | per-workspace daemon `daemon.pid`, `daemon.log`, `workspace.bound` | `daemon-control.ts:33`, `workspaceKey` at `daemon-control.ts:22-27` |
| `~/.rbox/bin/`, `~/.rbox/release.json` | installed binary + release metadata | `upgrade-cmd.ts:83`, `deps-notify.ts:80` |

**`~/.config/rbox/` — XDG config (override: `RBOX_CONFIG_DIR`, then
`XDG_CONFIG_HOME`).** Holds only the dependency-drift state and shell hook
(`rbox-paths.ts:19-25`, `depsStatePath`). Design 29's drift store, deliberately
kept out of `~/.rbox`.

**Per-workspace, machine-local (never global, never synced):**
`<root>/.rbox/workspace.json` (the binding, `config.ts:11-47`),
`<root>/.rbox/state.json` (the sync baseline, `config.ts:75-102`), plus activity
and shell-line sidecars under `<root>/.rbox/state/`.

### 2.1 Is any of this already a partial registry?

`~/.rbox/daemons/` is the closest thing, and it's worth being precise about why
it *doesn't* suffice:

- It only exists for workspaces that have had a daemon **started** — `rbox track`
  followed by `rbox sync` (foreground) never creates a `daemons/<key>` dir.
- Its key is `workspaceKey(root)` = `<basename>-<sha256(absRoot).slice(0,8)>`
  (`daemon-control.ts:22-27`). The hash is **one-way**: given the dir you cannot
  recover the absolute path it was derived from. The basename hints at it, but a
  workspace at `~/conductor/workspaces` and one at `~/tmp/workspaces` collide on
  basename and are only disambiguated by an opaque hash. So the daemons dir
  cannot answer "enumerate the tracked paths" — the one thing we need.
- `workspace.bound` records the *workspace id* the running daemon bound
  (`daemon-control.ts:44-47`), not the path, project, or account.

Conclusion: the daemons dir is a runtime-liveness index, not a binding index.
The registry should **reuse its `workspaceKey`** (to cross-reference daemon
liveness cheaply) but store the real path itself.

## 3. Decision: a machine-wide binding registry under `~/.rbox/`

Add `~/.rbox/workspaces.json` (mode 600, atomic write via
`writeFileAtomic`, honoring `RBOX_HOME` exactly as credentials/daemons/keystore
do). It is a **local cache/index of bindings** — the source of truth for any one
binding stays that workspace's own `workspace.json`; the registry just makes the
set of them enumerable without a filesystem hunt.

### 3.1 What to store — and what deliberately *not* to

The design constraint: the registry's whole reason to exist is that you can't
open a workspace's `workspace.json` until you already know its path. So the
registry must carry the path plus *just enough* identity to render a useful
`rbox list` row without opening every binding — and nothing that would duplicate
fast-changing or secret state.

Proposed entry:

```jsonc
{
  "version": 1,
  "workspaces": [
    {
      "rootPath": "/Users/via/conductor/workspaces", // PRIMARY KEY, resolved absolute
      "workspaceKey": "workspaces-1a2b3c4d",          // = workspaceKey(rootPath), daemon cross-ref
      "remoteWorkspaceId": "ws_ab12cd34",
      "projectId": "root",
      "deviceId": "dev_9f8e7d6c",
      "accountId": "acct_1234",                        // NOT in WorkspaceConfig — see below
      "remoteUrl": "https://api.rbox.to",
      "name": "conductor",                             // optional display label, if cached
      "createdAt": "2026-07-02T18:00:00Z",
      "lastTrackedAt": "2026-07-02T18:00:00Z"
    }
  ]
}
```

Justification against `WorkspaceConfig` (`config.ts:11-47`):

- **`rootPath`** — MUST cache; it's the primary key and the *only* field that is
  local-only and not derivable from anything else. This single field is the
  reason the registry exists (`config.ts:28` calls it "Local-only").
- **`remoteWorkspaceId`, `projectId`, `deviceId`, `remoteUrl`** — cache them.
  They're stable for the life of a binding and together compose the
  `syncStreamId` identity (`config.ts:115-116`); caching them lets `rbox list`
  print an identity-complete row with a single file read instead of opening N
  `workspace.json` files. Cheap redundancy, and if one drifts the live
  `workspace.json` wins (§5.1).
- **`accountId`** — the one field that is **not** in `WorkspaceConfig` at all. It
  lives only in the per-machine `Credentials` (`credentials.ts:15-18`). Capturing
  it at bind time is what lets the registry answer "which workspaces belong to
  account X" — directly the missing link behind the orphaned-e2ee-cache problem
  (§1): six accounts' key caches with nothing recording which were live.
- **`name`** — optional; mirror the locally-cached label (`config.ts:17-22`) so
  `list` shows human names with no round-trip. Absent = show the id.
- **`createdAt` / `lastTrackedAt`** — new. Bind-time timestamps only (see §3.2).

Deliberately **not** stored:

- **Sync state / sequence / last-synced.** The single source of truth is
  `<root>/.rbox/state.json` (`config.ts:171-199`), and the 2026-07-01 rebind
  mass-delete (`config.ts:80-101`, design 44) is a standing lesson about
  duplicated, drift-prone sync baselines. `rbox list` reads freshness **live**
  from each entry's own `state.json` / activity sidecar (the same reads `rbox
  status` already does, `index.ts:358-363`) — never from a cached copy.
- **`token`, `kek`** — secrets; they never leave the credential/keystore
  (`config.ts:150-153` strips them even from `workspace.json`).
- **`syncGit`, `encrypted`, `noDrift`, `trash`** — read live from
  `workspace.json` once you have the path (which you now do). No value in a
  second, staleable copy.

### 3.2 Keep the shared file write-cold

`lastTrackedAt` is deliberately a **bind-time** stamp, not a live "last seen."
Reason: a single shared `workspaces.json` is a contention point under concurrent
read-modify-write (the daemons dir uses *per-workspace* files precisely to avoid
this, §2.1). Bind events (`track`/`init`/`untrack`) are rare, so a shared file
touched only then stays cold and last-writer-wins is acceptable. Anything
frequent — "last synced N minutes ago" — is derived live from each workspace's
own `state.json`/activity at `list` time, never written back to the shared file.
(§9 open question 3 raises a per-file directory layout as the fallback if even
bind-time contention proves real.)

## 4. Write hook — where a binding gets recorded

A binding is persisted at exactly one choke point today: `saveConfig`
(`config.ts:148-154`), called from all three bind paths:

- `rbox track` → `track-cmd.ts:107`
- `rbox init` → `init-cmd.ts:180`
- `rbox setup` → drives `runInit` (`setup-cmd.ts:245`), so it flows through
  `init-cmd.ts:180` too.

The registry write should be a thin new module (`registry.ts`) exposing
`recordBinding(cfg, accountId)`, called **immediately after each `saveConfig`**
at the two real call sites (`track-cmd.ts:107`, `init-cmd.ts:180`). Both sites
already hold the loaded credential — `init-cmd.ts:124` (`creds`) and `track-cmd`
loads it at `track-cmd.ts:42-43` — so `accountId` is in hand.

Why not fold the upsert *into* `saveConfig`? Because `saveConfig` deliberately
knows nothing about credentials — its whole contract is "write this
workspace.json, stripping secrets" (`config.ts:150-153`). Reaching into
`loadCredentials()` from inside it to grab an `accountId` would couple a pure
per-workspace file writer to global auth state and make it do a second, global
write. A dedicated `recordBinding` at the call sites keeps `saveConfig`'s
contract clean and puts the credential read where the credential already lives.

`recordBinding` is an upsert keyed on resolved `rootPath`: a re-track of the same
path updates the existing row (and refreshes `lastTrackedAt`) rather than
appending a duplicate. On a **rebind** (design 44 — same path, new workspace),
it overwrites the identity fields, matching what `track`/`init` already do to
`workspace.json` (`track-cmd.ts:84-91`, `init-cmd.ts:156-164`).

## 5. Prune hook + the `logout` policy question

### 5.1 `untrack` prunes

`rbox untrack` is the clean teardown: it removes `<root>/.rbox` and the global
`~/.rbox/daemons/<key>` runtime dir (`untrack-cmd.ts:67`, `:71`). The registry
prune is one more line right after: `registry.remove(root)`. Single obvious spot,
and it mirrors the existing `removeDaemonRuntime` cleanup exactly.

### 5.2 `logout` leaves the registry alone

`logout` only clears the credential file (`auth-cmd.ts:134-137` →
`clearCredentials`, `credentials.ts:69-71`). It does **not** touch any
`.rbox/` binding, any local file, the daemons, or the e2ee keystore. The
workspaces are still fully tracked on disk; you simply can't sync until you log
back in.

Decision: **logout does not prune the registry.** Pruning bindings on logout
would misreport machine state — the directories are still bound and will resume
syncing the moment you re-authenticate. The registry should reflect *what is
tracked*, not *what is currently authenticated*.

But logout is exactly where the `accountId` field earns its place. The
orphaned-e2ee-cache problem (§1) is a logout-shaped gap: logout leaves
`~/.rbox/e2ee/<accountId>/` untouched too, so key caches for stale accounts pile
up. The registry's `accountId` makes an account-scoped cleanup *possible* later —
a future `rbox logout --purge` (or a standalone cleanup command) could ask "which
tracked workspaces and which e2ee caches belong to this account?" and act on the
answer. That deeper e2ee-cache GC is out of scope here (§8), but the registry is
the primitive it would need.

## 6. Staleness detection + self-heal

The registry is a cache, so it can drift when a path is moved or deleted **outside**
`rbox untrack` (the user `rm -rf`s the dir, or just `rm -rf .rbox`). On the next
`rbox list`, each entry is validated by stat-ing its `rootPath` and its
`<rootPath>/.rbox/workspace.json`:

| Observed | Meaning | Registry action |
|----------|---------|-----------------|
| path + `workspace.json` present, `remoteWorkspaceId` matches | live | show as tracked; no write |
| path + `workspace.json` present, `remoteWorkspaceId` **differs** | rebound outside the registry's knowledge | **self-heal**: `workspace.json` is source of truth — update the row in place |
| path present, `workspace.json` **gone** | binding removed manually (`rm -rf .rbox`) | flag `binding removed`; offer prune |
| path **gone entirely** | dir moved/deleted | flag `missing`; offer prune |

Self-heal policy mirrors the codebase's existing aversion to destructive
surprises. `loadState` refuses to silently reset a corrupt baseline
(`config.ts:181-189`); by the same principle, **`rbox list` never silently
deletes registry rows.** It annotates stale entries and reports them; removal is
an explicit, separate action (§7). The one exception is a strictly-additive
self-heal — updating a row whose live `workspace.json` disagrees — because that's
correcting the cache toward truth, not deleting anything.

`rbox list` is the natural, frequent trigger for this validation, so drift
self-corrects on the next enumeration rather than needing a background sweep.

## 7. New / changed CLI surface

- **`rbox list` (new top-level).** The command this whole doc unlocks. Enumerate
  every machine-tracked workspace: path, name/short id, account, and *live*
  freshness (last-synced from each `state.json`, running-daemon from
  `isDaemonRunning`, reusing `status`'s reads at `index.ts:350-363`). Stale
  entries (§6) are flagged inline. The `list` verb is currently unclaimed in the
  dispatcher, so there's no collision.

  Rationale for `rbox list` over `rbox status --all`: `status` means "one
  workspace, in depth" (`index.ts:333-403`), and overloading it with a
  fleet-wide mode muddies that. A distinct `list` verb reads cleaner and leaves
  `status` untouched.

- **`rbox list --prune` (proposed, follow-on).** Explicitly remove only the
  entries `list` flagged as stale (path or binding gone). Additive, low-risk —
  it removes *bookkeeping* for things already gone, never a live binding.

- **`rbox untrack --all` — NON-GOAL for this doc.** A mass-unbind hammer (untrack
  every *live* workspace) is a bigger, more dangerous flow that deserves its own
  confirm-and-safety design; folding it in here would blur a bookkeeping doc into
  a destructive-operation doc. Flagged, deferred.

## 8. Non-goals

- **No remote/dashboard sync of the registry.** This is purely local, per-machine
  bookkeeping. The server already models account → workspaces (designs 15/17);
  the registry is a *complement* to that, not a client of it, and syncing a list
  of local paths to the server would leak machine layout for no product benefit.
  (Left as an explicit open question below in case a future "your devices" view
  wants it — but not now.)
- **No e2ee-cache garbage collection.** Cleaning up orphaned
  `~/.rbox/e2ee/<accountId>/` caches is a related motivation (§1, §5.2) but a
  separate operation; this doc only provides the `accountId` primitive it would
  build on.
- **No migration/backfill of existing bindings** as a blocking step — see the
  lazy-population open question.

## 9. Open questions

1. **Backfill of pre-registry bindings.** Workspaces tracked before this ships
   won't appear until re-touched. Options: (a) lazy — any `status`/`sync`/`start`
   upserts the current workspace into the registry, so the set fills in as you use
   it; (b) a one-shot `rbox list --scan` that walks the known `~/.rbox/daemons/`
   keys plus a bounded `find` under `$HOME` for `.rbox/workspace.json`. Lean (a)
   with (b) as an opt-in. Which is the right default?

2. **Key: absolute path vs `workspaceKey` hash.** Path is human-scannable and
   required anyway for the stat-based staleness check (§6); the hash is opaque but
   collision-safe and already the daemons-dir key. Proposal stores `rootPath` as
   the key and `workspaceKey` as a cross-ref field. Is there a case where two rows
   should share a path (e.g. a path rebound to two projects)? Today a path binds
   one workspace/project, so one row per path holds.

3. **Concurrency shape: single file vs directory-of-files.** `workspaces.json` is
   simplest and human-scannable and matches the rest of `~/.rbox` conventions,
   and §3.2 keeps its writes bind-time-rare. But if even bind-time
   read-modify-write contention proves real, the fallback is
   `~/.rbox/registry/<workspaceKey>.json` — one file per binding, mirroring the
   daemons dir exactly, so each `recordBinding`/prune is an isolated single-file
   write with no RMW race, at the cost of `list` doing a `readdir` + N reads.
   Recommend shipping the single file and switching only if contention is
   observed.

4. **Should the registry ever be surfaced remotely?** A "your tracked machines &
   workspaces" view in the dashboard would want this data, but that reopens the
   privacy trade-off in §8. Explicitly deferred; noting it so a future device-management
   design (cf. design 30) knows the local primitive exists.
