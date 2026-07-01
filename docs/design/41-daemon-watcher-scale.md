# §41 — Daemon watcher scale: 11 GB idle RSS + dropped live changes

**Status:** 🟢 IMPLEMENTED on this branch (PR #24), pending codex re-review + `/simplify`.
Root-caused by reproduced measurement on the founder's machine; the `@parcel/watcher`
swap is built, Phase-0-gated on darwin-arm64, and re-measured on the same 17 GB corpus:
**11,106 MB / 330 s → 60 MB / <0.1 s.** This doc is the design **and** the record of what
shipped. Closes codex **round 1** (async lifecycle / floor, symlink realpath, HashCache.prune)
**and round 2** (deterministic all-platform release embedding, negation-aware + recursive
native prune, hot-path write-finish retry, robust/expanded tests, root-containment guard).

**Implements:** the deferred watcher-backend swap flagged in `watcher.ts:30` and
`docs/design/09-hardening-scale.md` (M9 "scale"). **Composes with:** the swappable
`Watcher` interface (`src/cli/watcher.ts`), the daemon reconcile loops
(`src/cli/daemon.ts`), and the ignore matcher (`src/engine/ignore.ts`).

---

## 1. Problem statement

The daemon is meant to be an invisible background citizen — watch a workspace, push on
change, cost tens-to-low-hundreds of MB. On a real monorepo-scale workspace it did the
opposite. Two failures, both observed live:

1. **~11 GB resident memory while idle** (0 % CPU, stable — a fixed startup allocation,
   not a growing leak). ~100× the budget.
2. **Passive sync silently dropped live changes.** A newly-created file, given ~60 s, was
   never synced.

Initial-scan correctness was fine: the scanner excludes `node_modules/.git/build/.env`
and synced 8,601 source files out of 200,000+. The failure was entirely in the
**live-watch layer**.

### The workload (founder's machine, `~/conductor/workspaces`)

| Metric | Value |
|---|---|
| Workspace size | ~17 GB |
| Monorepo copies | ~8 (Conductor worktrees) |
| **Total directories** | **196,370** |
| Dirs outside `node_modules`/`.git` | 15,600 |
| `node_modules` directories (mostly nested) | 2,193 |
| Total files | 200,000+ (~185k in `node_modules`) |
| **Source files rbox syncs** | 8,601 |

The archetypal "many small files, deep nesting, huge ignored subtrees" shape.

---

## 2. Root-cause analysis (measured)

Reproduced with a harness driving the **real** `startWatcher` + `buildIgnoreMatcher`
against the live workspace, sampling RSS and instrumenting every `ignores()` consult.

### 2.1 The scanner is exonerated (117 MB)

`scanManifest` → **8,601 files, 8.8 s, RSS 117 MB.** It prunes ignored dirs during the
walk (`manifest.ts:148`) and hashes with bounded concurrency. Not the memory holder; its
`HashCache` (one entry per synced file) is negligible.

### 2.2 The watcher IS the holder — reproduced to the megabyte

chokidar with `watcher.ts`'s exact config:

```
  60s  RSS ≈ 2.9 GB      (still building the initial watch set)
 180s  RSS ≈ 7.3 GB
 330s  RSS = 11,106 MB   ← initial watch buildup finally completes
```

**11.1 GB, 330 s to get there** — reproduces the field figure.

### 2.3 Memory attribution — native `fs.watch` handle state, not JS

A second run captured `process.memoryUsage()` + chokidar's `getWatched()` at `ready`:

```
rss = 11,122 MB   heapUsed = 71 MB   heapTotal = 88 MB   external = 10 MB
getWatched: dirs = 14,758   fileEntries = 23,358   totalPaths = 38,116
native residual (rss − heapTotal − external) = 11,024 MB
```

JS heap is **88 MB**; the other **11,024 MB** is native OS watch-handle state across
**38,116 watched paths** — **~289 KB per watched path.** The 11 GB is unambiguously
per-path `fs.watch` handles, not JS objects and not scanner retention.

### 2.4 Why — and it is NOT "fsevents can't prune node_modules"

The old comment assumed macOS fsevents watches recursively and chokidar holds state for
the whole tree including `node_modules`. The measurement refutes that:

- **chokidar 5 dropped fsevents entirely.** `chokidar@5.0.0` (like v4) has no `fsevents`
  dependency; its `NodeFsHandler` watches via **per-path, non-recursive `fs.watch`** —
  `_watchWithNodeFs()` opens one handle per directory AND per file (`handler.js`). Under
  Bun this maps onto Bun's own `fs.watch`.
- **node_modules pruning works.** Instrumentation: `ignoreCalls=70,165`, of which only
  **38** were `node_modules` consults. The 8 monorepos nest their `node_modules`; chokidar
  meets each *outermost* one (~38), prunes it, and never descends. The pattern is right
  too: `node_modules/` (trailing-slash only) matches at any depth under gitignore
  semantics (= `**/node_modules/`).

So the 11 GB is watching the **legitimately-non-ignored** tree — ~38k paths (8 copies of a
real source tree) at ~289 KB each. Excluding `node_modules` doesn't save you; the backend
pays per surviving path.

### 2.5 Dropped events — the backend is the primary cause, not the only one

The 330 s tell: a harness `setTimeout(75 s)` didn't fire until 330 s. Installing ~38k
per-path handles **saturates the single JS event loop for ~5.5 min**, starving every timer
— including the 60 s safety-tick reconcile that is supposed to heal drops. That is the
dominant cause of "created a file, waited 60 s, nothing."

But several independent gaps compound, and each survives the backend swap unless handled —
so we do **not** claim a single root cause explains every drop:

- **Startup blind window.** The daemon does the initial scan → pull → push *before*
  `startWatcher` (`daemon.ts`); anything created in that window is invisible to the watch.
- **`ignoreInitial` suppression.** Files created between the initial snapshot and the
  watch going live emit no `add`.
- **Safety tick heals only *stat-visible* misses.** It's a stat-only (mtime+size) pass, so
  a dropped event for a same-mtime+size edit waits for the 30-min cache-bypassing **deep
  scan**, not the 60 s tick.
- **OS-level drops.** Any watcher can miss under load; correctness must fall back to the
  reconcile loops, never assume a lossless stream.

**Conclusion.** Primary cause: chokidar's per-path `fs.watch` backend (~289 KB/path +
multi-minute loop-blocking install that disables the safety net). Fixing the backend fixes
both headline symptoms; the secondary gaps are handled in the lifecycle (§4) and tests (§7).

