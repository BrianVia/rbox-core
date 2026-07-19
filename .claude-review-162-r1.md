# Adversarial design review — 162 status without scanning (round 1)

## Verdict: CHANGES-REQUIRED

The user-visible latency problem is real, and the reported field numbers are plausible, but the design is not implementation-ready. Its two central code claims are wrong on current `main`: trusted local status already skips `scanManifest`, and the dircache is already composed into the engine and daemon scan paths behind `RBOX_SCAN_PRUNE`. More importantly, the proposed ambient trust boundary has no producer-boot/readiness identity, so a fresh record can truthfully prove only that *some* recent daemon projection was written—not that it belongs to the currently live boot or that startup established coherent local truth.

## Findings

### 1. BLOCKER — The CLI-side root-cause claim is false: `trustedLocalSnapshot` already skips the manifest scan

**Claim attacked:** design 162 lines 12–17 says the 60-second machinery substitutes only “ACTIVITY” and that the change-detection scan still runs unconditionally.

**Evidence:**

- `trustedLocalSnapshot` is a narrow trust predicate over `activity.local`, not over `daemon.status.json`. It requires a running daemon, current workspace binding, a v2 live pidfile boot id, an activity record with `local` and `ws`, age in `[0, 60s)`, matching stream/base sequence, and `local.settled === true` (`src/cli/status-cmd.ts:124,149-173`; shape at `src/cli/activity.ts:26-48`). `attributeDaemonForStatus` has already rejected activity whose `ws.bootId` differs from the live pidfile boot (`src/cli/status-view.ts:197-225`).
- When that predicate succeeds, `statusCmdWithDeps` enters `if (trusted)`, takes the daemon's file counts, and does **not** enter the fallback that loads `HashCache` and calls `scanManifest` (`src/cli/status-cmd.ts:388-442,459-490`).
- This is contract-tested directly: `src/cli/json-output.test.ts:233-260` installs throwing `loadHashCache`/`scanManifest` fakes and proves trusted status succeeds without either call. I ran that test with the existing dircache suites: 21 pass, 0 fail.
- The expensive work that really is unconditional before this branch is the state load/parse (`src/cli/status-cmd.ts:356-357`). Even on the trusted branch, Git repo admission/divergence still runs (`src/cli/status-cmd.ts:423-442`; cache/repo filesystem reads at `src/cli/sync-git/divergence-cache.ts:61-104`).

**Required change:** rewrite §Problem A around the actual costs: unconditional config/credential/reset checks and 59 MB state parse, plus remaining Git-divergence and presentation dependencies. State explicitly that the 12.2-second field invocation either failed one of the existing trust conditions or spent its time outside `scanManifest`; capture which predicate failed before attributing the field run to an unconditional tree walk. The A-path test should assert zero state reads and zero Git traversal as well as zero manifest walks.

### 2. BLOCKER — A fresh ambient record is neither authenticated to the live daemon boot nor ready at daemon startup

**Claim attacked:** lines 28–31 say existing pidfile/boot-id checks plus a fresh heartbeat make the entire ambient projection safe to render; lines 37–40 call it the daemon's authoritative knowledge.

**Evidence:**

