# Benchmarking & Observability Design

> Status: **proposal** — design doc, not yet implemented.
> Scope: a repeatable performance benchmarking suite for the rbox sync engine + transport,
> plus the production observability needed to know *what is slow in the wild and why*.

## 1. Why

rbox's pitch is speed-with-restraint: "50k files scanned in ~2.4s", concurrent
encrypt+upload, incremental cold/warm scans. Today none of that is *defended*. We have:

- one ad-hoc benchmark (`scripts/bench-scan.ts`) covering exactly one hot path (scan);
- conflict **counters** (`src/cli/metrics.ts`) but zero latency/throughput data;
- blob-count progress on a spinner (`sync.ts:50`), no bytes/sec;
- essentially **no server observability** — 2–3 `console` calls across the whole Worker,
  no request timing, no per-op metrics (`apps/api/src/`).

So we can't answer the two questions that matter:

1. **Did this change make rbox faster or slower?** (regression gating, pre-merge)
2. **What is slow for real users right now, and where is the time going?** (production)

This doc proposes both halves — a local/CI benchmark harness, and a thin,
privacy-safe telemetry layer — and a way to run *realistic* end-to-end benchmarks
using two throwaway VMs via Apple's `container`.

### Goals
- Reproducible, statistically honest micro- and macro-benchmarks of the real hot paths.
- A fixture/corpus generator so runs are comparable across machines and over time.
- Regression detection wired into CI with a tolerance budget.
- Production telemetry that surfaces p50/p95/p99 latency and throughput per operation,
  client and server, without ever shipping plaintext or path contents off-device.
- A realistic Mac↔Linux e2e benchmark using isolated VMs.

### Non-goals
- Distributed load testing at scale (single-tenant perf first; load comes later).
- Replacing the existing dogfooding `SyncMetrics` — we extend it.
- APM vendor lock-in. We lean on what's already in the stack (Cloudflare) + plain JSON.

## 2. What to benchmark

Two tiers. Micro-benchmarks isolate one function so we can attribute regressions;
macro/e2e benchmarks measure the thing users actually feel.

### 2.1 Micro-benchmarks (single hot path, in-process)

| Bench | Target | File | Why it matters |
|---|---|---|---|
| `scan-cold` / `scan-warm` | `scanManifest` + `drainHashes` | `src/engine/manifest.ts:25,179` | cold-start dominator; hashcache hit/miss divide |
| `hash-small` / `hash-large` | `hashFile` across the 1 MiB stream threshold | `src/engine/hash.ts:7,15` | validates `STREAM_THRESHOLD` (whole-read vs streamed). Note: `HASH_CONCURRENCY=16` lives in the manifest **drain** path (`manifest.ts:179`), not `hashFile` — benchmark it via `scan`/`drainHashes`, not here |
| `encrypt` | `encryptFileToTemp` | `src/engine/crypto.ts:61` | **two full passes per file** (plaintext re-hash + ciphertext hash) — prime suspect |
| `decrypt` | `decryptFileToPath` | `src/engine/crypto.ts:85` | pull cost |
| `diff` | `diffManifests` / `sameContent` | `src/engine/diff.ts:32,20` | runs every cycle; `pushManifest` calls it twice (`sync.ts:269,276`) |
| `reconcile` | `reconcile` | `src/engine/reconcile.ts:41` | per-cycle |
| `chain-verify` | `verifyCommitChain` over `commitsSince(pin)` | `src/cli/e2ee-remote.ts:127` | **grows with history** — runs in `latest()` (`:127-131`), which is called after each `refreshAccount()` (`:205`) on the pull path |
| `sha256-stream` | pure-JS SHA-256 | `src/engine/sha256-stream.ts` | workerd fallback; suspect on server hashing |

The encrypt double-pass and the history-linear chain verification are the two paths I'd
bet money on regressing first — they should be benchmarked from day one so we can prove
or kill the hypothesis.

### 2.2 Macro / end-to-end benchmarks (the felt experience)

Measured against a running control plane (local Miniflare *and* the two-VM setup, §4):

- **first-push** of a cold corpus — encrypt + upload of N files / M bytes end to end
  (`sync.ts:81` `encryptAndUpload`, `pool()` at `:56`, `ENCRYPT_CONCURRENCY=8`/`UPLOAD_CONCURRENCY=16`).
