# §39 — Pull apply optimization (narrow the scan, patch the manifest, schedule the writes)

**Status:** DRAFT v1 — design only, no implementation, **no adversarial review yet**. Implements
proposal **C7** ("Pull apply optimization",
`docs/performance-architecture-proposal.md:568-593`). Attacks the pull-side scan/apply cost that
the §30 dogfood measured: a **65,421-file / 433 s cross-host pull**
(`docs/perf-improvements.md:527`), whose wall time is download + decrypt + **65k filesystem writes**
+ **two full O(tree) scans**. This design removes the redundant scans on the daemon's common path
and schedules the writes, **without weakening the per-file precondition** that anchors apply
correctness (`apply.ts:115-121`, design 01 §6.2). It is deliberately **SQLite-free**: it works on
the current in-memory/JSON manifest; C6 (`docs/performance-architecture-proposal.md:540-566`) would
make the in-memory patching cheaper at 100k+ files but is **not required** and is **not designed
here** (see §7).

**Depends on** §35 (client phase metrics — to prove the scan/apply phases are the cost before and
after). **Pairs with** §36 (blob transfer pipeline — §36 owns the verified-plaintext temp; this
design owns the atomic move + the write schedule). **Does not touch** the server, the DO, or the
manifest wire format.

**Prior evaluations.** The daemon's *watcher* hot path already rejected full re-scan-per-change in
favor of O(changed) incremental patching (`docs/design/01-daemon.md:132`, `:202`); this design
extends that same principle to the *pull* path, which still double-scans. Scan cost itself was
previously put behind a "measure before building" bar (`docs/design/09-hardening-scale.md:98-102`,
cold-scan 2.4s/0.76s for 50k files), so §39 stays gated on §35's fs-apply/scan phase split —
consistent with that bar, not a departure from it.

---

## Problem

A pull today does **two** full tree walks, and the daemon usually does a **third**, to apply a
handful of changed files.

1. **`pull()` scans the whole tree before reconcile.** `pull()`
   (`sync.ts:157-192`) fetches the remote manifest (`sync.ts:159`), then unconditionally
   `scanManifest(root, undefined, cache)` — a **full O(tree) walk** (`sync.ts:166`) — to produce the
   `local` snapshot that `reconcile` diffs against (`sync.ts:175`). With a warm hashcache this is
   *stat-only* for unchanged files (`manifest.ts:164-167`), but it is still `readdir` + `lstat` on
   **every path in the tree** — 65k `lstat`s to apply what may be a 3-file diff.

2. **The daemon scans the whole tree *again* after apply.** `doPull()`
   (`daemon.ts:179-189`) calls `pull()` (which already scanned at `sync.ts:166`), then
   **re-scans the entire tree** — `scanManifest(this.root, this.matcher, this.cache)`
   (`daemon.ts:188`) — solely to refresh `this.manifest` to disk truth before the follow-on push.
   So a single notification-driven pull walks the tree **twice** (once in `pull()`, once in
   `doPull()`), plus the periodic safety scan (`daemon.ts:95`) walks it again on its own cadence.
   Correct — but O(tree) two-to-three times per remote commit.

3. **The write phase is one flat 64-wide pool regardless of file-size mix.** `applyActions`
   funnels every write through `poolMap(rest, dlConc ?? 64, …)` (`apply.ts:80-81`). 64 concurrent
   *large* streamed writes is the right lever for a media/monorepo clone (the download-concurrency
   sweep, `apply.ts:73-79`). But 65k *tiny* writes at 64-wide is 64 concurrent `open`/`rename`/`fsync`
   storms competing for the same disk queue — raw concurrency **punishes** the disk instead of
   saturating bandwidth. One knob cannot serve both mixes.

The daemon already holds the answer to (1) and (2): a **trusted in-memory manifest**
(`this.manifest`, `daemon.ts:47`) that it maintains incrementally on the push path via
`applyWatchEvents` (`daemon.ts:166` → `manifest.ts:43-87`) and re-grounds from disk on the safety
and deep ticks (`daemon.ts:197`, `daemon.ts:201-205`). Nothing about pull uses it. The pull path
throws that trusted state away and rebuilds `local` from a full scan — twice.

