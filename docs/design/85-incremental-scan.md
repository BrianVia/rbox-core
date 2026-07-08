# 85 - Scan at O(change): dir-mtime-pruned walk + CLI daemon delegation

Status: Design draft v2, revised after adversarial review (codex gpt-5.5,
verdict REDESIGN — the v1 manifest-handoff Layer B is dead; §3.4 records why)
and the founder's architecture call: **delegation, not handoff**. Client-only.
Pending the phase-0 decomposition in section 5 before Layer A is built.
Origin: post-v0.9.10 profiling. Design 82 killed the O(N²) encrypt-cache path
and left `scan` as one of the two dominant terms of a steady-state cycle
(scan 6.0-15.0s; the larger term, git-plan 25.5s, is design 83's). Design 82
§7 non-goal #1 parked exactly this work.
Related: design 83 (git-plan cost — owns the `.git` lane and the racy-clean
fingerprint discipline this design reuses), design 72 (ignore semantics —
untouched), design 49 (safety-scan cadence — made cheaper here), the existing
`HashCache`, and `applyWatchEvents` (the daemon's already-incremental hot path).

All numbers were measured on 2026-07-08 on the founder's real workspace
(`~/Development`, 116,881 tracked files / 98 git repos, Mac WiFi) unless marked
inferred. This design continues the designs 79-82 method: measure, falsify,
then redesign — including falsifying its own first draft (§3.4).

## 1. Problem and evidence

Measured means observed directly on the named workload; inferred follows from
those measurements but still needs the phase-0 gate in section 5.

1. **`scan` runs on every sync-path entry, measured.** 6.0-15.0s per run on the
   Mac (RBOX_METRICS=1, v0.9.10); variance tracks page-cache state (cold ≈ 15s,
   warm ≈ 6s). Scoped honestly: on a 41s no-op daemon tick (scan 15.0 +
   git-plan 25.5 + state-load 0.1) scan is the SECOND-largest term — git-plan
   is design 83's. But scan multiplies worse across entry points: once per CLI
   `push` (`src/cli/sync.ts:329`), once per CLI pull leg (`sync.ts:194`), once
   per 409-retry rescan (`sync.ts:172`), so a contested CLI `sync` pays it 2-3
   times; and in FIVE daemon sites — start convergence (`daemon.ts:197`),
   ignore-rule rescan (`daemon.ts:580`), post-pull refresh (`daemon.ts:659`),
   safety `fullScan` (`daemon.ts:867`), `deepScan` (`daemon.ts:875`).
2. **The walk itself dominates warm, not hashing, measured.** A recursive
   `readdir`-only walk of `~/Development` (2026-07-08, warm page cache, coarse
   6-dir prune so it over-counts the tree at 42,539 dirs / 154,911 files vs
   rbox's pruned 116,881): **2.26s**. Adding one `stat()` per file: **+0.99s**,
   total **3.26s**. Hashing contributes ~0 warm because `HashCache` already
   skips re-hash on `(mtime,size)` hits. So of the scan's wall: `readdir` is
   the floor, `stat` a real secondary, and the residual from ~3.3s to rbox's
   6-15s is ignore-matcher CPU per entry + `FileEntry` allocation + the final
   116k-entry sort + cold-cache inflation. Phase-0 (§5) decomposes this
   precisely before we build anything.
3. **The daemon already scans at O(change) on its hot path, measured in code.**
   `applyWatchEvents` (`src/engine/manifest.ts:64`) patches the in-memory
   manifest from a settled watcher batch — re-hash one changed path, drop an
   unlink, rescan only an added subtree. The daemon holds authoritative
   incremental truth continuously; the full walks above are its safety floor.
4. **The CLI has no incremental option at all, measured in code.** The CLI
   one-shots scan unconditionally even while a healthy daemon holds a fresher
   manifest in memory. Notably `pushManifest` (`sync.ts:391`) already accepts a
   precomputed manifest — the daemon uses that today; the CLI wrapper is the
   only caller that must walk first.
5. **The persisted fingerprints already exist, measured.** `state.json` is 47MB
   (`lastSyncedManifest`, 116,928 entries: path/sha/size/mode/mtimeMs);
   `hashcache.json` is 22MB (`(path)->(mtime,size,sha)`,
   `src/engine/hashcache.ts:17`). Layer A needs one new small table (per-dir
   listings), not new per-file truth.

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
   only the ~2.3s readdir share.

Corollary: **true O(change) requires already knowing which paths changed — the
watcher feed.** And the review (§3.4) established that watcher-derived truth
cannot be safely *exported* across a process boundary: completeness of a
manifest is provable only inside the process that owns the watcher, the
pending-event queue, and the safety/deep-scan backstops. So the O(change) layer
is not a cache and not a handoff — it is **delegation**: let the process that
owns the truth run the cycle.

## 3. Design

### Invariant (stated first, design-82 style)

> **A changed file is NEVER silently skipped, and a new file is NEVER silently
> missed.** Every fast path is conservative by construction: it may do EXTRA
> work — re-stat, re-readdir, re-hash, full-scan, or run the push twice — but
> may never OMIT a change. Concretely: (a) the manifest that backs any push is
> produced inside a single process that either walked the tree this run (CLI)
> or owns a live watcher WITH its safety/deep-scan reconciliation loop (daemon)
> — a manifest never crosses a process boundary as trusted truth; (b) a cached
> directory listing is reused only when the dir's mtime is strictly older than
> the previous scan's start minus a racy-clean margin AND the ignore-rule
> fingerprint is unchanged; (c) a cached content sha is reused only on a full
> `(mtime, size, ctime)` fingerprint match. On ANY doubt — fingerprint
> mismatch, rule change, delegation timeout, daemon death — fall back to the
> slow correct path. The periodic cache-bypassing **deep scan** (`doDeepScan`)
> remains the unconditional backstop against anything the fast paths could
> ever mask.

### 3.1 Layer A — directory-mtime-pruned walk (bounded, page-cache-fragile)

Persist a per-directory listing table alongside `HashCache`
(`.rbox/state/dircache.json` — safe-to-discard, like hashcache: corruption or
absence only costs a full readdir walk):

```
header:  { version, ruleFingerprint, lastScanStartMs }
entries: dirRelPath -> { mtimeMs, children: [{name, type: file|dir|symlink}] }
```

During a full walk, before `readdir(dir)`:

- **Reuse** the cached child listing (names + types) instead of `readdir` iff
  the dir's current lstat `mtimeMs` equals the cached one **and** is strictly
  older than `lastScanStartMs - RACY_MARGIN_MS (2s)`. The margin closes
  timestamp-granularity races (a change landing in the same mtime tick as the
  scan that cached it) — the same racy-clean discipline design 83 adopts for
  its git stat-fingerprints; keep the two consistent. Still `stat` each child
  file (in-place edits, per §2) and still run the ignore matcher per child.
- **Miss** → `readdir` as today, rewrite the dir's entry stamped racy-or-clean.

Two review fixes are load-bearing here:

1. **Ignore-rule invalidation (review BLOCKER).** Cached listings were pruned
   under the rules in force when cached — a rule change can un-ignore a subtree
   the cache never descended into. The daemon already full-rescans on any
   ignore-rule file event (`daemon.ts:575-580`) and after a pull that wrote
   rules (`daemon.ts:649-659`); Layer A must match: the table header carries a
   `ruleFingerprint` (path + size + mtime of every effective ignore-rule file,
   the `src/engine/ignore.ts:279-286` set); any mismatch drops the ENTIRE
   table and the walk runs un-pruned. Whole-table drop is deliberately simpler
   and safer than per-dir invalidation — rules have non-local effects
   (negations). Cached listings are stored UNFILTERED (raw readdir output)
   with the matcher applied on every reuse, so filtering can never be stale
   independently of the fingerprint.
2. **No childCount in the check (review MAJOR — circular).** v1 proposed
   `(mtimeMs, childCount)`; you cannot know the current childCount without
   paying the readdir the check exists to skip. The check is dir-mtime +
   racy-clean margin only; the cached listing *supplies* names/types, it does
   not verify them. POSIX/APFS/ext4 bump dir mtime on any entry
   add/remove/rename, so mtime-equal + strictly-racy-clean ⇒ same entry set.

**Fix-in-passing (review MAJOR, pre-existing).** `scanManifest`'s deferred hash
path lacks the midwrite stat-hash-stat guard that `statHashEntry` has
(`manifest.ts:173,190-193` vs `:256,262,276-278`) — a full scan stats once,
hashes later, and records pre-hash metadata, so a file written between stat and
hash can be baked torn. Since this design touches the scan loop anyway,
`drainHashes` gains the same guard: re-lstat after hashing; on mtime/size
shift, drop the entry and surface it via the existing deferred mechanism.
Cheap, correctness-positive, and it makes the full scan and the incremental
path tell the same story about mid-write files. Ships regardless of Layer A's
phase-0 fate.

Layer A reclaims the readdir share (~2.3s warm) on the unchanged-dir fraction
(§5 P0.2 measures it; expected near-total on a steady tree). It does NOT reach
O(change): the per-file stat floor (~1s) and matcher CPU remain. It ships ONLY
if phase-0 justifies the table (§5 gates). It applies to every full-scan site —
all five daemon sites and the CLI's no-daemon path — which is what makes the
design-49 safety cadence cheap.

### 3.2 Layer B — daemon delegation (the O(change) win)

When a healthy daemon exists, `rbox push` / `rbox sync` do not scan at all:
they ask the daemon to run the cycle NOW and stream the result back. The
manifest never crosses a process boundary — the completeness proof that killed
the v1 sidecar (§3.4) simply does not need to exist, because the daemon's
manifest is consumed where it is produced, inside the process that owns the
watcher, the pending-event queue (`applyPendingWatchEvents`, `daemon.ts:570`),
the mid-write retry loop, the safety scan, and the deep-scan backstop.

**Discovery and liveness.** Reuse `isDaemonRunning`
(`src/cli/daemon-control.ts:236-239`), which verifies the pidfile's pid is
alive AND is our daemon for this root via ps-command match
(`daemon-control.ts:199-204`) — never bootId/pidfile match alone (review MINOR:
bootId can come from env, `daemon.ts:167`, so it is an ownership token, not a
liveness proof).

**Transport: unix domain socket**, listener owned by the daemon, created after
the startup binding and removed on graceful stop. Decided, not open — the
file-based alternative (request file + response file, daemon polls) loses on
every axis that matters here: (a) ack latency — the daemon's pump is
event-driven, not polling; a request file needs a new sub-second poll loop
(idle disk churn design 49 just spent a release removing), and `.rbox` is
hard-pruned from the daemon's own watcher (`src/engine/ignore.ts:150`) so no
event would ever announce the file; (b) progress streaming — the CLI should
render the daemon's phase/transfer progress live, which is a stream, not a
file rewrite; (c) **death detection** — a socket close IS the
daemon-died-mid-cycle signal, immediate and unambiguous, whereas file polling
needs pid re-checks and staleness heuristics. New long-lived surface, yes, but
small: one localhost-only socket, mode 0600, same-uid only. One portability
edge: `sun_path` is ~104 bytes on macOS, so the socket lives at
`$TMPDIR/rbox-<sha256(root)[0:16]>.sock` (deterministic per root, no length
risk) with the path recorded beside the pidfile.

**Protocol** (newline-delimited JSON, versioned hello):

```
CLI → daemon:  {v:1, op:"push"|"sync", metrics:bool}
daemon → CLI:  {ack: opId}                                — within 2s
               {progress: {phase, done, total, bytes?}}    — streamed
               {log: line}                                 — forensics, verbatim
               {result: {ok, committed, sequence, files,
                         deferred, phaseReport?}}          — terminal
```

**Semantics.** A delegated op jumps the tick: the daemon handler sets
`want.pull`/`want.push` (`request()`, `daemon.ts:323`) and the single-flight
pump (`pumpLoop`, `daemon.ts:350`) serializes it against in-flight work exactly
like a watcher batch or safety tick — no new concurrency inside the daemon.
Before the push it drains pending watcher events as it always does
(`doPush` → `applyPendingWatchEvents`, `daemon.ts:473`). The CLI renders
progress, prints the result, and exits with a matching code. A delegated
`sync` = the daemon's pull+push pair (the pump already chains
`want.push = true` after a pull, `daemon.ts:376`).

**Timeout and fallback — fail open to the slow correct path.** The CLI falls
back to its own full-scan push (Layer A-accelerated) when: no daemon;
`isDaemonRunning` false; socket connect or ack exceeds 2s; the progress stream
goes silent past a heartbeat bound (daemon emits progress or a keepalive at
least every 10s; the CLI allows 30s of silence — cycles are long, so silence
is the failure signal, not total wall); or the socket closes without a
terminal result (daemon died mid-cycle). Fallback is safe because the
operation is **idempotent under concurrency by existing discipline**: commits
are sequence-CAS'd server-side, and `pushManifest`'s bounded recovery loop
already handles a 409 from any concurrent pusher by pull-first recovery
(`sync.ts:391` docblock; design 82 §1.5 measured exactly this fleet behavior).
Worst case a half-dead daemon's cycle and the CLI's fallback both run: one
wins the CAS, the other 409s and recovers to a no-op. Duplicate work, never
lost changes — gate 2 in §7 proves it by killing the daemon mid-delegation.

**Flags.** `--no-daemon` on `push`/`sync` forces the local scan+push path
(escape hatch for debugging, daemon distrust, benchmarking). Delegation is
also skipped for flag/config combinations the daemon cycle does not honor
(e.g. purge-ignored safety rescans) — enumerated at implementation time;
anything unsupported falls back rather than approximating.

**RBOX_METRICS.** The daemon's cycle produces the phase report; with
`metrics:true` the serialized report rides the `result` frame and the CLI
prints it in the standard format, with the scan phase carrying
`recordDetails({source: "daemon-delegated"})` plus the daemon's own
statted/skipped/hashed counts (§6). The CLI additionally reports
`delegation: {ackMs, totalMs}` so gate 1 (§7) is self-measuring.

### 3.3 Failure modes and how each fails safe

1. **mtime granularity** (two edits inside one mtime tick). File level:
   fingerprint includes size + ctime; deep scan re-hashes on cadence. Dir
   level: the racy-clean margin (§3.1) refuses to trust a listing whose mtime
   is within 2s of the scan that cached it.
2. **mtime-preserving write** (`touch -r`, same size). `ctime` joins the
   `HashCache` fingerprint (decided, §9): content writes bump ctime and
   userspace cannot restore it on macOS/Linux → fingerprint miss → re-hash.
   Schema note (review MAJOR): `HashCacheEntry` gains `ctimeMs` with a cache
   version bump; an old-version cache is discarded wholesale — it is
   safe-to-discard by contract (`hashcache.ts:14`), one-time full re-hash.
   Cost of the extra strictness: a chmod/xattr touch re-hashes one file.
   Deep scan remains the ultimate backstop.
3. **clock skew / backward jump.** File fingerprints are equality-compared,
   never ordered, so future-dated mtimes cause no skip. The dir racy-margin
   comparison IS ordered — belt-and-suspenders, a detected backward jump
   (`lastScanStartMs` in the future) drops the dircache table.
4. **inode reuse / delete+recreate same path.** Recreation shifts ctime (and
   usually mtime) → miss. The parent dir's mtime also bumps → readdir re-runs.
5. **watcher overflow / stream death / native-prune blind spots.** Delegation
   inherits the daemon's existing answer wholesale: `onError` un-trusts the
   watcher and pins the safety scan to its 60s floor (`daemon.ts:235-244`,
   design 49), the safety scan heals dropped events and native-prune
   re-include gaps (`ignore.ts:179-184`), and the deep scan heals everything
   else. A delegated push after a drop is no worse than the daemon's own next
   push after a drop — same process, same manifest, same healing loops. This
   is the structural advantage over the dead sidecar: the CLI no longer needs
   to *prove* watcher coverage, because it never consumes watcher-derived
   truth directly.
6. **daemon down / mid-cycle death / stale pidfile.** No trusted daemon state
   survives its process: `isDaemonRunning` gates entry, socket close mid-cycle
   triggers CLI fallback (§3.2), and the fallback path scans from disk.
7. **atomic-rename editors** (write tmp + rename). Unchanged from today:
   `statHashEntry` re-derives from disk and returns `midwrite` on torn reads
   (`manifest.ts:173`); §3.1's fix-in-passing extends the same guard to the
   full-scan hash drain.
8. **case-insensitive APFS.** A case-only rename is a directory-entry rename →
   parent dir mtime bumps → readdir re-runs and yields the on-disk casing; the
   old-cased manifest entry drops on the same walk. File fingerprints are
   keyed by exact-case relPath throughout.

### 3.4 Rejected alternative: the persisted-manifest sidecar (v1 Layer B)

Recorded because the reasoning is load-bearing (codex review 2026-07-08,
verdict REDESIGN; five blockers, all confirmed against source):

1. **Stat-verify cannot detect additions.** Verifying known entries catches
   modifications and deletions, but only a readdir walk or a watcher event
   ever *discovers* a path (`manifest.ts:225`, `:153-154`). A verified sidecar
   can be consistent and incomplete at once — the failure mode is silent.
2. **"Watcher healthy since boot" does not prove coverage.** The daemon scans
   and pumps BEFORE arming the watcher (`daemon.ts:197,202,204`); a mutation
   in that window is invisible until a safety scan.
3. **A persisted "settled" stamp races the reader.** Unsettle is in-memory
   (`daemon.ts:231-233,702-705`); the generation counter is an event-drain
   guard, not a persisted coverage watermark (`daemon.ts:356,724`).
4. **Watcher-healthy ≠ manifest-complete by design.** The native watcher
   hard-prunes dirs and the ignore layer explicitly documents that some
   re-included paths heal via safety scan, not live events
   (`ignore.ts:146-150,161-168,179-184`; `watcher.ts:258-260`).
5. **bootId is not liveness** (`daemon.ts:167` env override) — and even the
   proposed ≤0.5s stat-verify gate was unrealistic at 116k stats plus symlink
   readlinks (`manifest.ts:240-243`).

Each hole is patchable in isolation; together they mean exporting
watcher-derived truth needs a completeness proof that keeps growing new
obligations. Delegation deletes the proof obligation instead of meeting it.

## 4. Non-goals and the git boundary

1. **git-plan subprocess cost** (25.5s; design 83). **Boundary, explicit:** the
   scan owns the WORKING-TREE manifest and never descends into `.git` (pruned
   by the matcher); all per-repo git work runs in git-plan's own subprocesses
   with its own `git-divergence.json` fingerprint cache. **Shared-walk note
   (future work, referenced by design 83, not in scope):** git-plan runs its
   own full-tree `discoverGitRepos` walk (~2.3s, `src/cli/sync-git.ts:309`),
   and `scanManifest`'s `onGitRepo` callback (`manifest.ts:43,231-232`) was
   built to feed it but has ZERO consumers today — a dead parameter. With
   delegation putting scan and git-plan on the same daemon tick, one walk can
   eventually serve both discoveries.
2. **Commit envelope O(N) encoding** (design 82 §7 #2). Separate.
3. **Cold join / first scan.** No cache, no daemon → full walk by definition.
4. **Ignore matcher semantics** (design 72). This design changes how often and
   how cheaply the walk runs, never what it includes.
5. **Daemon-side push internals.** Delegation invokes the existing pump ops
   unmodified; what a push does is other designs' turf.

## 5. Phase-0 — measure before building (falsification-first)

Layer B (delegation) needs no phase-0 — its win is architectural (skip the
scan AND the 47MB state parse on the CLI side entirely) and its risk is
protocol, covered by gates. Layer A does:

- **P0.1 — decompose the scan.** Instrument `scanManifest` (recordDetails
  only, §6) to split wall across readdir / stat / matcher-eval / hash /
  sort+alloc on the real workspace, WARM and COLD. Hypothesis from §1.2:
  readdir ≈ 2.3s+, stat ≈ 1s, hash ≈ 0 warm, matcher+alloc the residual to
  6-15s. **GATE:** readdir < ~1.5s of a warm scan → do NOT build Layer A.
- **P0.2 — dir-prune ceiling.** On steady-state ticks, count dirs whose mtime
  is unchanged-and-racy-clean since the prior scan. Reclaimable ≈ that
  fraction × readdir share. **GATE:** product < ~2s → Layer A is not worth
  the table.
- **P0.3 — watcher drop rate (reframed post-review).** With the sidecar dead
  this gates no handoff; it now informs the DAEMON'S OWN safety-scan cadence
  (design 49 tuning): over a 24h soak, diff each deep-scan manifest against
  the incremental manifest it replaces and count real missed changes. Zero
  over the soak → evidence the idle backoff can lengthen — or, likely the
  better trade, keep the cadence and make it cheap via Layer A (§9.3).

## 6. Instrumentation

Shared 83/84/85 convention: **recordDetails-only on existing phases — no
`PhaseName`/`PHASE_ORDER` changes** (`phase-report.ts:167`), so three
concurrent designs cannot collide in the closed union.

1. `scan` recordDetails: `{ dirsWalked, dirsReusedFromCache, filesStatted,
   filesSkippedCacheHit, filesHashed, midwriteDeferred, readdirMs, statMs,
   matcherMs, hashMs, sortMs, dircache: "hit"|"cold"|"rules-dropped" }` —
   makes P0.1/P0.2 self-reporting in the field and catches any regression
   that silently turns a pruned scan back into a full walk (design 82 §8
   lesson: instrument the phase BEFORE optimizing it, or its cost gets a
   false alibi).
2. Delegated runs: the daemon's phase report rides the result frame; the CLI
   prints it with `scan` details `{source: "daemon-delegated"}` plus
   `delegation: {ackMs, totalMs}`.
3. Daemon log: one line per delegated op (opId, requester pid, outcome), and
   the P0.3 deep-scan drift counter (`changes missed by incremental: N`) so a
   nonzero drop is loud, not silent.

## 7. Acceptance gates

RBOX_METRICS, both fleet hosts. Fleet rule: only ONE design's A/B gate window
runs on the shared WAN at a time — 83/84/85 serialize their gate runs.

1. **Delegation overhead, not absolute wall.** Delegated `rbox push` on a warm
   no-change tree: CLI end-to-end wall ≤ daemon-reported cycle wall + **2s**,
   ack ≤ 2s. (Absolute wall is whatever the daemon's cycle costs — 25-63s at
   v0.9.10, falling as design 83 lands; this gate must not inherit 83's
   number.) The CLI-visible result (sequence, counts) matches the daemon log.
2. **Fallback correctness.** Kill the daemon mid-delegation (after ack, before
   result): the CLI detects the close, falls back, completes its own
   full-scan push, exits 0, and a final deep scan confirms no lost changes.
   Also the race variant: a deliberately-slowed daemon cycle and the CLI
   fallback both push; one 409s and recovers to a no-op; the tree converges.
3. **Layer A warm full scan (if built per §5): ≤ 3s Mac / ≤ 6s Linux**, from
   6-15s; cold recorded alongside for the page-cache-fragility note. Applies
   to the daemon safety scan too (design 49 cadence cost ≤ 3s Mac).
4. **Correctness soak: 500 daemon cycles with injected edge cases** —
   mtime-preserving same-size edit, `touch -r` restore, atomic-rename save,
   case-only rename on APFS, create+delete+recreate of one path, a multi-GB
   slow write mid-tick, an ignore-rule edit that un-ignores a populated
   subtree, and a burst designed to overflow the watcher queue — then a final
   deep scan. **ZERO** missed changes. Any miss blocks release.
5. **Drift audit:** the §6.3 deep-scan drift counter stays 0 across the soak.
6. **Parity:** full `bun test` green; `--no-daemon` output equivalent to a
   daemon-stopped run; a cross-host rename and delete apply correctly through
   a delegated push.

## 8. Rollout

Flag-gated, OFF by default in the first release; daemon-first:

1. Ship §6.1 scan decomposition instrumentation — zero behavior change,
   answers P0.1/P0.2 in production.
2. The midwrite fix-in-passing (§3.1) — independent, correctness-positive,
   ships regardless of Layer A's phase-0 fate.
3. If P0 gates pass: Layer A, daemon full-scan sites first (the deep-scan
   backstop catches a Layer A bug within one cycle), then the CLI path.
4. Layer B delegation behind `RBOX_DELEGATE=1` (or config): socket, protocol,
   fallback; soak per §7.2/§7.4 on both hosts.
5. Default ON only after a clean soak. `deepScan` stays unconditional forever
   — it is the invariant's insurance. `--no-daemon` stays forever — it is the
   user's.

## 9. Open decisions (founder calls)

1. **Delegated `sync` semantics for pull-only intent.** Delegating `rbox sync`
   as the daemon's pull+push pair is clean; is a delegated bare `rbox pull`
   worth having, or does pull stay always-local? (Pull pays the same 6-15s
   scan, so the answer covers half the CLI surface.)
2. **Progress fidelity.** Stream the daemon's full transfer-progress frames to
   the CLI spinner (nicest, more protocol), or phase-level lines only
   (simpler)? Affects protocol v1 surface that is annoying to change later.
3. **Safety-scan cadence after P0.3** — lengthen the idle backoff on
   zero-drift evidence, or keep 60s-5m and make it cheap via Layer A.
   (Leaning: keep cadence, make it cheap — frequency is the correctness
   margin.)
4. **Does Layer A ship at all** if P0.1 shows readdir is a small fraction?
   Delegation alone already removes scan from the daemon-present CLI path;
   Layer A then only serves the daemon's own full-scan ticks and daemonless
   CLI use.

Resolved since v1: **ctime ships in the HashCache fingerprint** (YES —
chmod/xattr false-misses just re-hash one file); transport is the unix socket
(§3.2, decided on ack-latency/streaming/death-detection); all v1 sidecar
decisions (cache-vs-state dedup, handoff transport, sidecar write churn) died
with the sidecar.

## 10. Lessons (to fill after the gate runs)

Placeholder for the design-82-style retro. One already earned: the v1 draft's
manifest handoff survived its author's own failure-mode enumeration and died
only under adversarial review with line-level evidence — the completeness of
a scan is a property of a *process* (watcher + queues + backstops), not of a
*file*, and any design that ships the file without the process re-derives the
proof obligations one blocker at a time.