---

## 3. Options considered

| # | Option | Memory at scale | Ignore | Event-loop | Cross-platform | Verdict |
|---|--------|-----------------|--------|------------|----------------|---------|
| **a** | **`@parcel/watcher`** | macOS **O(1)** single stream; Linux per-dir inotify (bounded, §5) | Native prune (hard dirs) + JS matcher authoritative post-filter | Native thread; loop free | FSEvents / inotify / RDCW | **CHOSEN** |
| b | Degrade to **periodic-scan-only** | Tens of MB (scanner) | JS matcher | none | universal | **Fallback floor** (always available) |
| c | Raw `fs.watch({recursive:true})` | macOS O(1); Linux poor | JS post-filter only | low | Linux recursive weak; missing `filename`; inode-replace drops (Node docs) | **Experimental, own gate — not default fallback** |
| d | Bound/limit chokidar (`depth`,`usePolling`) | polling pegs CPU | — | worse | — | Reject |
| e | `nsfw` / `watchman` | watchman O(1) but needs a **separate daemon install** | — | — | — | Reject |

`@parcel/watcher` is the M9-anticipated plan and is the watcher behind VS Code, Parcel,
Nx, Tailwind — built for exactly this workload. It runs the OS watch on a **native
background thread**, so the JS loop is never blocked installing watches (structurally
fixes §2.5's dominant cause). The `Watcher` interface already hid the backend; the change
is localized to `watcher.ts` plus the async-lifecycle daemon changes below.

The fallback is **periodic-scan-only (b)**, *not* raw `fs.watch`. Node's docs disqualify
recursive `fs.watch` as an unqualified Plan B (inconsistent, missing `filename`,
inode-replacement drops, unreliable on network/virtual FS). Option (c) stays experimental
behind its own gate.

---

## 4. What was built

### 4.1 `src/cli/watcher.ts` — swappable backend behind an async factory

`startWatcher(...)` is now `async → Promise<Watcher>` and selects a backend
(`RBOX_WATCHER` env override, else `parcel`). Both backends feed a **shared coalescing
batcher** (the debounce/`maxWait` logic, extracted verbatim). The chokidar backend is
retained for small workspaces / debugging / a Phase-0-failing target.

**Parcel event mapping** (parcel gives `create|update|delete` with no file/dir tag):
`update → change`; `create → stat → addDir|add`; `delete → unlinkDir` — because
`applyWatchEvents`' `unlinkDir` removes the exact path *and* any `path/**` children, one
mapping correctly covers a deleted file or directory.

**Native ignore is coarse-only, negation-aware; the JS matcher stays authoritative.**
`nativePruneGlobs(root)` (new in `ignore.ts`) builds Parcel's `ignore` from `HARD_PRUNE_DIRS`
(`node_modules`, `.git`, `.rbox`, `dist`, `build`, `target`, …) — but honors negations:

- **Recursive subtree globs.** Each kept dir emits **both** `**/<dir>` (the dir itself) and
  `**/<dir>/**` (its whole subtree). picomatch's `**/node_modules` matches the directory but
  *not* `node_modules/pkg/file.js`, and a native watcher emits child paths — so without the
  `/**` form, node_modules **children would flood the JS filter** (statSync + matcher on the
  hot path). Re-measured on the founder's corpus: a file written deep inside
  `…/node_modules/pako` now yields **0 events reaching JS, 0 matcher consults** (finding 3).
- **Negation-aware pruning.** A hard-prune dir the user could **re-include** under (e.g. a
  `.rboxignore` `!dist/`) is **dropped** from the native set, so its live events still reach
  the authoritative JS matcher instead of being silently pruned before it. `node_modules` /
  `.git` / `.rbox` are treated as always-prunable (never realistically re-included; `.rbox`
  is hard-excluded in code); `dist`/`build`/`.next`/… are conditional on there being no
  negation that could match inside them (finding 2). Confirmed live: with `!dist/`,
  `dist/keep.txt` is delivered as a live event, not merely healed by the safety scan.

The full `IgnoreMatcher` remains the authoritative **post-filter** on every delivered
create/update — native prune is a *volume* optimization only, never the thing that decides
whether a path syncs.

**Hot-path write-finish retry (finding 4).** chokidar had `awaitWriteFinish` stability
gating; Parcel flushes on debounce only, so a still-writing large file can hash to
"mid-write" and be dropped until the next event. `applyWatchEvents` now reports mid-write
paths via a `deferred` out-set (and `statHashEntry` distinguishes `gone` from `midwrite`),
and the daemon re-pushes them as `change` events after a short quiet — bounded to ~15 tries
(~3 s) per path, after which the safety/deep scan is the floor. A pathological
never-settling file can't hot-loop the pump.

**Three implementation findings worth recording:**

1. **`require`, not `import`, for the native binding.** Node-API (`.node`) modules can't
   load via ESM `import`/`import()` under Bun ("use require() or process.dlopen"). A
   *literal bare* `require("@parcel/watcher-<platform>")` is the one form that works BOTH
   interpreted (`bun run`/`bun test`) and embedded by `bun build --compile` — the bundler
   statically resolves the literal and inlines the `.node`. `createRequire` and computed
   specifiers are opaque to the bundler and fail in the compiled binary. The binding is
   loaded lazily via a literal per-platform `switch`.
2. **Realpath the watched root.** Parcel reports event paths as *real* paths (symlinks
   resolved). If the root has a symlinked component (macOS `/tmp → /private/tmp`),
   relativizing against the un-resolved root yields `../…` and **silently drops every
   event.** The parcel backend now `realpathSync`es the root before subscribing. (Relative
   structure — and thus manifest keys — is unchanged.)
3. **Proper root-containment guard (finding 6).** The escape check is `rel === ".." ||
   rel.startsWith("../")`, not a bare `startsWith("..")` — so legitimately dotdot-named
   files (`..keep`, `..data/x`) are delivered rather than wrongly dropped as "outside root."

### 4.2 `src/cli/daemon.ts` — async lifecycle; reconcile loops are the floor

The "no daemon-loop changes" claim from round 1 is **retracted**; parcel's `subscribe()`
is async. Concretely:

- The 60 s safety tick and 30 min deep scan are **armed unconditionally, before** the
  watcher is started. They are the correctness floor.
- Watcher init is `await`ed in a `try/catch`. On **rejection** (no native binding, inotify
  exhaustion, unsupported FS) the daemon logs `live watch unavailable: … — degrading to
  periodic scan` and continues. **There is no path where a failed watcher leaves sync
  silently dead** — it degrades to periodic full-scan reconciliation.
- Startup log distinguishes `ready` from `ready (periodic-scan mode; no live watch)`.

### 4.3 `HashCache.prune()` wired — the adjacent unbounded-growth bug

The daemon never called `HashCache.prune()`, so `.rbox/state/hashcache.json` grew
monotonically over a workspace's lifetime (branch switches, moved trees). Now
`pruneCache()` runs after every full scan (initial + safety tick), dropping entries for
paths no longer in the manifest. The deep scan already rebuilds a fresh, tight cache.

### 4.4 Release cross-build — deterministic all-platform embedding (finding 1)

The native `@parcel/watcher` binding is platform-specific, and its npm packages are
os/cpu-gated, so a single Ubuntu release host (`release.yml`) would only install its own —
`bun build --compile --target=bun-darwin-arm64` would then **fail to resolve**
`@parcel/watcher-darwin-arm64`. Fix, verified by building all four targets on one macOS
host:

- **`release.yml` installs with `bun install --frozen-lockfile --os=* --cpu=*`** — bun's
  documented override that force-installs **every** platform package regardless of host
  (all four `.node`s land; `--frozen-lockfile` still honored). `release.ts` repeats it so a
  standalone `bun scripts/release.ts` also works.
- **Per target, `--external` the three non-target packages**, embedding only the target's
  `.node` (helper `externalFlagsFor(t)`). All four platform packages are declared in
  `optionalDependencies`.
- **`release.ts` asserts the target's `watcher.node` is present before building** and fails
  loud if not — a release must embed the real binding, never silently ship the degraded
  periodic-scan fallback. (A binary that somehow lacks its binding still *boots*, degraded —
  see §4.2 — so users are never bricked; but a release shipping degraded is a hard error.)

Confirmed: all four `--target`s resolve + embed on a single host after the all-platform
install.

---

## 5. Cross-platform / Linux (not O(1))

macOS FSEvents is a single recursive stream (O(1) memory). **Linux is different:**
`@parcel/watcher` uses inotify, which registers **one watch per directory** and is bounded
by `fs.inotify.max_user_watches` (defaults 8k–128k). Post-prune this corpus is ~12–15k
dirs — likely under a modern default but not guaranteed on stock distros. The
degrade-to-periodic-scan path (§4.2) is exactly the inotify-exhaustion handler: an
`ENOSPC`/limit failure at `subscribe()` rejects → daemon logs + degrades, never crashes or
silently under-watches. **Still to validate in CI on a real Linux target** (watch count
post-prune, exhaustion behavior); tracked in §6.

---

## 6. Phase 0 result + target coverage

**Phase 0 (the hard gate): PASS on darwin-arm64.** Proven end-to-end, not just "build
exits 0": the compiled standalone binary of the real `watcher.ts`, run from an isolated dir
with no `node_modules`, **loaded the embedded native addon, subscribed, received a create
event, pruned `node_modules`, and idled at ~40 MB.**

| Target | Native embed proven | How |
|---|---|---|
| **darwin-arm64** | ✅ locally (compile + run + event) | this machine |
| darwin-x64 | ⚠️ CI-gated | build with `--external` the 3 others; run the compiled binary on a mac-x64 runner, subscribe, assert an event |
| linux-x64 | ⚠️ CI-gated | build on/for linux-x64 with its package installed; run compiled binary on a linux-x64 runner, subscribe, assert an event; also assert inotify count post-prune |
| linux-arm64 | ⚠️ CI-gated | same, linux-arm64 runner |

**CI requirement:** each target must run its compiled binary on native hardware (or
faithful emulation) and confirm the watcher **loads + delivers an event** — `bun build`
exit 0 is insufficient (the native `.node` only fails at load). A target whose package is
absent at build time still produces a working binary that **degrades to periodic-scan**
(the binding `require` throws → caught → floor), so no target ships broken; it either has
the native watcher or the safe fallback.

---

## 7. Tests (CI-safe)

Deterministic, bounded, on synthetic temp trees against the real parcel backend. The
watcher tests **probe once and `skipIf` the native watcher can't start** (sandboxed CI with
no FSEvents), so they run on Linux/inotify CI and dev machines but never hard-fail in a
headless box (finding 5a).