## Root cause

`pull()` was written as a **stateless one-shot** command (`rbox pull`), where a full pre-apply scan
is the *only* way to know `local`. The daemon reuses that one-shot `pull()` verbatim
(`daemon.ts:180`) even though it holds a warm, incrementally-maintained manifest that is exactly the
`local` snapshot `reconcile` wants. The redundant work is the cost of a command-shaped primitive run
in a long-lived process that already knows the answer.

The load-bearing observation: **`reconcile` only emits actions for paths where remote diverges from
local, and `applyActions` re-checks each of those paths against disk at apply time**
(`apply.ts:115-121`). The broad pre-apply scan of the *untouched* majority contributes **nothing** to
correctness — every write and delete is independently guarded by its own `expectedLocal` precondition
(`reconcile.ts:14-19`, `apply.ts:117`, `apply.ts:194`). So the scan of untouched paths is pure
overhead: it neither gates a write nor protects a byte.

## Design

Three moves, in order of leverage. Each is an optimization on the **common (daemon) path**; the
one-shot `rbox pull` command keeps its full scan (it has no trusted manifest to narrow against), and
the periodic safety + deep scans (§6, invariant I2) remain the backstop for all of it.

### 4.1 Narrow the pre-apply work to the diff (move 1)

Give `pull()` an optional **trusted local manifest** the daemon can supply:

```
pull(root, cfg, { ...deps, localManifest?: Manifest })
```

- **One-shot `rbox pull`** passes nothing → `pull()` behaves exactly as today: full
  `scanManifest` (`sync.ts:166`). No behavior change for the command.
- **Daemon `doPull()`** passes `this.manifest` (`daemon.ts:47`) as `localManifest`. `pull()` then
  uses it directly as the `reconcile` `local` argument (`sync.ts:175`) **instead of** the full scan
  at `sync.ts:166`.

`reconcile` produces the same action set it would from a fresh scan **for every path where the trusted
manifest is accurate** — which, for the daemon, is every path, because `this.manifest` is kept live by
the incremental patch (`daemon.ts:166`) and re-grounded by the safety/deep ticks. For any path where
the trusted manifest is *stale* (a dropped watcher event — §6, invariant I2), the per-file
precondition catches it at apply time:

- **Stale path that remote also changed** → `reconcile` emits a write/delete with `expectedLocal`
  from the stale manifest; `applyActions` re-stats and re-hashes the target
  (`currentEntryAt`, `apply.ts:116,204-221`), sees it **doesn't** match `expectedLocal`, and moves
  the surprise bytes aside to a `.conflict` copy before publishing (`apply.ts:117-120`) — exactly the
  design 01 §6.2 guarantee, **unchanged**. No clobber.
- **Stale path that remote did *not* change** → `reconcile` emits **no action** for it (remote didn't
  touch it), so narrowing simply doesn't push that local edit *this tick*. The next safety scan
  (`daemon.ts:95,197`, ≤60 s) re-grounds `this.manifest` from disk and the follow-on push publishes
  it. Latency, not loss (§6, invariant I2).

**We do not narrow the hash work away from correctness — we narrow it away from the *untouched* tree.**
The paths in the remote diff are still fully re-stat'd and re-hashed at apply time by the precondition;
we are skipping the broad scan of the 65,000 paths the diff never mentions.

**Warm no-change fast path (the daemon-invisibility win).** Before any scan or reconcile, `pull()`
compares the fetched remote against the last-synced state: if `sequence === state.lastSyncedSequence`
(or the remote manifest equals `state.lastSyncedManifest`), it returns **zero actions and touches no
path** — no full hash pass, no stat pass, nothing. A safety-tick or reconnect pull
(`daemon.ts:230`, `daemon.ts:95`) against an unchanged remote becomes a single `latest()` round-trip.
This is the "no-op daemon tick near zero cost on a 100k-file corpus" success metric
(`docs/performance-architecture-proposal.md:788`) for the pull side.

### 4.2 Patch the in-memory manifest after apply — don't rescan (move 2)

