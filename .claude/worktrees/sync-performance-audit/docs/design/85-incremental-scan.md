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
> the next unpruned scan within `DEEP_SCAN_MS` (30m) — and that bound holds
> on EVERY path, not only under a daemon (R3 F1): the daemon's deep scan is
> unpruned on that cadence, and ANY scan (including a daemonless /
> `--no-daemon` CLI one-shot) that finds the dircache's last unpruned
> rebuild older than the same bound runs unpruned itself and rebuilds
> (§3.1). The unpruned scan is not "insurance" — it is part of the
> invariant, on every path.

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
hashing and applies ONE exact stability predicate (R2 F1 — "mtime/size
shift" is not enough because a chmod changes mode and ctime but ordinarily
neither mtime nor size): pre- and post-hash lstat must agree on **file type,
`ino`, `dev`, `size`, `mtimeMs`, `ctimeMs`, and permission mode** (Node
exposes ino/dev on both shipped platforms; ino+dev catches atomic
replacement even under restored timestamps, ctime catches chmod/xattr/owner
changes, mode is asserted explicitly as belt-and-suspenders). On any
mismatch, drop the entry and surface the path via the existing deferred
mechanism; on a match, record the POST-hash stat's values. The predicate is
one shared, unit-tested function, and the incremental `statHashEntry` guard
— today mtime/size-only (`manifest.ts:230`) — is upgraded to call the same
function, so "same contract as midwrite" becomes true by construction
rather than by aspiration. Test gate: an append, an atomic replace (same
size, `touch -r`-restored timestamps), and a chmod injected between a
scan's stat and its deferred hash must each yield a deferred path, never a
mixed tuple. Ships first; it is also a prerequisite for P0.3's drift
attribution (§5) — without it, deep-scan diffs cannot distinguish watcher
drops from scan tears.

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
header:  { version, lastScanStartMs, lastUnprunedScanAtMs,
           ruleFiles: [{relPath, size, mtimeMs, ctimeMs} | {relPath, absent: true}] }