- `AmbientDaemonStatusV1` contains no boot id, pid, workspace id, stream, state nonce, or base sequence (`src/cli/daemon/ambient-status.ts:39-59`). Its parser can therefore validate shape but cannot correlate the bytes to the current pidfile boot or state lineage (`src/cli/daemon/ambient-status.ts:316-378`).
- The existing activity fast path *can* make that correlation because `activity.ws.bootId` is serialized and compared to the live pidfile (`src/cli/activity.ts:41-49`; `src/cli/status-view.ts:208-225`). The ambient writer only uses the pidfile boot to fence writes; it does not serialize the boot (`src/cli/daemon/daemon.ts:1586-1604,1616-1631,1735-1756`).
- Crash/restart race: daemon A can leave a still-fresh ambient record; daemon B installs a new pidfile/binding; until B replaces the ambient record, a CLI sees a live/current-bound daemon but cannot tell that the record came from A. Atomic writes and the live-process check prevent a dead daemon's pid from being trusted, but do not solve this cross-boot generation race.
- There is a deterministic same-boot startup lie too. A new daemon begins with an empty manifest and no `syncBase` (`src/cli/daemon/daemon.ts:273-280`), records binding and writes/awaits ambient *before* loading state and doing its startup scan (`src/cli/daemon/daemon.ts:445-470`). At that moment `localSettled()` can be true (`src/cli/daemon/daemon.ts:1506-1516`), so the projection selects `state: "synced"`, stamps a current heartbeat, and exposes empty-manifest file totals (`src/cli/daemon/ambient-status.ts:209-224,249-258`; `src/cli/daemon/daemon.ts:1586-1604`).

**Required change:** make the complete interactive summary an authenticated, readiness-gated unit. It needs at least producer `bootId`, workspace/stream lineage, base sequence, a `ready/coherent` marker set only after state seeding and the startup reconciliation scan, and a summary observation generation/time. The CLI must compare producer boot to the live pidfile and current binding/lineage and fall back on any absence or mismatch. Add tests for crash → rapid restart, old record/new pidfile, pre-first-scan startup, rebind/reset lineage, and an ambient write racing pidfile replacement. Do not call ambient authoritative before these checks exist.

### 3. MAJOR — “Interactive” and “ENTIRELY from ambient” do not name a realizable presentation contract

**Claim attacked:** lines 26–36 appear to cover every non-JSON status mode and say identity/deferrals/status render entirely from ambient.

**Evidence:**

- `rbox status` has three distinct non-conflicting presentation flags: default brief, `--verbose` (“complete legacy status detail”), and `--git` (per-repository detail) (`src/cli/main-dispatch.ts:333-350`; `src/cli/help-registry.ts:87-95`). `opts.git` takes the brief branch and then renders every projected deferral; `opts.verbose` renders a much larger legacy surface (`src/cli/status-cmd.ts:605-690` and following).
- The ambient core has state/heartbeat/sequence/operation/attention and deferral summary only (`src/cli/daemon/ambient-status.ts:39-59`). The daemon writes extra RboxBar fields (`fileCount`, `totalBytes`, version, root), but those are a private intersection type and the TypeScript ambient parser currently discards them as unknown (`src/cli/daemon/daemon.ts:113-118,1586-1604`; parser reconstruction at `src/cli/daemon/ambient-status.ts:327-364`). There is no ambient account identity or workspace display name.
- The current default brief additionally depends on credential/account profile, remote-behind knowledge, typed halt, quota, daemon-version skew, locking health, trash, and update state (`src/cli/status-cmd.ts:605-650`). The reset-safety checks deliberately precede state loading and must remain authoritative (`src/cli/status-cmd.ts:309-354`).
- Design 124 carriage is real but bounded: ambient has an authoritative count plus at most five **repo projections**, not the complete lane set (`src/cli/daemon/ambient-status.ts:56-58,238-277,338-343`; `docs/design/124-deferral-drilldown-and-fix-brief.md:133-181`). It cannot reproduce complete `--git`, verbose, or JSON deferral detail.

**Required change:** scope A explicitly to the default brief/front door (`!json && !verbose && !git`) for v1, and say “no state load, manifest walk, or Git divergence walk” rather than “entirely from ambient.” Keep the small config/credential/reset/locking/etc. reads that preserve current headline semantics, or define every required value and its freshness/provenance in a complete ambient DTO. Leave `--verbose` and `--git` on the current path unless separately specified; the five-row ambient cap cannot silently truncate them.

### 4. MAJOR — Pending-change count semantics would regress both Git correctness and freshness honesty

**Claim attacked:** lines 32–36 call pending count a small summary; lines 69–71 lean toward “last-cycle + age annotation.”

