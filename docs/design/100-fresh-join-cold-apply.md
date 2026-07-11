# 100 - Fresh join cold apply: directory-trie apply, size-aware lanes, Git chain prefetch

Status: Design draft v5 (v1 → REVISE 18; v2 → REVISE 9; v3 → REVISE 6;
v4 → REVISE 1; dispositions in `REVIEW-100.md`). Measurement-first, falsification-first —
modelled on design 85's phase-0 discipline (measure, falsify, then build). Every
build gate is stated so a phase-0 number can KILL the corresponding phase before
a line ships. Client-only; no server or wire-format change.

**Implementable envelope: Phases 0–3** (directory-trie apply, size-aware lanes,
within-repo Git artifact prefetch). Phase 4 (streaming decrypt) and Phase 5
(local plaintext source) are MEASUREMENT + DISPOSITION notes only in this
doc — if their triggers fire they are implemented in their own designs (R1 #17),
because each substantially changes the transfer/trust surface and must not ride
this design's correctness and rollout envelope.

Origin: the 2026-07-10 sync performance audit
(`docs/audits/2026-07-10-sync-performance-audit.md`), Findings 11–14 and the
"initial download" opportunity map (audit:123–130). Fresh join — a new device
pulling a whole workspace from empty — is the second-device "it just synced"
moment, and onboarding is THE conversion moment. Worth attacking even though it
is not the steady-state hot path.

Measured baseline (audit executive summary, audit:33–43): a **wired 96k-file
fresh join is 84s total, of which Git materialization ≈ 34s**. The audit found
the remaining ~50s outside Git contains (a) cold apply that repeats directory
work — hundreds of thousands of redundant path operations (Finding 12), and (b)
an encrypted pull that performs avoidable disk passes (Finding 13). These
numbers are STALE BY DEFAULT: §3.0 (phase 0) re-measures on current `main`
before any later gate is evaluated, exactly as design 85 §5 does.

Related: design 39 (pull/apply optimization — the size-aware scheduler Phase 2
applies; NOT yet shipped for cold apply, see §3.2), design 36 (blob transfer
pipeline — the disk-pass shape Finding 13 attacks), design 53 (incremental git
packs — the pack-chain + presence-skip Phase 3 must PRESERVE, SHIPPED, never
re-proposed), design 81 (worker-pool crypto — the reason decrypt+write is ~1% of
wall on the source-heavy corpus, which bounds Finding 13), design 52 (local blob
source — the sibling-worktree opportunity, §3.5), design 85 (the scan side of
cold work; this design owns the APPLY side and shares its phase-0 method).

**Shipped work this design MUST NOT re-propose, rebuild, retune, or claim as its
own win** (audit:68–98, verified in code; R1 #12). Implementation-diff
boundaries are stated per phase:

| Shipped mechanism | Code | This design's boundary |
|---|---|---|
| Repository-level parallel Git materialization | `poolMap(nestedRepoChains, gitApplyConcurrency(), …)` `src/cli/sync-git.ts:2282` | Phase 3 works INSIDE one repo's slot; the repo `poolMap` and `gitApplyConcurrency` default (6) are untouched |
| Incremental Git pack chains + presence-skip | `importGitPackChain` `src/engine/git/shared.ts:298–311` | Import-time presence-skip stays verbatim and authoritative; Phase 3 ADDS an early producer-side check as its own deliverable (§3.3, R2 #9); chain construction untouched |
| Git-plan fingerprint caching | (design 83) | Out of scope; not touched |
| Small-blob batch GET | `apps/api/src/blob-batch.ts` | All apply measurements run WITH batching on; not modified |
| 48 download-slot knee | apply.ts:106–112 | Phase 2 splits lanes; it does not raise the measured knee |
| Bun crypto worker pool | `withCryptoPool` apply.ts:120 | Phase 4 (deferred) would reuse it; not re-proposed |

## HARD PRIVACY RULE (applies to every phase, especially phase 0)

No raw file names or paths may appear in any **emitted** metric or **log line**
this design adds. Emitted metrics carry **counts, bytes, durations, and errno
codes only**. In-memory path use is fine and necessary — the directory trie
(§3.1) and its obstruction records hold paths in memory so the fallback resolver
can act on them (R1 #9); the rule prohibits SERIALIZING or LOGGING a path, not
holding one. The phase-0 collector and every new counter below are path-free at
the emission boundary by construction, and the gate protocol (§5) treats a path
leak in an emitted metric/log as a build-blocking test failure, not a nit.

## 1. Problem and evidence

Measured means observed directly on the named workload; inferred follows from
those measurements but still needs the phase-0 gate in §5. All line references
are the v1.0.0 working tree.

### 1.1 Git materialization is ~40% of the join wall, and serial within a repo (Finding 11)

Repository-level concurrency already shipped and pulled the Git phase to ≈34s
(audit:821). What is still serial is the work INSIDE one repository. Each
pack-chain link is downloaded → decrypted → bundle-verified → imported, then the
next link starts (`importGitPackChain`, `src/engine/git/shared.ts:288–311`: the
`for` loop calls `getGitArtifact` then `git bundle verify` then `git fetch` per
link, in order). Index and op-state side artifacts are fetched serially BEFORE
import (`src/engine/git/apply.ts:237–258`). The design-53 chain bound permits up
to ~8 links per repository, so a deep-history repo pays up to eight
strictly-ordered fetch→decrypt→verify→import cycles even though the FETCH of link
N+1 is independent of the IMPORT of link N.

The ceiling is unknown until phase 0 attributes the 34s across fetch/decrypt vs.
bundle-verify vs. git-import. If git-import (subprocess CPU) dominates, prefetch
has almost no ceiling — so §3.3 SHIPS ONLY on a phase-0 finding that
fetch/decrypt stalls are a meaningful share of the 34s (§5 G4).

### 1.2 Cold apply repeats directory work (Finding 12)

`applyActions` (`src/engine/apply.ts:66–182`) already fixed the old ~500k
per-file ancestor probe. Two residues remain:

1. **Duplicate `mkdir -p`.** An encrypted batch-delivered file can call recursive
   mkdir at three layers: `writeEntry` before staging (apply.ts:207); `writePayload`
   before writing (`src/cli/remote/blob-batch.ts:545–551`); and `publishAttempt`
   before rename (`blob-batch.ts:535–542`). For a 96k-file join every file
   re-walks and re-`mkdir`s its ancestor chain two-to-three times.
   `mkdir(recursive)` is not free even when the directory exists — it stats
   components.
2. **The unique-ancestor pass.** The obstruction-detection pass
   (apply.ts:85–133) builds `needDirs` and `lstat`s each shallowest-first before
   the write pool. That is O(unique directories), not O(files) — already good —
   but on the no-obstruction steady state it is still a full serial `lstat` sweep
   of every directory the join will populate, whose only product is "no
   obstruction found." On a fresh (empty) join there is by definition nothing to
   obstruct.

Fix (Finding 12's recommendation): build the directory tree ONCE, create each
directory once in a pre-pass, and give writers a "parent prepared" contract so
the three mkdir layers collapse. Quantified in §3.1, gated in §5.

### 1.3 Encrypted pull performs avoidable disk passes (Finding 13, with its priority caveat)

`stageEntryToTemp` (apply.ts:264–295): (1) downloads ciphertext to a `.ct` temp
(apply.ts:275); (2) hashes it while landing; (3) re-reads `.ct` to decrypt into
the plaintext temp (apply.ts:278); (4) re-reads the plaintext temp to verify
`plaintextSha` (`src/engine/crypto.ts:283–335`); (5) removes `.ct` (apply.ts:285)
— one extra full write + two extra full reads per blob vs. a single streaming
pass.

**Priority caveat (audit:1018–1031).** Design 81's worker pool already put
decrypt+write near **1% of wall** on the current source-heavy corpus. This is NOT
a top fresh-join project today; it matters for very large blobs, disk-constrained
agents, temp-disk PEAK (the `.ct` temp doubles peak transient bytes per in-flight
blob), and future paths where the network/Git poles have fallen. Scoped as a
measurement + disposition note (§3.4), to be implemented in its own design —
ideally folded into the shared upload/download transfer module (audit:1029–1030).

### 1.4 Local plaintext can satisfy sibling-worktree joins (Finding 14)

Design 52: the common new-worktree case where thousands of intended remote files
already exist byte-identically in sibling worktrees; the current pull still GETs
and decrypts them. Helps a sibling-worktree join dramatically and a truly empty
host not at all (audit:129). Scoped as a measurement + disposition note (§3.5).

### 1.5 What is NOT in scope

The read-optimized small-blob pack cache (Finding 15, audit:1054–1079) is
conditional and an explicit non-opportunity (audit:1199). It is fully OUT of
this design (§7): not a gate, not a blocker, and — per R2 #8 — not even an
"optional metric." A future Finding-15 design owns and justifies its own
evidence collection.

## 2. Invariant (stated first, design-85 style)

> **A fresh join publishes only atomically-staged, fully-verified bytes; never
> leaves a displaced-obstruction subtree unrecoverable; converges on re-run
> without losing user bytes; and every optimization here can only do EXTRA safe
> work — the moment reality contradicts the plan it demotes to the proven
> per-entry path.** Concretely:
>
> (a) **File atomicity and guard placement are unchanged — stated honestly
> (R2 #1).** Every file is still staged to a temp beside its target and
> atomically `rename`d in (`writeEntry`, apply.ts:209–241;
> `restoreEntryToPath:335–348`). `assertWithinRoot`
> (`src/engine/fsutil.ts:60–80`) realpath-walks every ancestor ONCE at the top
> of `writeEntry` (apply.ts:206), before mkdir/stage/rename; there is NO
> re-validation between that check and the final `rename`. A window therefore
> exists TODAY in which an external process replacing an ancestor with a
> symlink after the check could redirect a publish — that is the CURRENT
> code's exposure, not something this design introduces or claims to fix.
> Phase 1's obligation is narrower and testable: the check keeps exactly its
> current per-entry placement at write time (well after the pre-pass), and the
> only removed operations are redundant `mkdir` calls — so the window is not
> widened. Closing it for real (anchored `openat`/`O_NOFOLLOW` directory
> handles) is an independent hardening project, explicitly out of scope (§7).
>
> (b) **Directory changes never straddle a failure unsafely.** The trie pre-pass
> (§3.1) touches DIRECTORIES only and only on the CLEAN path (create-or-confirm).
> The instant it meets anything that is not cleanly "absent, or already a
> directory," it demotes the WHOLE affected subtree to today's unchanged serial
> obstruction resolver (apply.ts:124–159), which stages+verifies the entire
> affected write group BEFORE displacing an obstruction. No new obstruction
> protocol is invented (R1 #1, #18).
>
> (c) **Trash-tier semantics are unchanged.** Type-flip directory eviction and
> propagated clean deletes still route through `TrashBatch` when present
> (apply.ts:236–239, `deleteEntry:362–380`); `restoreEntryToPath`'s
> trash-on-overwrite (apply.ts:339–347) is untouched.
>
> (d) **Resumability is a re-run, and correctness rests on the next run's
> scan+reconcile, not on apply internals** (R1 #3, #4). Re-running re-scans the
> partially-populated tree, reconciles against the manifest, and applies only the
> still-missing actions; the promise is "no user bytes lost," not "zero conflict
> copies" (§4.3).
>
> (e) **Emitted metrics/logs are path-free** (the HARD PRIVACY RULE), on every
> path.

## 3. Design (phased; Phase 0 = measurement)

### 3.0 Phase 0 — decompose the join wall (per-phase minimal evidence, not one giant blocker)

Instrumentation is measurement-only, behind `RBOX_METRICS` / a soak flag, and
changes no behavior — same rule as design 85 §5. It EXTENDS the existing
`PhaseReport` (pull already names `latest`/`state-load`/`scan`/`apply`,
`src/cli/sync.ts:239–267`) and `RBOX_LANE_TIMING` fetch-vs-write attribution
(apply.ts:253–262); it does not build a parallel metrics system.

**Structure (R1 #15).** Phase 0 is split into MANDATORY minimal evidence PER
downstream phase (each phase's own gate can proceed the moment ITS evidence
exists — phases do not block each other) plus OPTIONAL fleet characterization.
Owner and collection are named per item.

MANDATORY, minimal:

- **M-P1 (feeds Phase 1 / G1, G2):** daemon-stopped local fresh joins on ONE
  host (the §5 protocol's ≥5-sample rule applies — one HOST, not one RUN),
  path-free counters for `mkdir` API calls, directory-component walks, successful
  directory creations, `EEXIST` classifications, `lstat`/`open`/`rename` counts,
  plus the wall of the ancestor-preflight pass (apply.ts:85–159) split from the
  write pool, and total apply wall. Owner: whoever builds Phase 1.
- **M-P2 (feeds Phase 2 / G3):** per-write size (from `entry.size`, no extra
  stat) bucketed small/large, and the small-file lane's completion wall vs. the
  large-file blobs' transfer wall on the SAME join, so contention is observable.
- **M-P3 (feeds Phase 3 / G4):** extend per-repo `repoTimings`
  (`src/cli/sync-git.ts:2269–2278`) with chain-length, artifact fetch+decrypt
  wall, bundle-verify wall, git-import wall, index/op-state wall — measured UNDER
  the existing repo parallelism (so the number is the real serial-within-repo
  stall, not a single-repo microbenchmark, R1 #12).

OPTIONAL characterization (does NOT block any phase; run where practical):

- APFS + ext4, empty + sibling-worktree arms, wired + Wi-Fi, additional hosts,
  p50/p95/range, on the fleet. This widens confidence beyond the mandatory
  samples; it gates nothing.

No pack-cache instrumentation of any kind — not even "optional" (R2 #8): a
future Finding-15 design owns and justifies its own evidence.

### 3.1 Phase 1 — directory-trie apply plan (the clearest win)

Build the directory tree ONCE from the reconcile action set, create every needed
directory in a single pre-pass on the CLEAN path, and demote any obstruction
whole-subtree to the existing serial resolver.

```ts
interface DirObstruction { path: string; kind: "file" | "symlink" | "alias"; }  // path is IN-MEMORY only
interface DirectoryPlan {
  prepared: Set<string>;              // dirs created-or-confirmed this run (in-memory)
  demotedSubtrees: string[];          // roots handed back to the serial resolver (in-memory)
  collisionGroups: string[][];        // fold-key-equivalent target groups, serialized apply (in-memory)
  obstructions: DirObstruction[];     // in-memory; NEVER serialized/logged (privacy rule)
  counters: { mkdirCalls: number; created: number; eexistDir: number;
              demoted: number; collisionGroups: number; lstatCalls: number };   // path-free; safe to emit
}
```

- **EXACT-BYTE trie nodes + prefix-closed collision grouping (R1 #6; R2 #2, #3;
  R3 #2).** Insert each target path into a trie of directory nodes keyed by
  exact bytes. Do NOT merge case/normalization variants in memory — no portable
  equivalence key exists (APFS case/normalization vary by volume; ext4 can
  casefold), and merging would be WRONG on a case-sensitive volume. Separately,
  while building the plan, compute a conservative fold key (Unicode NFC +
  simple casefold) for **every path prefix** of every action path — not just
  full targets (R3 #2: `A/x` and `a/y` collide at the parent even though the
  full paths don't). Any fold key with >1 distinct exact-byte spelling marks a
  **colliding prefix set**; the **collision group** is the union of ALL actions
  whose paths pass through ANY member of that set (transitively closed across
  overlapping sets). The entire group is (a) EXCLUDED from the trie pre-pass —
  no §4.5 "confirm on EEXIST and continue" applies to any node under a
  colliding prefix; that shortcut exists only for non-colliding paths — and
  (b) removed from the parallel write pool and applied SERIALLY through
  today's per-entry path in deterministic (byte-order) sequence, which
  performs its own mkdir/precondition work per entry exactly as today. On a
  case-SENSITIVE volume the group members don't physically collide and serial
  application is merely slower for those entries; on a case-INSENSITIVE volume
  the serial order makes every physical-target interaction deterministic —
  never two concurrent `rename`s racing one physical file (R2 #2), and any
  obstruction/failure inside the group affects the group as a unit, so no
  alias keeps running concurrently against the same physical subtree (R2 #3).
  Honest coverage limit (R3 #2): a filesystem whose equivalence is STRANGER
  than NFC+casefold evades the flag and those paths REMAIN IN THE PARALLEL
  POOL — exactly today's behavior (today nothing is grouped at all), so the
  heuristic is strictly risk-reducing, never risk-adding; it is a mitigation,
  not a proof.
- **Unrepresentable-pair terminal state — durable across base advancement
  (R3 #1; R4 #1).** Grouping source: fold-key prefix grouping is computed over
  the FULL target manifest's paths (joined with the pending action set), not
  the action set alone — so an incoming `a/x` collides with an
  already-synced/on-disk `A/x` even when `A/x` has no pending action. When two
  manifest FILE entries fold-collide on their full paths and the serial
  application of the second discovers the first group-member's bytes at its
  physical target, the volume has proven it cannot represent both. Contract:
  the FIRST member (byte-order) is published; each remaining colliding member
  is **skipped with a loud per-path deferral** (join summary + logs by count
  and errno-style reason; paths only in the existing forensic log, never in
  metrics) — NOT conflict-copied, NOT re-fetched this run.
  **State model (R4 #1 — the load-bearing rule):** apply returns the skipped
  paths, and the pull **excludes those entries from the advanced base** —
  `lastSyncedManifest` is recorded as the remote manifest MINUS the skipped
  entries. Both convergence properties then follow from EXISTING reconcile
  semantics, with no new durable pending-set: (a) **no delete echo** — a
  subsequent PUSH sees "absent on disk, absent in base" for the skipped path,
  i.e. no local change, so it can never propose the remote delete (the R4
  data-loss echo is prevented by construction, not by a suppression list);
  (b) **stability** — a subsequent PULL sees "present in remote, absent in
  base" and re-emits the write action; the group is re-derived from the full
  manifest and the same byte-order rule re-defers it identically. The
  deferral is therefore re-computed truth, not stored state; an interruption
  anywhere loses nothing (the base simply advances less). If the colliding
  winner is later deleted remotely, the next pull's re-emitted action for the
  loser applies cleanly — the deferral self-heals. §8's remaining founder
  question is only whether/how to SURFACE the standing deferral (status/UI),
  not its safety.
- **One shallowest-first creation pre-pass, CLEAN path only.** Walk breadth-first;
  `mkdir` (non-recursive) each node once.
  - success → node prepared; descendants proceed.
  - `EEXIST` → `lstat` THAT node only (not a whole-tree sweep, R1 #8): a directory
    is success (prepared); a file/symlink is an obstruction.
  - `ENOTDIR` (an ancestor is a file) or an obstruction at this node → record the
    obstruction (in-memory path) and **demote the entire subtree rooted at the
    obstruction to the existing serial resolver** (apply.ts:124–159), which
    already stages+verifies every affected write before displacing, then
    publishes (invariant (b)). The pre-pass creates nothing under a demoted root.
  - On an EMPTY (fresh) target every `mkdir` succeeds, so the whole serial
    obstruction `lstat` sweep (apply.ts:125–133) is skipped: absent node ⇒ absent
    descendants, do not stat them (audit:915).
- **`parentPrepared` is a concrete cross-layer flag, not prose (R1 #2; R2 #6).**
  Plumbing, named: `applyActions` already threads per-action named options into
  `writeEntry` (`WriteEntryOptions`, apply.ts:189–195 — the `preparedTmp`
  precedent); Phase 1 adds `parentPrepared?: boolean`, set iff the entry's
  parent chain is in `plan.prepared` and the entry is not in a demoted
  subtree/collision group. For the batch downloader, the per-payload request
  record that already carries the destination temp path gains the same boolean,
  set at enqueue time from the same plan; `writePayload`
  (blob-batch.ts:545–551) and `publishAttempt` (blob-batch.ts:535–542) skip
  their `mkdir` iff it is set. Failure contract, stated against what the code
  ACTUALLY does (R3 #4): `applyActions`' write pool is FAIL-FAST — `poolMap`
  rejects on the first task failure (`src/engine/pool.ts:7–10`); there is no
  per-entry retry in the apply layer today, and this design adds none. So a
  flagged write that fails ENOENT/ENOTDIR (a prepared parent vanished)
  **fails that apply run**, exactly as any staging failure fails it today, and
  recovery is the §4.3 re-run contract: the next join builds a FRESH plan
  against current disk truth and converges. Where retry legs DO exist — inside
  the batch downloader (its internal re-attempts and its
  fall-back-to-single-payload leg) — every retry leg MUST clear
  `parentPrepared` and take the mkdir path: the flag is valid for exactly one
  attempt. Both are tested: (a) remove a prepared parent mid-pool → the apply
  fails loudly and a re-run converges; (b) a batch-internal retry after a
  flagged ENOENT runs unflagged, recreates the directory, and succeeds. All
  safety checks (`assertWithinRoot` at its current placement, precondition
  re-check, atomic rename) run identically flagged or not — the flag can only
  remove an mkdir, never a guard.

**Expected reduction (confirmed by M-P1, gated by G2).** Directory creation drops
from O(files × depth × layers) `mkdir(recursive)` component-stats to one
non-recursive `mkdir` per directory on the empty path. On resume/sibling joins
existing directories yield `EEXIST`+one `lstat` each — so the honest gate (G2)
counts created vs. eexist-classified separately and REQUIRES an end-to-end
apply-wall win, not just a lower asymptotic counter (R1 #14).

### 3.2 Phase 2 — size-aware apply lanes

**Shipped-work boundary (R1 #12):** design 39's size-aware scheduler is NOT
shipped for cold apply — the current pull runs ONE pool at one concurrency
(`poolMap(rest, dlConc, …)`, apply.ts:161; default 512 with batching,
apply.ts:111–112), and Finding 12 explicitly lists "combine with design 39's
size-aware scheduler" as future work (audit:925–929). Phase 2 applies that
scheduler to the cold-apply write pool ONLY; it does not touch the batch GET
coalescer, the 48-slot knee, or steady-state pull.

Small-file work is IOPS/round-trip bound (wants wide concurrency); large-file
work is bandwidth/disk bound (wants narrow streaming). Split the write set on a
size threshold (from manifest `entry.size`):

- **Small-file lane:** wide bounded concurrency; feeds the batch coalescer
  exactly as today (the coalescer, not the pool, bounds real network parallelism,
  apply.ts:106–110).
- **Large-file lane:** narrow, streaming straight to temp (`store.getToFile`
  already streams without a whole-file buffer, apply.ts:290–293).
- **Shared FD/RSS budget** across both lanes so they cannot jointly exceed the
  process ceiling.

Ships only if M-P2 shows large-file blobs materially contend the small-file lane
(§5 G3); a uniformly-small corpus gains nothing and the split stays off.

### 3.3 Phase 3 — within-repo Git artifact prefetch (ordered bounded pipeline; gated on M-P3)

Within EACH repository's existing `applyGitSections` slot, overlap link N+1's
fetch+decrypt with link N's verify+import. Strictly inside the per-repo work; the
repo-level `poolMap` and `gitApplyConcurrency` (default 6) are untouched (R1 #12).

**Presence-skip: what is preserved vs. what is new (R1 #11; R2 #9).** Two
distinct things, stated precisely:

- PRESERVED UNCHANGED: chain construction, the shipped import-time presence-skip
  (`src/engine/git/shared.ts:306–309` — the consumer re-runs it verbatim,
  authoritative, immediately before each import), batch GET, incremental packs,
  and repository parallelism. None is rebuilt or retuned.
- NEW, and a deliverable of THIS phase: an EARLY presence check in the producer —
  before acquiring a fetch slot for a historical link, run the same
  `gitTipsPresent` predicate; if the tips are present, the producer skips the
  download entirely. Semantics for BOTH presence transitions (R3 #3):
  - producer MISS → consumer-time PRESENT (an earlier link's import made the
    tips present): the authoritative import-time skip drops the prefetched
    artifact — wasted bytes only.
  - producer HIT (download skipped) → consumer-time ABSENT (cannot arise from
    rbox's own apply, which only adds objects mid-apply; possible under a
    concurrent external `git prune`): the consumer performs a **late fetch** —
    the ordinary fetch+decrypt for that link under the same global
    semaphore/byte budgets — then verifies and imports in chain order. The
    consumer always holds the link descriptor, so nothing is missing; the
    pipeline stalls one link, which is exactly today's serial cost. If the
    late fetch fails, the repo defers via the existing per-repo catch.
  With the late-fetch rule the early check has NO correctness role on either
  transition: every imported link passed the authoritative import-time
  decision with an artifact in hand. Test: inject tip removal between producer
  skip and consumer import → link is late-fetched and imported.

**Ordered bounded producer/consumer (R1 #10)** — not await-all-then-import:

```
// per repository, inside the existing applyGitSections poolMap slot:
producer:  walk links in chain order; for each link whose tips are NOT already
           present, acquire a slot from the GLOBAL artifact semaphore
           (bounded by BOTH ready-artifact count K and total in-flight bytes),
           fetch+decrypt to a temp, hand the ready artifact to the consumer queue.
consumer:  in strict chain order, take the next ready artifact, revalidate
           presence-skip, `git bundle verify`, `git fetch` (import). Import of N
           overlaps fetch of N+1..N+K, never exceeding K ready artifacts.
on error:  cancel outstanding producers, delete prefetched temps, defer THIS repo
           via the existing per-repo catch (`src/cli/sync-git.ts:2260–2267`).
```

- **GLOBAL artifact semaphore** bounds total in-flight fetch/decrypt across the
  whole repo pool (task count AND byte budget), so six repos under
  `gitApplyConcurrency` cannot each launch eight unbounded fetches (audit:860–861).
  One shared semaphore; per-repo concurrency unchanged.
- **Import order + verification unchanged**; `git` mutating one repo stays
  single-threaded per repo. Bundle-verify + `git fetch` still gate publication.
- **No half-apply**: prefetch never mutates the repo; a failed prefetch is wasted
  bytes, deferred cleanly (invariant (b)).

**HARD SHIP GATE (§5 G4):** ships ONLY if M-P3 shows fetch+decrypt is a
meaningful, overlappable share of a repo's git wall AND prefetch reduces the
measured 34s Git phase (audit:1316). If git-import (subprocess CPU,
unoverlappable) dominates, prefetch is NOT built.

### 3.4 Phase 4 (MEASUREMENT + DISPOSITION ONLY) — fewer decrypt disk passes

Streaming staging primitive that decrypts network ciphertext on the fly, hashing
ciphertext and plaintext in one pass, writing plaintext straight to the staging
temp (audit `stageEncryptedBlob`, audit:980–1008), removing the `.ct` temp and
the final plaintext re-read; apply RETAINS preconditions/conflict/atomic publish
(audit:1013). Decrypt+write is ~1% of wall today (§1.3), so this design only
MEASURES the lane (part of M-P1's decrypt+write timing) and records the
disposition: if a re-measured lane, a large-blob workload, or a temp-disk-peak
constraint justifies it, it is implemented in its own design, ideally folded into
the shared transfer module (R1 #17). It is NOT justified by the 84s number and
carries no fresh-join wall gate here.

### 3.5 Phase 5 (MEASUREMENT + DISPOSITION ONLY) — local plaintext source

For a target plaintext SHA already present byte-identically in a sibling worktree
(design 52): reflink/copy local → staging temp, hash the temp, publish only on a
plaintext-SHA match, fall back per-file to GET+decrypt on any error
(audit:1044–1049). A HINT, never a trust source (hash re-verification mandatory).
It substantially expands source-discovery/trust surface, so this design only
records the disposition (R1 #17): built in its OWN design iff the sibling-worktree
arm of Workload C shows a large local-duplicate share AND blob transfer is a
dominant pole for that arm; otherwise DEFERRED. Either way re-benchmarked under
the current batch transport (audit:1051–1052).

## 4. Correctness requirements

### 4.1 File atomicity + directory-level failure recovery (R1 #18)

File publish is unchanged (staged temp → `rename`; invariant (a)). Directory
changes never straddle a failure unsafely (invariant (b)): an obstruction is
resolved only by the existing serial resolver, which stages+verifies the whole
affected write group before displacing. Tests inject failure during: (1)
obstruction discovery; (2) descendant staging; (3) obstruction displacement; (4)
directory recreation; (5) multi-file publication under a just-created directory.
Required invariant: a displaced obstruction is never left without its replacement
set safely recoverable — i.e. the user's displaced bytes survive (conflict copy
or trash per the existing rule) even if the join dies before publishing the
replacements.

### 4.2 Trash-tier semantics unchanged

Type-flip eviction to trash (apply.ts:236–239), clean-delete trashing
(`deleteEntry`, apply.ts:374–376), and restore-overwrite trashing
(apply.ts:339–347) are downstream of the write pool and untouched; the trie
pre-pass never deletes. Test: the design-50 trash suite passes unchanged; a fresh
join evicting a squatting directory routes it to trash, not `rm` (churn-bomb
reasoning at apply.ts:232–234 preserved).

### 4.3 Interrupted-join resume — persistent-intermediate inventory (R1 #3, #4)

SIGKILL runs no cleanup. After an interruption the tree may hold, per source:

| Intermediate | Source | Re-run behavior |
|---|---|---|
| Atomically-published files | `rename` in `writeEntry` | Next scan sees them; reconcile emits no action (already match manifest) — no re-write, no conflict |
| `.rbox-tmp-*` staging temps | `tmpName`, apply.ts:447–450 | Matcher-pruned (`ignore.ts:86`) so never pushed; best-effort removed on a clean run; harmless orphans otherwise |
| `.ct` ciphertext temps | `stageEntryToTemp`, apply.ts:271 | Same prefix family / beside-target temp; matcher-pruned; harmless orphan |
| Empty directories from the trie pre-pass | §3.1 | Not manifest entries; ignored by scan; harmless |
| Git scratch refs `refs/rbox-incoming/*` | `importGitPackChain`, git/apply.ts:219–220 | Next git-apply runs `pruneStaleScratchRefs` before import (git/apply.ts:219) — reclaimed |
| Prefetched artifact temps | §3.3 producer | Written under the per-repo `tmpDir`; cleaned on next apply's tmp setup; never referenced by published state |
| Partial `git fetch` / stale lock files | `git fetch` mid-kill | Stale git lock blocks the next git op on that repo → that repo DEFERS LOUDLY via the existing per-repo catch (`git-sync deferred <repo>: …`), and the rest of the workspace converges. Pre-existing exposure of every git-touching path today, unchanged by this design; whether rbox should auto-reclaim provably-rbox-owned stale locks is a separate design question, NOT solved here |

Convergence rests on the next run's scan+reconcile, NOT on apply internals
(invariant (d)). The gate (§4.3 tests), stated so it can actually pass (R2 #4) —
two tiers:

- **File plane (unconditional for representable entries, R3 #1):** SIGKILL at
  phase boundaries AND at the dangerous instruction-level windows (between
  obstruction-displace and replacement-publish; between temp-stage and rename)
  followed by a clean re-run CONVERGES the file tree with **no user bytes
  lost**. Conflict copies are acceptable ONLY where the user actually diverged
  between attempts; a file merely re-seen from a prior attempt must NOT
  produce a conflict copy (reconcile, not apply, decides it). Entries the
  volume cannot represent (§3.1 unrepresentable-pair contract) converge to the
  STABLE "deferred-loudly" state: skipped entries are excluded from the
  advanced base (R4 #1), so every re-run re-derives the same deferral, a push
  can never propose their remote delete (absent-on-disk + absent-in-base = no
  local change), and remote deletion of the colliding winner self-heals the
  loser on a later pull. Tests: join → push cycle proposes NO delete for a
  deferred entry; repeated joins yield identical deferrals and zero conflict
  copies; remote delete of the winner materializes the loser next pull.
- **Git plane (converge-or-defer-loudly):** SIGKILL mid-`git fetch` followed by
  a clean re-run either converges that repo (the common case — bundle import is
  re-runnable and scratch refs are pruned) or defers THAT REPO with a visible
  reason while every other repo and the whole file plane converge. Silent
  corruption or a wedged whole-join is a test failure; a loud single-repo
  deferral on a genuinely stale foreign lock is not.

### 4.4 Torn-scan / watcher interaction while a join is in flight

A fresh join may run under a live daemon watching the same tree (R1 #5).

1. **Staging events are NOT new.** Apply ALREADY stages `.rbox-tmp-*` temps beside
   targets and renames them today, and those temps are matcher-pruned
   (`ignore.ts:86`), so the watcher already ignores temp create/write/rename/cleanup.
   This design adds only bare `mkdir` events for empty directories, which are not
   manifest entries. Test: with a daemon watching, the directory pre-pass adds
   zero files to the daemon's pending push set.
2. **The daemon-manifest handoff, named (R2 #5).** Three states are in play: the
   pulled remote manifest, the daemon's watcher-maintained in-memory manifest,
   and the persisted `lastSyncedManifest` in `state.json`. The handoff this
   design RELIES ON (and does not change) is the existing one: (i) the join,
   as a top-level mutex owner (design 93), writes `state.json` —
   `lastSyncedManifest` now equals the pulled manifest — before releasing the
   lock; (ii) the daemon's queued watcher events for the join's published
   files are then applied through `applyWatchEvents`
   (`src/engine/manifest.ts:101–199` — re-stat/re-hash each settled path), so
   its in-memory manifest converges to the on-disk truth the join created;
   (iii) the daemon's next push computes divergence against the UPDATED
   `lastSyncedManifest`, and join-authored bytes show zero divergence — the
   drain is not "hiding" state updates, it is performing them, and a push with
   nothing divergent is correctly empty. A CONCURRENT USER EDIT during the join
   is real divergence and MUST survive the drain as a pending push. Tests: (a)
   drain the queue after a join under a live daemon → daemon manifest equals
   the pulled manifest, no push fires; (b) the SAME-TARGET adversarial case
   (R3 #5), not just an unrelated-path edit: the user edits path P AFTER the
   join publishes P but BEFORE the queued events for P drain, so the daemon's
   queue holds coalesced add/change (and possibly unlink/re-add) events for
   ONE path with two authors — assert `applyWatchEvents` re-stats FINAL disk
   truth, the user's edit is retained as divergence against the newly
   persisted remote base (pending push), and neither is the edit lost nor a
   join-authored version pushed as if it were the user's; (c) the daemon's
   existing post-pull/safety rescan sites (design 85 §1.1) remain the backstop
   if events were dropped — unchanged by this design.
3. **No torn tuple.** Files publish by atomic rename (one settled event); design
   85's P-1 torn-scan guard and design 92 manifest-entry integrity are the
   backstop, unchanged. This design adds no new top-level mutex owner and takes no
   lock the current apply path does not already take.

### 4.5 Case-sensitivity and symlink edge cases (R1 #6, #7, #8)

- **Exact-byte trie + prefix-closed collision groups (R2 #2, #3; R3 #1, #2).**
  Normative rules live in §3.1; summary: fold keys are computed over EVERY
  path prefix; a colliding prefix pulls its ENTIRE descendant action set into
  one collision group; collision groups are wholly excluded from the trie
  pre-pass (no EEXIST-confirm shortcut applies inside them — that shortcut is
  for non-colliding paths only, resolving v3's §3.1/§4.5 contradiction, R3
  #2) and applied serially through today's per-entry path in byte order. An
  unrepresentable FILE pair converges to §3.1's stable loud-deferral terminal
  state (first member published, rest deferred with visible reasons, no
  conflict churn on re-join). Test matrix: case-sensitive APFS,
  case-insensitive APFS, decomposed vs. composed Unicode names, casefolded
  ext4; file/file full-path collision, dir/file case collision, parent-only
  collision (`A/x` + `a/y` — one group, serialized, both land under one
  physical dir), Unicode-equivalent names; each asserting a deterministic
  outcome, no lost bytes, and re-run stability.
- **Symlinked ancestors.** A node that exists as a symlink/file where the trie
  wants a directory is classified by the single-node `lstat` on EEXIST/ENOTDIR
  (not a sweep) and demotes the subtree to the serial resolver, which moves the
  obstruction aside (visible conflict copy for a file/symlink — the existing
  semantic at apply.ts:135–159; directory type-flip uses trash, apply.ts:236–239)
  before creating the real directory. `assertWithinRoot` (realpath, symlink-
  following) still guards every publish. Tests: symlink chains, dangling links,
  links pointing outside root, and ancestor REPLACEMENT after prepare / after
  stage / immediately before rename (R1 #2).
- **Symlink FILES in the manifest** stage via `fs.symlink` into the temp and
  rename (apply.ts:265–267), unchanged.

## 5. Gates (falsifiable, with a uniform measurement protocol)

Gates to falsify, not promises (audit:1305).

**Measurement protocol (uniform, R1 #13; R2 #7).** Every effect-size gate names
its workload and is evaluated as CONTROL vs. CANDIDATE runs on the same host,
same corpus, same network class:

- Workload: benchmark Workload C, empty arm, 96k-file corpus, wired, daemon
  stopped (the sibling arm is named explicitly where a gate uses it).
- Samples: ≥5 valid runs per side, alternating control/candidate. A run is
  INVALID (discarded, reason recorded, replaced) only for documented external
  interference (another sync on the WAN, host sleep, OOM-kill of an unrelated
  process); silent discard is not allowed and ≥5 valid runs remain required.
- Pass rule: candidate p50 improvement must exceed the control's own
  (p95 − p50) noise band on the gated quantity.
- **Resource ceiling — true peaks where obtainable, hard caps as the actual
  invariant (R3 #6).** Memory: process HIGH-WATER RSS (`ru_maxrss` /
  `VmHWM`), not sampling — a true peak. Temp disk: BYTE ACCOUNTING by the
  owning code (the prefetch producer and blob stager account every temp byte
  they allocate/free — exact by construction), reported as owned-temp
  high-water. FDs: owned open/close accounting on the code paths this design
  touches, plus 1 Hz `/proc` sampling as an honest LOWER-BOUND backstop
  (labelled "sampled," never "peak"). Gate: candidate p50 of each TRUE peak
  must not exceed control p50 by >10%. Independent of measurement, the safety
  invariant is enforced by construction: Phase 3's global semaphore carries a
  HARD configured byte cap and task cap, and Phase 2's lanes share a HARD
  FD/RSS budget — the caps, not the measurements, are what bound the process.
- "≈" in any counter gate means **within 2% or ±16 absolute, whichever is
  larger** (the constant absorbs fixed-count setup dirs like `.rbox`).

- **G0 (privacy):** no emitted metric or log line contains a raw path (build-
  blocking test). NO pack-cache / R2 dependency in G0 (R1 #16, R2 #8).
- **G1 (Phase 1 prospective kill + wall):** prospective kill: if M-P1 shows
  directory-ops (ancestor-preflight + mkdir wall) are **< 8% of apply wall**
  (p50 over the M-P1 samples), Phase 1 is NOT built. Ship gate: candidate
  (trie ON) beats control (trie OFF, same build) on apply wall per the
  protocol, with the reduction concentrated in the directory-op split.
- **G2 (directory syscalls, disambiguated, R1 #14; R2 #7):** report mkdir API
  calls, component walks, successful creations, and EEXIST classifications
  SEPARATELY. Empty arm: `successfulCreations ≈ directoryCount` AND
  `mkdirApiCalls ≈ directoryCount` (the 2–3× per-layer amplification of §1.2 is
  gone; "≈" per the protocol). Resume/sibling arms: creations +
  EEXIST-classifications ≈ directoryCount (no O(files×depth) blowup).
  Falsifier: if M-P1 shows the CURRENT ratio is already ~1 mkdir/dir with no
  measurable directory-op wall, Phase 1's directory win is illusory.
- **G3 (lanes, control/candidate, R2 #7):** trigger: M-P2 shows the large-file
  transfer wall overlapping and extending the small-file lane's completion wall
  beyond the noise band on a Workload-C variant WITH large blobs (the variant is
  part of the gate definition). Ship gate: a lanes-ON prototype beats lanes-OFF
  on BOTH small-file-lane completion wall AND total apply wall per the protocol.
  Falsifier: a uniformly-small corpus shows no contention → lanes stay off.
- **G4 (Git prefetch):** trigger: M-P3 shows fetch+decrypt is **≥ 30% of
  per-repo git wall** (p50 across repos weighted by wall). Ship gate: a
  prefetch-ON prototype beats prefetch-OFF on the total Git phase per the
  protocol (audit:1316). Falsifier: git-import dominates → not built.
- **G5 / G6 (Phases 4/5):** no wall gate here; disposition only (§3.4/§3.5) —
  implemented in their own designs if their triggers fire.
- **G-correctness (all shipped phases):** the design-50 trash suite; §4.1
  directory-failure-injection tests; §4.3 interrupted-resume tests (phase-boundary
  AND instruction-level windows); §4.4 watcher drain test; §4.5 case/symlink
  matrix; and the corruption / conflict / E2EE-determinism suites (audit:1301) all
  pass.

## 6. Rollout

1. **Phase 0 minimal evidence first, per phase.** Land measurement-only
   instrumentation behind `RBOX_METRICS` / a soak flag; collect each phase's
   MANDATORY single-host evidence. No behavior change. Optional fleet
   characterization proceeds in parallel but blocks nothing (R1 #15).
2. **Phase 1 (directory trie)** — highest-confidence, lowest-risk — first among
   behavior changes, behind `RBOX_APPLY_DIR_TRIE` (on-by-default only after fleet
   dev-build validation), with the serial obstruction resolver as the fallback and
   the §4 suites as the gate. A/B the old release as control (audit:1300).
3. **Phase 2 (lanes)** and **Phase 3 (Git prefetch)** independently, each gated on
   its own M-P2/M-P3 number (G3/G4) and its own env kill-switch. Phase 3's global
   semaphore size is a tuned constant validated on the fleet, held to the 10% temp/
   RSS ceiling — never "raise the pool size" (audit:1190).
4. **Phases 4/5** are not implemented under this design; if triggered they get
   their own designs (R1 #17).
5. Every shipped phase: fleet dev-build validation on a real 96k-file join before
   merge; old release kept as A/B control; corruption/GC-fence/409/E2EE suites
   re-run (audit:1301).

## 7. Out of scope

1. **Repository-level parallel Git materialization, incremental pack chains +
   presence-skip, Git-plan fingerprint caching, batch GET, 48-slot download
   tuning, the crypto worker pool** — all SHIPPED (audit:68–98); this design
   overlaps/plans WITHIN them and PRESERVES presence-skip (§1 boundary table),
   never re-proposes/retunes/claims them.
2. **The read-optimized small-blob pack cache** (Finding 15) — conditional
   non-opportunity (audit:1199); NOT a gate, NOT a blocker, NOT built, NOT
   instrumented here in any form (R1 #16; R2 #8).
3. **Raising any pool size** beyond measured knees (audit:1190–1192) — Phase 3
   uses a bounded global semaphore.
4. **Steady-state sync, commit admission, manifest deltas, the scan side**
   (designs 82/84/85, audit Track A) — cold-APPLY side only.
5. **Server / wire-format / D1 changes** — client-only.
6. **Phase 4's streaming primitive and Phase 5's local-plaintext source as
   implementations** — separate designs if triggered (R1 #17); Phase 4's primitive
   should ultimately be SHARED with the upload pipeline (audit:1029–1030).
7. **Closing the pre-existing publish TOCTOU window** (anchored
   `openat`/`O_NOFOLLOW` directory handles between `assertWithinRoot` and
   `rename`, invariant (a)) — a real hardening project affecting every write
   path, not just cold apply; this design only guarantees not to widen the
   window (R2 #1).
8. **Auto-reclaiming stale git lock files** left by a killed process — a
   separate design question; here a stale lock is a loud single-repo deferral
   (§4.3, R2 #4).

## 8. Open questions for the founder

1. **G1 target number.** What fresh-join wall is "it just synced" enough for the
   onboarding conversion story — a specific second-count, or "materially under 84s
   and dominated by unavoidable transfer"? Phase 0 sets the achievable number; the
   PRODUCT bar is a founder call.
2. **Phase 5 priority.** Is the sibling-worktree join a real onboarding path worth
   a separate design, or is the empty-host second device the only conversion
   moment that matters (deferring Phase 5)?
3. **Kill-switch defaults.** Ship Phase 1's trie on-by-default after fleet
   validation, or soak it off-by-default behind `RBOX_APPLY_DIR_TRIE` for a
   release first (design 85 P-2 soak precedent)?
4. **Surfacing standing unrepresentable deferrals (R3 #1 → R4 #1).** The
   delete-echo risk is closed by construction (§3.1 base-exclusion: a skipped
   entry is absent from both disk and base, so push proposes nothing). What
   remains is product surface: should `rbox status` / the dashboard show a
   standing "N entries unrepresentable on this volume" indicator, and should
   there be an explicit resolution flow (rename remotely / choose a winner)?