entries: dirRelPath -> { mtimeMs, ctimeMs, children: [{name, type: file|dir|symlink}] }
```

`scanManifest` gains an explicit dircache parameter with two modes — the mode
is chosen by the CALL SITE, never defaulted inside the engine, and a `pruned`
request self-demotes to `unpruned` when the header says the deadline or the
rules require it:

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
  rules-changed path; the deadline path below): the dircache is NEVER
  consulted. The walk readdirs everything and **rebuilds** the dircache from
  the observed truth (fresh header including `lastUnprunedScanAtMs = now`
  and a fresh rule-file inventory, fresh entries), exactly as `doDeepScan`
  already rebuilds the HashCache from a fresh instance
  (`daemon.ts:1147-1149`). The scan stats assert `dirsReusedFromCache === 0`
  in this mode. This closes review R1 F2: v2 would have let the deep scan
  reuse the same stale listing it exists to catch — the backstop must not
  share the fast path's assumption.

**The unpruned deadline is path-independent (R3 F1).** The invariant's
bounded-staleness promise previously leaned on the daemon-owned deep-scan
timer (`daemon.ts:270`) — but a workspace used only through one-shot CLI
commands has no daemon, so a timestamp-aliased listing could in principle
have been reused forever there. Rule: a `pruned` scan first checks
`now - lastUnprunedScanAtMs`; if it exceeds `DEEP_SCAN_MS` (30m — one
constant, shared with the daemon's deep cadence), the scan self-demotes to
`unpruned` and rebuilds. A `lastUnprunedScanAtMs` in the future (backward
wall-clock jump) drops the table, same as the existing `lastScanStartMs`
rule. Consequence stated honestly: daemonless CLI one-shots more than 30m
apart never prune — which is exactly today's cost, so Layer A's CLI value
concentrates where the pain is (retry legs and rapid sequences within an
operation window, and the daemon's 60s safety ticks). This keeps §9's
founder-call 2 honest rather than quietly inflating Layer A's CLI benefit.

Three review fixes are load-bearing here:

1. **Ignore-rule invalidation (v1 review BLOCKER; inventory + fingerprint
   fixed per R3 F2).** Cached listings were pruned under the rules in force
   when cached — a rule change can un-ignore a subtree the cache never
   descended into. The daemon already full-rescans on any ignore-rule file
   event (`daemon.ts:688-691`) and after a pull that wrote rules
   (`daemon.ts:787-789`); Layer A must match, and v3's first cut had two
   holes R3 caught. (a) **Fingerprint strength:** `(path,size,mtime)` is the
   exact tuple P-2 exists to reject — a same-size rule edit + `touch -r`
   would leave it unchanged. Rule files use the P-2-grade
   `(size, mtimeMs, ctimeMs)` tuple, recorded per file in the header's
   `ruleFiles` inventory (absence recorded explicitly so creation of a root
   file is a mismatch too). (b) **Inventory completeness:** the previously
   cited `effectiveIgnoreRules` (`ignore.ts:693`) reads only the ROOT
   `.gitignore`/`.rboxignore`, but the active matcher also lazily reads each
   git-repo base's nested `.gitignore` (`getGitLayer`,
   `ignore.ts:296-303`) and `isIgnoreRuleFile` recognizes nested rule files
   at any depth (`ignore.ts:228-229`). The inventory is therefore defined as
   OBSERVED, not enumerated a priori: every path matching `isIgnoreRuleFile`
   in the listings the walk consumed (fresh readdirs AND reused cached
   listings — children names are stored raw, so the set is derivable from
   the table itself), plus the two root files unconditionally. This is not
   circular: CREATING or DELETING a rule file bumps its parent dir's
   mtime+ctime → that dir misses → readdir observes it (adversarial
   timestamp restoration on the parent falls under the invariant's
   unpruned-deadline bound, §3.1 above); EDITING an inventoried file is
   caught by its per-file tuple, stat'd every scan (rule files are few —
   trivial cost). Any mismatch — tuple, appearance, disappearance — drops
   the ENTIRE table and the scan restarts unpruned (bounded: at most one
   restart per scan), rebuilding matcher-visible state and dircache from
   the same observed rule snapshot. Whole-table drop is deliberately
   simpler and safer than per-dir invalidation — rules have non-local
   effects (negations). Cached listings are stored UNFILTERED (raw readdir
   output) with the matcher applied on every reuse, so filtering can never
   be stale independently of the inventory.
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

**Degraded locking disables delegation (R2 F2).** The mutex deliberately has
an UNLOCKED degraded mode: when the lock primitive is unsupported on the
workspace filesystem, `acquireWorkspaceSyncMutex` returns an acquired-shaped
handle with no lock and everyone continues through the legacy state path
(`sync-mutex.ts:38-50,86-89`; `workspaceSyncMutexDegraded`,
`sync-mutex.ts:52`). On such a workspace the "exactly one owner" proof does
not exist for ANYONE, and — worse for the state machine — a post-ack CLI
mutex probe would "succeed" instantly with a degraded handle while the live
daemon is still mutating. Two rules close it, POSITIVELY (R4 F2 — "no
degradation observed yet" is not evidence the primitive works, because
degradation is only ever learned from an acquisition result,
`sync-mutex.ts:80-89`, and the daemon's first acquisition happens inside
the pump, `daemon.ts:425`):

- **Capability is established BEFORE the listener exists — read off the
  HANDLE, because the daemon API hides degradation inside `acquired` (R6
  F3).** `acquireWorkspaceSyncMutex(root, "daemon")` maps an unsupported
  lock primitive to `{status: "acquired", handle}` with a degraded handle
  (`sync-mutex.ts:85-89`) — there is no `unsupported` status at this
  boundary, so every capability statement is defined in terms of
  `workspaceSyncMutexDegraded(handle)`. The daemon's startup sequence
  already runs the initial-convergence pump before any delegation surface
  exists (`daemon.ts:247-252`); that pump's FIRST acquisition doubles as
  the probe: result `acquired` → `lockMode =
  workspaceSyncMutexDegraded(handle) ? degraded : exclusive`; result
  `contended` → exclusive (someone holds a REAL lock, so the primitive
  demonstrably works); `error` → the daemon fails loudly as today. The
  probe handle needs no separate lifecycle — it IS that pump iteration's
  ordinary op handle, released by the pump's existing `finally`
  (`daemon.ts:538-540`). The socket listener is created only after
  `lockMode` is recorded; a degraded daemon still starts the listener but
  answers every hello `reject: {reason: "lock-degraded"}` (a fast,
  explicit LOCAL signal instead of a connect timeout). No hello can be
  acked as exclusive from ignorance.
- **Later unexpected degradation is terminal for delegation — checked per
  acquisition, before mutation.** Every pump acquisition that will run an
  op with BOUND delegated entries re-checks
  `workspaceSyncMutexDegraded(handle)` on the handle it just received; if
  degraded (filesystem changed under a running daemon), `lockMode` flips
  to degraded and sticks BEFORE any mutation of the bound op: every bound
  entry receives an error `result` (`error: "lock-degraded"`), unbound
  entries are cancelled with `{cancelled}`, all further hellos are
  rejected, and the iteration proceeds (or not) as an ordinary AMBIENT op
  exactly as the degraded legacy path behaves today. The CLI treats that
  error result as a normal terminal — it may then choose LOCAL, which is
  exactly the exposure a degraded workspace has today.

Post-ack, every CLI fallback arm that reasons from a mutex acquisition must
check `workspaceSyncMutexDegraded` on the handle it got: a degraded
acquisition proves nothing and is treated as CONTENDED (→ INDETERMINATE),
never as "no daemon op in flight." The proven-death arm is unaffected — it
reasons from process liveness, not the lock.

**Discovery and liveness.** Reuse `isDaemonRunning`
(`src/cli/daemon-control.ts:216-219`), which verifies the pidfile's pid is
alive AND is our daemon for this root via ps-command match — never
bootId/pidfile match alone (bootId can come from env, `daemon.ts:213`; it is
an ownership token, not a liveness proof).

**Transport: unix domain socket**, listener owned by the daemon, created
only after the initial-convergence pump has recorded `lockMode` (the
positive lock probe above) and removed on graceful stop. Decided, not open —
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
(R1 F12, mechanism made runnable per R2 F4):** "same uid" is enforced by a
filesystem-permission capability, not by socket peer credentials — Bun's
`net` surface exposes no `SO_PEERCRED`/`getpeereid`, and the only FFI seam
in the tree is the narrow io-priority shim, so specifying peercred would
force an implementer to improvise security-critical native code. Instead:
at socket creation the daemon writes a fresh random 32-byte token to
`.rbox/state/delegation-token` with mode 0600 (regenerated each daemon
start, unlinked on graceful stop); the CLI reads it and presents it in the
hello; a hello with a missing/mismatched token is rejected
(`reject: {reason: "auth"}`) and logged with the peer's pid if provided.
Only a process running as the owning uid (or root, who owns the machine
anyway) can read a 0600 file, so token possession IS the same-uid proof —
same trust primitive as the existing pidfile/state files. The 0700 socket
directory and 0600 socket are defense-in-depth. `SO_PEERCRED`/
`LOCAL_PEERCRED` via a reviewed FFI shim is noted as optional future
hardening, not a v1 dependency. Tests: token mismatch → reject; token
rotation on daemon restart → stale client rejected. **Stale
socket rules:** on startup the daemon connects to any existing socket path;
if the connect succeeds and helloes as a live rbox daemon for this root, the
new daemon defers to the pidfile arbitration (existing stale-daemon logic);
otherwise it unlinks the path and binds fresh. The CLI treats
ENOENT/ECONNREFUSED as "no daemon" → local path.

**Protocol** (newline-delimited JSON, versioned hello):

```
CLI → daemon:  {v:1, op:"push"|"pull"|"sync", root, token, pid, metrics:bool}
daemon → CLI:  {ack: {opId}} | {reject: {reason}}            — within 2s
CLI → daemon:  {cancel: {opId}}                              — optional, any time
daemon → CLI:  {progress: {phase, done, total, bytes?}}      — streamed, ≥1/10s
               {log: line}                                   — verbatim, --verbose fodder
               {cancelled: {opId}}                           — terminal (pre-bind cancel)
               {result: {opId, ok, error?, failedLeg?,
                         push?: {committed, sequence, files, deferred},
                         pull?: {writes, deletes, conflictsTotal,
                                 conflictSamples: [{path, keepLocalAs}],
                                 writtenPaths, writtenPathsElided},
                         phaseReports?}}                     — terminal