**Evidence:**

- Today's headline count is not just file divergence. It is `added + changed + deleted + gitChanged` (`src/cli/status-cmd.ts:493-494,625-632`). Even when file counts come from the trusted daemon snapshot, status still evaluates Git divergence and conservatively reports one divergent repo on evaluation failure (`src/cli/status-cmd.ts:400-442`).
- `localSnapshot` contains file-plane counts only (`src/cli/daemon/daemon.ts:1569-1583`); neither the ambient input nor schema carries Git divergence (`src/cli/daemon/ambient-status.ts:39-59,98-109`). Projecting that count as today's `pendingChanges` makes Git-only changes falsely read zero.
- Heartbeat time is not observation time. Every five-second timer rebuilds ambient and stamps `heartbeatAt = now` from in-memory values (`src/cli/daemon/daemon.ts:1463-1468,1661-1687`; `src/cli/daemon/ambient-status.ts:249-254`). A raw watcher event marks local state unsettled before the settled batch is applied (`src/cli/daemon/daemon.ts:511-525,1498-1504`). Thus a three-second-fresh heartbeat can carry an older zero count; a long/hung operation can keep refreshing that stale knowledge indefinitely.

**Required change:** define the count at a precise producer boundary and preserve both planes, e.g. separate `pendingFileChanges` and `pendingGitRepos` plus a validated aggregate/known bit. Add `pendingObservedAt` (not heartbeat time), base sequence/generation, and settled/unknown semantics. While a watcher batch or operation is unsettled, do not present an old exact zero as “0 changes waiting”; label it last-observed/lower-bound or omit it. Pin behavior for edit-during-cycle, Git-only edits, Git probe failure, post-upload/pre-next-observation, and crash between durable state commit and projection write.

### 5. BLOCKER — Resolve the `--json` decision in favor of the existing path for this design

**Claim attacked:** line 62 promises unchanged JSON data source, while lines 65–68 lean ambient-first plus a `source` field.

**Evidence:**

- The current JSON document includes workspace, computed health, daemon/CLI version skew, locking, remote provenance, local counts, trash, account/credential, crypto, complete lane-level Git deferrals, repo projections, Git capability/config state, and halt reason (`src/cli/status-cmd.ts:529-600`). Ambient cannot supply that contract.
- Design 124 requires `status --json`'s `git.deferrals` to remain byte/field-consistent with `git deferrals --json`; those are full lane entries from durable state, while ambient deliberately carries at most five repo projections (`docs/design/124-deferral-drilldown-and-fix-brief.md:77-98,133-181`; `src/cli/status-cmd.ts:572-588`).
- A top-level `source` tells a consumer *why* fields differ; it does not make omitted, bounded, or cycle-lagged fields compatible. It also changes a script-facing schema while the contract says scripts are unchanged.

**Required change:** keep `--json` on today's state-backed path in this design. It may continue using the existing trusted activity optimization for local counts, which already skips `scanManifest`; do not replace the full document with ambient. A future ambient JSON mode needs a separately versioned DTO and migration contract, not a provenance label on two non-equivalent shapes.

### 6. BLOCKER — The dircache is already composed; the actual missing composition is the Darwin bulk-success branch

**Claim attacked:** lines 18–20 and 42–48 say `src/engine/dircache` was never composed into `scanManifest` and propose wiring it in.

**Evidence:**