- **incremental push** — change k files, measure cycle latency (`applyWatchEvents` path).
- **full pull / clone** onto a fresh device — download + decrypt + chain verify.
- **no-op cycle** — steady-state daemon tick cost (should be ~free; if not, that's a bug).
- **conflict storm** — two writers racing the `WorkspaceSync` DO (`apps/api/src/workspace-sync.ts`),
  measuring 409 rate and retry-backoff tail latency (`sync.ts:289-298`).
- **large-file** — single blob across the 90 MiB `SINGLE_PUT_MAX` boundary into multipart
  (`src/cli/remote.ts:11,99`).

Second-wave benches (not P0, but real and currently uncovered): daemon watch-event coalescing,
the apply path (download + decrypt + write), ignore-rule pruning, `validateManifest`, multipart
**resume** after interruption, 422/413 recovery + fallback, quota-exceeded handling, stale-epoch
rejection, pruned-history / rebaseline pulls, rollback/fork detection, GC interaction, and
auth/key-rotation flows. Also track **resource** cost (peak RSS, fd count), not just wall time —
a faster cycle that doubles memory is a regression.

### 2.3 Corpora (fixtures)

Benchmarks are only comparable if the input is fixed. A generator
(`scripts/bench/corpus.ts`) produces deterministic synthetic trees, seeded so they're
byte-identical across machines:

- `tiny` — 100 files, ~1 MB (CI smoke; fast).
- `repo` — ~50k files, mixed sizes, a realistic node project shape (the README's 50k claim).
- `bigfiles` — a handful of 50–500 MB blobs (transport/multipart).
- `wide` vs `deep` — directory-shape sensitivity for the walker.
- `git` — a real-ish git working tree to exercise `captureGitState` (`src/engine/git-state.ts:88`).

Seeded with a fixed PRNG; entropy/compressibility controlled (random vs zero-filled vs
text) because that changes encrypt/hash cost and R2 behavior. Store the generator, **not**
the corpus, in the repo.

## 3. Methodology — make the numbers honest

A benchmark that lies is worse than none. Rules:

- **Keep the raw samples.** Persist every iteration's measurement, not just summary stats.
  Percentiles are derived downstream; you can't recompute a CI or re-bin a tail from a p95
  someone already collapsed. Sample count scales to the metric: tail percentiles need many
  more samples than a median — **don't report a p99 off 10 runs** (that's just `max` cosplay).
  Report p99 only for cheap benches we can run hundreds of times; for expensive macro benches,
  report p50 + a confidence interval and say so.
- **Report distribution + spread, not a mean.** min / p50 / p95 (/ p99 where sample count
  earns it) **plus variance / CI**. The mean hides the tail, and the tail is what users feel
  (conflict retries, GC pauses, large blobs).
- **Throughput, not just wall time.** files/sec and MB/sec — wall time alone isn't comparable
  across corpora. Define the byte basis explicitly (see §3.1).
- **Cold vs warm explicitly labeled.** `bench-scan.ts` already does this; everything follows it.
- **Per-iteration reset contract (critical).** Macro benches accumulate state that silently
  poisons later iterations. Each iteration must declare and perform its reset: wipe
  `.rbox/state` + hashcache for cold-client runs; reset server state (D1/DO/R2 blob presence,
  dangling multipart uploads) for first-push; account for warm TLS connection reuse. A bench
  with no documented reset is presumed contaminated. `first-push` in particular is a *cold
  server* operation — re-running it against a server that already has the blobs measures the
  re-encrypt-on-missing fast path, not a first push.
- **Pin *and acknowledge the limits of* the environment.** Record CPU model, core count, Bun
  version, OS, free RAM, generator version + seed + corpus digest, and `git rev-parse HEAD` +
  dirty flag. But know these don't control thermal throttling, macOS power mode, Spotlight/
  FSEvents churn, APFS state, Miniflare/Wrangler version, or (for staging runs) Cloudflare colo
  and R2 region. Hold those constant by running base+head **in the same job back-to-back** (§6)
  rather than pretending a recorded field neutralizes them.
- **Isolate I/O.** drop the page cache between cold runs where the OS allows (`purge` needs
  sudo — fine for nightly, not per-PR); otherwise label the run "warm-fs" honestly. The
  reliable cold-cache path is a fresh ephemeral VM disk (§4), not a flag.
- **Single source of timing.** one `time(label, fn)` helper using `performance.now()`,
  shared by every bench, emitting one JSON schema (below).

### 3.1 Byte basis — define it once

"MB/sec" is ambiguous under E2EE: plaintext bytes ≠ ciphertext bytes ≠ uploaded bytes ≠
logically-changed bytes. Every throughput metric **names its basis** (`plaintextBytes`,
`ciphertextBytes`, `wireBytes`, `changedBytes`) and benches never mix them. This same
discipline applies to production telemetry (§5.3) — units first, shared names second.

### 3.2 Result schema

Each scenario emits one JSON object. It carries the **raw samples** (so percentiles/CIs are
recomputable downstream) plus full corpus + reset provenance:

```jsonc
{
  "bench": "first-push",
  "corpus": { "name": "repo", "gen": "1", "seed": 42, "digest": "sha256:…",
              "files": 50000, "byType": {"file": 49800, "symlink": 200},
              "sizeHistogram": {"<1KiB": 30000, "1KiB-1MiB": 19900, ">1MiB": 100} },
  "reset": "cold-client+cold-server",   // what was wiped before each iteration
  "git": { "sha": "16377f0", "dirty": false },
  "env": { "cpu": "Apple M3 Pro", "cores": 11, "bun": "1.x", "os": "darwin 25.5",
           "ramFreeMB": 8123, "wrangler": "x", "miniflare": "y" },
  "n": 30,
  "samplesMs": [2410, 2455, 2398, /* … all n raw wall-time samples … */],
  "metrics": {
    "wallMs":   { "p50": 2410, "p95": 2680, "ci95": [2380, 2520] },
    "filesPerSec": 20800,
    "plaintextBytesPerSec": 73400000,
    "wireBytesPerSec": 81200000,
    "phases": { "encryptMs": {"samples": [/*…*/], "p50": 900},
                "uploadMs":  {"samples": [/*…*/], "p50": 1400} }
  }
}
```

Results land in `bench-results/<timestamp>-<sha>.jsonl` (gitignored). A small
`scripts/bench/compare.ts` diffs two result files and prints a regression table with the
CI overlap, not just point deltas.

## 4. Isolated e2e via throwaway Linux VMs/containers (host-adaptive)

**Honesty up front:** this is a *Linux client-in-a-box* benchmark, **not** a "Mac↔Linux" one.
The isolated environments run Linux; the host only runs the control plane / routes traffic.
It buys isolation, fixed resources, and guaranteed cold disks — it does **not** validate a
real macOS client (different libc, APFS vs the VM fs, case sensitivity, FSEvents vs inotify).
macOS-client numbers come from running the harness natively on a Mac host. Alpine in particular
is a thin proxy for real user systems; treat its results as "does it work + relative perf on
Linux," not "this is what a user's Mac sees."

### 4.1 Host-adaptive runner

The rig targets two dev hosts. `scripts/bench/e2e.ts` detects the host and picks a backend
behind one small `BenchRunner` interface (`create / setResources / exec / cp / rm`), so the
bench logic is written once and the rest of this doc's benches don't care which backend ran:

| Host (`process.platform`) | Backend | Isolation kind |
|---|---|---|
| `darwin` | Apple [`container`](https://github.com/apple/container/blob/main/docs/container-machine.md) machines | lightweight Linux VM per machine |
| `linux` | Docker containers | namespaced container per peer |

The two backends are **not equivalent** and runs are labeled with which one produced them
(`env.runner: "apple-container" | "docker"`) — never compared across backends as if they were
the same. Apple `container` is a per-VM hypervisor boundary; Docker on a Linux host shares the
host kernel. Different fs/scheduler/cache behavior → only same-backend deltas are meaningful.

> ⚠️ Apple `container` subcommand syntax drifts between releases — verify against the installed
> version (`container --help`) before wiring scripts. Shapes below are the intent.

**macOS host — Apple `container`:**
```bash
container machine create alpine:latest --name rbox-bench-cli
container machine set -n rbox-bench-cli cpus=4 memory=8G
container machine run -n rbox-bench-cli -- bun /workspace/scripts/bench/run.ts first-push repo
container machine rm rbox-bench-cli            # fully disposable
```

**Linux host — Docker:**
```bash
docker run --rm --name rbox-bench-cli \
  --cpus=4 --memory=8g \
  -v "$PWD:/workspace:ro" \                    # ship the binary in; corpus stays on container fs
  oven/bun:alpine \
  bun /workspace/scripts/bench/run.ts first-push repo
```

In **both** cases: pin cpu/memory for comparability, mount the repo **read-only** only to ship
the binary, and **generate the corpus onto the container/VM's own writable fs** (not a host bind
mount) so cold-FS numbers aren't poisoned by the host page cache (see the cold-start note below). On Linux, `--memory`
plus dropping caches (`echo 3 > /proc/sys/vm/drop_caches`, root in-container) gives a more
honest cold run than macOS can manage without a full fresh VM.

Why this is worth it:

- **True isolation + fixed resources.** Pinning cpus/memory makes runs comparable and stops
  a noisy host from poisoning numbers.
- **Linux-specific behavior.** Catches Linux scan/hash/fs behavior the Mac dev loop hides
  (inotify limits, ext4 vs APFS) — complementary to native-host macOS runs, not a substitute.
- **Disposable = clean cold-start — *if the corpus is on the VM's ephemeral disk*.** A fresh
  machine gives a fresh device identity (real `link`/`pair`/first-pull cost). But the doc's
  home-dir mapping is a **trap for cold-FS claims**: a host-mounted corpus rides the host page
  cache and the VM↔host fs bridge, which can dominate scan/hash timing. For cold-FS numbers the
  corpus must be **generated onto the VM's own disk**; use the host mount only to ship the
  binary and collect results.

### Control-plane options for the e2e bench

The DO/D1/R2 control plane can't run *inside* an Alpine VM (it's workerd). Two modes:

1. **Local Miniflare** (`@cloudflare/vitest-pool-workers` already gives us real D1+R2+DO):
   run `wrangler dev` on the host, point both VMs at the host gateway. Measures
   client + protocol cost with a realistic but local server. **Default for CI.**
2. **Staging Worker** (deployed `apps/api`): measures the true production network +
   R2 + DO latency. **Used for periodic "production-shaped" runs**, not every CI run
   (costs real R2/egress).

The second ("server-side") VM is largely **decorative** — the real control plane is workerd
and can't run in Alpine, so it falls back to host `wrangler dev`. Don't oversell it: the rig
stresses the **client** and the **wire**, and Miniflare mode misses Worker cold starts, real
R2 multipart latency, D1 latency, and DO placement. Server-internal latency is measured by the
**staging-Worker e2e run + the server telemetry in §5**, not synthetically. Keep Miniflare runs
and staging-Worker runs as separate, separately-labeled result sets — never average them.

## 5. Production observability — "what's slow in the wild"

Benchmarks tell us about synthetic corpora; production tells us about reality. Today that
signal doesn't exist. We add a thin, privacy-safe layer at the seams the engine already
exposes.

### Hard privacy constraint — a metadata threat model, not a slogan

rbox is E2EE by design, and the threat telemetry reintroduces is **metadata**, which is
exactly what an E2EE sync service still leaks if it's careless. "No plaintext" is necessary
but nowhere near sufficient. The review gate on every telemetry PR is this explicit ban list:

- **No path hashes.** "hash-of-path" is *not* a safe aggregate — it's a dictionary attack
  waiting to happen. `package.json`, `.env`, `bun.lockb`, `src/index.ts` hash to known values,
  and stable hashes make a user's tree linkable across events. The server already doesn't need
  plaintext paths (`FileEntry.path` is local manifest data; the manifest is encrypted before
  commit) — keep it that way. If a path *dimension* is ever truly needed, it must be a coarse
  bucket (extension class, depth band), never a per-path identifier.
- **No raw IDs as analytics dimensions.** Account / device / workspace IDs + route + status +
  byte counts + commit cadence + conflict rate reconstruct a detailed work-pattern timeline.
  Use **route templates** (`/v1/ws/:ws/...` → `/v1/ws/{ws}/...`, params stripped) and coarse,
  privacy-scoped, rotating identifiers — not the raw principal/device id.
- **No blob/commit hashes, upload IDs, bearer tokens, raw URLs, or request/response/error
  bodies** in logs or analytics. These are direct content/identity handles.
- **Sizes and counts are sensitive as labels.** The commit body already exposes `blobRefs`,
  sizes, `encManifestSha`, sequence, epoch, and device id to the server
  (`apps/api/src/workspace-sync.ts:134`), and convergent blob encryption deliberately leaks
  byte-equality within a workspace/key epoch (`src/engine/crypto.ts:10`). Log fields and
  analytics dimensions use coarse buckets only. Analytics Engine numeric measures may keep
  raw durations, sizes, counts, and ratios so percentiles remain queryable; do not mirror
  those raw values into dimensions, logs, IDs, paths, hashes, tokens, or raw request material.

This is non-negotiable and reviewed per-PR against the list above.

### 5.1 Client-side timing (extend, don't replace, `SyncMetrics`)