`doPull()`'s post-apply full rescan (`daemon.ts:188`) exists only to refresh `this.manifest`. But
after a successful apply the daemon knows **exactly** which paths changed — they are the actions it
just applied. Replace the broad rescan with an **incremental patch of the touched paths only**,
reusing the same primitive the push path already uses (`applyWatchEvents` / `statHashEntry`,
`manifest.ts:79,94-116`):

- **write / conflict action** → `statHashEntry(root, path, cache)` the just-written path and set the
  entry (the cache is warm — `applyActions` staged and `apply.ts`'s caller invalidated it,
  `sync.ts:184-190`). Re-reading **post-write disk state** (not the intended remote entry) is what
  makes a conflict-copy divergence or a racing local edit show up honestly, the same reason the push
  path re-stats rather than trusting intent (design 01 §6.3, `manifest.ts:112-113`).
- **delete action** → drop the entry, invalidate its cache slot (`hashcache.ts:49`).

This is O(actions), not O(tree). `pull()` already returns the action list (`sync.ts:157` returns
`Action[]`), so the daemon has everything it needs; `doPull()` patches `this.manifest` from that list
instead of calling `scanManifest` at `daemon.ts:188`. The post-apply broad scan becomes
**unnecessary** — we know precisely what changed, and the periodic safety scan (I2) remains the
authority that heals anything we didn't.

Net for a notification-driven pull of a k-file diff on an n-file tree: **from ~2·O(n) walks to
O(k)** stat/hash — with the k diff paths still fully precondition-checked.

### 4.3 A size-aware write scheduler (move 3)

Replace the single flat `poolMap(rest, dlConc, …)` (`apply.ts:80-81`) with a scheduler that splits
writes into two lanes by plaintext size (from the manifest `entry.size`, already present):

- **Bulk lane (many tiny files):** files below a threshold (`SMALL_FILE_BYTES`, e.g. 256 KiB) go
  through a **wider, batched** lane. These are latency/IOPS-bound `open`/`write`/`rename`; batching
  their staging + `rename`s keeps the disk queue full without 64 simultaneous large streams. 65k
  small writes stop competing head-to-head with GB streams.
- **Stream lane (few large files):** files at/above the threshold go through a **narrower** lane
  (small concurrency, streamed straight to temp — `stageEntryToTemp` / `getToFile`,
  `apply.ts:151-154`). Large streamed writes are bandwidth-bound; a handful in flight saturates the
  link, and more only thrash.