```

Framing rules (R3 F4): the hello carries the freshly read delegation
`token` and the CLI `pid` — they are part of the normative wire schema, not
prose; every frame is a single line, hard-capped (64KB request frames; 1MB
result frames, sized by the caps below); an oversized, non-JSON, or
schema-invalid frame is answered `reject: {reason: "malformed"}` (pre-ack)
or dropped with the connection closed (post-ack, → the CLI's socket-close
arm); the token is never echoed into any daemon log line (the per-op
forensic line carries opId/pid/outcome only).

`reject` reasons are enumerated: `version` (protocol mismatch), `root`
(hello root ≠ daemon root), `auth` (missing/mismatched delegation token),
`malformed` (framing violation), `lock-degraded` (workspace locking
unsupported — no exclusivity proof exists, R2 F2), `pull-only` (daemon
started pull-only suppresses pushes, `daemon.ts:383-385` — a delegated
`push`/`sync` is rejected, a delegated `pull` is fine), `unsupported`
(future op). Any reject → CLI local path, chosen before any lock was taken.

**Request↔result correlation and coalescing (R1 F12; demand separation per
R2 F5).** The `want` booleans (`daemon.ts:179,387-395`) coalesce by design,
are fed by AMBIENT causes (watcher batches, WS catch-up, safety/deep ticks,
post-pull chaining, `daemon.ts:445-461`), and cannot prove which request
owns which terminal result — so delegated demand is a SEPARATE source that
never reads or writes `want`: the daemon keeps `delegated: Map<opId,
{op: "push"|"pull"|"sync", socket, acc}>`. The pump loop's continue
condition becomes "any `want` set OR `delegated` non-empty," and demand at
op selection sees each delegated entry's kind. **Delegated `sync` is ONE
composite pump iteration, not two (R6 F1 — the pump acquires and releases
the mutex per iteration, `daemon.ts:425-431,538-540`, while local sync
deliberately holds one `withWorkspaceSyncMutex` across the whole `sync()`
call, `sync-cmd.ts:58-84`; splitting the legs across iterations would let
another top-level owner interpose between pull and push, breaking design
93's decision→mutation→state-save interval for exactly the operation the
caller asked to be atomic).** The pump gains a composite `sync` op kind
that runs `doPull` then `doPush` inside a SINGLE iteration under the SAME
mutex handle — precisely mirroring the shared `sync()` composition the CLI
uses. Demand accounting for the composite: it consumes `want.pull` and
`want.push` if set (it performs both, so ambient demand is covered, not
stolen); standalone delegated `pull` entries may bind to its pull phase and
`push` entries to its push phase, each resolved by that phase's outcome.
When the pump STARTS an op (or composite phase) it binds every matching
delegated entry; a bound entry's `result` is built when its op completes;
on failure every bound entry gets an error `result` naming the failed leg
(a composite's pull-phase failure aborts its push phase). **Cancellation
therefore never touches `want` at all:** a pre-bind cancel just removes the
map entry — ambient demand is structurally incapable of being consumed by
it, and a cancelled-away delegated op runs nothing spurious because the
entry no longer contributes demand. Two clients requesting push coalesce
into one push iteration and each receives the same terminal result under
its own opId — semantics: "a push cycle covering your request completed,"
which is exactly what the coalescing pump means today.

**Delegated standalone `pull` suppresses the pump's post-pull push chain
(R4 F1).** The current pump unconditionally chains `requestPush()` after a
successful `doPull` ("publish any local divergence after taking remote",
`daemon.ts:460-465`) — correct for the daemon's own convergence, but a
foreground `rbox pull` / `sync --pull-only` performs NO push, so delegating
pull through the unmodified chain would mutate the remote as a consequence
of the CLI's request, after the CLI already reported success — a different
remote-mutation contract, not an output detail. Rule (demand provenance,
extending R2 F5's separation): the post-pull auto-chain is SKIPPED iff the
pull iteration's only demand was delegated standalone-`pull` entries and
`want.push` was not already set. Any ambient co-demand (a watcher batch, an
already-queued push, `want.pull` set by WS catch-up) keeps the chain; a
delegated `sync` never depends on the chain at all — its composite
iteration runs its own push phase internally (R6 F1, correlation above).
Daemon convergence is unharmed by the suppression:
real local divergence is republished by the next watcher batch or safety
tick exactly as if the delegated pull had never happened — the rule removes
only the push the CLI did not ask for. On a live daemon, ambient pushes
continue as always; a delegated pull just doesn't ADD one — which is
precisely the foreground contract.

**Pull and sync result contracts (R2 F6; pull parity per R3 F3).** A local
pull returns the individual actions: `summarize` prints per-conflict
`path`/`keepLocalAs` lines, and `postSyncNudge` needs the WRITTEN paths for
the design-29 drift notice (`main-dispatch.ts:258-274`;
`sync-cmd.ts:66-73`). Counts alone cannot reproduce that, so the `pull`
result payload (used by delegated `pull`, `sync --pull-only`, and the sync
accumulator's pull leg alike) carries: `writes`/`deletes` counts; an
EXPLICIT `conflictsTotal` plus `conflictSamples` as `{path, keepLocalAs}`
pairs capped at 50 (R4 F4 — the total must never be derived from a capped
list: local `summarize` counts the full action set, `sync-cmd.ts:46-52`,
so the frame carries the true total and the CLI prints it from that,
renders one line per sample, and appends an explicit truncation notice
beyond the cap); and `writtenPaths` capped at 500 with a
`writtenPathsElided` flag. The truncation notice must not point at
forensics that don't exist (R5 F2): the existing pull log line
(`summarizeActions`, `daemon.ts:73-96`) caps FIFTY action paths TOTAL in
action order, so writes/deletes can consume every slot and elided
conflicts may appear nowhere. Whenever a pull's conflict count exceeds the
wire sample cap, the daemon therefore logs a DEDICATED conflicts line
(`pull conflicts: p1 p2 … (+N more)`) with its own 200-path cap,
independent of the shared action budget. Notice wording matches reality:
`(+N more conflicts — up to 200 listed in rbox logs)`, and past 200 the
remainder is stated as unavailable rather than implied to be logged.
Parity claim, narrowed accordingly: counts and `--json` schema/totals are
ALWAYS identical to the local path; human per-conflict lines are identical
up to 50 conflicts and explicitly truncated past it. The CLI runs `postSyncNudge` CLI-SIDE from
`writtenPaths` — the daemon never runs the nudge (a foreground advisory;
design 29's `RBOX_NO_DRIFT`/config gates are the CLI's to apply). When
`writtenPathsElided` is set the nudge is skipped — best-effort by contract
(`sync-cmd.ts:33-44`), and a 500+-file pull is not a lockfile-drift
situation. A sync's two legs run inside one composite iteration (R6 F1)
but are still distinct phases, so the terminal frame is built from a
per-opId accumulator (`acc`): the pull phase records the payload above and
the push phase records `{sequence, committed, files, deferred}`; the
`result` frame carries both plus `failedLeg: "pull"|"push"` on error, and
with `metrics:true` the phase reports of both legs. Gate 6 tests the
narrowed contract: `--json` schema-identical with exact totals; human
output identical below the caps. A
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
  `{cancelled}` (removal of the map entry alone — ambient `want` demand is a
  separate source and is never touched, see correlation below); a cancel for
  a BOUND opId is answered by the
  op's eventual `result` (the daemon never aborts a mutation mid-flight —
  same principle as its SIGTERM drain, `daemon.ts:369-374`); (3) **proven
  daemon death** — socket closed without a terminal AND `isDaemonRunning`
  false: the daemon process is gone, so its mutex is dead-pid-reclaimable
  (design 93 §7 liveness) and the CLI falls back to LOCAL safely; (4)
  **explicit INDETERMINATE** — socket closed without a terminal but the
  daemon process is still alive (stuck, or the CLI was disconnected): the
  CLI makes ONE ordinary mutex acquisition attempt (the standard 16×50ms);
  if it acquires a REAL lock (`workspaceSyncMutexDegraded` false — a
  degraded handle proves nothing, R2 F2, and counts as contended), the
  daemon has no op in flight and the CLI continues locally **under the
  handle it already owns** (R6 F2): it invokes the same operation body the
  normal wrapper would (`withWorkspaceSyncMutex` is already
  body-as-`fn(handle)`, `sync-mutex.ts:108-119`), passing the probe handle
  as `deps.syncMutex` and releasing it exactly once in `finally` — NEVER by
  re-entering the wrapper, which would self-contend on its own probe, and
  NEVER by releasing first and re-acquiring, which would hand the daemon a
  gap that dissolves the proof. If contended or degraded,
  it exits nonzero with a distinct code and message
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
   state machine never creates a second concurrent owner. On a workspace
   where locking itself is degraded there is no exclusivity for anyone —
   so delegation is rejected outright there (§3.2, R2 F2) and the exposure
   is exactly today's, not a new one. Gate 2 (§7) kills a daemon
   mid-delegation and asserts the proven-death, indeterminate, and
   degraded-reject arms.

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
  target; classify added/deleted/modified — as drift CANDIDATES only.
  Attribution then survives the scan-window races R2 F3 identified (an
  add/delete DURING the walk whose watcher event has not yet been
  delivered is legitimate churn: it can look consistent to both the fresh
  manifest and a re-lstat, and the old-manifest snapshot is not a temporal
  snapshot of the filesystem). Three filters before anything counts as a
  drop: (a) **event cover** — record the raw-event generation
  (`watcherUnsettledGeneration`) and pending queue at scan start; after the
  scan, wait out the watcher's settle window (debounce max 3s + margin)
  and drain; any candidate covered by a watcher event delivered since scan
  start, or present in `pendingEvents`/`deferredRetryPaths`, is `racing`;
  (b) **re-verification** — each surviving candidate is re-checked against
  disk (P-1-grade stat/hash) and must still mismatch the pre-scan
  incremental manifest in the same direction; (c) **quiescence tag** — the
  whole scan is tagged quiescent iff zero raw watcher events arrived from
  scan start through the settle window; (d) **audit-horizon confirmation
  (R4 F3 — a finite settle window cannot distinguish a LATE event from a
  DROPPED one, so no single-window candidate ever feeds the gate; R5 F1 —
  and the confirmation must judge against a RETAINED counterfactual,
  because deep scan N itself HEALS the divergence when it installs fresh
  truth as `this.manifest` (`daemon.ts:1148`), so at scan N+1 the ordinary
  incremental-vs-fresh diff is clean even for a genuine drop)** — each
  surviving candidate is persisted to the soak sidecar as
  `{path, expected, observed, firstSeenAtMs, eventGenAtScan, bootId,
  watcherSessionId, errorGenAtScan}`, where `expected` is the pre-heal
  incremental entry (or explicit absence) and `observed` the first fresh
  observation: the pending set IS the counterfactual, held deliberately
  outside the manifest that healing overwrites. At the NEXT deep scan
  (the natural 30m audit horizon) each pending candidate is resolved
  under continuity and coverage rules (R6 F4):
  - **Continuity first:** attribution requires one continuously observed
    watcher interval. If the daemon restarted (bootId differs), the
    watcher instance was recreated (`watcherSessionId` differs), the
    error generation advanced, or the watcher was unhealthy at any point
    between the scans, the candidate resolves `unattributable` — its own
    class, never confirmed, never gated (a disk change in an unobserved
    gap is not watcher loss).
  - **Coverage uses `applyWatchEvents` semantics, not exact-path match:**
    a candidate is covered by an event iff the event names the path
    itself, OR is an `addDir`/`unlinkDir` whose subtree contains it, OR
    (rename) is one side of a create/delete pair whose other side is the
    candidate path — the same ancestor/subtree relations the daemon's
    event application uses (`manifest.ts:134-182`).
  - **Covered ≠ automatically exculpatory:** a covering event RETRACTS
    the candidate as `late-covered` only when its re-derived truth
    matches the recorded `observed` — plausibly the late delivery of the
    very mutation the scan caught. A covering event that reflects a
    LATER, different state resolves `covered-ambiguous`: excluded from
    confirmed drops AND from clean retractions, reported separately
    (treating every later same-path event as exoneration would erase a
    genuine first drop behind an unrelated second edit).
  - **Otherwise CONFIRMED** iff that scan's fresh disk truth still
    differs from the RETAINED `expected` — disk having mutated further
    WITHOUT any covering event is still a confirmed miss, because the
    test is "the incremental state of record was wrong about this path
    and the watcher said nothing about it across one continuously
    observed horizon."
  An event delayed beyond a full deep-scan interval is indistinguishable
  from a drop and counts as one — stated, and acceptable, since the
  safety cadence being tuned is itself an order of magnitude shorter. Only confirmed drops from quiescent-tagged scans
  feed the drop-rate GATE (everything else logs as lower-confidence
  evidence). Log one bounded non-PII line per deep scan: counts by class
  (candidates, confirmed, late-covered, covered-ambiguous, unattributable,
  racing), quiescence tag, watcher health + error generation, seconds
  since last safety scan, watcher events since, whether ignore rules
  changed. Report per host/filesystem
  over a 24h soak: deep scans, quiescent scans, confirmed drops, paths by
  class, max inferred drift age. Zero confirmed drops over the soak →
  evidence for design 49's cadence question (§9.3); nonzero → the number
  the safety cadence must answer to.
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
   dircache: "hit"|"cold"|"rules-dropped"|"deadline"|"unpruned" }` to the existing
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
4. Daemon log: one line per delegated op (opId, requester pid, op,
   outcome, cancelled-or-completed); the P0.3 drift line
   (`deep-scan drift: candidates=C confirmed=D late-covered=L racing=R
   ambiguous=X unattributable=U quiescent=y/n …`) so a nonzero drop is
   loud, not silent; and the
   dedicated `pull conflicts:` line (200-path cap, §3.2/R5 F2) whenever a
   pull's conflicts exceed the wire sample cap — the shared
   `summarizeActions` 50-slot budget cannot be assumed to contain them.

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
   complete, tree converges, no 409 storm required to make it true. (d)
   Degraded-lock workspace (lock primitive unsupported): hello is rejected
   `lock-degraded` and the CLI runs LOCAL — delegation is provably never
   active without an exclusive mutex. (e) Sync atomicity: a `--no-daemon`
   push launched between a delegated sync's pull and push phases waits for
   the WHOLE composite iteration (R6 F1) — the interposer never observes a
   half-synced state interval.