`src/cli/metrics.ts` already persists counters to `.rbox/state/metrics.json` and surfaces
them in `rbox status`. Extend the record with rolling latency/throughput per operation:

- wrap the existing hooks: `SyncDeps.onProgress(done,total,phase)` and
  `onCommitConflict` (`sync.ts:46,50`) already exist — add `onPhaseTiming(phase, ms, bytes)`.
- instrument the `pool()` workers in `sync.ts:56` for per-blob encrypt/upload latency + bytes.
- time `scanManifest`/`drainHashes`, `crypto.ts` encrypt/decrypt, and each `remote.ts`
  fetch (per-blob latency/bytes — the single richest client signal).
- store as bounded reservoirs / t-digests (not raw samples) so the file stays small;
  surface p50/p95 in `rbox status` and `rbox doctor`.

This gives every user a local "why was that sync slow" view with zero network egress.
`rbox doctor --report` (explicit opt-in) bundles only the §5 aggregate — and **shows the user
the exact payload locally before anything leaves the device**, so the privacy claim is
verifiable, not asserted.

### 5.2 Server-side telemetry (the current black hole)

The Worker has almost no observability (`apps/api/src/`). Add, in priority order:

1. **Structured logging + request IDs.** One JSON log line per request: `reqId`, **templated**
   route (params stripped — `/v1/ws/{ws}/...`, never the raw path), status, duration,
   size-bucket, coarse/rotating principal, and `r2Ms`/`d1Ms`/`doMs` sub-timings. Replaces the
   ad-hoc `console` calls. Emit it for early 4xx validation failures too; request rows/logs
   are the source of truth for total request counts. **Never** log raw URLs, bodies, tokens,
   blob/commit SHAs, upload IDs, or raw error strings (per §5 ban list).
2. **Per-operation latency to Workers Analytics Engine.** Cheap, built-in, queryable.
   Dimensions: route, op (`blobPut`/`multipart*`/`commit`/`pull`), status, size-bucket.
   Blobs (`apps/api/src/blobs.ts:52,83-200`) and the DO `transactionSync`
   (`apps/api/src/workspace-sync.ts`) are the must-instrument paths. Op rows describe work
   that actually ran, so some early 4xxs intentionally have only a request row.
3. **Tail Worker** for error/exception aggregation + slow-request sampling (log requests
   over a p99 threshold with their sub-timings).
4. **DO contention metrics.** 409 rate and `transactionSync` hold time — this is the
   sharpest "it's slow under concurrency" signal and currently invisible.
5. **§23/§24 validation signals.** Add stale-receipt reject counts, orphan candidate/deletion
   counts, sidecar fetch/parse latency, and GC sidecar fail-closed abort counts when those
   paths land. These are observability hooks for the accepted designs, not architecture
   changes.

### 5.3 Surfacing "what is slow"

- A Cloudflare dashboard (or a tiny `apps/web` admin page) over Analytics Engine: p50/p95/p99
  per op, throughput, 409 rate, R2 part-upload latency, all over time.
- **Slow-op alerting**: threshold on server p99 and on client-reported aggregates (opt-in).
- The benchmark result schema (§3) and the production telemetry schema share field names
  **only where the unit is identical** — define the byte/duration basis first (§3.1), then
  unify names. A synthetic `bytesPerSec` and a prod `bytesPerSec` that mean different bases
  (plaintext vs wire) is worse than two clearly-different names.
- **Future, out of core §25:** blocklist/streaming-overlap metrics belong in a later protocol
  pass. If added, keep them bounded and low-cardinality: prefetched block counts, prefetch
  cache size buckets, hit/miss rates, and block-index/download-progress overlap.

## 6. CI integration & regression gating

- `bun run bench` → runs the micro + `tiny`/`repo` macro benches via Miniflare, emits JSONL.
- A CI job runs benches on every PR. **Compare base vs head in the same job, back-to-back, on
  the same runner** — diffing against a "last main result" from a *different* machine just
  measures runner variance. `scripts/bench/compare.ts` reports the delta with CI overlap.
- **Report-only burn-in first.** Ship the comparison as a non-blocking PR comment and collect
  weeks of base-vs-head data to learn the actual run-to-run noise floor *on CI hardware*. Only
  after that data exists do we set a tolerance budget (a regression beyond the measured noise,
  sustained across repeats) and let it block merges. Gating before burn-in = flaky CI and
  ignored alerts.
