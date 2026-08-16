# 268 — State-CAS lock acquisition: amortize the durability work

Status: DRAFT r4. Evidence: GH #749 (`acquire50.3` on FM's 103-repo first
pull; every sibling CAS step ~0). Parents: design 178 (crash-safe lock
lifecycle, R2-locks L1-L7 verbatim), design 200 (artifact refs double the
per-ref lock count).

Review ledger: r1 codex (CHANGES-REQUIRED) — marker-only recovery arm
REFUTED (copied-marker L2 violation, the bug class reproduced during 178
hardening); temp-fsync skip (M2b) REFUTED and settled. r2 codex
(CHANGES-REQUIRED) — the staged-inode scheme closed r1's counterexamples
but opened a new one: a same-user process can hardlink the durably-named
staged inode into the lock path before acquisition, making a foreign link
indistinguishable from our own publication. The clean fix (atomic
no-replace rename) has no Node/Bun API, and its link+unlink emulation
reintroduces an unreapable-litter crash window. **r3 conclusion: per-lock
durable publication provenance is the floor of this threat model. r3
changes only the COST of meeting it, not the semantics.**

## 1. Problem — measured and mechanically explained

`acquirePreparedStateCasLocks` (`state-cas-locks.ts:181-233`): per lock, 2
marker fsyncs (temp + dir, `lockfile.ts:1226,1381`) plus a FULL journal
rewrite (atomic temp write + dir fsync serializing all N entries,
`:123-126`) — including for `blocked` entries. Release adds a dir fsync
per lock (`lockfile.ts:1337`). Totals: ~4N fsyncs + O(N²) journal bytes on
acquire; N dir fsyncs on release. FM scale (≈1,000-2,000 locks on a
103-repo first pull): the 50.3s. Nothing waits on anything.

Decomposed: cost = (a) O(N²) journal BYTES from full rewrites, (b) 2
journal fsyncs per lock, (c) 1 lock-directory fsync per publication and
per release. r3 attacks all three without touching what is persisted per
lock or when.

## 2. Semantics preserved verbatim (the r1/r2 lessons, now settled)

- Per-lock durable observation BEFORE proceeding to later locks: KEPT.
  It is what makes a crash window exactly one lock wide; batching it makes
  crashed locks unreapable (fail-closed retention = the 178 orphan-litter
  incident class) or, with any relaxed recovery arm, deletable-without-
  ownership (r1/r2 CRITICALs). Both review rounds independently arrived
  here; recorded as settled.
- Exact observation-based release gate (`:504-511`), copied-marker
  preservation (test :188), L2 age/absence rule, no-follow/containment
  fences, non-blocking contention, per-marker content fsync
  (`lockfile.ts:1226`), release durability + journal-retirement refusal
  (`:254`), deferral-hygiene classification: all UNCHANGED.
- Crash-seam contract: CHANGED and documented (r3-MAJ ruling — the old
  per-lock "journal AND namespace durable before later locks" boundary is
  physically incompatible with batched directory fsyncs). The per-append
  seam is RENAMED `afterStateCasLockAppended` (fires after the append's
  fdatasync + the §M1 fd/path binding check; lock-parent durability NOT
  yet established at that instant); a NEW `afterStateCasBatchDurable`
  seam fires after the complete parent-flush + final exact readbacks.
  `afterStateCasLockPersisted` is deleted with its meaning, not silently
  reused. The crash matrix kills at BOTH new seams.

## 3. Mechanisms

### M0 — Attribution

The lock/blocked COUNTS come from the acquisition's final result (not
from any crash seam — r2 ruling), reported through the existing
`casStepMs`/`appendDetails` channel (`pull.ts:481-483` precedent): the
state-save span gains `locks<N> blocked<M>`. On `exists`, one explicit `observeLockMarker` read
records the HOLDER's marker in a NEW bounded optional journal field
(`holderMarker`; r2-MINOR: it must not replace the transaction's own
`marker`, and a raced-away read records `"unknown"`). Reports carry counts
only; identity stays in the journal (consistent with `sync-mutex.ts:76`).

### M1 — Append-structured journal v2 (O(N²) bytes → O(N); 2N journal fsyncs → N)

Journal schema v2, explicit (r2-MINOR resolved, no deferred decision):

- **Header record** written at `prepared` exactly as today's semantics
  demand (txn id, owner incarnation, common-dir identities, complete
  allowlist with per-lock markers) — one atomic write + dir fsync, before
  the first lock (178 §A.1 verbatim).
