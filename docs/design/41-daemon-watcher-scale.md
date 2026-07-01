# §41 — Daemon watcher scale: 11 GB idle RSS + dropped live changes

**Status:** 🔴 DESIGN-REVIEW, **NOT STARTED.** First-draft depth, backed by a
reproduced measurement on the founder's machine. No adversarial (codex) review yet
— the parent runs that after this lands. This doc **diagnoses and designs**; it does
**not** implement. It cashes the IOU already written into the code: `watcher.ts:30`
("chokidar today, @parcel/watcher for monorepo scale in M9").

**Implements (forward):** the deferred watcher-backend swap flagged in `watcher.ts`
and `docs/design/09-hardening-scale.md` (M9 "scale"). **Composes with:** the existing
swappable `Watcher` interface (`src/cli/watcher.ts`), the safety-tick reconcile loop
(`src/cli/daemon.ts:18`), and the ignore matcher (`src/engine/ignore.ts`).

---

## 1. Problem statement

The rbox daemon is supposed to be an invisible background citizen: watch a workspace,
push changes as they happen, cost "tens-to-low-hundreds of MB." On a real monorepo-scale
workspace it does the opposite of invisible. Two failures, both observed live:

1. **~11 GB resident memory while idle** (0 % CPU, stable — a fixed startup allocation,
   not a growing leak). That is ~100× the budget.
2. **Passive sync silently drops live changes.** A newly-created file, given ~60 s, was
   **never synced** — the daemon produced zero reaction.

Sync *correctness* on the initial pass is fine: the scanner correctly excludes
`node_modules/.git/build/.env` and synced **8,601** source files out of the workspace's
200,000+. The problem is entirely in the **live-watch layer**, not the scan/diff/push.

### The workload (founder's machine, `~/conductor/workspaces`)

Measured directly:

| Metric | Value |
|---|---|
| Workspace size | ~17 GB |
| Monorepo copies | ~8 (Conductor worktrees) |
| **Total directories** | **196,370** |
| Directories outside `node_modules`/`.git` | **15,600** |
| `node_modules` directories (mostly nested) | 2,193 |
| Total files | 200,000+ (~185k in `node_modules`) |
| **Source files rbox actually syncs** | **8,601** |

This is the archetypal "many small files, deep nesting, huge ignored subtrees" shape —
exactly what a dev-tool sync daemon must survive.

---

## 2. Root-cause analysis (measured, not assumed)

I reproduced the failure with a throwaway harness that drives the **real** `startWatcher`
(`src/cli/watcher.ts`) and the **real** `buildIgnoreMatcher` (`src/engine/ignore.ts`)
against the live workspace, sampling RSS and instrumenting every `ignores()` consult.
Three independent measurements attribute the memory precisely.

### 2.1 The scanner is exonerated (117 MB)

```
SCAN-ONLY: scanManifest() → 8,601 files, 8.8 s, RSS = 117 MB
```

`scanManifest` prunes ignored directories during the walk (`manifest.ts:148` —
`if (matcher.ignores(`${childRel}/`)) continue;`) so it never descends `node_modules`,
and it hashes with bounded concurrency (16). Full cold scan of a 17 GB / 200k-file tree:
**117 MB, under 9 s.** The scanner is not the memory holder, and the `HashCache` it
retains (one `{mtime,size,sha}` per *synced* file = 8,601 entries) is negligible.

### 2.2 The watcher IS the memory holder — reproduced to the megabyte

Driving only chokidar (`watcher.ts`'s exact config: `followSymlinks:false`,
`ignoreInitial:true`, `awaitWriteFinish`, function-based `ignored`):

```
  60s  RSS ≈ 2.9 GB      (still building initial watch set)
 180s  RSS ≈ 7.3 GB
 330s  RSS = 11,106 MB   ← initial watch buildup finally completes
final  RSS = 11,106 MB   ← matches the founder's observed ~11 GB exactly
```

**~11.1 GB, and it took 330 seconds to get there.** The number reproduces the field
observation to within noise. Since the scanner over the same tree is 117 MB and the JS
heap is small, **the ~11 GB is native `fs.watch` state**, not JS objects.

