# 82 - Steady-state sync at O(change): kill the O(N²) encrypt-cache path migration

Status: Design accepted 2026-07-08 on the steady-state profiling evidence
below. Client-only. Target release: the next release after the dev-build A/B
gate in section 6 passes on both fleet hosts.
Origin: post-v0.9.9 profiling of steady-state syncs on the real workspace
(`ws_2b6e15da`, 116,879 files / 98 git repos, Mac WiFi plus wired Linux host).
Related: design 75 introduced the first-publish encryption address cache.
Method lineage: design 79 compress-before-encrypt, design 80 batched blob
transport, and design 81 worker-pool crypto.

This started as a git-lane investigation: 34s of the 84s full join was in git,
and the roughly 6-minute cold small-sync was suspected to be git recapture.
Phase-0 measurement falsified that prior. Warm git-apply is 6.2s / 3.8s. The
real steady-state cost is the encrypt-cache path migration documented here.
This design continues the empirical method of designs 79-81: measure, falsify,
then redesign.

All numbers in this document were measured on 2026-07-08 on the founder's real
workspace unless explicitly marked inferred.

## 1. Problem and evidence

Measured means observed directly on the named 2026-07-08 workload. Inferred
means the estimate follows from those measurements but still needs the
dev-build A/B gate in section 6.

1. **A no-op `rbox sync` took 559.3s wall, measured.** This was
   `RBOX_METRICS=1` with the v0.9.9 compiled binary on the Mac. The phase
   report accounted for only about 62s: latest 6.6s, scan 24.5s, commit 24.4s,
   git-apply 6.2s, and saves 0.4s. All 98 repos were unchanged, at about 110ms
   each. Roughly 497s was invisible to phase timers while the process held 93%
   CPU.
2. **A lone `rbox push` of a 4.7KB change took 700.4s, measured.** This was a
   Bun source run with the daemon stopped. The visible phases were latest 4.3s,
   scan 51.4s, encrypt 0.1s, upload 0.3s, commit 40.9s, and git-apply 3.8s,
   for about 101s accounted. Roughly 599s was unphased. RSS was 9.33GB under
   profiler, versus 2.8GB compiled.
3. **The CPU profile names the burner, measured.** 68.7% of total wall, 481s of
   701s, is self-time in `removePathFromOtherEntries`
   (`src/engine/encrypt-address-cache.ts:141`). It is called from `migratePath`
   (`src/engine/encrypt-address-cache.ts:121`), and the hot call site is
   `encryptAndUpload`'s unchanged-file carry-forward loop
   (`src/cli/sync-recovery.ts:165`, call at `src/cli/sync-recovery.ts:172`).
   For every unchanged file whose ciphertext descriptor is carried forward from
   the base manifest, about 116k per push attempt, `migratePath` calls
   `removePathFromOtherEntries`, which iterates all cache entries, 47,748
   measured, doing `entry.paths.includes(relPath)`. That is about 5.5 billion
   entry visits per push attempt: accidental O(files x cacheEntries). The
   measured cache shape was 47,748 entries, 93,020 total paths, max
   paths-per-entry 513, median 1.
4. **Secondary profile lines are real but dwarfed, measured.** Git subprocess
   spawn self-time was 55.6s across the 98-repo identity, capture, and apply
   floor. Scan hashing was about 24s, `commitSigned` was 12.9s, and
   `memoryUsage` sampling was 9.4s in metrics-only mode.
5. **The quadratic multiplies through the 409-recovery loop, measured.** Pushes
   this slow lose races against routine fleet churn. The other host publishes
   about every 10 minutes from a `build.log` echo; the local daemon publishes
   when dev work moves a repo's git identity. Each 409 causes pull-first
   recovery, a full O(N) pull, a re-scan, and another O(N²) attempt. Observed:
   a CLI push starved for 15+ minutes across 3 attempts. The daemon's own
   steady-state push cycle, using an in-memory manifest and no scan, is about
   3.5 minutes capture-to-publish, so the daemon pays the quadratic every cycle
   too.
