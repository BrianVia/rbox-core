# Changelog

All notable changes to rbox are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions map to the
`v*` git tags that trigger the CLI release build.

## [Unreleased]

## [1.2.0] — 2026-07-12 — the Mac gets fast: bulk scans, working fold evidence, field-proven trust recovery

Same-day follow-through on v1.1.0: everything that shipped dark yesterday is
now field-verified and on, plus the macOS performance sprint.

### Improved (measured on the live fleet)
- **macOS scans: per-file stat eliminated (design 107, #241).**
  `RBOX_SCAN_BULK=1` (darwin-only) walks directories with one
  `getattrlistbulk` syscall instead of ~118k `lstat`s — warm full scan
  **5.5s → 3.1s bench, 3.9s pull-scan / 2.0–3.2s safety-scan live**, with
  value-identical attributes (0 parity mismatches across the full corpus)
  and per-directory fallback on any FFI failure.
- **Manifest fold evidence works everywhere (design 84 r2+r3, #234/#238).**
  Same-head pulls fetch ZERO blobs; multi-link pulls fetch only the new
  suffix; chronic git-repo deferral (linked-worktree branches) no longer
  suppresses evidence — receiver manifest reads are **0.4–1.5s fleet-wide**
  (were 4.5s legacy / up to 21s broken-fold), and delta writes work on every
  host. Fold hot path: streaming canonical hash, each manifest verified
  exactly once per walk, memory bounded.
- **Watcher trust recovery field-confirmed (design 104).** The Mac's
  transient FSEvents drops now cycle suspect → re-trusted-behind-unpruned-
  scan instead of pinning full rescans at a 60s floor for the daemon's
  lifetime.
- **Pruned safety scans (design 85 Layer A, #236).** `RBOX_SCAN_PRUNE=1`
  reuses ctime-keyed directory listings (~24% scan cut; readdir share);
  deep scans stay unpruned as the drift backstop; pruned scans can never
  testify for watcher re-trust.

### Fixed
- **GC Phase-1 lifecycle (#235/#237/#239):** mark/purge are now cursored and
  fit D1's subrequest budget (previously: marks accumulated unboundedly —
  230k stale rows — and purge threw mid-page while misreporting success);
  the fence probe is robust to any mark-table size (enforce falls back to
  full validation whenever the probe is skipped — never silently unfenced);
  operator drain tooling gained grace parity with the cron and honest
  failure reporting. Backlog drained: 228,962 stale marks, 35.3GB of
  accounting released.

### Added
- **Machine-readable design-102 soak gate** (#232): `GET /v1/admin/delta-soak`
  (platform secret) exposes divergence/fallback/admission AE aggregates.
- **Cross-host propagation analyzer** (#240):
  `bun scripts/propagation-report.ts <originLog> <receiverLog>` — first fleet
  numbers: publish→apply p50 16.7s over 233 events, zero staleness
  incidents.

## [1.1.0] — 2026-07-12 — manifest deltas, watcher trust recovery, self-draining GC

The performance program's second checkpoint, hours after v1.0.1.

### Added (flag-gated, default off — staged per-host rollout with measurement)
- **Manifest delta encoding (design 84, #231).** The end of the constant
  39–41MB manifest transfer: zstd snapshot envelopes (`RBOX_MDE_SNAPSHOT`,
  measured **24×** smaller), O(change) delta commits (`RBOX_MDE_DELTA` — a
  one-file change ships ~KB), and head-blob-only fast pulls
  (`RBOX_MDE_FAST_PULL`). Chain-verified reads with exact-list matching, a
  pin-as-parent repair transaction (`rbox recover --repair-chain` + doctor
  check), fail-to-snapshot semantics on every delta trigger. Server chain
  acceptance is unconditional and additive — old clients are unaffected.
- **Watcher trust recovery (design 104, #229).** With `RBOX_WATCHER_RETRUST=1`,
  a transient macOS FSEvents overflow no longer permanently distrusts the
  watcher (which pinned full 116k-file rescans to a 60s floor — measured ~11%
  continuous I/O duty on the Mac). Transient drops now enter a suspect state
  that re-earns trust behind an unpruned safety scan, with a drop fuse
  preserving today's behavior under sustained failure.

### Changed
- **Scheduled GC purge enabled (#228).** The founder-supervised drain
  completed (5,410 blobs / 4.29GB reclaimed); the daily fenced cron now
  drains the remaining candidates as they age past the 7-day grace.

### Telemetry
- **Multipart transfer decomposition (design 101 Phase 0, #230)**: per-part
  walls/gaps/completion (client) + additive `serverTimings` with the
  whole-object verification reread isolated (server), plus a read-only
  multipart/staging orphan inventory for the platform operator.
- **First-publish stage decomposition (design 98 §5.1, #226)** emitted on
  both the serialized and pipeline paths with one schema.
- **Design 105 (merged design):** the existing WebSocket notify channel is
  formalized; its reliability fixes (pong deadline, jittered backstop pull,
  session cap) are specified and sequenced for implementation next.

## [1.0.1] — 2026-07-12 — performance program checkpoint: instant preflights, fused crypto, full sync telemetry

The first checkpoint of the sync-performance program (designs 97–103). Two
improvements are live by default or via fleet flags; the rest ship dark
(flag-gated, default off) pending their measurement gates.

### Improved
- **Change-only blob preflight (design 103 Part B, #218).** With
  `RBOX_PREFLIGHT_DELTA=1`, a push checks only the blobs it introduced (plus
  any 422-recovery residue) instead of the whole workspace — measured
  **2.8–4.0s → 0.1s** on a 114k-file workspace. Includes the fix that threads
  the server's unsatisfied-blob list through retry (previously dropped), a
  capped recovery accumulator with a chunked full-audit fallback, and
  `RBOX_PREFLIGHT_FULL=1` to force the full audit.
- **Instant rejection of stale commits (design 103 Part A, #218/#219).** The
  server now 409s an already-stale commit in ~0.1s instead of ~6s of admission
  work, cutting conflict-retry storms (previously 12–42s of added wall).
- **CLI usability fixes (#203).** `rbox restore` is now trash-tier-backed
  (undoable); uninstall warns about the keystore; assorted audit fixes.
- **Torn-scan hardening (#205).** Same-size edits with restored mtimes are
  re-hashed (ctime joins the fingerprint); mid-hash instability defers a file
  instead of publishing a torn read.

### Added (flag-gated, default off — awaiting measurement gates)
- **Fused crypto worker jobs (design 99, #224).** `RBOX_CRYPTO_FUSE=1` batches
  small-file encryption into byte-bounded in-memory jobs under a budget with a
  contention-bounding dispatch cap — **79.7% encrypt-wall reduction** on the
  production path in rig A/B (95% CI [77.2%, 86.5%]), byte-identical
  ciphertext. Fleet first-publish gates pending.
- **Overlapped first-publish pipeline (design 98 Tier 1, #225).**
  `RBOX_PUBLISH_PIPELINE=1` overlaps encrypt → upload → receipt redemption
  with reservation-based disk backpressure, an error-latched receipt drainer,
  and a two-barrier abort protocol. Serialized remains the default until the
  Workload-B gates hold.

### Telemetry (numbers-only; no file names or paths, ever)
- **Server commit decomposition rendered in push lines (#207/#213):**
  `srv/env/acct/ssc/cm/mir/rsp` tokens — this measurement attributed ~87% of
  commit-POST time to D1 ref admission and now feeds the design-102 shadow
  soak.
- **Join/apply decomposition (design 100 Phase 0, #223)** and **first-publish
  stage decomposition (design 98 §5.1, #226)** — gate evidence is emitted by
  the binary, not hand-timed.
- **Scan-site stats, per-dir probe, deep-scan drift audit (design 85 P0,
  #208)**, with `RBOX_METRICS` now **default-on** (opt out: `RBOX_METRICS=0`;
  measured worst-case scan overhead ≤3%).

## [1.0.0] — 2026-07-10 — the correctness milestone

rbox reaches 1.0. The three correctness pillars are now field-proven fleet-wide:
head authority (design 91) makes the commit chain un-forkable, manifest entry
integrity (design 92) makes a push poison-proof and pulls self-healing, and git
config sync (design 93) carries remotes and branch tracking with the repo. No
functional changes over 0.9.18 — this release is the version bump that marks the
milestone.

## [0.9.18] — 2026-07-10 — git config sync (design 93): remotes and tracking travel with the repo

### Added
- **Git config sync (design 93) (#192).** A repo's remotes and branch-tracking
  configuration now sync with its state — clone on a fresh machine and
  `git fetch`/`git push`/`git pull` work without re-adding remotes by hand.
  Config is embedded from a stability-bracketed snapshot at capture and applied
  through a locked, optimistic-CAS config transaction, so a concurrent editor or
  a mid-write power loss can never leave a partial config; the carry-base rule
  means a config that can't be represented is preserved byte-for-byte rather than
  stripped. Credential-bearing remote URLs are skipped (with a loud per-repo
  log). `rbox status` gains a `config:` line. Host-identity resolution degrades
  safely to the legacy path where it can't be established.

### Changed
- **Per-repo git-sync lines collapse into one progress counter (#191).** `rbox
  sync`/`rbox pull` used to print one stderr line per repo during apply — alarming
  at scale and easy to misread as failures. The default now shows a single
  "git sync ran for N/total" counter; real conflicts/warnings still print
  immediately. `--verbose` restores the per-repo dump. `rbox pair` also gains a
  single-keypress `[c]` token copy and corrected setup wording.
- **RboxBar shows total synced size instead of the sequence number (#190).** The
  dropdown's secondary status line now reads a human-readable size (e.g. "15 GB")
  computed from the daemon's in-memory manifest, falling back to "seq N" for
  older daemons in a mixed-version fleet.

### Fixed
- **Design-93 rollout hardening (#193, #194).** Config-sync wire bounds raised
  after field calibration (#193); the fingerprint cache is invalidated when those
  bounds change and invalid incoming config fields are ignored, and the config
  reader degrades rather than failing on unexpected input (#194).

## [0.9.17] — 2026-07-09 — download self-heal + CLI hygiene + calmer menu bar

### Fixed
- **A full join no longer hard-fails on a corrupted blob download (#187).** Under
  sustained high-concurrency load a large-body fetch could reassemble corrupt
  bytes; content-addressing already caught it, but rbox aborted the whole sync
  instead of re-fetching. `getBlobToFile` now bounded-retries on an integrity
  mismatch with backoff (the re-fetch lands as the pool drains into the reliable
  low-concurrency state), via a typed `BlobDownloadIntegrityError` that logs the
  recovery; persistent corruption still fails loudly with no partial file left
  behind.
- **`rbox track` reuses your logged-in identity and forwards the workspace name
  (#186).** Tracking a directory while logged in used to mint a fresh random
  device id (polluting local config and the server roster); resolution order is
  now `--device` > previous config > logged-in credential's device id > mint.

### Changed
- **RboxBar dropdown calmer and files-first (#185).** A degraded state (no user
  action needed) drops the card for a dim one-line status; critical states keep
  the card and carry a per-reason remedy. File count becomes the primary datum,
  the footer shows daemon version and hostname, and a six-hour update check
  renders a dim "Update available" row that copies the install command. Daemon
  status gains additive fields (fileCount, daemonVersion, workspaceRoot) so old
  and new bars interoperate.
- **`RBOX_API` endpoint overrides now warn loudly (#186)**, so a stray override
  can't silently point rbox at the wrong server.

## [0.9.16] — 2026-07-09 — manifest entry integrity (design 92): poison-proof push, self-healing size, fail-closed carry

### Fixed
- **Manifest entries can no longer be poisoned, and pulls self-heal (design 92)
  (#184).** Encrypt verify-defers an entry whose bytes changed mid-capture rather
  than recording a mismatched address; a diff heals a stale entry size instead of
  trusting it; carry is fail-closed (a base entry that can't be verified is
  carried, never silently dropped); and apply verifies a blob before it displaces
  a local file. Field-gated after real zstd-gated poison findings. The
  simplification pass also removed a ~500k-lstat ancestor walk from a 123k-file
  pull.
- **RboxBar finds its resource bundle when installed (#183)**, so the menu bar app
  renders correctly from an installed copy rather than only from the build tree.

## [0.9.15] — 2026-07-09 — self-clearing watcher-degraded status + native menu bar app

### Added
- **Native RboxBar menu bar app (design 88 UI) (#177).** A SwiftUI `MenuBarExtra`
  app (macOS 14+) replaces the SwiftBar shell plugin, reading the same atomic
  daemon status files with no daemon round-trips. It mirrors the prompt-status
  verdict rules exactly (15s staleness, absent/corrupt → dead, graceful paused
  stays paused), reproduces the synced/syncing/attention states theme-aware for
  light and dark, uses a custom R-monogram icon with a state badge, and is
  multi-workspace aware.

### Fixed
- **A transient FSEvents drop no longer pins the status on "attention" until a
  daemon restart (#182).** A dropped-events window is covered by a completed
  full/deep scan, which may now clear the watcher-degraded flag — guarded by an
  error-generation counter (no new watcher error since the scan began) and a live
  watcher (a periodic-scan fallback stays degraded). Found dogfooding RboxBar.

## [0.9.14] — 2026-07-09 — commit-fork recovery (`rbox recover`) + un-regressable head (design 91)

### Added
- **`rbox recover`** — a supported, one-command re-baseline when a workspace's
  local head pin has diverged from the server (reset the pin, re-verify the
  server chain, reconcile local files via keep-both, re-push local diffs).
  Replaces the need to hand-delete a keystore pin file. (The former phrase
  re-enrollment moved to `rbox key recover`.)

### Fixed
- **The commit sequencer can no longer fork under a Durable Object restart
  (design 91).** The workspace head is DO-authoritative and fail-closed: a
  missing head with evidence of prior life serves `repair_required` instead of
  reseeding from the best-effort D1 mirror (the reseed was what let a
  deploy-triggered DO restart re-issue an already-used sequence and fork the
  chain). Server-side same-sequence equivocation is now rejected. The server
  fix deployed with the prior `apps/api` push; this release ships the client
  `rbox recover` companion.

## [0.9.13] — 2026-07-08 — join/populate reliability (design-87 dogfood fixes)

### Fixed
- **Populate pulls can no longer hang silently on a lost blob completion.**
  Request-level settlement tracking in the batch downloader, size-aware total
  deadlines on every blob fetch, and a stream-progress-aware stall watchdog:
  90s of no progress logs the outstanding blobs and retries them (fail-silent
  duplicates — a failing retry never kills a request the primary may still
  deliver); persistent stalls fail loudly with a resume hint. Resume already
  re-fetched exactly the missing blobs.
- **Keyed setup persists credentials** (mode 600), so `--daemon` joins survive
  the invoking shell and reboots; `rbox key materialize` remains env-only.
- **`rbox status` and the prompt are honest during an initial populate**:
  a versioned populate marker renders "initial sync in progress — N/M files"
  instead of claiming 120k phantom local changes with sync not running.

New env knobs (documented in docs/development.md):
`RBOX_PULL_JOIN_WATCHDOG_MS`, `RBOX_PULL_JOIN_WATCHDOG_MAX_FIRINGS`,
`RBOX_NET_BLOB_MIN_TIMEOUT_MS`, `RBOX_NET_BLOB_MAX_TIMEOUT_MS`.

## [0.9.12] — 2026-07-08 — ambient sync status (design 88)

### Added
- **Ambient sync status (design 88).** The daemon maintains an atomic
  `daemon.status.json` beside its pidfile (5s heartbeat, ownership-gated,
  early-paused on graceful stop); `rbox prompt-status [--json]` reads it with
  staleness-as-death semantics (a killed daemon shows `! dead` within 15s);
  the zsh prompt's staleness window tightens 180s → 15s on the new heartbeat;
  `contrib/swiftbar/rbox.5s.sh` ships the macOS menu bar MVP with a
  Status / File / Progress dropdown, pause/resume, and log tail.

## [0.9.11] — 2026-07-08 — git-plan at O(change) (fingerprint cache) + phase-0 instrumentation

### Fixed
- **git-plan no longer spawns ~13 git subprocesses per unchanged repo
  (design 83).** `planGitSections` consumes the `git-divergence.json`
  stat-fingerprint cache via a shared publish-grade v4 fingerprint
  (content-hashed HEAD/refs/small-index, ctime, 2s racy-clean margin,
  per-decision memoization) with a base-carry-only fast path and a
  baseless-worktree-pointer pre-skip. Measured on the real workspace:
  git-plan 24–43s → 4.0s (Mac) / 0.9s (wired Linux); daemon no-op tick
  25–63s → 4.5–4.8s (Mac) / 1.5s (Linux); no-op CLI push 41s → 10.2s.
  Cache file v2 → v3 (old caches self-heal with one cold plan).
- **Git identity probes are side-effect-free.** `git write-tree` rewrites
  the index file on every invocation; probes now run it against a temp
  index copy (`GIT_INDEX_FILE`), so rbox's plan/status probes no longer
  churn index files in tracked repos.

### Added
- **Commit/latest/scan sub-step instrumentation (designs 84/85 phase-0).**
  `RBOX_METRICS=1` phase lines now decompose commit
  (refresh/sidecar/encode/encrypt/upload/post + encBytes), latest
  (download/decrypt/parse), scan (readdir/stat/matcher/hash/sort + walked/
  statted/hashed/cache-hit counts, cumulative across 409-retry rescans),
  and git-plan (fpHits/fpMisses/fpUntrusted/pointerPreSkips/spawnedRepos).

## [0.9.10] — 2026-07-08 — steady-state sync at O(change) (encrypt-cache reverse path index)

### Fixed
- **Steady-state pushes no longer pay an O(files × cache-entries) scan
  (design 82).** The encrypt-address cache migrated every unchanged file's
  path with a full-cache scan — ~5.5 billion entry visits per push on a
  116k-file workspace with a 47k-entry cache, 481s of a 700s push, invisible
  to phase timers. Path migration is now O(1) via a reverse path index (same
  on-disk format; legacy duplicate paths self-heal on load). Measured on the
  real workspace: Mac push with a 1-file change 204s → 54s, Linux 60s → 29s,
  no-op sync 43s, daemon publish cycle ~3.5 min → 25–63s.

### Added
- **Phase coverage for the formerly-invisible sync zone (design 82 §4).**
  New `state-load`, `git-plan`, `address` (with cache hit/miss detail), and
  `missing` phases in `RBOX_METRICS=1` reports — phase walls now account for
  96–98.7% of push wall (was ~10–14%), so a regression like this can't hide
  again. Disabled reports are now a shared allocation-free singleton, so the
  no-op daemon tick stays free.

## [0.9.9] — 2026-07-08 — worker-pool crypto (real cores for blob encrypt/decrypt)

### Added
- **Worker-pool crypto (design 81).** Blob encrypt and decrypt now run on a
  pool of Bun workers (default `min(cores−2, 16)`, memory- and fd-aware;
  `RBOX_CRYPTO_WORKERS` overrides, `0` disables). The pool is lazy — small
  syncs below 8 crypto jobs stay inline — keyed to the workspace key epoch,
  and idles out after 60s. Ciphertext output is byte-identical to the inline
  path. If workers can't start (e.g. a broken binary), rbox falls back to
  inline crypto and `rbox doctor`/`rbox status` surface the degradation.
  Measured on a 32-core Linux host (105k-file first publish): wall
  27.5 min → 10 min, encrypt phase 5.5x, join decrypt lane 10% → 1%,
  zero small-push regression, full-corpus byte diff clean.

## [0.9.8] — 2026-07-08 — batch slot defaults from the capstone curves

### Changed
- **Batch transport slot defaults raised: downloads 16→48, uploads 8→24.**
  Cloudflare Workers cap parallel subrequests per invocation (~6), so a
  32-record batch settles in ~1s regardless of size — concurrent batch
  requests are the linear throughput lever. Measured on the v0.9.7 capstone:
  publish 83s→39s (8→24 put slots, A/B corpus, WiFi); full-corpus wired join
  128s→84s (16→48 get slots; 64 is flat — the knee is 48). `RBOX_BATCH_SLOTS`
  / `RBOX_BATCH_PUT_SLOTS` still override.

### Fixed
- Push lane timing no longer double-counts batched blobs
  (`ownsUploadLaneTiming` is now forwarded through the E2EE remote wrapper,
  and ownership is exclusive).

## [0.9.7] — 2026-07-08 — compress-before-encrypt + batched uploads

### Added
- **Compress-before-encrypt (design 79), default ON.** Blob payloads are
  zstd-level-3 compressed before AES-GCM when it pays (≥128 bytes and >5%
  smaller; media/archives stay raw automatically) — measured 2.17x
  byte-weighted across a real 6 GiB workspace, 4.9x on source-heavy corpora.
  Key/nonce derive from the sha of the exact encrypted bytes (`payloadSha`),
  so raw blobs stay bit-identical to 0.9.6 and nonce reuse is impossible by
  construction. Compressed manifests stamp `manifestSchema: 4`; older clients
  refuse them with one loud "upgrade rbox" error (validation now runs at the
  manifest decode boundary, covering pull, versions, and restore alike).
  Decompression is capped at each entry's declared size. Opt-out:
  `RBOX_COMPRESS=0` (new encryptions only). **Upgrade all machines in a
  workspace (and restart daemons) before the first push from this version.**
- **Batched blob uploads (design 80).** Small ciphertexts ride
  `POST /v1/blob-batch/put` — up to 32 per request, receipts-only, parallel
  R2 server-side with per-record results, receipts preserved via
  `Promise.allSettled`. The client coalescer mirrors the download side
  (same-sha waiter coalescing, pull-first dispatch with a 10ms tail flush,
  single-PUT fallback on old servers / per-record failures); the upload pool
  scales to 512 when batching. Kills the measured ~125 blobs/s per-request
  upload floor. Kill switch: `RBOX_BATCH_BLOBS=0`.

### Performance
- The design-79 A/B that motivated both features (17.5k files / 570 MB,
  WiFi): compression cut wire bytes 79% while walls stayed flat — proving
  small-blob transfer is request-bound, not byte-bound. Batching removes the
  request floor; compression then cuts the remaining bytes. Combined
  measurements land in the design docs after the release capstone.

## [0.9.6] — 2026-07-07 — batched downloads + parallel git materialization

### Added
- **Batched blob downloads (design 77 P1).** Small encrypted blobs now ride
  `POST /v1/blob-batch/get` — up to 32 per request under the §27 download
  grant (one verification, zero D1 on the happy path), streamed back as
  binary frames in completion order. The client coalescer fills batches
  pull-based from a supply-scaled download pool; large blobs keep the
  streaming single GET. A fresh join now issues ~3k requests where it issued
  ~93k. Kill switch: `RBOX_BATCH_BLOBS=0`.
- **Parallel git materialization.** Pull-side git apply runs repos through a
  bounded pool (`RBOX_GIT_APPLY_CONCURRENCY`, default 6) over nesting-safe
  chains, with per-store locking for worktrees sharing a common git dir.
  Measured: the ~98-repo git phase of a fresh join dropped from ~85s serial
  to ~34s.
- **Push-side lane timing.** `RBOX_LANE_TIMING=1` now attributes push wall
  time to encrypt vs upload, mirroring the pull instrument.

### Performance
- Fresh join of a 96k-file / 4.9 GiB workspace, measured end to end on the
  same hardware: **118s**, vs ~200s before this release and ~30 minutes two
  days ago. Server-side (already live for all clients): grant-authenticated
  blob reads skip the per-request D1 queue entirely (§27 Amendment A).


## [0.9.5] — 2026-07-07 — index resolve-undo fix

### Fixed
- **Repos with old merge-conflict residue no longer defer forever on
  receivers.** An index resolve-undo extension pointing at unreachable
  conflict blobs failed every receiver's post-apply fsck. Snapshots now
  strip it at capture, and apply clears it before fsck (existing stuck
  sections heal without a re-capture).

## [0.9.4] — 2026-07-07 — the performance sprint

### Added
- **Incremental git sync (design 53).** Repos with a synced base ship
  history increments instead of full bundles — measured 0.024% of the
  full-bundle bytes per change. Default on; `git.incremental: false`
  opts a workspace out. The first chained capture moves the workspace to
  manifest schema 3 (older clients must upgrade — clean break).
- **Instant status (design 69 §3.4).** With a live, settled daemon,
  `rbox status` answers from the daemon's published counts in ~50ms
  (was ~8s on a 130k-file tree) — and falls back to the full scan on any
  trust-predicate miss, never to wrong output.
- **Live byte progress (design 73).** Transfers render dual fractions
  (`uploading 126,352/126,369 · 4.1/6.3 GiB`); git capture shows
  cumulative bytes sent. Multi-GB uploads no longer look like hangs.
- **Pull instrumentation + faster fresh joins (design 74 Phase 0).**
  The pull's git-apply tail is now measured per repo, and download
  concurrency defaults to 128 (recorded sweep: ~25% faster on big
  materializations).
- **First-publish encrypt cache (design 75).** Retrying a large first
  publish re-encrypts only what the server is actually missing, instead
  of the entire workspace.
- **No more silent network wedges.** Small control requests carry a 60s
  deadline with the established retry rules, and the daemon heartbeat
  advances on a timer, so a hung operation reads as visible staleness.

### Changed
- Hourly server maintenance moved off the top of the hour (was
  correlating with transient commit 500s).

## [0.9.3] — 2026-07-07 — daemon hotfix

### Fixed
- **v0.9.2 daemons stopped pushing minutes after start** ("E2EE required:
  refusing to sync without an encryption key"): the new workspace-config
  reload rebuilt the daemon's config from workspace.json, dropping the
  runtime-attached encryption key material and credential remote override.
  The reload now moves only the hot-reloadable setting. If you installed
  0.9.2, upgrade and restart the daemon (`rbox upgrade && rbox stop && rbox
  start`).

## [0.9.2] — 2026-07-06 — refs at scale: big workspaces can publish

### Added
- **Receipt redemption (design 71).** Upload receipts are redeemed in batches
  *before* the commit, so the commit request stays tiny regardless of
  workspace size. Previously a cold first publish of a very large workspace
  (~123k files) sent a ~45 MiB receipts map into an 8 MiB request cap and
  could never publish.
- **Per-commit ref cap raised 50k → 250k**, enforced against the full
  accounted set (data refs + carriers) and backed by budget tests derived
  from the platform math. A workspace over the cap now gets an actionable
  error and an honest red "sync blocked" status (no false "will be retried")
  instead of a silent retry loop.
- **Bare `rbox` inside a workspace** shows the status block plus a small
  action picker (Sync now / View logs / Pause) instead of the setup wizard;
  the status header now includes the installed version.
- **Local dev builds**: `bun run dev:install` compiles a `rbox-dev` binary
  (`<version>-dev+<sha>`) for release-free on-machine testing
  (docs/dev-loop.md).

### Fixed
- **0.9.1 shipped without its own headline status-honesty changes** — a
  stale-base squash silently reverted them post-merge. Restored: amber
  "will be retried" for transient failures, live first-publish progress in
  the git-sync line, fresh-active precedence in the prompt glyph.
- **A file vanishing mid-push no longer aborts the whole push** (constant on
  live trees with agents/builds churning); it defers like any churning file
  and the stable subset commits.
- **Git capture failures name their real reason** (repo-context / HEAD
  probes) instead of the generic "capture returned nothing".
- Recovery from very large missing-blob sets pages through honestly
  (bounded 422 responses carry the total; progress refunds the retry
  budget).

## [0.9.1] — 2026-07-06 — status honesty + capture fixes

### Changed
- **`rbox status` never lies about liveness.** A fresh active cycle leads with
  its live percentage; a standing failure renders in amber beneath it as
  "last attempt failed … — will be retried"; "sync halted" (red) is gone —
  a live daemon always retries. "git-sync: 0 repos synced" during a first
  publish now reports capture progress instead of implying idleness.

### Fixed
- **Case-drifted symbolic HEAD no longer permanently defers a repo's git
  capture** (macOS case-insensitive checkouts: HEAD casing vs packed-refs
  casing). Capture normalizes to the ref store's casing; self-validation
  failures now report the real reason instead of "capture returned nothing."


## [0.9.0] — 2026-07-06 — worktree git-sync, live progress, network resilience, fast status

Born from a founder stress test: a first push over a 140-repo, 131k-file
workspace, run as a real customer would.

### Added
- **Git-state sync for main clones with linked worktrees (design 68).**
  Primary repos using `git worktree` (agent workflows, Conductor) now capture
  index/HEAD/stash via `--single-worktree --all`; applies defer whole-section
  when a ref collides with a branch checked out in a sibling worktree; in-tree
  scratch worktrees no longer re-upload the shared history once per worktree.
- **Live progress for the long sync phases.** First pushes show
  `scanning… N files` and `capturing git state 3/140 — <repo>`; the daemon
  feeds the same progress to `rbox status` and the zsh prompt glyph.
- **Network resilience on the sync path.** Transient socket faults retry with
  bounded backoff (commit POSTs proven idempotent via the server's sequence
  CAS); stalled transfers time out (no-progress watchdog on downloads,
  size-scaled caps on uploads); network errors now say what dropped and that
  re-running is safe — raw runtime errors never reach the terminal.
- **Resumable, hardened git-capture uploads.** Capture stages under the
  workspace's `.rbox/` (immune to tmp reapers), sha-mismatch faults re-encrypt
  and retry like file blobs, GB-scale bundle uploads resume across attempts,
  and stale staging sweeps are pid-aware (a live capture is never swept).

### Changed
- **`rbox status` is ~11× faster on repo-heavy trees (design 69).** 90s → ~8s
  warm on the stress-test workspace: status finally uses the on-disk hash
  cache, discovers repos during the one scan walk, pools the git probes, and
  skips unchanged repos entirely via a stat-only gitdir fingerprint cache
  (zero git subprocesses for a quiet repo).
- **Onboarding prompts tightened.** Workspace naming is one prompt (ENTER
  accepts the suggestion, `-` skips); background-sync + autostart is one
  three-way select; first-push spinners explain the scan phase.

### Fixed
- A transient network fault no longer discards an entire initial push.
- The 6GB-bundle capture failure mode (ciphertext truncated in `os.tmpdir()`
  during long multipart uploads) is closed.

## [0.8.0] — 2026-07-04 — launch-readiness batch (designs 60-67)

### Added
- **Self-serve genesis (design 60).** Cold accounts created via web signup or
  device-code `rbox login` mint their first encryption keys with
  `rbox key genesis`; `rbox setup` runs it inline on the first machine.
- **Daemon autostart (design 61).** `rbox autostart enable|disable|status`
  registers a per-user login agent that restarts background sync after reboot or
  re-login.
- **`rbox usage` + quota UX (design 62).** A dedicated command for plan limits vs
  current usage; typed `402 quota_exceeded` errors name the cap and next step.
- **Data export (design 65).** `rbox export` decrypts every workspace under your
  keys and writes a directory or `.tar.gz`.

### Changed
- **Team checkout disabled (design 63).** Team is listed but not purchasable
  across the CLI, web, and pricing surfaces;
  the server rejects Team checkout intent before any Stripe call.

### Security
- **Abuse hardening (design 64).** Rate limits on the anonymous edge
  (device-code start/poll, release, link/pair) plus a per-account durable-device
  cap.

## [0.7.1] — status probe elision
- `rbox status` elides the remote-head probe when the local daemon is live and
  attributable to the current workspace (design 59); JSON status fetches account
  usage separately.

## [0.7.0] — doctor, diagnostics, recovery kit
- `rbox doctor` + opt-in plaintext support-report upload (design 56).
- Recovery kit: `--kit` / `--kit-path` write the 24-word phrase to a `0600` file,
  tracked by `rbox key status` (design 58).
- Setup picker UX polish; dev-gated bootstrap `--plan`.

## [0.6.8] — destructive-apply safety
- Local trash tier (`rbox trash list|restore|empty`), type-flip healing, and a
  push-side mass-delete guard (design 50).

## [0.6.7] — rbox.yml revival + usage guide
- Scoped `rbox.yml` design revival and the narrative usage guide; the `deps` CLI
  group disabled/commented out (design 51).

## [0.6.6] — daemon IO priority
- Daemon disk-IO priority + idle safety-scan backoff (design 49).

## [0.6.5] — browser-optional login
- Browser-optional device-code login (design 47).

## [0.6.4] — zsh integration
- zsh shell integration: ambient sync status in the prompt + completions
  (design 46).

## [0.6.3] — status health
- Status health verdict, daemon activity sidecar, and live transfer percentages
  (design 45).

## [0.6.2] — rebind safety
- Rebind safety: stream-ownership stamp + mass-delete guard, closing the
  design-44 mass-delete incident.

## [0.6.1] — maintainability pass
- Behavior-preserving module splits across the engine, CLI, and API (antislop
  refactor pass).

## [0.6.0] — 2026-07-01 — nested-repo git sync
- Nested-repo git sync: per-repo GitSections, worktree materialization, all E2EE
  (design 43).

## [0.5.7] — 2026-07-01 — daemon rebind self-heal + dashboard rebuild
- Stale-daemon rebind detection, forensic sync logs, and ignoring `.git` pointer
  files (#42); setup sends the prompted workspace name on the create path (#40).
- Batched the blob-check push preflight D1 reads (serial → `db.batch`) (#39);
  customer dashboard rebuilt on Tailwind v4 + shadcn-svelte (#41).

## [0.5.6] — 2026-07-01 — bulletproof live-folder sync
- Snapshot-first encryption, safe against concurrent writes (#37); churning files
  now defer instead of aborting the whole push (#38).

## [0.5.5] — 2026-07-01 — setup names + live-folder resilience
- `rbox setup` prompts for a workspace name (#35); push self-heals a live-folder
  TOCTOU (`sha_mismatch`) (#36).

## [0.5.4] — 2026-07-01 — interactive CLI revamp
- `@inquirer` interactive surfaces + pick-workspace-by-name (#34).

## [0.5.3] — 2026-07-01 — download grants (design 27 client)
- The client presents signed download grants on blob GET, taking D1 off the
  blob-GET hot path (#32).

## [0.5.2] — 2026-07-01 — workspace names + track picker
- Opt-in, server-visible workspace names in status, plus a pick-from-list for
  track-existing (#31, #33); admin cockpit gains the Analytics-Engine SQL read
  path (§25 Plane A) (#30).

## [0.5.1] — 2026-07-01 — verify every upload path
- Manifest signature is now verified on every upload path (#26).

## [0.5.0] — 2026-07-01 — watcher scale + global daemon logs
- `@parcel/watcher` backend: RSS 11 GB → 60 MB and no more dropped events
  (§41) (#24). Daemon logs/pid move under `~/.rbox` (#21), and `rbox status`
  shows account/plan/link status (#19). arm-Mac + Linux only.

## [0.4.3] — 2026-07-01 — installer PATH + phase metrics
- Installer persists PATH; the daemon no longer spawns from the compiled-binary
  help menu (#16). Coarse client phase metrics (§35) (#17).

## [0.4.2] — 2026-06-30 — native log tail + observability
- `rbox logs` becomes a real native daemon log tail (#14). Self-serve account +
  data deletion (GDPR/CCPA, design 37) (#12); §32 observability — Slackpipes
  pings, Tail Worker, admin cockpit (#13); §33 per-account entitlement GC.

## [0.4.1] — 2026-06-30 — multi-device fix + security email
- Fixed the §31 admission-grant `notAfter` that bricked multi-device accounts
  (P0). New-device security emails via Cloudflare Email Service (#10, #11); §30
  large-ref commit accounting lifts the 6002-ref cap.

## [0.4.0] — 2026-06-30 — version history + CLI redesign + device dashboard
- CLI redesign: `rbox start`/`setup`, `track`/`untrack`, a `deps` group, `--help`,
  and dependency-drift notifications (#9). Device-management dashboard (§22) (#5).

## [0.3.2] — 2026-06-30 — CLI redesign groundwork
- `rbox --help`/`-h` exit 0; the §29 CLI command redesign was finalized.

## [0.3.1] — 2026-06-30 — version history under E2EE
- Version history + restore under E2EE (design 12 §15); a device-management
  dashboard (devices route + revoke + unlink); the CLI defaults to the prod API
  (`api.rbox.to`); `rbox versions .` lists the whole workspace.

## [0.3.0] — 2026-06-30 — git-sync under E2EE
- §28 git-sync under E2EE — git artifacts encrypted, default on. §24 blobRef
  sidecar makes the signed commit body O(1); upload/download concurrency raised
  to 64.

## [0.2.0] — 2026-06-30 — upload receipts (~6× faster sync)
- §23 upload-receipts (direct-write) cut sync time ~6×. Account linking
  (design 21): `rbox account link/status/unlink` plus a dashboard "Link your CLI
  account" flow; §25 server observability streams per-op R2/D1/DO timing to
  Analytics Engine.

## [0.1.2] — 2026-06-29 — concurrency knee
- Default upload/download concurrency 16 → 32 (measured knee) + a bench harness.

## [0.1.1] — 2026-06-29 — sync perf + empty-file fix
- Concurrent blob upload/encrypt and download with push/pull progress; empty-file
  round-trip fixed; concurrent-push bugs found dogfooding a real repo. Dashboard
  redesign (#1).

## [0.1.0] — 2026-06-29 — first release: sync engine, control plane, CLI
- Initial rbox: a continuous daemon (watcher + live push), a streaming /
  multipart / resumable blob path, opt-in git-state sync, convergent E2EE blob
  encryption, version history + restore, reachability GC + retention, multi-tenant
  isolation, self-hosted device-token auth + machine pairing, plan/quota
  enforcement, Stripe billing (checkout/portal/webhook), and a Clerk-authenticated
  web dashboard.