3. **Layer A warm full scan (if built per §5): ≤ 3s Mac / ≤ 6s Linux**, from
   6-15s; cold recorded alongside for the page-cache-fragility note. Applies
   to the daemon safety scan too (design 49 cadence cost ≤ 3s Mac). Dircache
   bytes on the founder workspace ≤ 25% of hashcache.json's size. A pruned
   request against a dircache past the 30m unpruned deadline (daemon
   stopped) self-demotes: asserted via `dircache: "deadline"` +
   `dirsReusedFromCache === 0`.
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
   a delegated push; delegated `--json` output schema-identical to local
   with exact totals, human output identical below the §3.2 caps (explicit
   truncation notice beyond); a delegated `pull` against local divergence
   leaves the remote sequence unadvanced (chain suppression, R4 F1) while
   the daemon's own next ambient cycle still publishes it.

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
6. **Delegation auth is a 0600 token file, not socket peer credentials**
   (R2 F4): runnable today with zero native code; peercred is optional
   future hardening.
7. **Delegation requires an exclusive workspace mutex** (R2 F2): a
   lock-degraded workspace rejects delegation and keeps today's behavior.
8. **The unpruned deadline is path-independent** (R3 F1): any pruned scan —
   daemon or daemonless — past 30m since the last unpruned rebuild
   self-demotes, so the invariant's staleness bound needs no daemon.