6. **The fleet-level effect is tens of CPU-minutes per hour, measured.** In the
   two-device fleet, 1-file changes produced sequences 183->201 in about 100
   minutes, with each sequence causing an O(N) plus O(N²) cycle on both ends.

## 2. Root cause

Design 75 introduced `EncryptAddressCache` so warm first-publish retries could
skip deterministic encryption for blobs already present server-side. That cache
keeps plaintext-sha entries with `paths` as eviction refs. It also maintains an
implicit invariant: each relPath belongs to at most one cache entry.

The invariant is real and must be kept. A path whose content changes must not
remain associated with the old plaintextSha, or the cache-hit freshness check in
`classifyCacheHit` (`src/cli/sync-recovery.ts:110`) can misattribute the path
after it accepts unchanged size and mtime (`src/cli/sync-recovery.ts:114`).

The enforcement is the bug. Today every `migratePath(sha, path)` scans the whole
cache to evict `path` from other entries. On a workspace where steady-state
pushes carry forward almost every file, that turns a path-invariant check into
an O(files x cacheEntries) pass before the push even gets to the remaining
changed file.

## 3. Design - explicit reverse path index

Add a private reverse index to `EncryptAddressCache`:

```ts
#pathOwner: Map<string /* relPath */, string /* plaintextSha */>
```

This makes the existing invariant explicit. The map is built once in the
constructor from parsed entries in O(totalPaths), which was 93k paths in the
measured cache and should take milliseconds. It is not serialized. `toJSON()`
is unchanged (`src/engine/encrypt-address-cache.ts:158`), and the on-disk
format stays version 1.

Load-time disjointness enforcement becomes defined behavior. If a stored cache
has the same path in two entries, legacy or corrupt state, load keeps the first
owner in deterministic sorted-sha order, scrubs the path from later entries,
deletes any entry whose paths become empty, and marks the cache dirty so the
next save self-heals. This is the only behavior change, and it is deliberately
a **lossy corrupt-cache salvage policy** (codex review, finding 2): today's
full scan resolved a cross-entry duplicate lazily in favor of whichever keep-sha
touched the path first, and sorted-first can instead scrub the entry matching
the path's current content. The blast radius is bounded and self-correcting:
the cache is keyed by plaintext sha and `lookup()` never returns `paths`, so a
scrub can never redirect a lookup to a wrong blob; unchanged-file reuse comes
from the base manifest (`baseEnc` in `encryptAndUpload`), not this cache, so
carry-forward is untouched; the worst case is ONE re-encrypt of one file's
content whose only cache entry was scrubbed — and cross-entry duplicates only
arise from legacy writers or a crash between migrate and save in the first
place. Exact-parity alternatives (a duplicate-tolerant multi-owner index) buy
nothing for that rarity and carry permanent complexity.

`removePathFromOtherEntries(relPath, keep)` becomes O(1):

1. look up `#pathOwner.get(relPath)`;
2. if absent or equal to `keep`, return false;
3. otherwise remove `relPath` from exactly that one owned entry;
4. delete the entry if its paths are now empty;
5. `#pathOwner.delete(relPath)`, mark dirty, and return true.

Step 5 is a **delete, never a set-to-keep** (codex review, finding 1):
`migratePath` only evicts a path from other entries — it does not add the path
to the keep entry, and the carry-forward loop calls `migratePath` without
`record`. Ownership is established exclusively by `record()`, which actually
adds the path to an entry. (Post-scrub the distinction is also unreachable in
the set direction: if the keep entry contained the path, the invariant means no
other entry did, so the owner lookup would have returned `keep` and exited at
step 2.)

Two implementation invariants, explicit so a future refactor cannot silently
break them (opus review, Q3/Q7):