The two lanes run concurrently with **independent** concurrency caps; total in-flight is bounded by
the sum, so fd/RSS stay bounded (design 01 §6.0 #4). Both `RBOX_DOWNLOAD_CONCURRENCY`
(`apply.ts:72`) and the new small-lane width stay env-tunable; the split threshold is a constant now,
tunable later. **This changes only the *scheduling* of writes — every write still flows through
`writeEntry` with its full precondition + atomic rename (`apply.ts:98-126`) unchanged.** It is the
fs-apply-phase lever §35's per-phase metrics (`docs/performance-architecture-proposal.md:712-722`)
are needed to size and prove.

## Safety — hard invariants

These are non-negotiable. The narrowing is an optimization on the common path; correctness stays
anchored where it already is.

- **I1 — Per-file preconditions are never weakened.** Every write is guarded by `expectedLocal`
  (`reconcile.ts:14-19`) and re-checked against a fresh re-stat + re-hash at apply time
  (`apply.ts:115-121`); every delete likewise (`apply.ts:192-198`). Narrowing the pre-apply scan
  changes **which paths we scan broadly**, never **whether a written path is precondition-checked**.
  A precondition miss still produces a `.conflict` copy, never a clobber (design 01 §6.2). The
  write scheduler (§4.3) reorders/laned writes but each still runs the identical `writeEntry`
  precondition + atomic rename.

- **I2 — A dropped watcher event is recovered by the periodic safety scan — no permanent blind
  spot.** Narrowing trusts `this.manifest` as `local`. If the watcher dropped an event, that manifest
  is stale for one path. Recovery path, spelled out: (a) if the remote diff touches that path, the
  apply precondition (I1) catches the divergence and conflict-copies it — immediate, correct; (b) if
  the remote diff does *not* touch it, the local edit is simply not pushed **this tick**, and the
  **stat-only safety scan** (`SAFETY_SYNC_MS` ≤ 60 s, `daemon.ts:18,95,197`) re-grounds
  `this.manifest` from full disk truth on its own cadence and the follow-on push publishes it; (c) an
  mtime+size-stable silent edit that even the stat scan misses is caught by the **deep cache-bypassing
  re-hash** (`DEEP_SCAN_MS`, `daemon.ts:19,201-205`). The narrowing removes the *redundant* broad scan
  from the hot path; it does **not** remove the periodic full-truth scans that are the backstop. Blind
  spot duration is bounded by the safety-scan interval, never permanent.

- **I3 — A concurrent local edit during apply is still caught.** The precondition re-stat/re-hash in
  `writeEntry` (`apply.ts:116-120`) and `deleteEntry` (`apply.ts:192-197`) runs at apply time,
  independent of how `local` was produced. An edit landing in the scan→apply (or patch→apply) window
  is preserved as a conflict copy exactly as design 01 §6.2 specifies — including the documented
  irreducible sub-instruction TOCTOU, which this design does **not** enlarge (it does not add any new
  window between the final re-hash and the rename).

- **I4 — Warm no-change pull does no hash pass.** The §4.1 fast path returns before any scan when the
  remote sequence is unchanged. Correctness is trivially preserved (no actions, no writes); the win is
  purely the absence of work. This is the measurable daemon-invisibility target (I2's safety scans
  still run on their own cadence — the fast path only elides the *pull-triggered* scan).

## Files touched

| File | Change |
|---|---|
| `src/cli/sync.ts` | `pull()` accepts optional `localManifest`; warm no-change fast path (return zero actions before scanning) when remote sequence == last-synced; use `localManifest` as reconcile `local` when supplied, else full `scanManifest` (`sync.ts:166`) as today |
| `src/cli/daemon.ts` | `doPull()` passes `this.manifest` as `localManifest`; replaces the post-apply full rescan (`daemon.ts:188`) with an O(actions) in-memory patch of the touched paths from the returned `Action[]` |
| `src/engine/apply.ts` | size-aware write scheduler (bulk vs stream lanes) replacing the single flat `poolMap` (`apply.ts:80-81`); `writeEntry` precondition + atomic rename unchanged |
| `src/engine/manifest.ts` | small helper to patch a `Manifest` from an `Action[]` + touched-path re-stat (reuse `statHashEntry`, `manifest.ts:94`), or reuse `applyWatchEvents` shape |
| (tests) | narrowed-pull correctness, dropped-event recovery, warm no-change, write-scheduler phase timing |

No server, DO, wire-format, or crypto change. No new dependency.

## Benefits

- **Notification-driven pull drops from ~2·O(tree) walks to O(diff).** A 3-file remote commit on a
  65k-file tree stops costing 130k `lstat`s; it costs ~3 stat/hash + 3 precondition re-hashes.
- **Warm no-change pull is near-free** — one `latest()` round-trip, zero filesystem work (I4). Directly
  serves the "no-op daemon tick near zero cost" success metric (`performance-architecture-proposal.md:788`).
- **Large-tree cold pull's fs-apply phase improves** by not thrashing the disk with 65k tiny writes at
  64-wide (§4.3) — the phase §30 measured as a first-order cost of the 433 s pull
  (`perf-improvements.md:527`).
- **Correctness is exactly where it was** — per-file preconditions + periodic full-truth scans
  (I1/I2). No new trust, no weakened guarantee.
- **Deletion test for the scheduler:** remove the lanes and 65k-tiny-file apply regresses on a
  constrained disk while large-file clone is unchanged — the split earns its place or it's cut.

## Validation gate

- **Concurrent-local-edit tests stay green.** The design 01 §6.2 apply-precondition suite (mid-window
  edit → conflict copy, not clobber) passes **unchanged** with narrowed pull, because I1 leaves the
  per-file guard untouched. Add a case that runs the precondition against a **deliberately stale**
  `localManifest` (simulating a dropped event on a remote-touched path) and asserts a conflict copy,
  not a clobber.
- **A dropped watcher event is recovered by the safety scan (I2).** Suppress a watcher event so
  `this.manifest` is stale for a path the remote did **not** touch; assert the narrowed pull does not
  push it, then assert the ≤60 s stat-only safety scan re-grounds the manifest and the follow-on push
  publishes the edit — bounded latency, zero loss.
- **Warm pull with no changes avoids a full hash pass (I4) — measured.** Instrument (via §35 phase
  metrics) a notification/safety pull against an unchanged remote and assert **zero** scan/hash phase
  time (the fast path returned before scanning). Compare against today's `pull()`, which always scans
  (`sync.ts:166`).
- **Large-tree pull fs-apply phase improves — quantified.** With §35 per-phase metrics, re-run the
  §30 corpus (65,421 files) and show the filesystem-apply phase drops under the size-aware scheduler
  vs the flat 64-wide pool, with **byte-identical** cross-host result (`diff -rq` clean, as
  `perf-improvements.md:527`) and no conflict-safety regression.
- **In-memory patch equals a full rescan.** After a narrowed+patched pull, assert `this.manifest`
  equals what a full `scanManifest` would produce for the same disk state (patch fidelity) — the
  invariant the removed `daemon.ts:188` scan used to guarantee by brute force.

## Interactions

- **§35 (client phase metrics) — hard dependency for the gate.** The whole premise (scan and
  fs-apply are the pull-side cost) must be *measured*, per the proposal's "measure before building"
  discipline (`performance-architecture-proposal.md:115-116`) — which already killed three
  speculative builds (`perf-improvements.md:399-411`). §35 supplies the per-phase timers
  (scan stat/hash, filesystem apply — `performance-architecture-proposal.md:712-722`) that both
  justify this design and prove its gate. Do not land §39 without §35's numbers on the §30 corpus.
- **§36 (blob transfer pipeline, proposal C1) — clean seam.** §36 owns the encrypted
  download→decrypt→verify into a plaintext temp; §39 owns what happens next: the **atomic move** into
  place under the precondition (`apply.ts:98-126`) and the **write schedule** (§4.3). The lane split
  is the natural place §36's pipeline hands staged temps to the scheduler. The two compose — §36
  makes each write cheaper, §39 makes the *set* of writes schedule sanely — with no overlap in
  ownership.
- **C6 (local SQLite index) — explicitly NOT a dependency.** This design runs entirely on the current
  in-memory `Manifest` + JSON hashcache. The in-memory patch (§4.2) is an array/map update, cheap at
  today's scales. C6 (`performance-architecture-proposal.md:540-566`) would make that patch and the
  narrowed lookups cheaper at 100k+ files by indexing local state, but §39 needs **none** of it and
  designs **none** of it. If C6 ever lands, §4.2's patch becomes an indexed upsert with zero logic
  change. Keeping §39 SQLite-free is deliberate: it ships the pull win now, without waiting on a
  larger local-state migration.
- **Design 01 (daemon) — this extends, does not rewrite.** §39 reuses the daemon's existing trusted
  manifest (`daemon.ts:47`), incremental patch (`manifest.ts:43-87`), and three-tier drift control
  (design 01 §6.3, `daemon.ts:18-19,95-96`). It removes two redundant scans from the hot path and
  leaves the safety net exactly as designed.

## Open questions for the founder

1. **Scheduler threshold + widths.** `SMALL_FILE_BYTES` split point (256 KiB?), bulk-lane width, and
   stream-lane width — set by §35 measurement on the §30 corpus, or ship sane constants first and tune?
2. **Fast-path aggressiveness.** Gate the warm no-change fast path on `sequence` equality alone
   (cheapest, correct given the DO is authoritative), or also on a manifest-hash compare as
   defense-in-depth against a mis-seeded `lastSyncedSequence`?
3. **One-shot `rbox pull` parity.** Leave the command on the full-scan path (simplest, it has no
   trusted manifest), or let it opt into narrowing from a persisted manifest when one exists? Default:
   leave it — the daemon is where the win lives.