`src/cli/watcher.test.ts` (10 cases):
- create → `add`; modify → `change`.
- **Ignore post-filter authority:** a `*.log` (natively-unpruned) is suppressed by the JS
  matcher; **negation** — `.env.example` delivered while `.env` filtered.
- **Re-included hard-prune dir** (`!dist/`) delivers a **live** `dist/keep.txt`, not just
  via the safety scan (finding 2).
- **Dotdot-named file** (`..keep`) is delivered, not treated as escaping root (finding 6).
- **Atomic write-then-rename** surfaces the final path, not the temp.
- **Directory delete** removes the subtree via `unlinkDir`.
- **create-then-delete** in one window coalesces to the delete (never a stale `add`).
- **SCALE (§41):** a ~10k-file monorepo-shaped tree (source + large `node_modules`) —
  asserts **ready < 10 s**, **RSS < 300 MB**, a create **deep under an existing
  node_modules** yields **zero events** (native subtree prune, finding 3), and a source
  create is delivered (finding 5b).

`src/cli/daemon-watch-degrade.test.ts`: **watcher init rejects → the reconcile timers stay
armed** (the never-silently-dead invariant, finding 5c). `src/cli/watcher-compiled.test.ts`:
**compiled standalone binary loads the native watcher and delivers an event** on the host
target, run in an isolated dir (finding 5d). `src/engine/engine-m1.test.ts`: `applyWatchEvents`
`deferred` collects mid-write paths only — a settled or gone file never defers (finding 4).