1. **Mutators stay synchronous.** `record`, `migratePath`, `prune`, and
   `removePathFromOtherEntries` contain no `await` today, which is what makes
   the entries-map and reverse-map updates atomic with respect to the Bun event
   loop (the encrypt poolMap workers interleave only at their own `await`s,
   never inside a cache mutation). No `await` may ever be introduced between an
   `entries` mutation and its paired `#pathOwner` mutation.
2. **The load-time scrub is sorted and conditionally dirty.** `parseStored`
   iterates JSON insertion order today; the scrub must sort the plaintext-sha
   keys before choosing a keeper, or "first owner" is deterministic-per-file
   but not the sorted order this document promises. And it must `markDirty()`
   only when it actually scrubbed a duplicate — an unconditional dirty would
   make every load rewrite the cache file.

Every mutation site keeps the entries map and the reverse map in lockstep. There
are exactly four:

1. `constructor` / load builds the reverse map and scrubs duplicates
   (`src/engine/encrypt-address-cache.ts:89`);
2. `record()` sets `#pathOwner.set(entry.path, plaintextSha)` after its
   existing migrate-plus-merge logic (`src/engine/encrypt-address-cache.ts:99`,
   with current callers at `src/cli/sync-recovery.ts:195`,
   `src/cli/sync-recovery.ts:222`, and `src/cli/sync-recovery.ts:286`);
3. `migratePath()` delegates to the O(1) `removePathFromOtherEntries`
   (`src/engine/encrypt-address-cache.ts:121`);
4. `prune()` deletes reverse entries for every path it drops
   (`src/engine/encrypt-address-cache.ts:127`). Two call sites: the
   encrypt-path finally block (`src/cli/sync-recovery.ts:370`) and the no-op
   push scrub `pruneEncryptAddressCache` (`src/cli/sync-recovery.ts:121`,
   called from `src/cli/sync.ts:523`) — the tests in section 5 cover both.

Public API, caller behavior, semantics, and on-disk format do not change. This
is a data-structure fix. Callers such as the `sync-recovery.ts` carry-forward
and encrypt paths keep their current ownership and flow.

Expected effect, inferred and gated in section 6. One basis note first (opus
review, finding 2): the 51.4s scan and 40.9s commit in the profiled run are
Bun-source-under-profiler numbers; the compiled binary measured 24.5s scan and
24.4s commit on the same workspace the same day. Gate arithmetic uses the
compiled basis. A compiled steady-state push should land around 80-110s
(latest ~4s, scan ~25s, git-plan ~15s, address ~2s, commit ~25s, git-apply ~4s,
plus state-load/missing/misc), from 700s. A compiled no-op sync should land
around 100-110s (two scans ~49s, commit ~24s, latest ~7s, git phases ~20s),
from 559s. The daemon cycle falls from about 3.5 minutes to under about 1.5
minutes. Shorter pushes also shrink the 409 collision window, so recovery loops
mostly stop happening at all; the fix compounds.

## 4. Instrumentation - phase the invisible zone

In the measured `rbox push`, 599 of 700 seconds were invisible to the phase
report. That is how the quadratic shipped and survived. A report whose phase
walls cover about 14% of process wall gives the slow path a false alibi.

This design adds the missing phase boundaries. Both reviews independently
flagged that the first draft's two phases left the next-largest unphased blocks
undeclared (the 47MB `state.json` parse and the ~116k-sha `missingBlobs` round
trip), which would have made the acceptance bar fail for reasons unrelated to
the fix. Four phases, then:

1. `address` — the carry-forward plus address-cache section of
   `encryptAndUpload`. Record counts for files carried, cache hits, and cache
   misses.
2. `git-plan` — `planGitSections` at the push attempt call site
   (`src/cli/sync.ts:483`). Capture already logs per-repo bytes but has no
   phase timer; the design-81 explore pass flagged this too.
3. `state-load` — every `loadState` call on the sync path (`src/cli/sync.ts`
   pull, push, and per-attempt sites; the 47MB parse runs once per attempt).