9. **The rule-file inventory is OBSERVED, per-file P-2-fingerprinted** (R3
   F2): derived from walked+cached listings plus the root files, never from
   the root-only `effectiveIgnoreRules` set.
10. **Delegated pull returns actions, not counts** (R3 F3; totals made
    explicit per R4 F4): true `conflictsTotal` + capped samples + written
    paths; `postSyncNudge` runs CLI-side only; parity claim narrowed to
    "identical below the caps, explicit truncation beyond."
11. **Delegated standalone pull suppresses the post-pull push chain** (R4
    F1): the pump publishes local divergence on its own ambient schedule,
    never as a side effect of a CLI pull request.
12. **Lock capability is positively probed before the listener exists**
    (R4 F2; handle-level per R6 F3): the initial-convergence pump's first
    acquisition resolves `lockMode` via `workspaceSyncMutexDegraded` on
    the acquired handle (contended counts as exclusive-capable); every
    delegated-bound acquisition re-checks its handle before mutation;
    degradation errors out bound ops and rejects all further hellos.
13. **Delegated `sync` is one composite pump iteration under one mutex
    handle** (R6 F1): per-leg exclusivity is not operation exclusivity;
    the composite mirrors local `sync()`'s single-owner interval.
14. **The INDETERMINATE-arm fallback continues under its own probe
    handle** (R6 F2): the operation body runs with the already-acquired
    handle as `deps.syncMutex`, released exactly once — never wrapper
    re-entry, never release-then-reacquire.

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