- Heavy corpora (`bigfiles`, two-VM e2e) run on a **nightly/manual** job, not per-PR.
- Store nightly baselines so we can chart engine perf over time (the README's "2.4s" becomes
  a tracked line, not a one-time boast).

## 7. Proposed layout

```
scripts/bench/
  run.ts          # dispatcher: run.ts <bench> <corpus>  (extends bench-scan.ts patterns)
  corpus.ts       # deterministic seeded fixture generator
  time.ts         # shared timing + percentile/t-digest helper, result schema
  compare.ts      # diff two JSONL result files -> regression table
  e2e.ts          # host-adaptive e2e rig: Apple `container` (macOS) / Docker (Linux)
bench-results/    # gitignored JSONL output
docs/benchmarking-and-observability.md   # this doc
```

`scripts/bench-scan.ts` folds into `scripts/bench/run.ts scan` and becomes the template the
rest follow.

## 8. Phased rollout

1. **P0 — harness skeleton.** `time.ts` + result schema (with raw samples) + `corpus.ts`
   (`tiny`,`repo`) + reset contract; fold in scan bench; micro-benches for
   hash/encrypt/decrypt/diff. *Outcome: honest local numbers.*
2. **P1 — server timing + macro + CI (report-only).** Structured logs + request IDs +
   per-op timing in the Worker land **here, not last** — you can't validate macro e2e, conflict
   storms, or DO contention without server-side latency. first-push/incremental/pull against
   Miniflare; `compare.ts`; **report-only** base-vs-head burn-in (§6). *Outcome: regressions
   visible (not yet gated) + server latency observable.*
3. **P2 — host-adaptive e2e + gating.** `e2e.ts` with the Apple-`container`/Docker backends
   (§4); nightly `bigfiles` + Linux-VM run + staging-Worker run. Turn on the CI gate once
   burn-in data sets the noise floor. *Outcome: isolated e2e numbers + multipart/large-file
   coverage + enforced regression budget.*
4. **P3 — client telemetry.** extend `SyncMetrics` with timings; `rbox status`/`doctor`
   surfacing + opt-in `doctor --report` with local preview. *Outcome: per-user "why slow",
   no egress.*
5. **P4 — production analytics.** Analytics Engine + Tail Worker; dashboard + slow-op alerting,
   all behind the §5 metadata threat model. *Outcome: production p50/p95/p99 + DO contention
   trends.*

P0–P2 answer "did we regress." P3–P4 answer "what's slow for real users." Ship in order;
each phase stands alone. (Server *timing* moved up to P1; full production *analytics* stays at
P4 — you need the former to trust e2e, but the latter only matters once there are real users.)

## 9. Adversarial review

This doc was reviewed by Codex (adversarial pass). Accepted and folded in: raw-sample
retention + no-p99-from-tiny-N (§3), the per-iteration reset contract (§3), corpus provenance
in the schema (§3.2), the "this is a Linux-VM client bench, not Mac↔Linux" honesty + ephemeral
disk for cold runs + decorative second VM (§4), the metadata threat model replacing the privacy
slogan — banning path hashes, raw IDs, raw routes, blob/commit hashes, and body/error logging
while allowing raw numeric measures in AE blobs (§5), the byte-basis-before-shared-names fix
(§3.1/§5.3), report-only burn-in before CI gating (§6), moving server *timing* up to P1 (§8),
and the missing bench classes (§2.2). Two factual errors it caught are corrected in §2.1
(chain-verify runs in `latest()`, not every `refreshAccount()`; `HASH_CONCURRENCY` lives in
the drain path, not `hashFile`).

## 10. Open questions

- **Encrypt double-pass**: is the plaintext re-hash in `crypto.ts:62` avoidable (reuse the
  hash the scan already computed)? The bench should quantify the win before we refactor crypto.
- **Chain verification growth**: at what history depth does `verifyCommitChain` (`e2ee-remote.ts:127`)
  become the pull bottleneck? Does it need a verified-checkpoint/pin cache?
- **Page-cache control on macOS** for trustworthy cold runs — `purge` needs sudo; acceptable
  for nightly, not per-PR. Fall back to fresh VM = guaranteed cold.
- **t-digest vs reservoir** for the on-device metrics file — which keeps the file smallest while
  preserving p99 fidelity?
- **Analytics Engine sampling**: at what request volume do we need sampling, and does sampling
  bias the p99 we care about?
- **Baseline storage**: commit nightly baselines to a branch, or an external bucket? (repo bloat
  vs convenience.)