4. `missing` — the `api.missingBlobs(encShas)` round trip
   (`src/cli/sync-recovery.ts:231`), currently invisible between the encrypt
   and upload phases.

Also confirm the push-side `saveState` is attributed to the existing
`state-save` phase, and extend `PhaseName` and `PHASE_ORDER` in
`src/engine/phase-report.ts` (closed union) with the four new names in
execution order: `latest, state-load, scan, git-plan, address, encrypt,
missing, upload, commit, download, decrypt, apply, git-apply, cache-save,
state-save`.

Acceptance: with `RBOX_METRICS=1`, the sum of phase walls on a steady-state push
accounts for at least 85% of process wall, versus about 14% today; ~90% is the
expectation, and the known residual (ignore-matcher build, two `diffManifests`
passes, spinner) is the allowance between them. If measurement shows that
residual above ~15%, phase it rather than lowering the bar.

## 5. Tests

Unit coverage:

1. Reverse-index and `paths` array consistency after every public mutation:
   record fresh, record duplicate-content path move, `migratePath` hit,
   `migratePath` miss, prune partial, and prune total. Assert through a
   test-only invariant checker that walks entries and compares against the
   reverse map.
2. Load-time scrub: stored JSON with one path in two entries loads with exactly
   one owner, deterministically the first in sorted-sha order, `needsSave` true,
   and the next save round-trips clean. A clean cache loads with `needsSave`
   false (the scrub must not dirty unconditionally).
3. Both prune paths: the encrypt-path finally-block prune AND the no-op push
   scrub (`pruneEncryptAddressCache`) drop reverse mappings — after either, a
   `migratePath` of a pruned path returns false.

Behavior parity:

1. Existing encrypt-cache tests pass untouched.
2. Existing sync-recovery suites pass untouched.

Performance guard:

1. The section 6 dev-build gate is the performance test. It is deliberately not
   a CI timing test because CI boxes cannot hold these timing SLOs.

## 6. Dev-build gate

Before any PR merge or release, run the same discipline as design 81: A/B on
both fleet hosts, compiled dev build versus v0.9.9, serialized so both hosts are
never running the benchmark at once on the shared WAN.

1. Mac, real workspace, daemon stopped for the run:
   `RBOX_METRICS=1 rbox push` with a 1-file touch. Pass: wall <= 150s, from
   700s (compiled-basis projection is 80-110s; 150-180s means investigate
   before merging, above 180s fails), and the `address` phase is visible and
   <= 5s.
2. Linux host, real workspace replica, steady state: same A/B, same numeric
   gate: wall <= 180s (the Linux single-core is weaker than the M-series and
   extra cores do not help the single-threaded path; the baseline burn is the
   same 481s shape) and `address` <= 5s.
3. No-op `rbox sync` A/B on Mac. Pass: <= 120s, from 559s. Arithmetic on the
   compiled basis: two scans ~49s + commit ~24s + latest ~7s + git phases ~20s
   + state/address/missing ~10s ≈ 110s, so 120s is tight but honest.
4. Correctness: full `bun test` green; encrypt-cache JSON after an A/B pair of
   pushes is semantically identical, same entries/paths modulo scrubbed
   duplicates; one file-move rename syncs correctly end-to-end across hosts,
   exercising `migratePath`'s actual purpose.
5. Daemon soak: restart both daemons on the dev build and observe one natural
   churn cycle each. Pass: capture-to-publish gap from `daemon.log` <= 90s.

### 6.1 Gate results (run 2026-07-08, dev build 0.9.9-dev+30e7359)

All runs on the real workspace, daemons stopped, hosts serialized on the shared
WAN. The clean compiled Mac baseline came in well under the phase-0 numbers
(204.1s vs the 700s bun-source/profiler run and the 559s contended sync — the
quadratic burn is machine-state and cache-size dependent), so the deltas below
are against same-day, same-conditions baselines.