- `scanManifest` already accepts `dircache` and explicit pruned/unpruned mode, self-demotes for deadlines/rule changes, walks with reuse, stamps coverage, and records outcomes (`src/engine/manifest.ts:119-193,496-540`). `DirCache` persists v2 `{mtimeMs, ctimeMs, children}` entries with a two-second racy-clean margin and a 30-minute unpruned deadline (`src/engine/dircache.ts:7-27,39-45,83-201`).
- Foreground sync loads/saves it behind `RBOX_SCAN_PRUNE=1` (`src/cli/sync/deps.ts:122-131`). The daemon independently loads it, passes it to `scanManifest`, and saves it (`src/cli/daemon/daemon.ts:1911-1938`). Changelog and project status say Layer A shipped behind that flag (`CHANGELOG.md:465-468`; `docs/STATUS.md:179-181`). `dc:off` therefore means the cache was disabled/not supplied on that run, not that no composition exists.
- Design 107's actual follow-up remains visible in code: a successful Darwin bulk listing sets `children` but never calls `dircache.record`; recording occurs only in the ordinary `readdir` branch (`src/engine/manifest.ts:511-540`). Design 107 names exactly this limitation (`docs/design/107-darwin-bulk-scan.md:150-153`). Changed directories reached through bulk consequently do not refresh their cache entries.

**Required change:** rewrite B as graduation/default-on of existing Layer A, plus composition of successful bulk children into `DirCache.record`. Reconcile the existing positive gate `RBOX_SCAN_PRUNE=1` with the proposed negative kill switch `RBOX_DIRCACHE=0`; do not leave two flags with unclear precedence. Tests must exercise bulk+dircache together, not only the ordinary readdir path.

### 7. MAJOR — Existing Layer A cannot collapse total scan work toward O(changed)

**Claim attacked:** lines 52–54 and 77–78 promise changed-directory scaling and a second scan that “touches O(changed)=0 directories.”

**Evidence:**

- A cache hit skips `readdir`, but the walker still `lstat`s the directory, recurses through every cached child directory, runs matcher logic, and stats every file so in-place content edits are found (`src/engine/manifest.ts:492-510,557-575` and subsequent file path). The cache contains only child names/types, not subtree manifests (`src/engine/dircache.ts:10-26`).
- Design 85 states the contract honestly: Layer A reclaims the readdir share but “does NOT reach O(change): the per-file stat floor and matcher CPU remain” (`docs/design/85-incremental-scan.md:337-342`). The measured shipped gain was about 24%, not a collapse to changed-directory cost (`docs/STATUS.md:179-181`).
- The existing benchmark's structural assertion is specifically `dirsWalked === 0`/all listings reused; it does not assert zero directory lstats, recursion, file stats, or total O(change) wall work (`src/engine/dircache.test.ts:51-81`; `src/engine/dircache-bench.test.ts:7-35`).

**Required change:** narrow the expected effect and acceptance language to “zero directory enumerations on a quiescent reusable tree” and measure `dirsReusedFromCache`, `dirsWalked`, file stats, matcher time, and wall time separately. If O(change) total work is the requirement, it needs the materially different Layer-B/daemon-manifest architecture described by design 85, not this dir-listing cache.

### 8. BLOCKER — Design 104 does not currently gate cache reuse, and clearing entries is not equivalent to an unpruned trust-recovery scan

**Claim attacked:** lines 45–48 say trusted-watcher state already gates reuse and an untrusted watcher forces a full walk.

**Evidence:**

- All safety scans currently request `"pruned"`; trust is not passed into `replaceManifestFromScan` or `scanManifest` (`src/cli/daemon/daemon.ts:1841-1850,1911-1924`).
- Design 104 re-trust requires walker-originated `coverage === "full-tree"` with stable watcher error generation (`src/cli/daemon/daemon.ts:1525-1548`; `docs/design/104-watcher-trust-recovery.md:134-168`). `coverageOf` deliberately marks both `hit` **and `cold`** as `pruned` (`src/engine/dircache.ts:79-80`). Invalidating every entry while still requesting pruned could physically enumerate the whole tree yet still cannot testify for re-trust.
- `watcherHealthy` starts true even before a watcher exists; watcher startup failure sets `watcherDegraded` but leaves `watcher` undefined (`src/cli/daemon/daemon.ts:289,314-326,585-589`). Existing cadence correctly defines live/trusted as `this.watcher !== undefined && this.watcherHealthy` (`src/cli/daemon/daemon.ts:632-646`). A gate on the boolean alone would wrongly prune in periodic-scan-only mode.