### 2.3 Why — and it is NOT "fsevents can't prune node_modules"

The code comment and the standing hypothesis assumed macOS fsevents watches recursively
and chokidar therefore holds per-path state for the *whole* tree including
`node_modules`. **The measurement refutes that**, on two counts:

**(a) chokidar 5 does not use fsevents at all.** The installed version is
`chokidar@5.0.0`, which (like v4) **dropped the fsevents dependency** — there is no
`fsevents` module in the tree. Its `NodeFsHandler` (`node_modules/chokidar/handler.js`)
watches via **per-path, non-recursive `fs.watch`**: `_watchWithNodeFs()` opens **one
`fs.watch` handle for every directory AND every file** it tracks (`_handleFile` and
`_handleDir` both call it). Under Bun, that maps onto Bun's own `fs.watch`
implementation.

**(b) node_modules pruning WORKS — it is not being walked.** Instrumenting the ignore
matcher across the whole run:

```
ignoreCalls = 70,165        (total ignore consults)
  node_modules consults = 38   (!!)
  returned-ignored      = 124
initial add events: files=5, dirs=0   (ignoreInitial:true, so these are live changes)
```

Only **38** `node_modules` consults — not 2,193 — because the 8 monorepos nest their
`node_modules`. chokidar meets each *outermost* `node_modules` (~38 of them), the
`directoryFilter → filterDir → _isIgnored` path prunes it, and it **never descends** to
discover the ~2,155 nested ones. Pruning is correct; `node_modules` is genuinely excluded.

**So where do 11 GB go?** Into watching the **legitimately-non-ignored** tree:
~12–15k surviving directories **plus all 8,601 files**, i.e. **~20k live `fs.watch`
handles**. That works out to **~0.5 MB of native state per watched path** — the known
pathology of the per-path `fs.watch` model at scale (each handle carries an OS event
stream + buffers). It is linear in *watched paths*, fixed at startup, idle at 0 % CPU —
exactly the observed signature. node_modules being excluded doesn't save us, because
**8 full copies of a real monorepo's source tree is still ~20k paths**, and this backend
pays half a megabyte for each.

### 2.4 The dropped-events mechanism — same root cause

The 330 s figure is the tell. My harness set a `setTimeout` for 75 s; **it did not fire
until 330 s.** Setting up ~20k per-path `fs.watch` handles **saturates the single JS
event loop for ~5.5 minutes**, starving every timer and callback. That fully explains the
"created a file, waited 60 s, nothing happened" report:

1. The daemon runs `scanManifest` (~9 s) **then** `startWatcher`, which then spends
   **minutes** installing watches. During that window the watcher is not yet live, so a
   new file emits nothing.
2. The **60 s safety-tick reconcile** (`daemon.ts:18`, `SAFETY_SYNC_MS`) is the exact
   mechanism designed to heal dropped events — but it is a `setInterval` on the same
   starved event loop. Just like my 75 s timer slipping to 330 s, the safety tick does
   **not fire on time** during buildup. The one safety net is disabled by the very thing
   it is meant to catch.
3. Even once "ready," the per-path `fs.watch` model at this scale is where OS watchers
   are least reliable (macOS coalescing/dropping, Linux would blow inotify limits).

**Conclusion.** Single root cause: **chokidar's per-path `fs.watch` backend does not
scale to a multi-copy monorepo.** It is quadratic-feeling in practice — ~0.5 MB/path of
native memory and a multi-minute, event-loop-blocking install phase that also breaks the
dropped-event safety net. This is not a leak, not a scanner problem, and not a
node_modules-pruning problem. It is the backend, exactly as `watcher.ts:30` predicted.

---

## 3. Options

The fix must: (1) hold memory to tens of MB regardless of tree size, (2) not block the
event loop (so the safety tick keeps healing), (3) still honor ignores, (4) deliver every
real change, and (5) survive being embedded in the `bun build --compile` single-file
binary across the release matrix (darwin-arm64/x64, linux-x64/arm64).