**Re-measured on the founder's real corpus (old → new):**

| | chokidar (old) | @parcel/watcher (new) |
|---|---|---|
| Idle RSS | 11,106 MB | **60 MB** |
| Time to ready | 330 s | **<0.1 s** |
| Live create synced | dropped | **delivered** |
| node_modules event leak | n/a (pruned) | **0** |

Verification: `bun test ./src/` = **292 pass / 0 fail**; `tsc --noEmit` (root + apps/api)
clean; all four release `--target`s resolve + embed on one host; compiled-binary smoke of
the real `watcher.ts` passes standalone.

---

## 8. Risks / follow-ups

| Risk | Mitigation |
|---|---|
| Non-darwin-arm64 native **runtime** load unproven locally | Build resolves + embeds for all 4 on one host (verified); runtime load is CI-gated per §6; absent-binding binary still degrades safely to periodic scan |
| Linux inotify `max_user_watches` exhaustion | `subscribe()` rejection → degrade to periodic scan + log; validate real count in CI |
| Native `ignore` hides a JS-re-included event | `nativePruneGlobs` **drops** any hard-prune dir with a possible negation (finding 2); node_modules/.git/.rbox always-prunable; JS matcher authoritative post-filter; asserted with `*.log`, `.env.example`, and live `!dist/` tests |
| node_modules **children** flood the JS filter | Native prune emits `**/<dir>/**` subtree globs; re-measured 0 nm events reach JS (finding 3) |
| Large-file save dropped mid-write | Bounded hot-path retry re-pushes mid-write paths (~3 s) before falling back to the safety scan (finding 4) |
| Same-mtime+size dropped edit | Reconcile floor: heals at 60 s (stat-visible) / 30 min deep scan (mtime+size-stable) |
| `experimental` raw `fs.watch` ever adopted | Behind its own pass/fail gate incl. atomic-save + inode-replacement delivery — not the default fallback |

**Follow-up (not in this PR):** CI runtime-load validation for the 3 non-local targets;
optional Linux inotify-count assertion in the SCALE test when run on Linux.