**Required change:** at the daemon call site, explicitly request `unpruned` whenever there is no watcher or it is unhealthy/suspect/fused, and `pruned` only for a live trusted watcher. Preserve the walker-emitted coverage contract so only genuine unpruned walks can re-trust. Specify behavior with `RBOX_WATCHER_RETRUST` both off and on, including watcher-init failure, transient suspect, fused, error-during-scan, and recovery-hold cases.

### 9. MAJOR — Watcher invalidation is underspecified and cannot be the correctness proof under FSEvents coalescing

**Claim attacked:** lines 44–48 add watcher-event invalidation as if it were a ready mechanism.

**Evidence:**

- `DirCache` has no per-path invalidation API; it offers reuse, record, and whole-table drop (`src/engine/dircache.ts:133-201`). The daemon creates a scan-local cache for each scan and saves it after the awaited walk (`src/cli/daemon/daemon.ts:1917-1924`), while watcher callbacks can interleave and only enqueue raw/settled events (`src/cli/daemon/daemon.ts:511-529`). There is no shared object or epoch tying an event to a cache save.
- A raw event can arrive after a directory was reused/recorded or while `dircache.json` is being atomically staged; the later scan save can republish the old entry. `DirCache.save` supports `beforeRename`, but the daemon does not use it (`src/engine/dircache.ts:115-127`; `src/cli/daemon/daemon.ts:1924`).
- The watcher batcher is last-kind-wins per exact path, Parcel maps every delete to `unlinkDir`, and ignore filtering occurs before callback delivery (`src/cli/daemon/watcher.ts:86-127,222-260`). FSEvents may coalesce, delay, or explicitly report dropped events; design 104 therefore treats the unpruned safety scan—not event delivery—as the healer (`docs/design/104-watcher-trust-recovery.md:40-51,75-82,134-168`). “Trusted” means no reported backend error, not that all prior mutations have crossed a serialization barrier.
- The existing cache's correctness discipline is independent of watcher invalidation: exact directory mtime+ctime, racy margin, rule inventory, and periodic unpruned rebuild (`src/engine/dircache.ts:39-45`; `src/engine/manifest.ts:136-191`; rationale at `docs/design/85-incremental-scan.md:239-313`).

**Required change:** either drop watcher invalidation from this design and graduate the already self-contained timestamp cache, or specify invalidation as defense-in-depth only. If retained, define cache ownership and a monotonic event-generation barrier across scan start, traversal, and atomic rename; invalidate all structurally relevant parents/ancestors; and ensure an event arriving during scan/save survives into the next persisted cache. Test delayed/coalesced rename and delete, nested create without a parent event, event during reuse, event during save, dropped-event error, ignore-rule changes, and daemon crash between scan and invalidation persistence.

### 10. MAJOR — Version skew is only safe with one atomic completeness/version predicate

**Claim attacked:** lines 32–36 say additive schema-v1 fields are safe both ways because old readers ignore them and new readers scan when absent.

**Evidence:**

- Old reader/new writer is structurally fine today: `schemaVersion` stays 1 and `parseStatus` reconstructs known fields while ignoring unknown keys (`src/cli/daemon/ambient-status.ts:316-364`).
- New reader/old writer is safe only if every field needed for the selected presentation—including producer boot/lineage/readiness and pending observation semantics—is checked as one unit. A collection of independent optional top-level fields permits mixed/partial records and cannot distinguish an older producer from a future producer that changed field semantics.
- This is already observable with the daemon's private `fileCount`/`totalBytes`/`workspaceRoot` additions: they are written but discarded by the current TypeScript parser (`src/cli/daemon/daemon.ts:113-118,1586-1604`; `src/cli/daemon/ambient-status.ts:327-364`). “Field present on disk” is not the same as “validated consumer capability.”

