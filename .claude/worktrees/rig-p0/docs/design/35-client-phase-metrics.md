# §35 — Phase 0: client phase metrics (the measurement foundation)

**Status:** DRAFT v1 — first draft, no adversarial review yet. This is **Phase 0** of the
performance architecture proposal (`docs/performance-architecture-proposal.md:706-731`) and
its **#1 prioritized candidate** ("High decision quality / Low risk / Prevents another
speculative cycle", `performance-architecture-proposal.md:770`). It builds **nothing that
moves bytes** — it instruments the client sync/pull pipeline so every later bet (C4 chunk
sync, C5 packfiles, S4 presigned R2) is chosen from a phase breakdown, not a hunch. It is
the **client analogue** of the server's §25 privacy-safe observability
(`apps/api/src/metrics.ts`), which the client has **no equivalent of** today. Client metrics
stay **local by default** — this is a client tool; shipping them off-device is out of scope.

**Implements (forward):** Phase 0 of the perf roadmap. **Gates:** C4/C5/S4 must not be built
until these metrics justify them (§Interactions). **Feeds:** §36 (blob transfer pipeline
Module) emits these same phase metrics from inside once it lands.

**Prior evaluations.** Client telemetry is not new — it was explicitly deferred to *P3* out of
the server-observability work (`docs/design/25-server-observability.md:33`: "Client telemetry …
stays in the obs doc's P3; it's not needed to validate server throughput"; earlier plan at
`docs/benchmarking-and-observability.md:390`). What changed since that deferral: the §30 dogfood
produced a 192s/433s result we **cannot attribute to any phase**, which promotes that shelved P3
item to build-this-first. This doc supersedes the P3 line — it does not re-open a rejected call.

---

## Problem

We just shipped a real dogfood run and **cannot say where the time went.** From
`docs/perf-improvements.md` (quoted in `performance-architecture-proposal.md:64-67`): the
real `~/conductor/workspaces` push moved **65,421 files / 11,925 unique blobs / 2.68 GB
ciphertext to prod in 192s**, and the **cross-host pull took 433s** — "commit time was
negligible compared with transfer, decrypt, and writing 65k files."

That last sentence is the whole problem: it is a **guess**. We have no instrument that
attributes those 433 seconds. Was the pull:

- **request/fs-bound** — 65k separate R2 GETs + 65k separate filesystem writes dominating,
  independent of byte volume (→ the C5 packfile bet)?
- **decrypt/byte-bound** — AES-GCM + the plaintext re-hash in `decryptFileToPath`
  (`src/engine/crypto.ts:85-116`) dominating (→ pipeline/crypto work, not packfiles)?
- **download-wait-bound** — pool starvation / server latency at 64-wide concurrency
  (`src/engine/apply.ts:80`) (→ S4 presigned R2 or adaptive concurrency)?