- **Acquisition records appended**: after each successful publication, ONE
  JSONL record `{lockPath, observation}` appended to the open journal fd
  followed by `fdatasync` — the same per-lock durable-provenance instant
  as today's full rewrite, at 1 fsync and O(1) bytes instead of 2 fsyncs
  and O(N) bytes. Blocked outcomes append `{lockPath, blocked,
  holderMarker}` the same way. The `locked` and `committed` phase records
  are appended likewise (`locked` only after M2's flushes complete).
- **Retained-fd path binding (r3-MAJ):** `fdatasync(fd)` proves the
  INODE durable, not that `journalPath` still names it. After every
  successful append-sync, before the append counts as persisted or any
  seam fires: no-follow stat of `journalPath` must show a regular file
  with the retained fd's dev/ino, length covering the completed append,
  inside the validated boundary. Mismatch = fail the acquisition, exact
  cleanup of ALL transaction-published links, retain discoverable
  authority, no hook. No extra directory fsync needed.
- **Recovery parser v2 (strict fold, r3-MAJ):** explicit record
  discriminators (header/acquisition/locked/committed); exactly one valid
  header, first; acquisition paths drawn from the header allowlist; at
  most one outcome per lock, no acquired/blocked conflicts, no duplicate
  phase records; `locked` only after every allowlisted lock has one
  durable outcome; `committed` only after `locked`; bounded line, record
  count, and total sizes. EXACTLY ONE incomplete EOF suffix may be
  ignored (its lock → today's marker-exact-but-unobserved fail-closed
  stale/retain arm — equivalent to today's crash between publication and
  journal write at `state-cas-locks.ts:207-212`); any OTHER malformed or
  misordered record makes the whole journal indeterminate — the parser
  never skips-and-continues.
- **Rollout contract (r3-MAJ):** journals are LOCAL transient state,
  never wire-visible — 1.x externals cannot encounter v2; 2.0 externals
  start fresh. v1 parsing is retained fail-closed alongside v2.
  DOWNGRADE across a crashed-transaction window is declared unsupported:
  a released-old binary reads a v2 journal as malformed and retains it
  fail-closed; the documented recovery path is one run of the new binary
  (which recovers and retires it). v1 parsing retires only on an
  evidence-backed absence gate (no v1 journal observed fleet-wide +
  doctor sweep), never on elapsed release time. Validation gains a
  released-old/candidate matrix (old binary + v2 journal → fail-closed
  retention, no deletion, no crash).
- `writeFileAtomic` stays for the header; appends use the retained fd (no
  reopen per lock). Directory fsync for the journal happens once at header
  publication (rename-into-place) — appends mutate an existing inode and
  need no directory entry durability.

### M2 — Batched directory fsyncs via a sealed receipt (r2-MAJ fixes folded)

Opt-in batching object owned by the CAS module; every other lockfile
consumer keeps today's per-call contract. Contract, amended per r2:

1. Accumulates EXACT parent directories (`path.dirname(lock.path)` — refs
   span subdirectories; never keyed by common dir).
2. `flushAll()` → a SEALED success receipt carrying the complete
   acquisition outcomes + flushed-parent set; `appendLocked` (the phase
   record) accepts ONLY the sealed receipt — type-level proof that every
   blocked outcome and parent flush was incorporated.
3. Hook semantics (r3 ruling): `afterStateCasLockAppended` per append
   (post-fdatasync + binding check; namespace durability NOT implied);
   `afterStateCasBatchDurable` after the complete parent flush + final
   exact readbacks. No hook implies lock-parent durability before the
   batch flush; the old hook name is deleted, not repurposed.
4. ANY parent flush failure fails the acquisition and releases EVERY link
   this transaction published — all directories, not only the failed one
   (today's catch-path behavior at `:229-232`, protected).
5. Release side: per-lock `durable` derived from that lock's ACTUAL
   parent's batch flush result; no lock in a failed or unattempted parent
   reports `durable: true`; journal retirement still requires all-durable.
   ADDITIONALLY (r2 gap): later recovery, before retiring a journal whose
   acquired/pending entries are now ABSENT on disk, fsyncs those entries'
   parent directories — closing the crashed-before-durable-release window
   that today's `:483/:566` path can retire past.
6. Single-use, assertion-guarded.

Publication-side per-lock directory fsync (`finalizeCreated:1381`) defers
into the receipt; per-lock readback verification stays. A successful
`link` whose readback MISMATCHES is a fail-closed publication error with
exact cleanup and journal retention — never `blocked` (r2-MINOR: no
holder caused it; attributing one would be false evidence).

### Requirement-challenge ledger (recorded, NOT built)

| Requirement | Cost | Alternative | Decision needed |
|---|---|---|---|
| Per-lock durable provenance under the current same-user threat model | ~2N fsyncs floor (temp + append) | Consumed-name publication (no-replace rename) — needs a native binding (no Node/Bun API) AND an explicit product ruling: even native rename cannot attribute a deliberate same-user consumer of the staged name (codex r3), so the ruling must exclude that actor or a stronger OS capability/namespace primitive is required | founder, future design |
| Per-append provenance fsync (1/lock) | ~N×3ms on FM | Batch appends K-at-a-time (K≈32): journal fsyncs → N/K, ~4.5s more saved; crash leaves up to K retained-litter locks instead of 1 | founder |

## 4. Expected effect (MEASURED, 2026-08-16)

Implementation close-out, same Linux NVMe 140-lock acquire+release fixture,
five runs per revision (median): acquire **98.678ms → 85.528ms** (-13.3%),
release **32.964ms → 27.716ms** (-15.9%), total **130.718ms → 113.039ms**
(-13.5%). Individual before totals: 148.781, 136.485, 127.252, 130.582,
130.718ms; after: 139.858, 113.039, 117.028, 106.074, 105.112ms. This
desktop lane is syscall-overhead dominated; the FM field re-pull remains the
required confirmation of the projected dirty-fsync gain.

Hardware probes: FM workspace fs = **2.92ms per dirty-file
create+write+fsync** (200-op probe); desktop NVMe = ~12µs (strace over the
140-lock crash-matrix: 2,492 fsyncs = 0.03s syscall time). The 250×
per-fsync hardware gap is why #749 is FM-only. Today's per-lock cost on
FM ≈ 2 journal fsyncs + 1 marker fsync + dir fsyncs ≈ ~12ms, plus
progressive O(N²) journal drag (~225MB total written at N≈1500).

r3 lands at ~2 dirty fsyncs/lock (marker + append) ≈ **~6ms/lock → ~9s on
the FM first-pull shape** (from 50.3s) — and ~6ms/lock IS the hardware
floor under the current crash-safety rules (torn-contents rule + per-lock
provenance). Bench + field confirm per the perf close-out rule.
Steady-state pulls carry few partial refs; the tail case is join/first
pull. Below-floor levers, ledger-recorded, founder decisions:

| Lever | Gain on FM shape | Trade |
|---|---|---|
| Batch provenance appends K-at-a-time (K≈32) | ~4.5s → journal fsyncs ~N/K | crash leaves up to K retained-litter locks instead of 1 |
| Reduce N: repo-granularity locks, or skip locks on repos THIS pull materialized (nothing can race a repo that did not exist) | ~10× fewer locks — the deepest fix | its own design: what does the CAS actually protect per ref? |
| Consumed-name publication provenance (no-replace rename) | batch-window provenance | needs native binding + same-user threat-model ruling |

## 5. Validation

- R2 real-process crash matrix (`:370`): UNCHANGED end-state assertions;
  the crash seams are the two NEW hooks (append-persisted and
  batch-durable — the boundary change is documented, not hidden). New
  crash points: after batch flush before `locked` append;
  torn final append line (recovery: fail-closed stale/retain, journal
  retained until blocker clears — asserted, with the existing
  copied-marker fixture :188 untouched).
- v1/v2 journal compat: v1 fixture documents parse fail-closed identically
  pre/post; a v2 journal survives a restart into recovery.
- Batch receipt: flush failure during acquisition → ALL links released
  exactly + journal retained; flush failure during release → affected
  locks report non-durable + retirement refused; later recovery re-fsyncs
  absent-entry parents before retiring (new fixture for the r2 gap);
  multi-directory refs under one common dir each flushed once.
- Native fs assertion (ext4 + APFS when a darwin runner exists; until
  then, the Mac probe per the darwin playbook): staged... N/A in r3 —
  instead: append+fdatasync durability probe and readback-mismatch
  fail-closed fixture.
- Bench: timed acquire+release on the 140-lock fixture before/after; field
  FM re-pull; both lanes per perf close-out. M0 counter visible in the
  span (`locks<N> blocked<M>`).
- `git-sync.test.ts:534` journal-leak guard unchanged; lint bar per house
  rules.

## 6. Sequencing

Independent of design 267; M0 prints into the same report line 267
brushes (`pull.ts:483`) — 267 merges first, this rebases.
