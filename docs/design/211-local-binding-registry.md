# 211 — Local binding registry + `status --all` / `doctor --all`

Implements §3 and the registry halves of §7 / "Implementation order" steps 6–7 of
`docs/design/notes/2026-07-25-cli-surface-review.md`.

## 1. Problem

`rbox status --all` needs to answer "what is rbox doing on this machine" from
anywhere. Today the only machine-wide enumeration is `collectMachineTriage`
(#503), which reads the per-workspace **daemon desired-state rows** under
`~/.rbox/daemons/<key>/desired.json`. That set is incomplete by construction:

- the desired row is written by `rbox start` / boot-resume, so a workspace bound
  with `rbox track` (or `init` without a first start) has no row at all —
  `doctor-machine.ts` ships a footer disclaimer admitting exactly this;
- arbitrary workspace roots cannot be discovered by scanning the filesystem.

So rbox needs a durable local record of every binding this machine has made.

## 2. Location and file shape

`~/.rbox/workspaces.json` — i.e. `rboxDir()` from `src/cli/rbox-paths.ts`, the
same host-global store that already holds `daemons/`. It is machine-local
runtime state, never synced, never sent to the server.

`rboxDir()` honors `RBOX_HOME`, so every existing test that redirects `~/.rbox`
gets an isolated registry for free. For test processes that do **not** set
`RBOX_HOME` (main-dispatch suites, front-door suites) the module honors
`RBOX_TEST_BINDING_REGISTRY_DIR`, which `scripts/test-preload.ts` pins to a
pid-scoped `/tmp` directory. This is the same escape hatch the lock-identity
ledger already uses (`RBOX_TEST_HOST_IDENTITY_DIR`) and exists solely so a unit
test can never write a garbage entry into the developer's real registry.
Precedence is `RBOX_HOME` → `RBOX_TEST_BINDING_REGISTRY_DIR` → `$HOME`, so an
explicit `RBOX_HOME` always wins and production is unchanged.

One file, not one directory per entry: the population is tens of entries, and a
single atomic rename gives readers a consistent snapshot with no directory walk.

```jsonc
{
  "schemaVersion": 1,
  "entries": [
    {
      "root": "/Users/x/code",          // absolute, path.resolve'd — the key
      "workspaceId": "ws_abc",          // cfg.remoteWorkspaceId at bind time
      "name": "code",                   // cached workspace name, optional
      "accountId": "acct_1",            // optional; absent for offline --workspace binds
      "boundAt": "2026-07-27T…",        // first time this root was recorded
      "lastSeenAt": "2026-07-27T…"      // last time rbox resolved/refreshed it
    }
  ]
}
```

Unknown fields are preserved on rewrite; an unparseable file degrades to "no
entries" rather than throwing (the registry must never be the reason a bind
fails). Entries are sorted by `root` on write so the file diffs cleanly.

## 3. Effective set = persisted entries ∪ daemon desired rows

The registry read is **not** the raw file. `readBindingRegistry()` returns the
union of the persisted entries and the live `readDesiredDaemonRows()`
enumeration, keyed by resolved root (persisted entry wins on conflict).

This is the whole migration story, and it is why there is no one-shot seeding
flag, no `seededAt` marker, and no ordering hazard:

- every existing user's started workspaces appear on the first run of the new
  binary, with no manual step;
- the union cannot resurrect an untracked workspace, because `untrack` already
  calls `removeDaemonRuntime(root)`, which deletes the directory the desired row
  lives in. Removing the persisted entry therefore removes the workspace from
  both halves of the union at once.

The remaining gap — a workspace bound by an *older* binary with `track` that has
never started a daemon — is closed by the lazy refresh in §4.

## 4. Who writes

Explicit, small diffs at the real bind/unbind sites:

| Path | Call |
|---|---|
| `src/cli/track-cmd.ts` (`track`, after `saveConfig`) | `rememberBinding(root, cfg)` |
| `src/cli/init-cmd.ts` (`runInit`, after `saveConfig`) | `rememberBinding(root, cfg)` |
| `src/cli/adopt-cmd.ts` (binding restore, after `saveConfig`) | `rememberBinding(root, cfg)` |
| `src/cli/untrack-cmd.ts` | `forgetBinding(root)` |

`setup` (guided **and** keyed) binds through `init-cmd`'s `runInit`, so it is
covered by the `init` row; `rbox link` forwards to `track`.

`saveConfig` itself is deliberately **not** hooked. Its fifth caller,
`export-cmd.ts`, writes a synthetic config into an ephemeral staging tree that
must never appear in the registry, and hooking the low-level writer would also
make ~40 unrelated unit tests write to a host-global path.