**Required change:** add one optional nested object such as `interactiveSummary: { version: 1, ...all-required-fields }`. A new CLI uses ambient only when the object version is exactly understood, every required field validates, producer identity matches, and its observation is coherent; otherwise it takes today's path. Old CLIs ignore the whole object. Tests need old CLI/new daemon, new CLI/old daemon, partial object, unknown summary version, unknown outer keys, restart boot mismatch, malformed individual fields, and future/negative timestamps.

### 11. MINOR — The freshness window and field measurements need precise provenance

**Claim attacked:** lines 4–7 provide field measurements; lines 28–29 call 60 seconds the existing ambient trust window.

**Evidence:**

- Sixty seconds is `trustedLocalSnapshot`'s activity-local window (`src/cli/status-cmd.ts:124,168-173`). Existing ambient heartbeat freshness is 5 seconds × 3 = 15 seconds (`src/cli/populate-marker.ts:5-6`; `src/cli/daemon/ambient-status.ts:511-516`). The ambient prompt reader also accepts future heartbeat times because it tests only `age > stale`, not finite `age >= 0` (`src/cli/daemon/ambient-status.ts:511-513`). A full-status trust boundary should fail closed on future time as the activity predicate already does.
- The exact 12.2 s / 192%, 8.3 s, 112,259 files / 21,807 dirs, and 59 MB values appear only in untracked design 162; no raw command, state byte count, status output, or telemetry line is checked in. They are nevertheless plausible: the same workspace family measured 45–47 MB state around 116.9k files (`docs/design/84-manifest-delta-encoding.md:49-80`; `docs/design/85-incremental-scan.md:23-25,81-84`), later fleet state was about 77 MB (`docs/design/138-reset-path-hardening.md:11-19`), historical full scans were 6–15 s (`docs/design/85-incremental-scan.md:53-64`), and the APFS bulk benchmark measured 5.484 s stock / 3.206 s bulk on 118,384 files (`docs/design/107-darwin-bulk-scan.md:109-126`). The 192% CPU is also plausible given overlapping scan/Git work and Git divergence concurrency of eight (`src/cli/sync-git/divergence-cache.ts:9`). Plausible is not independently reproducible.

**Required change:** choose and name the ambient gate (prefer the existing 15-second heartbeat rule unless justified), reject non-finite/negative age, and attach the raw field artifacts or exact reproduction commands: `stat` byte size for `state.json`, the complete status timing command/output, the daemon telemetry line including `dc:off`, CLI/daemon versions, relevant env flags, and trust-predicate outcome. This will separate state-parse/Git cost from a fallback scan.

## Required design rewrite before round 2

1. Reframe A as a default-brief fast path over an authenticated, ready, versioned ambient summary; retain current reset and small local health checks; keep `--verbose`, `--git`, and `--json` on their current contracts.
2. Specify boot/workspace/stream/base identity, readiness, observation time/generation, exact pending file+Git semantics, and one all-or-nothing summary capability gate.
3. Reframe B as default-on graduation of existing `RBOX_SCAN_PRUNE` Layer A plus Darwin bulk-result recording, with one clear kill switch.
4. Preserve design 104 by selecting genuine `unpruned` mode when watcher live/trust is absent; do not treat cache clearing as full-tree coverage.
5. Replace O(change) claims with the actual readdir-elision contract and define watcher invalidation, if retained, as generation-fenced defense-in-depth rather than the cache's correctness basis.

## Validation performed

- Read design 162 and designs 104, 107, 124, plus the relevant design-85 cache invariants and field-history documents.
- Traced `statusCmdWithDeps`, ambient projection/parser/writer, daemon startup/heartbeat/ownership flow, watcher trust/recovery, `DirCache`, `scanManifest`, foreground/daemon composition, and Darwin bulk integration.
- Ran `bun test src/cli/json-output.test.ts src/engine/dircache.test.ts src/cli/design85-layer-a.test.ts`: **21 pass, 0 fail**.

**Final verdict: CHANGES-REQUIRED.**