| # | Option | Memory at this scale | Ignore handling | Event-loop cost | Cross-platform | Bundling cost | Verdict |
|---|--------|----------------------|-----------------|-----------------|----------------|---------------|---------|
| **a** | **`@parcel/watcher`** (native N-API) | **~O(1), single stream** — a few MB | Native `ignore` glob prune (coarse) + keep JS `IgnoreMatcher` as post-filter | **Watches on a native thread**; JS loop free | macOS FSEvents (1 recursive stream), Linux inotify (per-dir, no per-file), Windows RDCW | **Native `.node` per target** — must embed in compiled binary; prebuilt binary per release arch | **RECOMMEND** |
| b | Bun/Node **`fs.watch({recursive:true})`** | macOS: O(1) FSEvents stream. Linux: recursive maturity varies | None native — filter events through existing `IgnoreMatcher` in JS | Low (OS thread does the watching) | macOS/Windows good; **Linux recursive is the weak spot** under Bun | **Zero deps**, embed-free | Strong fallback |
| c | Bound/limit chokidar (`depth`, `usePolling`, ignore more) | Polling 200k files pegs CPU/disk; `depth` breaks correctness | unchanged | polling = worse | same | none | **Reject** — treats symptom, re-breaks the "invisible" goal |
| d | Shrink scan/`HashCache` retention | N/A | N/A | N/A | N/A | N/A | **Reject** — scanner is 117 MB; not the problem |
| e | Different native watcher (`nsfw`, `node-watch`, `watchman`) | `watchman` O(1) but needs a **separately-installed daemon**; `nsfw`/`node-watch` less maintained | varies | varies | varies | `watchman` = external install (unacceptable for a drop-in CLI) | **Reject** for the primary; `@parcel/watcher` dominates |

### Why `@parcel/watcher` (a) is the right primary

- **Purpose-built for exactly this workload.** It is the watcher behind VS Code (file
  service), Parcel, Nx, and Tailwind — all of which watch large JS monorepos. The
  per-path pathology we measured is precisely what it was written to avoid.
- **O(1) memory on macOS.** It opens a **single recursive FSEvents stream** per watched
  root and filters natively — not 20k handles. Memory is a few MB and flat in tree size.
- **Native background thread.** The OS watch and event batching run off-loop; events
  arrive via a threadsafe napi callback. This **structurally fixes §2.4** — the JS event
  loop is never blocked installing watches, so the 60 s safety tick keeps firing.
- **Native ignore prune.** Its `ignore` option prunes high-volume subtrees
  (`node_modules`, `.git`, `dist`, …) before events are ever produced — the volume win —
  while we keep the full `IgnoreMatcher` (gitignore semantics, negations, hard-excludes)
  as a **JS post-filter for correctness**. Native prune for volume, JS matcher for
  correctness: they compose, and correctness never depends on the coarse native layer.
- **The seam already exists.** `watcher.ts` already hides the backend behind the
  `Watcher` interface + `startWatcher()`; `daemon.ts` only ever sees `onSettle(events)`.
  Swapping the backend is a single-file change plus a dependency.

### The one real cost of (a): embedding a native module in the compiled binary

`@parcel/watcher` is a prebuilt N-API addon (`.node`). Two things to prove out:

1. **Bun N-API support** — Bun loads napi modules, but `bun build --compile` embedding of
   a native addon must be verified, and the correct per-arch prebuilt must be shipped for
   each of the 4 release targets (`release.yml`). This is the gating risk.
2. **Install/size** — small (hundreds of KB per arch), acceptable; the concern is build
   pipeline complexity, not footprint.

If (1) proves intractable across the matrix, **fall back to (b)** Bun-native recursive
`fs.watch`: zero deps, embed-free, O(1) FSEvents stream on macOS. Its weakness is Linux
recursive-watch maturity under Bun and no native prune (we filter every raw event through
`IgnoreMatcher` in JS — cheap CPU, and node_modules noise is bounded because inotify still
needs per-dir registration). (b) is a genuine, shippable Plan B, not a strawman.

---

## 4. Recommendation

**Adopt `@parcel/watcher` behind the existing `Watcher` interface — gated on a
compile-embedding spike.** It is the M9-anticipated plan, it is battle-tested at exactly
this workload, and it fixes **both** symptoms at the root: memory drops from ~11 GB to a
few MB (single native stream, not 20k handles), and the native-thread model un-starves the
event loop so the safety-tick reconcile actually reconciles.