**Lazy refresh (the convergence net).** `main-dispatch` shadows its `findRoot`
import with a wrapper that, on a successful resolve, calls
`rememberResolvedRoot(root)`. Every workspace-local command (`status`, `sync`,
`start`, `stop`, `logs`, `doctor`, …) therefore records or refreshes the binding
it just operated on. This is what converges pre-existing track-only workspaces
and what covers any bind path a future change forgets to wire.

The refresh is cheap and read-mostly: it reads the file without a lock and
returns immediately unless the entry is absent, its identity changed, or
`lastSeenAt` is older than one hour.

Every registry write is **best-effort**: failures are swallowed. A busy lock or
a read-only `~/.rbox` must never fail the `track` it rides along with; the lazy
refresh re-adds the entry on the next command.

## 5. Staleness

The registry never silently drops an entry — the memo requires stale roots be
*reported*. Health is derived at read time, never persisted:

| health | condition |
|---|---|
| `bound` | `<root>/.rbox/workspace.json` exists and its `remoteWorkspaceId` equals the entry's |
| `missing` | the root, or its `.rbox/workspace.json`, is gone (deleted or moved) |
| `rebound` | the root is bound, but to a *different* workspace than the entry recorded |

`missing`/`rebound` entries are listed with the problem as their headline and a
remedy. To make the remedy real, `untrack` gains one behavior: when the entry
exists but `<root>/.rbox` is already gone, it removes the registry entry and
reports `forgot <root>` instead of erroring "nothing to untrack". That is the
only way a `missing` row can be cleaned, and it keeps GC explicit — there is no
age-based automatic pruning.

## 6. Concurrency and crash safety

Same primitives the desired-record store already uses, per the repo's
"battle-tested primitive" rule:

- **write**: `acquireLock` (`src/engine/git/lockfile.ts`) on
  `~/.rbox/workspaces.json.lock`, bounded poll to a 10 s deadline, then
  read-modify-write, `writeFileAtomic` (`src/engine/fsutil.ts`, tmp + rename) and
  `fsyncDirectory` — the same durability contract as `writeDesiredRecord`, so a
  rename we reported as successful cannot be discarded by power loss. The lock is
  released in a `finally`. Because the mutation re-reads inside the lock, two
  concurrent `track`s of different roots both survive.
- **revalidation**: both record paths re-read `<root>/.rbox/workspace.json`
  INSIDE the lock and write nothing unless it still names the binding being
  recorded. Without that, a process holding a pre-`untrack` snapshot would
  resurrect the entry untrack just removed.
- **failure reporting**: recording is best-effort (swallowed), but `forgetBinding`
  THROWS. `untrack` prints "this machine no longer lists it", and that claim must
  never be made about an entry still on disk.
- **read**: no lock. `writeFileAtomic`'s rename means a reader sees either the
  old or the new complete file, never a torn one.
- **crash**: a crash mid-write leaves the tmp file and the old registry intact;
  a crash while holding the lock leaves a stale lock, which `acquireLock`'s
  existing liveness classification handles. A crashed bind that wrote
  `.rbox/workspace.json` but not the registry converges on the next command via
  the lazy refresh.

## 7. Surfaces

`collectMachineTriage` (`doctor-machine.ts`) keeps its liveness/bootId trust
gates verbatim and only swaps its enumeration source from `readDesiredDaemonRows`
to `readBindingRegistry`. Its per-workspace summary gains the fields the memo
asks for, all read from the already-trusted ambient record: `mode`,
`lastSyncedAt`, `pendingWork`. No second divergence definition is introduced —
`deferredRepos` remains the daemon's own count.

- `rbox status --all` — table (name, root, binding health, daemon state+mode,
  last sync, pending, problem) + `--json`.
- `rbox doctor --all` — the existing #503 findings list, now registry-sourced.
  The `TRACK_ONLY_FOOTER` disclaimer is deleted: the registry covers those.
- bare `rbox status` / `rbox doctor` outside a workspace keeps its #503
  auto-all behavior, now over the registry.
- `--all` and `PATH` are **mutually exclusive** (`rbox status --all ./x` →
  clear error). Automation uses `--all` for stable aggregate semantics.

Two identity questions are deliberately answered by matching existing behavior
rather than by this design:

- roots are keyed by `path.resolve`, not `realpath`, because that is exactly how
  `workspaceKey` already names every daemon runtime directory. Canonicalizing
  here alone would make registry entries and daemon records disagree about the
  same workspace. Symlink-alias roots are therefore a repo-wide path-identity
  question, not a registry one.
- the daemon lifecycle race where a concurrent `stop` recreates `desired.json`
  after an `untrack` removed the runtime directory is pre-existing (the #503 view
  showed the same resurrected row). With the registry the outcome is a `missing`
  row, which is reported and now clearable — strictly better than before.

## 8. Non-goals

Network calls, per-workspace manifest scans (the aggregate view stays bounded
and read-only), remote workspace lists, cross-machine state, and any mutation
beyond the registry file itself.