We literally cannot tell. The prior perf cycle's own lesson (`performance-architecture-
proposal.md:114-116`, Design principle #1) is "**Measure before building** … measured simple
levers beat complex speculative designs" — and yet the two biggest remaining bets (chunk
sync, packfiles) are rated **High risk** (`performance-architecture-proposal.md:774-775`) and
would be built on the *narrative* above, not a measurement.

The pipeline today has **real, un-timed phases** we know exist because the code does them:

- **Push:** scan stat/hash (`scanManifest`, `sync.ts:235`) → per-file plaintext re-hash for
  key derivation (`crypto.ts:62`) → streamed encrypt to a temp (`crypto.ts:70-73`) →
  **ciphertext re-hash** of that temp for `encSha` (`crypto.ts:75`) → `missingBlobs` preflight
  (`sync.ts:113`) → 64-wide upload pool (`sync.ts:118`, `uploadConcurrency()` default 64,
  `sync.ts:69`) → commit (`remote.ts:240`).
- **Pull:** `latest()` + reconcile → 64-wide download pool (`apply.ts:80-81`, `dlConc ?? 64`)
  where each job streams ciphertext to a `.ct` temp and **hashes the ciphertext inline**
  (`getBlobToFile`, `remote.ts:212-238`) → `decryptFileToPath` streams decrypt and
  **re-hashes the recovered plaintext** (`crypto.ts:108-111`) → atomic filesystem apply
  (`writeEntry`, `apply.ts:98-126`).

Every one of those is a candidate hot spot. None is timed. The push path even carries a
`onProgress(done, total, phase)` callback with a `"encrypt" | "upload" | "download"` phase
label already (`sync.ts:52`) — but it emits **counts**, not **durations or bytes**, and the
daemon "ignores it" (`sync.ts:51-52`). We have the seam and throw the signal away.

## Root cause

There is **no phase-attribution surface on the client.** Progress is a count; timing is
nowhere. The server solved the identical problem for its hot path with `OpSpan` (a per-op
span that accumulates sub-timings and emits **one** privacy-safe data point,
`metrics.ts:98-155`) plus a positional AE schema (`metrics.ts:32-46`). The client has the
same shape of question ("what's slow, by phase, on this run?") and none of the machinery.

The fix is **not** to bolt timers onto every call site — that scatters timing logic the way
§36 says transfer logic is scattered today. It is to add **one** client-side span/collector
that the existing phase boundaries feed, mirroring `OpSpan`'s discipline: accumulate raw
durations + byte counts per phase, emit **one** structured report per run, carry **no** PII.

Two constraints shape it, and both come straight from the proposal's success metrics:

1. **Near-zero cost on the no-op tick.** The daemon runs a watcher loop whose hot path is
   watcher → incremental manifest patch → push, with a 60s safety `fullScan` and a 30m
   `deepScan` (`src/cli/daemon.ts:35-38`). The proposal's success metric is explicit:
   "**No-op daemon tick:** wall time and CPU near zero on 100k-file corpus"
   (`performance-architecture-proposal.md:788`; also C6 gate `:566`). A metrics layer that
   allocates per-file or writes a report on a tick that did nothing is a **regression the
   metric itself forbids.** Instrumentation must be a fixed handful of counter adds on the
   change path and produce **nothing** when a tick is a no-op (the `filesUnchanged &&
   gitUnchanged` short-circuit, `sync.ts:290-292`).

2. **Privacy, mirroring §25.** `metrics.ts:11-29` states the rule the client must inherit
   verbatim: dimensions carry only low-cardinality operational labels; **never** an
   account/device/workspace id, a **path**, a **path hash**, or a **blob/commit hash**;
   numeric facts are aggregate durations/sizes/counts. A per-file client timing that named
   paths would be exactly the per-user activity log §25 refuses to become — worse here,
   because it would sit in plaintext on the user's disk. **Aggregate by phase, never by
   file.** No path, no plaintext, no per-file identifier ever enters a metric.

## Design

Add a client `PhaseReport` collector (the `OpSpan` analogue) and wire the existing phase
boundaries into it. One report per push and per pull; a human summary line + a JSON blob the
operator can diff across runs and corpora.

### 3.1 The reporting bases (this is the load-bearing part)

A single "bytes/sec" number is a lie for an E2EE content-addressed sync — the same run moves
four *different* byte totals, and which one is the denominator decides which optimization
matters. Every throughput figure is reported against **all four bases**
(`performance-architecture-proposal.md:729-730`, `:783-791`):

- **plaintext bytes** — sum of scanned file sizes. The user's mental model of "how big is my
  folder." Denominator for *felt* throughput.
- **ciphertext bytes** — sum of `cipherSize` (`crypto.ts:76`). Plaintext + 16-byte GCM tag
  per blob; the thing crypto actually chews and R2 actually stores.
- **wire bytes** — bytes actually sent/received over HTTP this run. Diverges hard from
  ciphertext on an **incremental** push (dedup + `missingBlobs` mean most ciphertext is never
  re-sent) and on a resumed multipart (`remote.ts:180` skips completed parts).
- **changed bytes** — ciphertext bytes of only the blobs *this* run had to (re)encrypt/upload
  (`toEncrypt` / `missing`, `sync.ts:95,113`). The denominator that decides **C4 chunk sync**:
  if a large-file edit shows `changed bytes ≈ whole-file bytes`, whole-file physics is the
  ceiling and chunking pays; if it's already tiny, it doesn't. This is the instrument that
  turns C4/§40 from *speculative* into *triggered*: the day a user syncs a **database, a
  Lightroom catalog, or a VM image** — a large file rewritten in place — `changed bytes` spikes
  toward whole-file size on every small edit, and the metric **sees** it. We stop guessing
  whether the large-file-delta workload exists on our platform; we watch the denominator and
  let it tell us when §40 stops being premature.

The report emits, per phase and per basis, both the total and the derived rate, so a diff
across runs is apples-to-apples.

### 3.2 Phases captured

Push (each a phase timer + byte counter):

| phase | where | what it isolates |
|---|---|---|
| `scan` | `scanManifest` (`sync.ts:235`) | stat + hash of the working tree |
| `encrypt.hash` | plaintext re-hash (`crypto.ts:62`) | the fundamental convergent-key plaintext pass |
| `encrypt.write` | streamed cipher (`crypto.ts:70-73`) | AES-GCM + temp write |
| `encrypt.cthash` | ciphertext re-hash (`crypto.ts:75`) | the **avoidable** ct re-read §36 removes — this quantifies the prize |
| `upload.wait` | pool queue time before a job starts (`sync.ts:118`) | concurrency starvation vs actual transfer |
| `upload.wall` | `putBlobFile` / `multipartAttempt` (`remote.ts:142`) | real transfer + server time |
| `upload.retry` | 422 re-upload loop (`sync.ts:316-318`), multipart re-init (`remote.ts:132-139`) | wasted work from missing-blob round-trips |
| `upload.throttle` | reserved (no 429 handling client-side today; lands with S1) | future backpressure wait |
| `commit` | `api.commit` (`remote.ts:240`) | the phase we *assume* is negligible — now proven |

Pull:

| phase | where | what it isolates |
|---|---|---|
| `download.wait` | pool queue time (`apply.ts:81`) | starvation at 64-wide |
| `download.wall` | `getBlobToFile` (`remote.ts:212-238`) | GET transfer + inline ct hash |
| `decrypt` | `decryptFileToPath` (`crypto.ts:85-116`) | GCM verify + plaintext re-hash |
| `fs.apply` | `writeEntry` stage+rename (`apply.ts:98-126`) | the 65k-write cost the C5 bet hinges on |

Resource facts, **where practical** (`performance-architecture-proposal.md:722`,
`:391`): **peak RSS** (`process.memoryUsage().rss` sampled at phase boundaries — cheap, no
new syscall loop) and **fd count** (Linux: count `/proc/self/fd` at coarse checkpoints;
best-effort/skip on darwin where it's a `sysctl` — never a per-file probe). Also **temp bytes
written** (sum of `cipherSize` on push, staged `.ct` on pull) — a direct read on the disk-IO
amplification §36 targets.

`upload.wait`/`download.wait` require the pool to timestamp enqueue→start. `poolMap`
(`src/engine/pool.ts`) is the one shared choke point; adding an optional `onPhase(job,
"start")` hook there captures wait for **both** push and pull without touching either call
site's body.

### 3.3 The collector — one span, no per-file allocation

`PhaseReport` is a flat, fixed-shape accumulator (the `OpSpan` analogue, `metrics.ts:98-129`):
a struct of `{ ms, plaintextBytes, ciphertextBytes, wireBytes, changedBytes, count }` per
phase name, plus `peakRssBytes` / `maxFds`. A phase is timed by
`report.phase("encrypt.write", bytes, () => …)` which adds to fixed fields — **no array of
per-file records, no map keyed by path.** This is what satisfies constraint #1: the marginal
cost per file is a handful of `+=` on preallocated numbers, and a no-op tick that never
enters a phase produces an empty report that is **not written**.

It threads exactly like the existing `onProgress` (`sync.ts:52`) — an optional field on
`SyncDeps`, defaulted off, so tests and one-shot CLI runs opt in and the daemon's hot path
stays untouched unless metrics are explicitly enabled.

**Relationship to the existing `SyncMetrics`.** The client already has a metrics file —
`SyncMetrics` (`src/cli/metrics.ts`), cumulative *counters* (`syncs`, `commitConflicts409`,
`fileConflicts`) persisted to `.rbox/state/metrics.json` and surfaced in `rbox status`
(`index.ts:288-295`). `PhaseReport` is a **different animal**: per-*run* timings, not lifetime
counters — so it lives in its own module (`src/engine/phase-report.ts`, **not** a second
`metrics.ts`) and its own per-run JSON sidecar. The two connect at exactly one point: the
daemon may fold a handful of **rolling aggregates** from the last report (e.g. last push/pull
wall, last phase split) into `SyncMetrics`, so the cheap `rbox status` line can show "last push
192s (upload 144s)" without loading a sidecar. `SyncMetrics` stays the durable counter file;
`PhaseReport` stays the per-run instrument. Neither can corrupt the other or `state.json`.

### 3.4 Output + surfacing

Two artifacts per instrumented run, both **local**:

1. **Human summary line** — one line, greppable, e.g.:
   ```
   rbox push corpus=conductor/workspaces files=65421 blobs=11925 changed=11925 \
     ct=2.68GB wire=2.68GB 192.4s | scan 3.1s encrypt 41.2s(hash 9.8 write 24.1 cthash 7.3) \
     upload 144.0s(wait 11.2 wall 132.8) commit 0.9s | rss 812MB fd 128
   ```
   This is the line that finally answers "the 433s pull went where?" at a glance.
2. **Structured JSON** — the full per-phase × per-basis matrix + resource facts, written to
   `.rbox/state/metrics/<runId>.json` (runId is a random token, **not** a hash of content —
   privacy). One file per run so `jq`/a comparison script can diff two corpora or two commits.
   The comparison-script deliverable (`performance-architecture-proposal.md:729-730`) reads
   these.

**Surfacing via `rbox logs`.** The daemon already writes a tail-able log and `rbox logs`
(v0.4.2, `daemon-control.ts:155-208`) streams it. When metrics are enabled, the daemon writes
the **summary line** to that same daemon log, so `rbox logs` / `rbox logs -f` is the natural,
zero-new-surface place an operator watches phase timings roll in during a real sync. The JSON
sidecar is for offline diffing; the log line is for live watching. No new command, no new
daemon channel.

### 3.5 Admin surfacing (two planes — do not conflate them)

The founder wants performance visible in the admin cockpit (`admin.rbox.to`, the external SPA
behind `GET /v1/admin/overview`, `admin.ts:341`, Cloudflare-Access + allowlist gated). There
are **two distinct metric planes**, and only one is safe to surface without a consent decision:

**Plane A — server op-timings → admin (the easy, safe win).** The server already writes per-op
spans to Analytics Engine (`OpSpan` → `writeDataPoint`, dataset `rbox_prod_metrics`,
`metrics.ts:74-83`) but has **no read path** — §25 explicitly punted it ("wire these queries
into a dashboard once the token exists," `docs/observability-server-metrics.md:180-181`), and
the four dashboard SQL queries already sit written-but-unused
(`observability-server-metrics.md:79-161`). The move: an Access-gated read that runs those
queries against the AE SQL API and returns them as another field on `adminOverview`, slotting
in beside the existing best-effort `fetchFiveXxRate` Cloudflare-Analytics fetch (`admin.ts:294`,
`:348-354`, same `CF_ANALYTICS_TOKEN` shape). This surfaces D1/R2/DO ms, 429 counts, and
commit-ref distributions per op-class to the cockpit. It is **server-authoritative and PII-free
by §25's schema** — no consent question, pure plumbing of data we already collect. This is the
real answer to "surface to the admin UI/API," and it is **separable server work**: track it as
its own slice; it does **not** block or depend on the client collector.

**Plane B — client phase reports → admin (deferred, consent-gated).** The `PhaseReport`s in
§3.4 are **local by default** and must stay that way. Surfacing *client* phase timings to a
dashboard means shipping them off-device — an **opt-in aggregate telemetry** channel (e.g. the
`rbox doctor --report` upload the P3 line already reserves, `25-server-observability.md:37`),
carrying only the same phase-aggregate schema (never a path, never a hash, never an id). That
is a real privacy/product decision, not plumbing: default **off**, explicit consent,
aggregate-only. **Deferred out of this doc** — named here so the local report is never quietly
turned into a per-user activity pipe.

### Bench corpora

The report is only useful against a fixed corpus set so runs are comparable
(`performance-architecture-proposal.md:723-728`). A `scripts/bench/` harness drives the five:
**many-small-files** (isolates request/fs overhead — the C5 signal), **large-file-edit**
(isolates changed-vs-whole bytes — the C4 signal), real **savvy-core**, real
**conductor/workspaces** (the 192s/433s baseline above), and **long-history** (isolates
commit/history-walk cost). Each corpus × {push, pull} produces one JSON report; the comparison
script tabulates bytes/sec by all four bases across them.

## Files

- **New: `src/engine/phase-report.ts`** — `PhaseReport` collector (the client `OpSpan`), the
  fixed-field accumulator, JSON serializer, and the one-line formatter. Mirrors
  `apps/api/src/metrics.ts:98-155` in shape and privacy discipline. Named `phase-report.ts`,
  **not** `metrics.ts`, to avoid colliding with the existing cumulative-counter
  `src/cli/metrics.ts` (`SyncMetrics`) — see §3.3.
- `src/engine/pool.ts` — add an optional `onPhase` enqueue→start hook so `upload.wait` /
  `download.wait` are captured at the single shared pool, not per call site.
- `src/cli/sync.ts:42-53` — add `report?: PhaseReport` to `SyncDeps` beside `onProgress`;
  wrap `scan` (`:235`), `encryptAndUpload` phases (`:104-128`), and `commit` (`:304`). The
  no-op short-circuit (`:290-292`) must return **before** any report write.
- `src/engine/crypto.ts:61-116` — accept an optional phase sink so `encrypt.hash` /
  `encrypt.write` / `encrypt.cthash` (`:62,70-75`) and `decrypt` (`:85-116`) self-time
  without the caller re-instrumenting. (This is the seam §36 inherits when it owns crypto.)
- `src/engine/apply.ts:56-94` — time `download.wait` (pool), `download.wall` +
  `getBlobToFile`, `decrypt`, and `fs.apply` (`writeEntry`, `:98-126`).
- `src/cli/remote.ts:142-238` — expose `upload.wall` / `download.wall` boundaries around the
  multipart/PUT and `getBlobToFile` transfer.
- `src/cli/daemon.ts:35-38` — when metrics enabled, write the summary line to the daemon log
  (surfaced by `rbox logs`); **never** allocate a report on a no-op tick.
- **New: `scripts/bench/`** — corpus fixtures + a comparison script over the JSON sidecars.

## Benefits

- **Every later perf decision becomes a diff, not a debate.** The 433s pull resolves into
  named phases; C4/C5/S4 get built (or not) against numbers.
- **Kills speculative cycles.** This is the proposal's stated reason to do it first
  (`performance-architecture-proposal.md:770`) — one cheap, low-risk instrument prevents a
  high-risk bet from being built on a narrative.
- **Quantifies §36's prize before §36 is built.** `encrypt.cthash` + temp-bytes directly
  measure the ciphertext re-read and pull-side `.ct` temp that §36 removes — so §36 lands with
  a before/after, not a promise.
- **Privacy-safe by construction**, inheriting §25's rule — safe to leave on, safe to keep on
  disk, because it can't become a per-user activity log.
- **Near-zero daemon cost**, by design — the no-op tick allocates and writes nothing.

## Validation gate

- **No-op daemon tick stays near-zero** on a 100k-file synthetic corpus with metrics enabled:
  wall time and CPU indistinguishable from metrics-off (the `performance-architecture-
  proposal.md:788` / `:566` success metric — the gate this design could most easily violate).
- **Privacy assertion (unit):** serialize a report from a run over files with distinctive
  paths/content; assert the JSON and the summary line contain **no** path, no path substring,
  no plaintext byte, no `sha256`/`encSha`, no account/device/workspace id — only phase names,
  durations, sizes, counts. Mirrors the §25 dimension rule (`metrics.ts:11-29`).
- **Attribution correctness (unit):** a push of a known corpus reports `scan + encrypt.* +
  upload.* + commit` summing to within a small epsilon of measured wall time (no phase's time
  is silently dropped, the way `OpSpan` avoids on a throw, `metrics.ts:89-96`); the four bases
  are internally consistent (wire ≤ ciphertext on a cold push; changed ≤ ciphertext always).
- **Bases distinguish the right thing:** an incremental push that re-sends one blob reports
  `changed bytes ≪ ciphertext bytes ≪ plaintext-of-whole-tree`, proving the denominators are
  wired correctly and a future C4/C5 decision reads the right one.
- **Empirical (the actual point):** re-run the real `conductor/workspaces` push (192s) and
  cross-host pull (433s) with metrics on; produce the phase breakdown that today does not
  exist, and record it as the baseline every later phase is measured against.

## Interactions

- **Feeds §36 (blob transfer pipeline Module).** §36's own spec says the pipeline "emit[s]
  phase metrics from inside" (`performance-architecture-proposal.md:353,382`); this doc
  defines the `PhaseReport` surface it emits into. When §36 lands and takes ownership of
  crypto/transport/temp-files, the phase timers defined here move *inside* the Module rather
  than being threaded through `sync.ts`/`apply.ts` — the collector Interface is unchanged.
- **Gates C4 (chunk sync).** Priority depends entirely on the **large-file-edit** corpus:
  build C4 only if `changed bytes ≈ whole-file bytes` there (whole-file physics is the
  ceiling). If changed bytes are already small, C4's High risk isn't justified.
- **Gates C5 (packfiles).** Build only if the **many-small-files** / real-clone reports show
  the pull is **request/fs-bound** (`download.wait` + `fs.apply` dominating, wire bytes low
  per file) rather than **decrypt/byte-bound** (`decrypt` dominating). §36's guidance and the
  C5 gate (`performance-architecture-proposal.md:775`, `:798`) both hinge on this exact split,
  which only these metrics can settle.
- **Gates S4 (presigned R2).** Build only if `upload.wall` / `download.wall` show
  Worker-through-R2 transfer is a large, byte-bound cost that bypassing the Worker would
  actually remove — the proposal's own condition (`performance-architecture-proposal.md:248-249`).