1. **Mac push (gate 1): PASS.** Baseline v0.9.9: 204.1s wall for a 42B change
   (~185s unphased). Dev: **54.3s** (<= 150s), `address` **0.1s** (<= 5s),
   phase coverage **98.7%** (>= 85%). Phases now visible: git-plan 24.2s,
   commit 17.5s, scan 7.3s, missing 4.1s.
2. **Linux push (gate 2): PASS.** Baseline v0.9.9: 60.4s — the quadratic is
   small on this host because the encrypt cache only grows on the ENCRYPTING
   device: the Mac (original full publisher) holds 47,748 entries / 17MB, the
   Linux replica 5.4KB. Dev: **29.2s** (<= 180s), `address` 0.1s, coverage 96%.
   The fix matters most exactly where a workspace was born.
3. **Mac no-op sync (gate 3): PASS.** Dev: **42.9s** (<= 120s), 98.6% phased.
   Correction to the phase-0 read: the 559s "no-op" sync was actually carrying
   worktree churn (a true no-op short-circuits before `encryptAndUpload`, so
   the quadratic never ran on no-ops — it ran on every *changed* push, which
   the daemon does constantly).
4. **Correctness (gate 4): PASS.** `bun test ./src/` 867/868 (the 1 fail is the
   known-local json-output account-fields environmental); typecheck green. A
   clean cross-host rename applied as exactly 1 written + 2 deleted, and the
   cache entry migrated to own only the new path. Full-cache disjointness audit
   on the real 47,757-entry Mac cache after the dev runs: **0 duplicate paths**.
5. **Daemon soak (gate 5): PASS.** Both daemons restarted on the dev build.
   Mac: cold start to first catch-up publish 63s (worst case — includes the
   initial full scan), then steady cycles publishing ~60s apart under active
   churn (v0.9.9 cycle was ~3.5 min). Linux: post-pull to publish ~25s.
   Cross-host propagation (Mac publish to Linux pull applied) ~15s. All
   <= 90s.

One anomaly logged for the record: two consecutive HTTP 500s from the prod API
during the first dev-arm push attempts (failing at blob upload), not
reproduced on any subsequent run (all-200 wrangler tail on the passing run,
v0.9.9 pushed fine in between). Treated as a transient server blip; watch for
recurrence during the soak/release window.

## 7. Non-goals

1. **Scan cost.** A scan is 51.4s, and CLI sync can run about 2 scans. Future
   work: incremental scan or daemon-fed mtime cache reuse for CLI runs.
2. **Commit envelope O(N).** Commit was 40.9s. A full about-47MB manifest is
   re-encoded, re-encrypted, and re-uploaded per commit; `latest` also
   re-downloads and re-parses it per pull. Future work: manifest delta encoding.
   This is big but separable.
3. **Git subprocess floor.** Spawn self-time was 55.6s across capture, identity,
   and apply on 98 repos. Future work: batch probes or cache identity by
   stat-fingerprint on the PUSH path the way `git-divergence.json` already does
   for status.
4. **The `build.log` echo loop.** A 1-file publish every 10 minutes fleet-wide
   is content hygiene, not engine work. It is not this design.
5. **Cold join / cold small-sync git costs.** This was the original target and
   was falsified as the primary cause. Revisit only after this ships and
   re-measurement isolates what remains.
6. **RSS.** The compiled steady-state process was 2.8GB. It is worth a look
   someday, but not in this design.

## 8. Lessons

Phase timers that cover 14% of wall time are worse than none. They gave the
9-minute sync a 62-second alibi. Instrument the gaps that did not look
important.

The O(N²) path shipped inside a cache added for performance in design 75.
Performance machinery needs the same profiling scrutiny as the paths it
accelerates.

Profile the real workspace, not just synthetic corpora. A shape like 47k cache
entries times 116k files only exists at fleet scale.