Keep the `IgnoreMatcher` as the correctness authority (post-filter); use the native
`ignore` only as a coarse volume-prune. Keep the safety-tick + deep-scan reconcile loops
exactly as they are — with the loop un-starved, they resume being the real net under any
watcher.

If the spike (Phase 0) shows `@parcel/watcher` can't be cleanly embedded across all four
release targets, ship **(b)** instead — same interface, same design, different backend.

---

## 5. Phased plan

**Phase 0 — Spike/gate (½ day, blocks everything).** In a scratch branch, add
`@parcel/watcher`, write a `ParcelWatcher` behind the `Watcher` interface, and prove:
(i) it builds into `bun build --compile` for **all four** targets, (ii) it loads and
watches at runtime under the compiled binary, (iii) the release CI can source per-arch
prebuilts. **Decision point:** green → Phase 1 with (a); red → Phase 1 with (b).

**Phase 1 — Backend swap.** Implement the chosen backend as a second `startWatcher`
implementation behind the unchanged interface. Native `ignore` = the high-volume builtin
dirs; retain `IgnoreMatcher` as the JS post-filter on every delivered event. Preserve the
existing debounce/`maxWait` coalescing (`watcher.ts:39-64`) verbatim — that logic is
orthogonal to the backend and already correct.

**Phase 2 — Reproduce-the-fix test (tight loop).** Re-run the §2 harness against
`~/conductor/workspaces` on the new backend and assert: **idle RSS < 300 MB**, **watcher
ready in < ~10 s** (no multi-minute buildup), and a **live-created file syncs within one
safety window**. This is the pass/fail gate — it directly measures the two field failures.
Add a smaller committed fixture (a synthetic multi-copy `node_modules`-heavy tree) so the
memory/latency assertion runs in CI without the 17 GB corpus.

**Phase 3 — Correctness + cross-platform.** Verify ignores are still honored (no
`node_modules` events leak through the post-filter), every real add/change/unlink/dir-op
is delivered, and Linux behavior (inotify watch counts after pruning ≈ 12k dirs — under
common `max_user_watches` defaults, but log a clear error if the limit is hit and lean on
the safety tick). Confirm the `.gitignore`/`.rboxignore` live-rebuild path
(`daemon.ts:162`) still triggers a matcher rebuild + rescan.

**Phase 4 — Ship.** Land behind the interface (no daemon-loop changes), update
`watcher.ts:30`'s comment from promise to fact, and note in `docs/design/09` that M9 scale
is now genuinely closed. Roll out; watch idle RSS in the field.

**Out of scope / follow-ups (noted, not bundled):**
- The daemon never calls `HashCache.prune()` (`hashcache.ts`), so the on-disk cache grows
  unbounded across a workspace's lifetime. Small, separate, real — file it, don't ride it
  in here.
- Starting the watcher **before** the initial scan (or concurrently) to shrink the
  cold-start blind window further — only worth it if Phase 2 still shows a gap; with a
  fast-ready backend the window is already ~seconds.

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `@parcel/watcher` can't embed in `bun build --compile` across all 4 targets | Medium | **Phase 0 gates on exactly this**; clean fallback to (b) with the same design |
| Native `ignore` semantics ≠ gitignore (misses a negation, over-prunes) | Medium | Native prune is coarse/volume-only; **`IgnoreMatcher` remains the correctness authority** as a post-filter — native layer can never cause a wrong *sync*, only extra/handled events |
| Linux inotify `max_user_watches` exhausted (~12k dirs post-prune) | Low–Med | Usually under default limits post-prune; detect + log a clear remediation; safety-tick still converges even if some watches fail |
| A native watcher drops an event (any backend can) | Low | Unchanged: the 60 s safety-tick + 30 min deep-scan reconcile remain the authority — and they now actually run, because the loop isn't starved |
| Backend swap regresses the coalescing/debounce behavior | Low | Debounce/`maxWait` logic is backend-agnostic and reused verbatim; Phase 2 asserts burst behavior |
