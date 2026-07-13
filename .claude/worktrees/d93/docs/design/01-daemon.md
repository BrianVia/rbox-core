# Design 01 — Daemon + Watcher + Live Push (Milestone 1)

**Status:** ✅ IMPLEMENTED & VERIFIED. Aligned with codex over 3 correctness rounds + 2 performance rounds (all blockers/majors resolved; final verdict READY TO IMPLEMENT). Verified cross-machine Mac ↔ flat-meadow-prod-main-01 (6/6), local 2-dir (7/7), live control plane (11/11), unit (16/16).
**Implements:** roadmap M1. **Decisions:** D1 (continuous daemon is the product), D2 (DO sequencer).
**Goal:** Edit a file on host A; it appears on host B within seconds, with no manual command. Concurrent/competing edits are preserved as conflict copies (never silently overwritten in the scan→apply window); see §6.2 for the precise, honest durability guarantee and its one documented residual.

> Review history: codex review #1 flagged 4 BLOCKERS (DO commit non-atomic across awaits; missing DO↔D1 bootstrap; pull/apply lost-edit race; manifest path traversal) and 9 MAJORs. This revision incorporates every one; the resolutions are called out inline as **[R#1: …]**.

---

## 1. What exists today (the starting point)

- `push()` / `pull()` / `sync()` (`src/cli/sync.ts`) are content-addressed and correct *for manual, non-concurrent use*. Push uploads missing blobs then commits with `parentSequence = lastSyncedSequence`; 409 → pull+retry (bounded 3).
- Worker commit (`apps/api/src/worker.ts:117`) does `currentHead()`=`MAX(sequence)` then `INSERT head+1` — **racy** read-then-write across an `await`; concurrent commits PK-collide → 500 instead of clean 409.
- `pull()` does scan → reconcile → apply with **no precondition** that the disk still matches what reconcile saw — an edit landing in that window is clobbered by `applyActions` (`src/engine/apply.ts:64`). **[R#1-BLOCKER-3]**
- Commit accepts *any* object as a manifest (`worker.ts:117`); apply joins manifest paths straight onto the FS (`apply.ts:55,79`) — `../` escapes the workspace. **[R#1-BLOCKER-4]**
- `saveState`/`loadState` (`config.ts:61,69`) write JSON non-atomically and treat *any* read failure as empty state → a torn write silently resets the reconcile base to empty (destructive). **[R#1-MAJOR]**
- `scanManifest()` re-hashes everything every time. No cache.

M1 makes sync passive, fixes the sequencer race, and closes all of the above data-loss holes — several are pre-existing bugs that continuous sync would amplify from "rare" to "constant."

---

## 2. Architecture overview

```
 Host A (daemon)                 Cloudflare                     Host B (daemon)
 watcher → debounce              Worker (router)                watcher → debounce
   → single-flight push ──commit──▶  /blobs → R2/D1               ◀──commit── push
   WS client ◀──notify────────────  WorkspaceSync DO  ─────notify──────▶ WS client
   (on notify: PULL-only)          (sequencer + WS fanout)        (on notify: PULL-only)
```

**Two channels, strict invariant:**
- **Commit channel (HTTP):** source of truth. Blobs → R2; manifest commit → DO sequencer.
- **Notification channel (WebSocket):** optimization *only*. A broadcast says "remote advanced to sequence N, go pull." **Correctness never depends on delivery.** Missed notifications are recovered by reconnect-sync, a jittered safety-net sync, or the next local-change push's 409→pull. Delete the WebSocket and sync still converges, just lazily. This invariant is the backbone.

**On a broadcast, daemons PULL only — never full sync. [R#1-MAJOR retry-herd]** A broadcast carries no information about our local changes; those flow through the watcher. Pull-only on notify removes the "everyone pushes at once" herd.

---

## 3. WorkspaceSync Durable Object (D2)

One instance per stream: `id = idFromName(`${workspaceId}/${projectId}`)`. SQLite-backed (`new_sqlite_classes`) so the **synchronous** storage KV API (`ctx.storage.kv.get/put`) and `ctx.storage.transactionSync(...)` are available — essential for the atomic commit below.

> **API precision [R#2-BLOCKER]:** per current Cloudflare docs, on a SQLite-backed DO: synchronous KV ops (`ctx.storage.kv`) and `transactionSync` are fully consistent and do **not** require `blockConcurrencyWhile` — a synchronous block has no yield point for another request to interleave. `blockConcurrencyWhile` is for **async** state-sensitive work (e.g. the D1 bootstrap import). So: commit uses `transactionSync` (no `blockConcurrencyWhile`); bootstrap uses `blockConcurrencyWhile` (§3.2). Don't conflate the two.

### 3.1 Commit algorithm — synchronous transaction, no external awaits **[R#1-BLOCKER-1, R#2-BLOCKER]**

The fatal version (rejected): read head → `await R2.put` → write head. Another request interleaves at the `await`, both write the same sequence, one acked commit is lost.

Correct sequence:

1. **Outside any critical section (awaits OK):**
   - Validate manifest schema + safe paths (§5). Reject → 400.
   - **Verify every referenced file `sha256` exists in R2/D1** (batched IN query). Missing → **`422 {error:"unsatisfied_blobs", missing:[…]}`** — a *distinct* status from the parent-conflict 409 so the client knows to upload-then-retry rather than pull-then-retry **[R#2-MAJOR: 409/422 discrimination; `remote.ts` must branch on status, not treat all 409 as conflict]**. Without this a client can commit a manifest referencing absent blobs and break *every* future pull.
   - Compute manifest sha; `await R2.put(manifestKey, bytes)`. If this manifest loses the sequence race below it's just an orphan blob (content-addressed; GC reclaims it in M6).
2. **Atomic commit via `ctx.storage.transactionSync(() => …)` — zero `await` inside:**
   - Read `head` (sync `ctx.storage.kv.get`).
   - If `parentSequence !== head` → throw to abort the txn; caller returns `409 {error:"conflict", head}`.
   - `next = head + 1`; within the same transaction write **both** `head=next` and `seq:<next>=manifestSha`. `transactionSync` makes the two writes a single atomic unit (not two independent `put`s that could tear). **[R#2-BLOCKER: single atomic write]**
3. **After the transaction (awaits OK):** best-effort mirror the pointer row into D1 `manifests` (for M7 cross-workspace queries). DO storage is authoritative; D1-mirror failure is logged, never fatal. Broadcast `{type:"committed", sequence:next, deviceId}` to OPEN sockets.

Because the transaction body is synchronous, no other request can interleave inside it; the head check+advance is genuinely atomic.

### 3.2 Bootstrap from existing D1 state **[R#1-BLOCKER-2]**

A fresh DO starts at head 0; existing workspaces already have manifests in D1, so a naive DO would tell live clients "remote is empty" → destructive reconcile.

**Bootstrap runs once, in the DO constructor, under `ctx.blockConcurrencyWhile` [R#2-BLOCKER bootstrap-race].** Doing it in the constructor (not lazily per-request) means it completes before *any* request is dispatched to this instance, so two concurrent first-touch requests cannot both import and rewind each other — `blockConcurrencyWhile` delays all incoming requests until the async import resolves, and a constructor runs once per instantiation. Logic: if `ctx.storage.kv.get("head")` is undefined, `SELECT MAX(sequence)` for `(ws,proj)` from D1 → seed `head`; load that row's `manifest_blob_sha` → seed `seq:<head>`. If D1 has no rows, head stays 0 (genuinely fresh). After seeding, DO storage is authoritative forever.

**Scope of bootstrap [R#2-MAJOR overclaim]:** M1 only ever needs the *head/latest* pointer — `pull()` calls `latest()` only, and `reconcile` uses the client-held `lastSyncedManifest` as its base, never asking the server for an arbitrary old sequence. So head-only bootstrap is sufficient for M1. I am **not** claiming older sequences are recoverable from DO storage (the D1 mirror is best-effort, so only pre-DO rows and successfully-mirrored rows live in D1). Full sequence retention is M6's job, not M1's. The dev D1 still gets wiped per roadmap housekeeping; bootstrap means correctness doesn't *depend* on the wipe.

### 3.3 Latest

`GET latest` → DO reads `head` + `seq:<head>` (sync), fetches manifest blob from R2, returns `{sequence, manifest}`. Routed through the DO for consistency with the authoritative counter (the D1 mirror lags). Read cost is one DO call per pull; acceptable, and pulls are notification-gated, not polled.

### 3.4 WebSocket auth — `Authorization` header (verified) **[R#1-MAJOR ws-auth]**

The daemon is **always Bun**, and Bun's WS client supports `new WebSocket(url, { headers:{ Authorization:"Bearer <token>" } })` (verified locally — server receives the header; see learnings 2026-06-26). So `/connect` auth is the *same bearer check as HTTP* — no subprotocol echo, no `1002` risk. The DO reads `Authorization` off the upgrade request.

**Routing gotcha [R#1-MAJOR]:** the Worker currently runs `requireAuth` before routing (`worker.ts:44`). That's fine here *because* WS now uses the same bearer header — `/connect` passes the same `requireAuth`, then forwards to the DO. (If we later need browser WS clients, fall back to the subprotocol scheme in learnings; documented, not built.)

On success the DO completes the upgrade: `new Response(null, { status:101, webSocket: client })`. On failure: 401, no upgrade.

### 3.5 Hibernation — corrected specifics **[R#1-MAJOR hibernation]**

- Use the Hibernation API: `state.acceptWebSocket(server)`.
- `serializeAttachment({ deviceId })` — attachments cap at **16 KB**; we store only `{deviceId}` (and re-serialize if it ever changes). Fine.
- Broadcast over `state.getWebSockets()`, but **filter to `ws.readyState === WebSocket.OPEN`** (the set can include `CLOSING`) and wrap each `send` in try/catch so one dead socket can't abort the fanout.
- **No app-level ping handler.** Cloudflare answers protocol pings without waking the DO; an app-level text `ping` in `webSocketMessage` would wake it (cost). Use `state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"))` for a text heartbeat, or rely on protocol pings and skip app heartbeat entirely. `webSocketMessage` otherwise ignores client input (clients never drive state over WS).

### 3.6 wrangler.jsonc

```jsonc
"durable_objects": { "bindings": [{ "name": "WORKSPACE_SYNC", "class_name": "WorkspaceSync" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["WorkspaceSync"] }]
```

---

## 4. Worker routing changes

- `POST …/manifests` and `GET …/latest` → forward to DO (`env.WORKSPACE_SYNC.get(idFromName(`${ws}/${proj}`)).fetch(req)`).
- `GET …/connect` (`Upgrade: websocket`) → `requireAuth` (bearer), then forward to DO for the 101.
- Blob routes unchanged (content-addressed; no sequencing).

---

## 5. Manifest validation & safe paths **[R#1-BLOCKER-4]**

New `src/engine/manifest-validate.ts`, used **both** server-side (DO, before commit) and client-side (before apply):

- Each entry path must be **relative POSIX**: non-empty, no leading `/`, no `\\`, no `.`/`..` segment, no NUL, normalized == itself (reject `a/../b`), length-bounded.
- No duplicate paths; **no case-insensitive duplicate** either (macOS/APFS collision) — reject `Foo` + `foo`. **[R#1-MINOR case-collision]**
- Bounded entry count and total manifest bytes (plan-tied later; a sane hard cap now).
- `type` ∈ **{file, symlink}** — matching the actual engine `FileType` **[R#2-MAJOR]**. M1 does **not** introduce a `dir` entry type: `scanManifest` never emits directories (dirs are implied by file paths and `mkdir -p`'d on apply), and `apply.ts` treats every non-symlink as a file blob. Empty directories are therefore not synced in M1 (same limitation as git) — a documented, accepted gap. A `dir` type, if ever wanted, is a separate end-to-end engine change, not smuggled in via validation.
- symlink target must itself be a safe relative path that stays within the tree.

Defense in depth: even with server validation, the client re-validates before touching the FS (never trust the network).

---

## 6. Client

### 6.0 Performance & resource discipline — the daemon must be invisible **[USER DIRECTIVE: performance is paramount]**

The failure mode the user named: a developer runs `npm ci`, clones a 50k-file monorepo into the watched root, or bulk-copies a folder — and the daemon pegs CPU/disk/file-handles re-walking and re-hashing everything, starving the developer's own tools. A naive "watcher fires → full re-scan → re-hash tree" design does exactly this. The daemon must do **O(changed) work, not O(repo) work** in steady state, and must always lose the scheduler race to the developer's foreground work. Mechanisms, in order of leverage:

1. **Ignore-first watching (the biggest, free lever).** The watcher applies the *same* ignore matcher as `scanManifest` at the watch level, so `node_modules/`, `.git/`, `dist/`, `.venv/`, `target/`, build caches emit **zero** events and consume **zero** watches. Consequence: `npm ci` / `pnpm i` / `cargo build` write almost entirely into ignored dirs → the daemon never even notices. This alone neutralizes the most common "thousands of files" event the user worried about. Verified property to test: an install into `node_modules/` produces no commit.

2. **Event-driven incremental manifest — O(changed), not O(repo) [elevated from M9 per user directive].** The daemon holds the current manifest in memory. A settled batch of watcher events carries the *changed paths*; the daemon re-stats/hashes **only those paths** and patches the manifest (add/replace/remove entries), then diffs+pushes. A 5-file edit costs ≤5 stats + ≤5 hashes regardless of whether the repo has 1k or 1M files. This is the core performance architecture; the prior draft's "full re-scan every change" is explicitly rejected for the hot path.

3. **Periodic reconcile as a cheap safety net, not the hot path — two tiers (see §6.3 for full detail).** Watchers drop events. So a **frequent stat-only full scan** (~60s ± jitter) runs as cheap routine reconciliation (hashcache → stat-only), and an **infrequent deep scan** (~30 min, cache-bypassing re-hash) is the ultimate authority that catches even mtime+size-stable silent drift. Both are rate-limited, never per-event. Incremental = responsiveness; the two periodic tiers = guaranteed convergence.

4. **Bounded-concurrency hashing & upload pools.** Hashing changed files and uploading missing blobs run through a small worker pool (cap `min(cores, 8)`), never "open 50k file handles at once." A big clone hashes in throttled batches — real work, but it can't exhaust file descriptors or saturate the disk queue. Memory stays flat (streaming hash, one-blob-at-a-time upload within the cap; never buffer the tree).

5. **Low process priority — the daemon is a background citizen.** Spawn it niced (CPU: `nice` / `os.setPriority`) and, on Linux, IO-deprioritized (`ionice -c best-effort -n7` best-effort). Even mid-hash of a big tree, the developer's compile/install/test wins the CPU and disk. The daemon is never allowed to be why the laptop feels slow.

6. **Adaptive, coalescing debounce.** While events keep arriving (clone/install in progress), keep extending the settle window up to a max-latency cap (e.g. 400ms quiet, hard-capped at a few seconds) — don't repeatedly scan a moving target mid-clone. One pass after the burst settles.

7. **Watch-count / inotify awareness + escape hatch.** Ignore-pruning keeps watch counts down, but a genuinely huge watched tree can still pressure inotify limits. Surface `ENOSPC` loudly (don't die silently — fall back to the periodic full scan), and keep the watcher behind a swappable interface so `@parcel/watcher` (native, far fewer watches) can replace chokidar. Full monorepo-scale tuning stays M9; the swappable backend + safety-net make M1 degrade gracefully rather than break.

8. **Warm cold-start.** The hashcache persists across restarts, so a daemon restart on a big `~/Development` doesn't re-hash from zero — only genuinely-changed files. The *first-ever* run is unavoidably O(all files) to hash (we need content addresses), but it's throttled (4) and niced (5), and one-time.

**Net guarantee:** steady-state cost scales with *what changed*, not with repo size; mass operations into ignored dirs are free; mass operations into synced dirs (a real clone) are throttled, deprioritized, and bounded in memory — the daemon stays out of the developer's way.

### 6.1 No-op push short-circuit — implemented FIRST, before any daemon code **[R#1-MAJOR "both implemented" was false]**

Honest correction: the previous draft claimed this was already implemented. It is **not** — current `push()` always scans→uploads→commits (`sync.ts:33`). The daemon must not land before this guard or every apply-triggered event and every safety tick mints an empty commit and a broadcast → storm.

`push()` diffs the freshly scanned manifest against `lastSyncedManifest` (using existing `diffManifests`). **Zero diff → return current sequence, perform no upload and no HTTP commit.** Unit-tested: an unchanged push issues no commit request.

This is the primary echo-storm defense: a pull writes exactly `lastSyncedManifest`'s bytes, so the post-pull scan diffs clean → no commit → no broadcast → loop dies.

### 6.2 Apply preconditions — non-destructive apply (honest guarantee) **[R#1-BLOCKER-3, R#2-BLOCKER]**

Reconcile produces actions from a scanned local snapshot. Between scan and apply the user may edit. `applyActions` becomes **precondition-checked and non-destructive**:

- Each `write`/`delete` action carries `expectedLocal` (the sha+type the local file had when reconcile ran, or `absent`).
- **Write:** (1) fetch remote bytes and stage them to a temp file *first*; (2) re-stat/re-hash the target; (3) **if the target no longer matches `expectedLocal`** (user edited it in the scan→apply window), move the current target aside to a `.conflict` name (`conflictName` scheme) — capturing whatever bytes are there *now* — then `rename` the staged temp into place. If it still matches `expectedLocal`, plain atomic `rename` over it. Either way the surprise bytes are preserved, never overwritten in place.
- **Delete:** if the target still matches `expectedLocal`, remove it; **if it changed, do not `rm`** — move it aside to a `.conflict` name (a concurrent edit beats a propagated delete) so the user's bytes survive. (A real trash tier lands in M6; M1's move-aside is the interim safety net.)

**Honest guarantee (corrected from the prior overclaim "never silently lose a byte") [R#2-BLOCKER]:** any edit landing in the *scan→apply window* is preserved (as a conflict copy). There remains an **irreducible sub-instruction TOCTOU** between the final re-hash and the `rename`/`rm` itself — POSIX offers no way to atomically "swap only if unchanged" against an arbitrary external editor without holding a lock we can't hold. That window is microseconds and is further mitigated because (a) the daemon suppresses its *own* writes from the watcher during apply, so the only writer in that window is a human typing at exactly that microsecond, and (b) the editor still holds its buffer, so the user's next save re-pushes the content — convergence, not loss. This residual is **documented, not hidden**, and is the correct honest claim.

### 6.3 Incremental hashing + event-driven manifest patching

Two cooperating mechanisms (see §6.0 #2/#3):

**Hashcache (`src/engine/hashcache.ts`):** `{ mtimeMs, size, sha256 }` per relative path, persisted at `.rbox/state/hashcache.json` (atomic write, §6.6). `scanManifest(root, matcher, cache?)` reuses `sha256` when `(mtimeMs,size)` match; else re-hash and update. mtime+size is a **fast-path only**, never file identity. After an apply, the cache for written paths is refreshed from **actual post-write disk stat** (not the intended remote entry) so a same-size/same-mtime real edit is never masked. **[R#1-MAJOR suppression-masking]** A corrupt cache is safe to discard (only costs a re-hash) — unlike sync state.

**Incremental manifest patch (the hot path, O(changed)) — directory-aware [R#perf-3].** The daemon keeps the current `Manifest` in memory. A settled watcher batch yields changed paths *with their event kind*; `applyWatchEvents(manifest, root, matcher, events, cache)` patches as follows:
- **file add/change:** re-stat/hash that one path (consistency-checked, below); replace/insert its entry. Skip if the matcher now ignores it.
- **file unlink:** drop that entry; invalidate its cache entry.
- **directory unlink / a path that became ignored (`unlinkDir`):** **remove every manifest entry whose path is under that prefix** (`dir/**`), not just the dir itself — a coarse directory event must not leave stale children. Invalidate those cache entries.
- **directory add (`addDir`, e.g. a clone/copy/checkout dropped a whole subtree):** **recursively `scanManifest` just that subtree** (bounded concurrency, hashcache-warm) and merge all live entries. O(changed subtree), not O(repo).
Then re-sort and push (diff vs `lastSyncedManifest`, no-op guard §6.1).

**Single-file consistency under concurrent writes [R#perf-4]:** hashing isn't atomic with the stat. So per file: **stat → stream-hash → stat-again**; if `(mtimeMs,size)` changed between the two stats, the file is actively being written → **defer it** (don't bake a torn snapshot this round; the trailing watcher event re-picks it on the next settle). Record the cache from the *post-hash* stat. Backstop: the server verifies the sha on blob PUT (`worker.ts` `blobPut`), so even a race that slips through can't commit bytes that mismatch the manifest sha — it's rejected, not silently corrupted.

**Bounded deferral [R#perf-minor]:** a perpetually-mutating file (an always-appended log that escaped the ignore rules) would otherwise defer forever. After `MAX_DEFERRALS` (e.g. 5) consecutive defers, take one best-effort stat→hash snapshot, include it, and `log()` a warning naming the file (so the user can ignore-list it). Policy is "sync stable snapshots; a constantly-churning file syncs a point-in-time snapshot and warns" — explicit, not silent.

**Three-tier drift control [R#perf-1, R#perf-2] — the full scan must be *more* authoritative than the cache:**
1. **Per-event incremental** (instant) — the hot path above.
2. **Frequent stat-only safety scan** (~60s ± jitter, §6.5) — full `scanManifest` *with* the hashcache (cheap); catches most dropped events (any change that altered mtime or size) and **replaces the in-memory manifest from disk truth before declaring convergence** [R#perf-2].
3. **Infrequent deep scan** (slow cadence, e.g. ~30 min, configurable) — full `scanManifest` that **bypasses the cache and re-hashes every file**, then rebuilds the cache. This is the ultimate authority: it catches the one residual the stat-only scan can't — a content change that preserved *both* mtime and size while its watcher event was also dropped (the classic rsync fast-path blind spot). Rare, but no longer unhandled; cost is amortized by its slow cadence and bounded concurrency + low priority.

So: tier 1 = responsiveness, tier 2 = cheap routine reconciliation, tier 3 = guaranteed convergence even against (mtime,size)-stable silent drift. The roadmap's "scan only changed subtrees" is **delivered in M1**; monorepo-scale tuning of the full/deep scans stays M9.

### 6.4 Watcher

`src/cli/watcher.ts` wraps **chokidar** with `followSymlinks:false` (match `scanManifest`, which records symlinks without following — **[R#1-MAJOR symlink]**), `ignoreInitial:true`, and the **same ignore matcher** as `scanManifest` (don't watch `node_modules/`/`.git/`/`.rbox/` — also stays under inotify limits). Debounce: fire `onSettle` after `DEBOUNCE_MS` (400ms) of quiet.

**Behavioral verification required before relying on it [R#1-MAJOR chokidar]:** a Bun test that exercises add / change / unlink / atomic-save (write-temp+rename) / chunked-write on macOS and on the Linux prod host. If chokidar misbehaves under Bun, fall back to `@parcel/watcher` (native). Keep the watcher behind a small interface so the backend is swappable.

### 6.5 Daemon loop (`src/cli/daemon.ts`)

1. On start: lower own priority (§6.0 #5 — `os.setPriority`; best-effort `ionice` on Linux). Load the persisted manifest + hashcache (warm start). One full `sync()` to converge.
2. Open WS to `/connect` (Authorization header). On `{committed, sequence, deviceId}` with `deviceId !== self` and `sequence > lastSyncedSequence` → enqueue a **pull** (not full sync). **[R#1 retry-herd]**
3. Start watcher; on **settle** (adaptive coalescing debounce, §6.0 #6) → take the accumulated changed-path set → **incremental manifest patch** (§6.3, O(changed)) → push. Watcher applies the ignore matcher so ignored-dir churn (e.g. `npm ci`) produces no events. **[USER DIRECTIVE]**
4. **Single-flight executor:** one op at a time; overlapping requests collapse to a single "dirty" re-run after the current op. A pull and a pending push coalesce. Hashing/upload inside an op use a bounded concurrency pool (§6.0 #4).
5. **Apply-suppression done right [R#1-MAJOR]:** during `applyActions` set a flag so watcher events don't *immediately* trigger a push, but **do** set `dirtyAfterApply` and invalidate affected cache entries; after apply, refresh the cache from real disk state and run the incremental patch → if genuinely dirty, push. Suppression means "don't react instantly," never "forget."
6. **Jittered safety-net reconcile (two tiers, §6.3):** every `SAFETY_SYNC_MS` (60s ± jitter) a stat-only full `scanManifest` replaces the in-memory manifest from disk truth, then sync — recovers missed broadcasts and dropped watcher events. Every `DEEP_SCAN_MS` (~30 min, configurable) a cache-bypassing deep re-hash scan catches mtime+size-stable silent drift and rebuilds the cache. Both throttled + niced. **[R#1 retry-herd + R#perf-1/2]**
7. **Reconnect** with exponential backoff + jitter on WS drop; on every (re)connect, run one sync to catch up.
8. **Conflict-retry backoff [R#1 retry-herd]:** the existing push 409→pull→retry recurses immediately; add backoff+jitter between attempts so two hot daemons don't livelock.

### 6.6 Atomic local state **[R#1-MAJOR state-atomicity]**

`saveState`/`saveConfig`/hashcache writes → temp file in `.rbox/` + `rename` (atomic same-FS). `loadState` **distinguishes missing (→ empty base, expected on first run) from corrupt (→ hard error, refuse to silently reset to empty base** which would trigger a destructive reconcile). Temp files use a `.rbox/`-internal path or an ignored prefix so a crashed temp file is never scanned into a manifest. **[R#1-MINOR temp-beside-real]** Add the temp prefix to `BUILTIN_IGNORE` (apply.ts already writes temp beside target for cross-FS-safe rename; that prefix must be ignore-listed too).

### 6.7 Process management

- `rbox daemon start` → spawn detached `bun … __daemon-run <root>`; write `.rbox/daemon.pid` + log to `.rbox/daemon.log`. **PID handling [R#1-MINOR]:** before refusing/with `stop`, verify the PID is alive *and* is actually our daemon (cmdline contains the rbox daemon marker) to survive PID reuse; clean stale pidfiles.
- `stop` (graceful: close WS, finish in-flight op, SIGTERM), `status` (PID + seq + WS state + last sync), `logs [-f]`.
- `__daemon-run` hidden. systemd/launchd install noted, not built.

---

## 7. Files touched

| File | Change |
|---|---|
| `apps/api/src/workspace-sync.ts` | **new** DO: atomic commit, lazy D1 bootstrap, hibernating WS fanout |
| `apps/api/src/worker.ts` | route commit/latest/connect → DO; blob-existence check helper |
| `apps/api/wrangler.jsonc` | DO binding + migration |
| `src/engine/manifest-validate.ts` | **new** safe-path/manifest validation (shared) |
| `src/engine/hashcache.ts` | **new** persistent mtime+size→sha cache (atomic writes) |
| `src/engine/manifest.ts` | `scanManifest` accepts cache |
| `src/engine/apply.ts` | precondition-checked apply; ignored temp prefix |
| `src/engine/ignore.ts` | add temp-file prefix to builtin ignore |
| `src/cli/sync.ts` | no-op push short-circuit; conflict-retry backoff; `pullOnce`/`syncOnce` |
| `src/cli/config.ts` | atomic state writes; missing-vs-corrupt distinction |
| `src/cli/watcher.ts` | **new** chokidar wrapper (swappable backend) |
| `src/cli/daemon.ts` | **new** WS client, single-flight, suppression, safety-net |
| `src/cli/remote.ts` | `connectWebSocket()` (Authorization header) |
| `src/cli/index.ts` | `daemon start/stop/status/logs` + hidden `__daemon-run` |
| `package.json` | `chokidar` (already added) |

---

## 8. Verification plan

**Engine unit tests:** hashcache reuse/invalidation; no-op push issues zero commit; apply precondition converts a mid-window edit to a conflict instead of clobbering; manifest validation rejects `..`/absolute/NUL/case-dupes; atomic state load distinguishes missing vs corrupt.

**Local integration:** two dirs → one workspace against live dev Worker; both daemons; edit in A → appears in B in seconds; edit in B → propagates to A; **assert sequence stabilizes after edits stop (no echo storm)**; kill+restart a daemon mid-edit → no lost bytes.

**Remote (the real test):** deploy DO to `rbox-dev-api`. A=Mac `~/rbox-lab`, B=prod `flat-meadow-prod-main-01:~/rbox-lab` (bun at `/home/via/.bun/bin/bun`). Bidirectional passive sync; simulate WS drop → reconnect-sync recovers; concurrent edits on both sides → conflict copies, zero data loss; sequence stabilizes. **Prove WS auth against the deployed DO with the exact handshake.** Tear down `~/rbox-lab` after.

---

## 9. Resolved issues — checklist (reviews #1 and #2)

Review #1 (all resolved): BLOCKER-4 path traversal → §5; MAJOR no-op push → §6.1; suppression-drops → §6.5/§6.3; ws auth → §3.4; hibernation → §3.5; chokidar/symlink → §6.4; retry-herd → §2/§6.5; state atomicity → §6.6; hashcache masking → §6.3.

Review #2 (the partials/new, resolved here):
- [x] R#2-BLOCKER DO sync API named → §3.1 (`transactionSync` for commit, single atomic write of head+seq; `blockConcurrencyWhile` only for async bootstrap; no conflation)
- [x] R#2-BLOCKER bootstrap race → §3.2 (run once in the **constructor** under `blockConcurrencyWhile`; requests gated until import resolves)
- [x] R#2-BLOCKER apply TOCTOU + overclaim → §6.2 (stage-temp → re-check → backup-current-then-swap; honest guarantee + documented sub-instruction residual; goal line softened)
- [x] R#2-MAJOR 409 vs 422 → §3.1 (`unsatisfied_blobs` is **422**; `remote.ts` branches on status — `commit()` returns a discriminated result)
- [x] R#2-MAJOR phantom `dir` type → §5 (type ∈ {file, symlink} only; empty dirs not synced in M1, documented)
- [x] R#2-MAJOR bootstrap overclaim → §3.2 (head-only is sufficient for M1; no claim of old-sequence recovery; M6 owns retention)

## 10. Implementation order (once review #3 confirms)

1. Engine, no network: `manifest-validate.ts`, `hashcache.ts`, `scanManifest(cache)`, precondition-/backup-apply, ignore temp-prefix, atomic `config.ts` state. Unit-tested in isolation.
2. `sync.ts`: no-op-push short-circuit, 422 handling, conflict-retry backoff, `pullOnce`/`syncOnce`.
3. Control plane: `workspace-sync.ts` DO (constructor bootstrap, `transactionSync` commit, blob-existence 422, hibernating fanout), worker routing, wrangler DO binding+migration. Deploy to `rbox-dev-api`; prove WS auth + atomic commit live.
4. Client daemon: `watcher.ts`, `connectWebSocket()`, `daemon.ts` (single-flight, suppression, jittered safety-net, reconnect), CLI `daemon` subcommands.
5. Verify locally (two dirs), then remote (Mac ↔ prod host).
