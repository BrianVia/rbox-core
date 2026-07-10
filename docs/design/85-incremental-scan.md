# 85 - Scan at O(change): dir-mtime-pruned walk + CLI daemon delegation

Status: Design draft v3. v1 (manifest-handoff sidecar) died under adversarial
review (§3.4). v2 (delegation over a private socket protocol) was re-reviewed
2026-07-10 against `main` with designs 91-96 landed and REVISED: design 93's
workspace sync mutex is now the ownership/failure boundary Layer B must be
built around, Layer A needed an explicitly unpruned deep-scan mode to keep its
own backstop honest, and phase-0 was not runnable as written. This draft fixes
all of that. Client-only. Pending the phase-0 measurements in §5 before Layer
A is built; two prerequisite correctness ships (§3.0) precede everything.
Origin: post-v0.9.10 profiling. Design 82 killed the O(N²) encrypt-cache path
and left `scan` as one of the two dominant terms of a steady-state cycle
(scan 6.0-15.0s; the larger term, git-plan 25.5s, is design 83's). Design 82
§7 non-goal #1 parked exactly this work.
Related: design 83 (git-plan cost — owns the `.git` lane and the racy-clean
fingerprint discipline this design reuses), design 93 (workspace sync mutex —
the top-level ownership model Layer B rides), design 92 (manifest entry
integrity — why a torn scan tuple is unrepairable downstream), design 72
(ignore semantics — untouched), design 49 (safety-scan cadence — made cheaper
here), the existing `HashCache`, and `applyWatchEvents` (the daemon's
already-incremental hot path).

All numbers were measured on 2026-07-08 on the founder's real workspace
(`~/Development`, 116,881 tracked files / 98 git repos, Mac WiFi) unless marked
inferred, and are stale-by-default: §5 re-measures on current `main` before
any gate is evaluated. This design continues the designs 79-82 method:
measure, falsify, then redesign — including falsifying its own first two
drafts (§3.4, and the v2→v3 delta recorded in REVIEW-85.md).

## 1. Problem and evidence

Measured means observed directly on the named workload; inferred follows from
those measurements but still needs the phase-0 gate in §5.

1. **Full scans run per operation-PATH, not per entry point — count them that
   way, measured in code.** The correct baseline is scans per operation
   including recovery legs, because phase-0 samples and delegation savings
   otherwise compare unlike cycles:
   - CLI `push`: 1 scan (`src/cli/sync.ts:393`), +1 per 409/epoch retry
     (`rescanForRetry`, `sync.ts:201-210` via the recovery loop at
     `sync.ts:489-503`), +1 inside each recovery `pull` (`sync.ts:491` →
     `pull`'s own scan at `sync.ts:236`). A contested push pays 3 scans per
     recovery round.
   - CLI `pull`: 1 scan (`sync.ts:236`). CLI `sync`: pull leg + push leg = 2
     minimum.
   - Daemon direct sites (5): startup convergence (`src/cli/daemon.ts:247`),
     ignore-rule-event rebuild (`daemon.ts:688-691`), post-pull refresh
     (`daemon.ts:794`), safety `doFullScan` (`daemon.ts:1140`), `doDeepScan`
     (`daemon.ts:1148`). Nested on top: the daemon's `doPull` calls shared
     `pull()` (scan at `sync.ts:236`) and then rescans at `daemon.ts:794` —
     a daemon pull is 2 full scans today; a daemon push that hits 409
     recovery pays the same CLI recovery legs.
   At 6.0-15.0s per scan (RBOX_METRICS=1, v0.9.10; variance tracks page-cache
   state, cold ≈ 15s, warm ≈ 6s) this multiplies into the dominant
   client-side cost after design 83 takes git-plan.
2. **The walk itself dominates warm, not hashing, measured.** A recursive
   `readdir`-only walk of `~/Development` (2026-07-08, warm page cache, coarse
   6-dir prune so it over-counts the tree at 42,539 dirs / 154,911 files vs
   rbox's pruned 116,881): **2.26s**. Adding one `stat()` per file: **+0.99s**,
   total **3.26s**. Hashing contributes ~0 warm because `HashCache` already
   skips re-hash on fingerprint hits. So of the scan's wall: `readdir` is the
   floor, `stat` a real secondary, and the residual from ~3.3s to rbox's
   6-15s is ignore-matcher CPU per entry + `FileEntry` allocation + path
   construction + readlink + the final 116k-entry sort + cold-cache
   inflation. The decomposition instrumentation SHIPPED since v2
   (`ScanStats`, `src/engine/manifest.ts:32-56`; wired through
   `recordDetails` at `sync.ts:96-97,207,240,398`; gated by `RBOX_METRICS`,
   `src/cli/metrics.ts:20-28`) — §5 P0.1 is now a collection-and-validation
   protocol, not an instrumentation build.
3. **The daemon already scans at O(change) on its hot path, measured in code.**
   `applyWatchEvents` (`src/engine/manifest.ts:101-199`) patches the
   in-memory manifest from a settled watcher batch — re-hash one changed
   path, drop an unlink, rescan only an added subtree. The daemon holds
   authoritative incremental truth continuously; the full walks above are its
   safety floor.
4. **The CLI has no incremental option at all, measured in code.** The CLI
   one-shots scan unconditionally even while a healthy daemon holds a fresher
   manifest in memory. Notably `pushManifest` (`sync.ts:456`) already accepts
   a precomputed manifest — the daemon uses that today; the CLI wrapper is
   the only caller that must walk first.
5. **The persisted fingerprints already exist, measured.** `state.json` is
   47MB (`lastSyncedManifest`, 116,928 entries); `hashcache.json` is 22MB
   (`(path)->(mtime,size,sha)`, `src/engine/hashcache.ts:17-21`). Layer A
   needs one new small table (per-dir listings), not new per-file truth.
6. **Design 93 changed the concurrency ground rules, measured in code.** One
   workspace-wide interprocess mutex (`.rbox/state/sync.lock`) is held for
   the full decision→mutation→state-save interval by every top-level
   state-mutating entry point (`docs/design/93-git-config-sync.md:163-206`):
   CLI `push`/`pull`/`sync` take it before doing anything
   (`src/cli/main-dispatch.ts:231,258`; `src/cli/sync-cmd.ts:58`), and every
   daemon pump iteration acquires it per-op, re-queuing on contention rather
   than consuming the wakeup (`daemon.ts:425-431`, `sync-mutex.ts:92`). A
   CLI owner gets 16×50ms of retries then fails loudly ("another sync is in
   progress", `sync-mutex.ts:75-76,95`). Any Layer B protocol that lets a
   CLI hold the mutex while asking the daemon to work, or that "falls back"
   into a concurrent push while a live daemon owns the lock, is dead on
   arrival — §3.2 is redesigned around this.

## 2. Root cause — and the falsification that shapes the design

The naive hope is "persist a stat-fingerprint cache and the scan skips
unchanged files." **That hope is false for the walk.** The filesystem fact:

> A content edit that preserves a file's size bumps the FILE's mtime but NOT
> its parent DIRECTORY's mtime. Directory mtime changes only on entry
> add/remove/rename.

Two consequences:

1. A stat-fingerprint cache cannot reduce the `stat()` count of a
   correctness-preserving full scan — you must stat a file to learn it is
   unchanged. The cache only skips the *hash* after the stat, which `HashCache`
   already does and which §1.2 shows is ~0 warm.
2. Directory-mtime pruning CAN skip the `readdir` of a structurally-unchanged
   directory, but must still stat every child for in-place edits. It reclaims
   only the readdir share — whatever §5 P0.2 measures it to be TODAY, weighted
   by which directories are actually eligible (the v2 draft's
   `fraction × aggregate readdir time` estimator was unsound: directory costs
   are highly skewed, so the gate is on summed per-directory milliseconds).

Corollary: **true O(change) requires already knowing which paths changed — the
watcher feed.** And review round 1 (§3.4) established that watcher-derived
truth cannot be safely *exported* across a process boundary: completeness of a
manifest is provable only inside the process that owns the watcher, the
pending-event queue, and the safety/deep-scan backstops. So the O(change) layer
is not a cache and not a handoff — it is **delegation**: let the process that
owns the truth run the cycle, under the mutex ownership model design 93
already gives that process.

## 3. Design

### Invariant (stated first, design-82 style — honestly bounded)

> **A change is never LOST, and never deferred past the next unpruned deep
> scan.** Every fast path is conservative by construction: it may do EXTRA
> work — re-stat, re-readdir, re-hash, full-scan — but its worst legitimate
> failure is BOUNDED STALENESS healed by the periodic unpruned, cache- and
> dircache-bypassing deep scan. Concretely: (a) the manifest that backs any
> push is produced inside a single process that either walked the tree this
> run (CLI) or owns a live watcher WITH its safety/deep-scan reconciliation
> loop (daemon) — a manifest never crosses a process boundary as trusted
> truth; (b) a cached directory listing is reused only when the dir's current
> `(mtimeMs, ctimeMs)` both equal the cached values AND both are strictly
> older than the previous scan's start minus a racy-clean margin AND the
> ignore-rule fingerprint is unchanged; (c) a cached content sha is reused
> only on a full `(mtime, size, ctime)` fingerprint match. On ANY doubt —
> fingerprint mismatch, rule change, delegation failure, daemon death — fall
> back to the slow correct path.
>
> Scope honesty (review R1 F9): under ORDINARY POSIX semantics (APFS/ext4:
> entry add/remove/rename bumps parent dir mtime and ctime) plus the
> racy-clean margin, a pruned walk misses nothing. An ADVERSARY that mutates
> a directory and then restores its timestamps (`utimes` restores mtime; no
> userspace call restores ctime, but clock manipulation plus collision could
> in principle align both) is outside the fast path's proof and is healed by
> the next unpruned deep scan (≤30m, `DEEP_SCAN_MS`). The deep scan is not
> "insurance" — it is part of the invariant.

### 3.0 Prerequisite ships (standalone, before Layer A and before phase-0's drift measurement)

Both were "fix-in-passing"/"resolved prose" in v2; review R1 (F6, F10)
correctly promoted them to independent, individually-tested correctness ships.
Neither depends on Layer A's phase-0 fate.

**P-1: torn full-scan tuple guard.** The incremental path's `statHashEntry`
does stat→hash→stat-again and refuses to bake a mixed tuple
(`manifest.ts:210-233`, midwrite at `:230`). The full scan does not: `walk`
stats once (`manifest.ts:306-317`), defers the hash (`:322-325`), and
`drainHashes` records the PRE-hash size/mode/mtime with no second stat
(`manifest.ts:351-362`) — a file appended/replaced/chmodded between stat and
hash is baked with sha-of-new-bytes + metadata-of-old. Design 92 makes this
unrepairable downstream: manifest-entry integrity verification propagates a
poisoned tuple, it cannot heal it. Fix: `drainHashes` re-lstats after
hashing; on mtime/size shift, drop the entry and surface the path via the
existing deferred mechanism (same contract as `midwrite`). Test gate: an
append, an atomic replace, and a chmod injected between a scan's stat and its
deferred hash must each yield a deferred path, never a mixed tuple. Ships
first; it is also a prerequisite for P0.3's drift attribution (§5) — without
it, deep-scan diffs cannot distinguish watcher drops from scan tears.

**P-2: HashCache v2 — `(mtime, size, ctime)` fingerprint with format
versioning.** This is a TODAY-bug fix for the CLI, not Layer A support: the
current `(mtime,size)` cache (`hashcache.ts:33-38`) documents its safety as
"the watcher invalidates a changed path's entry" (`hashcache.ts:10-15`) — but
foreground CLI scans have no watcher, so a same-size write followed by mtime
restoration (`touch -r`) reuses a stale sha on the very next CLI push.
Content writes bump ctime and userspace cannot restore it on macOS/Linux →
fingerprint miss → re-hash. Changes, enumerated:
- `HashCacheEntry` gains `ctimeMs`; `lookup(relPath, mtimeMs, size, ctimeMs)`
  and callers (`manifest.ts:224,318`) pass `st.ctimeMs`; `PendingHash`
  carries `ctimeMs` so `drainHashes`' record (`manifest.ts:357`) writes the
  full tuple (P-1's re-lstat supplies the post-hash values).
- **Format versioning:** the current on-disk JSON is a bare
  path→entry map with no header (`hashcache.ts:67-78`). New format:
  `{ version: 2, entries: {...} }`. Loader: a parsed object with
  `version === 2` loads `entries`; anything else (including every legacy
  bare-map file) is discarded wholesale — safe-to-discard by contract
  (`hashcache.ts:14`), one-time full re-hash per workspace. No migration
  code: migrating `(mtime,size)` entries would mint unverified ctimes.
- Ordering: ships and soaks (one fleet release observing hit-rates via the
  shipped `filesSkippedCacheHit` stat) before Layer A reuses the same
  fingerprint discipline. Cost of the extra strictness: a chmod/xattr touch
  re-hashes one file.

### 3.1 Layer A — directory-mtime-pruned walk (bounded, page-cache-fragile)

Persist a per-directory listing table alongside `HashCache`
(`.rbox/state/dircache.json` — safe-to-discard, versioned like HashCache v2:
corruption, absence, or version mismatch only costs a full readdir walk):

```
header:  { version, ruleFingerprint, lastScanStartMs }
entries: dirRelPath -> { mtimeMs, ctimeMs, children: [{name, type: file|dir|symlink}] }
```

`scanManifest` gains an explicit dircache parameter with two modes — the mode
is chosen by the CALL SITE, never defaulted inside the engine:

- **`pruned`** (CLI scans; daemon startup/ignore-rebuild/post-pull/safety
  sites): before `readdir(dir)`, **reuse** the cached child listing (names +
  types) iff the dir's current lstat `(mtimeMs, ctimeMs)` equal the cached
  pair **and** both are strictly older than `lastScanStartMs -
  RACY_MARGIN_MS (2s)`. The margin closes timestamp-granularity races (a
  change landing in the same mtime tick as the scan that cached it) — the
  same racy-clean discipline design 83 uses for its git stat-fingerprints;
  keep the two consistent. ctime in the pair (new in v3, R1 F9): `utimes`
  can restore a directory's mtime after an add/remove/rename, but restoring
  it bumps ctime — so mtime-restoration alone can no longer alias a cached
  listing. Still `stat` each child file (in-place edits, per §2) and still
  run the ignore matcher per child. **Miss** → `readdir` as today, rewrite
  the dir's entry stamped racy-or-clean.
- **`unpruned`** (deep scan; degraded-watcher recovery scans; the
  rules-changed path): the dircache is NEVER consulted. The walk readdirs
  everything and **rebuilds** the dircache from the observed truth (fresh
  header, fresh entries), exactly as `doDeepScan` already rebuilds the
  HashCache from a fresh instance (`daemon.ts:1147-1149`). The scan stats
  assert `dirsReusedFromCache === 0` in this mode. This closes review R1
  F2: v2 would have let the deep scan reuse the same stale listing it exists
  to catch — the backstop must not share the fast path's assumption.

Three review fixes are load-bearing here:

1. **Ignore-rule invalidation (v1 review BLOCKER).** Cached listings were
   pruned under the rules in force when cached — a rule change can un-ignore
   a subtree the cache never descended into. The daemon already full-rescans
   on any ignore-rule file event (`daemon.ts:688-691`) and after a pull that
   wrote rules (`daemon.ts:787-789`); Layer A must match: the table header
   carries a `ruleFingerprint` (path + size + mtime of every effective
   ignore-rule file, the `src/engine/ignore.ts:693` set); any mismatch drops
   the ENTIRE table and the walk runs unpruned (rebuilding it). Whole-table
   drop is deliberately simpler and safer than per-dir invalidation — rules
   have non-local effects (negations). Cached listings are stored UNFILTERED
   (raw readdir output) with the matcher applied on every reuse, so filtering
   can never be stale independently of the fingerprint.
2. **No childCount in the check (v1 review MAJOR — circular).** You cannot
   know the current childCount without paying the readdir the check exists to
   skip. The check is dir `(mtime,ctime)` + racy-clean margin only; the
   cached listing *supplies* names/types, it does not verify them.
3. **Watcher-degradation self-clear stays unpruned (R1 F8).** Current
   semantics, verified: a watcher backend error permanently sets
   `watcherHealthy = false`, bumps `watcherErrorGeneration`, and pins the
   safety cadence to its 60s floor for the daemon's lifetime
   (`daemon.ts:285-297,318-324,1400-1403`); a generation-stable full/deep
   scan clears only the user-visible `watcherDegraded` flag
   (`daemon.ts:881-885`, called at `:453,:457`) — it restores the status
   presentation, never watcher trust or cadence. Layer A must not weaken
   this: a PRUNED safety scan's coverage rests on dir-timestamp reasoning,
   which is not the "completed full-tree scan" the self-clear comment
   promises. Rule: after any watcher error, the visible flag may be cleared
   only by an **unpruned** scan (in practice the deep scan, or a fullScan the
   daemon explicitly runs unpruned when `watcherErrorGeneration` advanced
   since the dircache was last rebuilt). Pruned safety scans still HEAL
   (child stats catch edits; changed dirs readdir normally) — they just
   don't testify. Delegation (§3.2) is gated on daemon liveness only, never
   on `watcherDegraded`: a degraded daemon's delegated push is exactly as
   trustworthy as that daemon's own next push, which is the bar (§3.3.5).

Layer A reclaims the readdir share on eligible directories — gated on P0.2's
weighted measurement, not the v0.9.10 2.3s estimate. It does NOT reach
O(change): the per-file stat floor and matcher CPU remain. It ships ONLY if
phase-0 justifies the table (§5 gates). Write churn is bounded: the table
saves like hashcache (atomic, post-scan, only when dirty); projected size is a
P0.2 output and a §7 gate input.

### 3.2 Layer B — daemon delegation (the O(change) win), rebuilt on the design-93 mutex

When a healthy daemon exists, `rbox push` / `rbox pull` / `rbox sync` do not
scan and do not take the workspace mutex: they ask the daemon to run the
cycle NOW and stream the result back. The manifest never crosses a process
boundary — the daemon's manifest is consumed where it is produced, inside the
process that owns the watcher, the pending-event queue
(`applyPendingWatchEvents`, `daemon.ts:680-699`), the mid-write retry loop,
the safety scan, and the deep-scan backstop.

**Mutex ownership (R1 F1 — the load-bearing change).** For a delegated
operation, the DAEMON's pump iteration is the sole top-level workspace-mutex
owner, exactly as design 93 already enumerates it
(`docs/design/93-git-config-sync.md:163-206`; acquisition at
`daemon.ts:425-431`). The CLI on the delegated path acquires NOTHING: it
selects delegation BEFORE any mutex acquisition, based only on flags/config
eligibility (below), `isDaemonRunning`, and a successful socket hello+ack.
The local path (`withWorkspaceSyncMutex` → scan → push, today's
`main-dispatch.ts:231`) is chosen up front for any ineligible invocation —
never as a mid-operation "approximation." This dissolves the v2 protocol's
fatal shape: a CLI that held its own lock could never be serviced by a daemon
whose pump re-queues on contention (`sync-mutex.ts:92`,
`daemon.ts:426-431`) — the two would starve by design.

**Discovery and liveness.** Reuse `isDaemonRunning`
(`src/cli/daemon-control.ts:216-219`), which verifies the pidfile's pid is
alive AND is our daemon for this root via ps-command match — never
bootId/pidfile match alone (bootId can come from env, `daemon.ts:213`; it is
an ownership token, not a liveness proof).

**Transport: unix domain socket**, listener owned by the daemon, created
after the startup binding and removed on graceful stop. Decided, not open —
the file-based alternative (request file + response file, daemon polls) loses
on every axis that matters: (a) ack latency — the daemon's pump is
event-driven; a request file needs a sub-second poll loop (idle churn design
49 spent a release removing), and `.rbox` is hard-pruned from the daemon's
own watcher (`ignore.ts:150`) so no event would announce the file; (b)
progress streaming; (c) death detection — a socket close IS the
daemon-died-mid-cycle signal. Surface: one localhost socket at
`$TMPDIR/rbox-<sha256(root)[0:16]>.sock` (deterministic per root; `sun_path`
is ~104 bytes on macOS, so no length risk), mode 0600 inside a 0700
per-uid directory, path recorded beside the pidfile. **Peer authentication
(R1 F12):** "same uid" is enforced, not assumed — the daemon checks peer
credentials on accept (`SO_PEERCRED` on Linux, `getpeereid`/`LOCAL_PEERCRED`
on macOS) and drops any connection whose euid differs from its own; the 0700
directory + 0600 socket are defense-in-depth, not the mechanism. **Stale
socket rules:** on startup the daemon connects to any existing socket path;
if the connect succeeds and helloes as a live rbox daemon for this root, the
new daemon defers to the pidfile arbitration (existing stale-daemon logic);
otherwise it unlinks the path and binds fresh. The CLI treats
ENOENT/ECONNREFUSED as "no daemon" → local path.

**Protocol** (newline-delimited JSON, versioned hello):

```
CLI → daemon:  {v:1, op:"push"|"pull"|"sync", root, metrics:bool}
daemon → CLI:  {ack: {opId}} | {reject: {reason}}            — within 2s
CLI → daemon:  {cancel: {opId}}                              — optional, any time
daemon → CLI:  {progress: {phase, done, total, bytes?}}      — streamed, ≥1/10s
               {log: line}                                   — verbatim, --verbose fodder
               {cancelled: {opId}}                           — terminal (pre-bind cancel)
               {result: {opId, ok, committed, sequence,
                         files, deferred, error?,
                         phaseReport?}}                      — terminal
```

`reject` reasons are enumerated: `version` (protocol mismatch), `root`
(hello root ≠ daemon root), `pull-only` (daemon started pull-only suppresses
pushes, `daemon.ts:383-385` — a delegated `push`/`sync` is rejected, a
delegated `pull` is fine), `unsupported` (future op). Any reject → CLI local
path, chosen before any lock was taken.

**Request↔result correlation and coalescing (R1 F12).** The `want` booleans
(`daemon.ts:179,387-395`) coalesce by design and cannot prove which request
owns which terminal result — so delegated requests get their own bookkeeping
on top: the daemon keeps `delegated: Map<opId, {needs: ("pull"|"push")[],
socket}>` (`push`→`["push"]`, `pull`→`["pull"]`, `sync`→`["pull","push"]`)
and sets the corresponding `want` flags. When the pump STARTS an op it binds
every delegated entry whose head-of-`needs` matches that op kind to the
running iteration; on op success it pops that leg (an entry with empty
`needs` gets its `result` built from that iteration's outcome); on op failure
every bound entry gets an error `result`. Two clients requesting push
coalesce into one push iteration and each receives the same terminal result
under its own opId — semantics: "a push cycle covering your request
completed," which is exactly what the coalescing pump means today. A
delegated op jumps no queue: the single-flight pump (`daemon.ts:419+`)
serializes it against watcher batches and safety ticks — no new concurrency
inside the daemon. Before a bound push the daemon drains pending watcher
events as it always does (`doPush` → `applyPendingWatchEvents`,
`daemon.ts:571`), and a delegated push inherits every standing discipline
unmodified — including design 95's GC-fence deferrals (`deferManifest` input
at `daemon.ts:576-578`) and design 44/50's consent gates (see flags, below).

**The delegation state machine (R1 F1 — replaces v2's "fail open" prose).**
The CLI's states and every exit:

```
ELIGIBLE ──connect+hello──▶ AWAITING-ACK ──ack──▶ DELEGATED ──result──▶ DONE (exit per result)
   │                            │                     │
   │ ineligible flags/config    │ reject / 2s timeout │──cancel──▶ CANCEL-SENT
   ▼                            │ connect error       │                │ {cancelled} → LOCAL
LOCAL (withWorkspaceSyncMutex,  ▼                     │                │ {result}    → DONE
 today's path, unchanged)     LOCAL                   │                ▼ silence 30s → INDETERMINATE
                                                      │ socket close w/o result:
                                                      │   isDaemonRunning=false ──▶ LOCAL  (proven death;
                                                      │                              mutex reclaimable per §7
                                                      │                              dead-pid liveness, design 93)
                                                      │   isDaemonRunning=true ───▶ INDETERMINATE
                                                      │ progress silence > 30s ───▶ send cancel → CANCEL-SENT
```

- **Pre-ack failures are free:** no request was accepted, nothing is in
  flight; the CLI selects LOCAL and proceeds exactly as today (its own mutex
  acquisition, 16×50ms, loud failure on contention — `sync-mutex.ts:75-95`).
- **Post-ack, the CLI gets exactly one of four terminals:** (1) a `result`
  frame; (2) a cancellation acknowledgement — `cancel` for an opId not yet
  BOUND to a running pump iteration removes it immediately and answers
  `{cancelled}` (the daemon deflates the corresponding `want` flag only if no
  other requester needs it); a cancel for a BOUND opId is answered by the
  op's eventual `result` (the daemon never aborts a mutation mid-flight —
  same principle as its SIGTERM drain, `daemon.ts:369-374`); (3) **proven
  daemon death** — socket closed without a terminal AND `isDaemonRunning`
  false: the daemon process is gone, so its mutex is dead-pid-reclaimable
  (design 93 §7 liveness) and the CLI falls back to LOCAL safely; (4)
  **explicit INDETERMINATE** — socket closed without a terminal but the
  daemon process is still alive (stuck, or the CLI was disconnected): the
  CLI makes ONE ordinary mutex acquisition attempt (the standard 16×50ms);
  if it acquires, the daemon has no op in flight and LOCAL is safe; if
  contended, it exits nonzero with a distinct code and message
  ("delegated push state unknown — daemon pid N still running; see `rbox
  status` / `rbox logs`, or retry") rather than racing a live owner. A
  client disconnect is treated by the daemon as an implicit cancel with
  identical semantics (bound ops run to completion; outcomes land in the
  daemon log regardless of who is listening).
- **Heartbeat:** from ack onward the daemon emits progress or a keepalive at
  least every 10s — including while its pump op is QUEUED behind mutex
  contention (`{progress:{phase:"queued"}}`) — so 30s of silence is a
  genuine failure signal, not a long cycle. On silence the CLI sends
  `cancel` and follows the cancel arm; it never silently starts local work
  while delegated work may be running.

Why this is safe where v2 was not: v2 claimed fallback safety from
server-side sequence-CAS + 409 recovery — true but irrelevant once the
workspace mutex exists, because the mutex's job (design 93) is to make the
local decision→mutation→state-save interval exclusive, and a blind CLI
fallback would violate exactly that. In v3 concurrent local mutation is
prevented by construction (the mutex), and the CAS/409 discipline remains
what it always was: remote-side defense-in-depth between MACHINES, not the
delegation protocol's safety argument.

**Eligibility — the enumerated delegation surface (R1 F12).** Delegated iff
ALL hold, decided before any lock: `RBOX_DELEGATE=1` (or config
`delegate: true`) during rollout; op is bare `rbox push`, `rbox pull`,
`rbox sync`, or `rbox sync --pull-only` (→ delegated `pull`); no
delegation-incompatible flag. Never delegated, always LOCAL: `--no-daemon`
(the standing escape hatch); `--allow-mass-delete` in both its pull and push
forms — consent is op-scoped and human-owned (design 44/50: "the daemon
never sets it", `sync.ts:149-157`), so a consented operation must run in the
human's own process; `rbox ignore --purge` and every other design-93 named
owner (recover, init/setup first-sync, reset/rebind) — those commands own
their mutex intervals for reasons delegation must not launder. `--json` and
`--verbose` delegate fine (rendered CLI-side from result/log frames).
`RBOX_METRICS` rides `metrics:true`. Anything not on the supported list
falls back to LOCAL rather than approximating — and the eligibility check is
a single pure function with a table test, so the list cannot drift silently.

**Progress fidelity (was open decision 9.2 — decided).** The daemon already
produces coarse `{phase, done, total, bytes}` transfer progress throttled to
~2Hz (`daemon.ts:1105-1136`); delegation streams exactly those frames plus
`log` lines. That is full spinner fidelity at negligible protocol surface;
per-file paths deliberately stay out of the frames (they remain in the
daemon log, which is already the forensic record).

**RBOX_METRICS.** With `metrics:true` the daemon's cycle builds the phase
report and the serialized report rides the `result` frame; the CLI prints it
in the standard format with scan details `{source: "daemon-delegated"}` plus
`delegation: {ackMs, queuedMs, totalMs}` so gate 1 (§7) is self-measuring.

### 3.3 Failure modes and how each fails safe

1. **mtime granularity** (two edits inside one mtime tick). File level:
   fingerprint includes size + ctime (P-2); deep scan re-hashes on cadence.
   Dir level: the racy-clean margin (§3.1) refuses to trust a listing whose
   timestamps are within 2s of the scan that cached it.
2. **mtime-preserving write** (`touch -r`, same size). ctime is in the
   HashCache fingerprint (P-2): content writes bump ctime and userspace
   cannot restore it on macOS/Linux → fingerprint miss → re-hash.
3. **directory-mtime restoration** (`utimes` on a dir after add/remove).
   ctime is in the dircache pair (§3.1): the restoration itself bumps ctime →
   miss → readdir. Residual (clock manipulation aligning both) is the
   invariant's bounded-staleness case — healed by the unpruned deep scan.
4. **clock skew / backward jump.** File fingerprints are equality-compared,
   never ordered, so future-dated mtimes cause no skip. The dir racy-margin
   comparison IS ordered — a detected backward jump (`lastScanStartMs` in the
   future) drops the dircache table.
5. **watcher overflow / stream death / native-prune blind spots.** Delegation
   inherits the daemon's existing answer wholesale: `onError` un-trusts the
   watcher and pins the safety cadence to its floor for the daemon's lifetime
   (`daemon.ts:285-297`, design 49), the safety scan heals dropped events and
   native-prune re-include gaps (`ignore.ts:179-184`), the unpruned deep scan
   heals everything else, and the visible degradation flag clears only per
   §3.1.3. A delegated push after a drop is no worse than the daemon's own
   next push after a drop — same process, same manifest, same healing loops.
   This is the structural advantage over the dead sidecar: the CLI never
   consumes watcher-derived truth directly, so it needs no coverage proof.
6. **daemon down / mid-cycle death / stale pidfile / stuck daemon.** The
   §3.2 state machine covers each explicitly: pre-ack → LOCAL; proven death →
   LOCAL (dead-pid mutex reclamation); alive-but-opaque → one polite mutex
   attempt, then explicit INDETERMINATE. No trusted daemon state survives its
   process.
7. **atomic-rename editors** (write tmp + rename). Unchanged from today on
   the incremental path (`statHashEntry` returns `midwrite` on torn reads);
   P-1 extends the same guard to the full-scan hash drain. The rename also
   bumps the parent dir's timestamps → dircache miss → readdir.
8. **case-insensitive APFS.** A case-only rename is a directory-entry rename →
   parent dir mtime+ctime bump → readdir re-runs and yields the on-disk
   casing; the old-cased manifest entry drops on the same walk. File
   fingerprints are keyed by exact-case relPath throughout. P0.4 probes this
   on real APFS rather than asserting it.
9. **concurrent CLI + daemon.** By construction now: the workspace mutex
   serializes every top-level owner (design 93); a delegated op has exactly
   one owner (the daemon); a LOCAL op has exactly one owner (the CLI); the
   state machine never creates a second concurrent owner. Gate 2 (§7) kills
   a daemon mid-delegation and asserts both the proven-death and the
   indeterminate arms.

### 3.4 Rejected alternative: the persisted-manifest sidecar (v1 Layer B)

Recorded because the reasoning is load-bearing (codex review 2026-07-08,
verdict REDESIGN; five blockers, all confirmed against source):

1. **Stat-verify cannot detect additions.** Verifying known entries catches
   modifications and deletions, but only a readdir walk or a watcher event
   ever *discovers* a path. A verified sidecar can be consistent and
   incomplete at once — the failure mode is silent.
2. **"Watcher healthy since boot" does not prove coverage.** The daemon scans
   and pumps BEFORE arming the watcher (`daemon.ts:247-254`); a mutation in
   that window is invisible until a safety scan.
3. **A persisted "settled" stamp races the reader.** Unsettle is in-memory
   (`daemon.ts:851-857`); the generation counter is an event-drain guard, not
   a persisted coverage watermark.
4. **Watcher-healthy ≠ manifest-complete by design.** The native watcher
   hard-prunes dirs and the ignore layer explicitly documents that some
   re-included paths heal via safety scan, not live events
   (`ignore.ts:146-150,179-184`).
5. **bootId is not liveness** (`daemon.ts:213` env override) — and even the
   proposed ≤0.5s stat-verify gate was unrealistic at 116k stats plus symlink
   readlinks.

Each hole is patchable in isolation; together they mean exporting
watcher-derived truth needs a completeness proof that keeps growing new
obligations. Delegation deletes the proof obligation instead of meeting it.
(The v2→v3 delta is the same lesson one level up: the delegation *protocol*
also had to inherit an existing ownership model — design 93's mutex — rather
than invent a parallel one out of CAS-retry folklore.)

## 4. Non-goals and the git boundary

1. **git-plan subprocess cost** (25.5s; design 83). **Boundary, explicit:** the
   scan owns the WORKING-TREE manifest and never descends into `.git` (pruned
   by the matcher); all per-repo git work runs in git-plan's own subprocesses
   with its own fingerprint cache. **Shared-walk note (future work, referenced
   by design 83, not in scope):** git-plan runs its own full-tree
   `discoverGitRepos` walk, and `scanManifest`'s `onGitRepo` callback
   (`manifest.ts:70,277-279`) was built to feed it but has ZERO consumers
   today — a dead parameter. With delegation putting scan and git-plan on the
   same daemon tick, one walk can eventually serve both discoveries.
2. **Commit envelope O(N) encoding** (design 82 §7 #2; design 84's lane).
3. **Cold join / first scan.** No cache, no daemon → full walk by definition.
4. **Ignore matcher semantics** (design 72). This design changes how often and
   how cheaply the walk runs, never what it includes.
5. **Daemon-side push internals.** Delegation invokes the existing pump ops
   unmodified; what a push does is other designs' turf (92/93/95 included).

## 5. Phase-0 — measure before building (falsification-first)

Layer B needs no phase-0 — its win is architectural (skip the scan AND the
47MB state parse on the CLI side entirely) and its risk is protocol, covered
by gates. Layer A does. R1 established that v2's P0 was not runnable: P0.1's
instrumentation had already shipped but measures less than claimed, and
P0.2/P0.3 named data no code collects. v3 splits phase-0 into what is
COLLECTABLE TODAY vs instrumentation that must be ADDED (all of it
measurement-only, behind `RBOX_METRICS`/soak flags, no behavior change):

- **P0.1 — collect and validate the shipped decomposition.** `ScanStats`
  exists (`manifest.ts:32-56`), CLI scans attach it
  (`sync.ts:172-175,205-207,235-240,392-398`), and the report plumbing is
  live (`phase-report.ts:167-172`, `metrics.ts:20-28`). Known limits,
  handled by protocol rather than code: (a) `sort+alloc` is NOT split —
  allocation, path construction, readlink, cache lookup, and loop overhead
  are an unlabelled residual, so report
  `residual = wall − (readdir+stat+matcher+hash+sort)` explicitly; (b)
  timing uses `Date.now()` around per-entry matcher/stat calls
  (`manifest.ts:281-317,341-348`, two matcher evaluations for some dirs) —
  quantized and potentially perturbing at 100k+ entries, so FIRST measure
  metrics-on vs metrics-off scan wall (5 pairs; if overhead > ~5% the
  per-entry numbers are directional only); (c) one `deps.scanStats`
  accumulates across recovery rescans (`sync.ts:133-135,172-175`), so the
  protocol uses DAEMON-STOPPED single local full scans only — one scan per
  details object. Samples: ≥5 warm + ≥3 genuinely cold (purged page cache
  where feasible) per host, APFS and ext4, recording wall,
  readdir/stat/matcher/hash/sort, residual, counts/cache-hit ratio,
  p50/p95/range. **GATE:** warm readdir share < ~1.5s → do NOT build
  Layer A. All later gates use these CURRENT numbers, not v0.9.10's.
- **P0.2 — dir-prune ceiling, weighted (instrumentation to ADD).** New
  measurement mode (env-gated) in the scan: per directory, record
  `(mtimeMs, ctimeMs, readdirMs, childCount)` keyed by a path hash, plus the
  scan's startMs, persisted to a soak sidecar. On each subsequent scan,
  classify every dir: ELIGIBLE (timestamps equal to prior record and
  racy-clean vs prior scan start) or not. Report per scan: eligible-dir
  count AND **the sum of observed readdir milliseconds over eligible dirs**
  (the reclaimable estimate — weighted, because directory costs are heavily
  skewed and `fraction × total` overstates), instrumentation overhead, and
  projected dircache bytes (children names+types serialized). Run quiescent
  consecutive-scan pairs AND mutation cohorts — in-place file edit, create,
  delete, same-dir rename, cross-dir rename, ignore-rule change — on both
  fleet filesystems. **GATE:** weighted reclaimable < ~2s warm on the Mac →
  Layer A is not worth the table. (The cohorts also validate eligibility
  flips where they must: every mutated dir must classify ineligible.)
- **P0.3 — watcher drop rate via deep-scan drift diff (instrumentation to
  ADD; P-1 is prerequisite).** Today `doDeepScan` overwrites `this.manifest`
  with no comparison (`daemon.ts:1145-1149`) — the drift it exists to heal
  is invisible. Add, inside `doDeepScan`: snapshot the pre-scan incremental
  manifest; build the fresh manifest (hash-cache-bypassing as today, and
  dircache-UNPRUNED per §3.1); diff on path/type/sha/size/mode/symlink
  target; classify added/deleted/modified. Exclude-or-separately-classify
  churn: any diff path that is in `pendingEvents`/`deferredRetryPaths`, or
  whose re-lstat during classification mismatches the fresh entry, counts as
  `racing`, never as a drop — otherwise live churn is mislabeled as watcher
  loss. Log one bounded non-PII line per deep scan: counts by class, watcher
  health + error generation, seconds since last safety scan, watcher events
  since, whether ignore rules changed. Report per host/filesystem over a 24h
  soak: deep scans, scans with nonzero drift, paths by class, max inferred
  drift age. Zero drops over the soak → evidence for design 49's cadence
  question (§9.3); nonzero → the number the safety cadence must answer to.
- **P0.4 — platform semantic probes (new; R1 F13).** A scripted probe (test
  rig, not fleet) on real APFS and ext4 recording Node-observed dir
  `mtimeMs`/`ctimeMs`/inode before/after: create, unlink, same-dir rename,
  cross-dir rename (both parents), atomic replace, rapid repeated ops inside
  one timestamp tick, `utimes` restoration (must flip ctime), and APFS
  case-only rename; plus relpath-keyed cache eviction for a moved/deleted
  subtree. Layer A's §3.1 reuse rule is implemented against these OBSERVED
  semantics; the §7 soak then validates end-state, it does not discover
  timestamp behavior by luck.

## 6. Instrumentation

Shared 83/84/85 convention: **recordDetails-only on existing phases — no
`PhaseName`/`PHASE_ORDER` changes** (`phase-report.ts:167-172`), so three
concurrent designs cannot collide in the closed union.

1. `scan` recordDetails (extends the SHIPPED ScanStats): adds
   `{ dirsReusedFromCache, midwriteDeferred, residualMs,
   dircache: "hit"|"cold"|"rules-dropped"|"unpruned" }` to the existing
   readdir/stat/matcher/hash/sort/counts — makes P0.1/P0.2 self-reporting in
   the field and catches any regression that silently turns a pruned scan
   back into a full walk (design 82 §8 lesson). The unpruned mode asserts
   `dirsReusedFromCache === 0`.
2. **Daemon scan sites emit (R1 F11).** `doFullScan`/`doDeepScan` currently
   call `scanManifest` with neither report nor stats (`daemon.ts:1138-1149`)
   — precisely the steady ticks P0.2/P0.3 concern. Each site creates its own
   `ScanStats` and logs one bounded line per scan (always for deep-scan
   drift, RBOX_METRICS-gated for per-phase timings). These scans do NOT
   share a phase report with the queued push that follows — the push begins
   its own `beginReport` as today (`daemon.ts:573`); one report = one op.
3. Delegated runs: the daemon's phase report rides the result frame; the CLI
   prints it with `scan` details `{source: "daemon-delegated"}` plus
   `delegation: {ackMs, queuedMs, totalMs}`.
4. Daemon log: one line per delegated op (opId, requester pid/uid, op,
   outcome, cancelled-or-completed), and the P0.3 drift line
   (`deep-scan drift: added=A deleted=D modified=M racing=R …`) so a nonzero
   drop is loud, not silent.

## 7. Acceptance gates

RBOX_METRICS, both fleet hosts. Fleet rule: only ONE design's A/B gate window
runs on the shared WAN at a time — 83/84/85 serialize their gate runs.

1. **Delegation overhead, not absolute wall.** Delegated `rbox push` on a warm
   no-change tree: CLI end-to-end wall ≤ daemon-reported cycle wall +
   queuedMs + **2s**, ack ≤ 2s. (Absolute wall is whatever the daemon's cycle
   costs — falling as design 83 lands; this gate must not inherit 83's
   number.) The CLI-visible result (sequence, counts) matches the daemon log
   line for the same opId.
2. **Failure-arm correctness (state machine, §3.2).** (a) Kill the daemon
   after ack, before result: CLI observes socket close, proves death,
   completes a LOCAL full-scan push (mutex reclaimed from the dead pid),
   exits 0; a final deep scan confirms no lost changes. (b) SIGSTOP the
   daemon mid-cycle: CLI hits the silence bound, cancels, cannot acquire the
   mutex, and exits with the distinct INDETERMINATE code without having
   mutated anything. (c) Concurrency-by-mutex: a `--no-daemon` CLI push and
   a delegated push issued together serialize — one waits/requeues, both
   complete, tree converges, no 409 storm required to make it true.
3. **Layer A warm full scan (if built per §5): ≤ 3s Mac / ≤ 6s Linux**, from
   6-15s; cold recorded alongside for the page-cache-fragility note. Applies
   to the daemon safety scan too (design 49 cadence cost ≤ 3s Mac). Dircache
   bytes on the founder workspace ≤ 25% of hashcache.json's size.
4. **Correctness soak: 500 daemon cycles with injected edge cases** —
   mtime-preserving same-size edit, `touch -r` restore (file AND directory),
   atomic-rename save, case-only rename on APFS, create+delete+recreate of
   one path, a multi-GB slow write mid-tick, an ignore-rule edit that
   un-ignores a populated subtree, and a burst designed to overflow the
   watcher queue — then a final unpruned deep scan. **ZERO** missed changes
   (drift line all-zero excluding `racing`). Any miss blocks release.
5. **Drift audit:** the §6.4 deep-scan drift line stays zero (excluding
   `racing`) across the soak.
6. **Parity:** full `bun test` green; `--no-daemon` output equivalent to a
   daemon-stopped run; a cross-host rename and delete apply correctly through
   a delegated push; delegated `--json` output schema-identical to local.

## 8. Rollout

Flag-gated, OFF by default in the first release; daemon-first:

1. **P-1 + P-2 ship first** (§3.0): torn-scan guard, HashCache v2 with format
   versioning. Independent correctness fixes; each with its own tests; P-2
   soaks one fleet release (hit-rate via `filesSkippedCacheHit`).
2. **Phase-0 instrumentation adds** (§5): P0.2 per-dir measurement mode,
   P0.3 deep-scan drift diff + log line, daemon-site ScanStats (§6.2). Zero
   behavior change. Collect P0.1 protocol runs + P0.4 probes; evaluate gates.
3. If P0 gates pass: **Layer A**, daemon full-scan sites first (the unpruned
   deep scan catches a Layer A bug within one 30m cycle), then the CLI path.
4. **Layer B delegation** behind `RBOX_DELEGATE=1` (or config): socket,
   protocol, state machine; soak per §7.2/§7.4 on both hosts.
5. Default ON only after a clean soak. `doDeepScan` stays unconditional and
   unpruned forever — it is the invariant's healer. `--no-daemon` stays
   forever — it is the user's.

## 9. Decisions

Resolved in v3 (previously open or implicit):

1. **Delegated `pull` ships in v1 of the protocol** (was open 9.1): pull pays
   the same full scan (`sync.ts:236`) plus the 47MB state parse, the daemon's
   `doPull` covers it, and a pull-only daemon accepts it — half the CLI
   surface for one more enum value. `rbox sync --pull-only` maps to it.
2. **Progress fidelity** (was open 9.2): stream the daemon's existing ~2Hz
   coarse `{phase, done, total, bytes}` frames + verbatim log lines; per-file
   paths stay in the daemon log (§3.2).
3. **Delegation eligibility surface** (R1 F12): enumerated in §3.2; consent
   flags and design-93 named owners never delegate; unknown flags → LOCAL.
4. **ctime joins BOTH fingerprints**: HashCache v2 (P-2) and the dircache
   pair (§3.1) — one racy-clean/equality discipline everywhere.
5. **Watcher self-clear requires an unpruned scan** once Layer A exists
   (§3.1.3); cadence/trust semantics unchanged from design 49.

Still the founder's calls:

1. **Safety-scan cadence after P0.3** — lengthen the idle backoff on
   zero-drift evidence, or keep 60s-5m and make it cheap via Layer A.
   (Leaning: keep cadence, make it cheap — frequency is the correctness
   margin.)
2. **Does Layer A ship at all** if P0.1/P0.2 come in under the gates?
   Delegation alone already removes scan from the daemon-present CLI path;
   Layer A then only serves the daemon's own ticks and daemonless CLI use.

## 10. Lessons (to fill after the gate runs)

Placeholder for the design-82-style retro. Two already earned: (v1) the
completeness of a scan is a property of a *process* (watcher + queues +
backstops), not of a *file* — any design that ships the file without the
process re-derives the proof obligations one blocker at a time. (v2) a
delegation protocol is not exempt from the same rule about *ownership*: when
the codebase already has an interprocess ownership model (design 93's
mutex), the protocol must be expressed in it — "both sides run and the
server sorts it out" was a completeness proof in disguise, and it died the
same way the sidecar did.
