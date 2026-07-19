# 163 — The state plane moves to SQLite

Status: DRAFT — adversarial loop pending. Origin: founder step-back question
2026-07-19 ("is that not a lot of memory to need? what's the step-back?")
after the third guard-layer around monolithic state reads.

## Problem — one primitive, four symptom families (all field-evidenced)

Local workspace state is ONE JSON document (`.rbox/state.json`, 59,220,693 B
at 112,259 files on the founder's Mac). Every consumer must parse all of it
or nothing; every save rewrites all of it; every integrity guard must treat
the whole blob as potentially adversarial. The guards we have stacked around
that contract:

1. **Reset safety** — 64 MB flat cap (pre-138, silently broke recovery on
   77 MB fleet states) → 52× worst-case parse multiplier + 4 GiB budget
   (138) → machine-scaled + cgroup-capped budget (161, after the founder's
   daemon crash-looped on a 59 MB state, 2026-07-19). Three tourniquets on
   the same artery.
2. **Interactive latency** — `rbox status` during initial sync: 12.2 s at
   192% CPU (fallback path: 59 MB parse + full scan + git divergence).
   Steady-state trusted path measures 0.84 s — the pain is exactly the
   cold/unsettled cases where the blob must be read (162 r1 evidence).
3. **Daemon memory** — RSS 2.95 → 6.41 GB, monotonic-decelerating, over 23
   cycles on an UNCHANGED corpus (daemon-2026-07-19.log). Each cycle parses
   + re-serializes the full 59 MB state (`state-save 0.2-0.3s` per line);
   the GB-scale transient allocations ratchet the heap high-water mark. The
   old 4 GiB reset budget was UNSATISFIABLE for this daemon by mid-day.
4. **Cycle I/O** — state-save rewrites ~59 MB every cycle even when
   `files=0 blobs=0` changed (9 of today's 17 telemetry lines were no-op
   pushes that still serialized everything).

Prior art solved adjacent planes, never this one: 84 fixed the WIRE plane
(server-read deltas/fold); 85 Layer A shaved scan readdir (shipped,
default-off); Layer B (daemon-owned manifests) was never built; 138 made
blob reads SAFE, not cheap; 161 made the safety budget saner. The playbook
rule applies (growing-complexity-means-wrong-layer): find the battle-tested
primitive. It ships inside our runtime: **`bun:sqlite`** (SQLite, WAL mode,
zero new dependencies).

## Mechanism

### Store
`.rbox/state/state.db`, SQLite via `bun:sqlite`, WAL journal mode.
Schema v1 (sketch — implementation freezes exact DDL):
- `meta(key TEXT PRIMARY KEY, value TEXT)` — stream id, state nonce, base
  sequence, schema version, lineage fields 138 cares about.
- `files(path TEXT PRIMARY KEY, sha TEXT, size INTEGER, mode INTEGER,
  mtime_ms INTEGER, kind INTEGER, …)` — one row per manifest entry.
- `git_repos(root TEXT PRIMARY KEY, …)` + `git_deferrals(...)` — the
  sync-git plane rows that today live inside the blob.
- `pending(...)` — in-flight operation rows as needed by the engine's
  existing shapes.
Indexes to serve the actual query set (status counts, divergence lookups,
prefix scans for directory operations).

### Access model
- **Daemon = single writer.** All mutations in transactions; commit points
  align with today's atomic-rename commit semantics (a sequence adoption is
  one transaction — crash-atomic by WAL, replacing the rename+fsync dance).
- **CLI = concurrent readers** (WAL allows readers during writes),
  read-only connections, busy_timeout bounded, fall back to
  daemon-ambient/trusted paths exactly as today when the db is locked or
  absent.
- Status queries become `SELECT count(*) …` — microseconds, memory O(rows
  touched). The 12.2 s fallback and the per-cycle 59 MB serialize both
  cease to exist ON THIS PATH.

### 138 interplay (the sensitive part)
- The reset/recovery classifier operates on db state via bounded queries +
  SQLite `PRAGMA integrity_check` on open; quarantine snapshots use the
  SQLite backup API into the existing quarantine dirs.
- 138's parse-admission guard (161-fixed) REMAINS for the legacy-JSON read
  paths (migration import, old-state recovery) — it is not deleted, it is
  bypassed by not having giant JSON to parse in steady state.
- Consent machinery, journal semantics, and destructive-primitive
  capabilities are UNCHANGED — transactions replace file-swap mechanics
  beneath the same contracts. Every 138 crash-window row from its normative
  table must be re-derived for the transactional store (the review should
  attack this hardest).

### Migration
- One-way, per-workspace, on daemon start: `state.json` present + db absent
  → guarded read of the blob ONCE (161 budget applies), transactional
  import, verify row counts + lineage, rename blob to
  `state.json.pre-163.bak` (kept until a later release's cleanup), db
  becomes authoritative.
- Downgrade story: same-machine CLI+daemon share one binary, so skew exists
  only mid-upgrade; an old binary seeing no `state.json` treats the
  workspace as needing reset-from-server (existing, now-safe flow) — the
  .bak enables manual restore; `rbox doctor` learns to say so.
- Kill switch (founder default-on rule): `RBOX_STATE_SQLITE=0` keeps the
  JSON path for one bake release; the flag flips nothing after migration
  has run (db authoritative once created — no dual-write; dual-write would
  reintroduce the serialize cost being removed).

### Rollout
U1 store module + schema + import (unit-heavy); U2 engine/CLI read-write
port behind the flag; U3 138 re-derivation + reset flows; U4 fleet bake
with telemetry (state-save ms, RSS, status latency before/after). Ship
default-ON per founder rule after U3's review; rig scenarios must run the
migration path from real pre-163 states.

## Acceptance targets (measured, not promised)
- `rbox status` cold with live daemon: < 200 ms on the 112k corpus.
- Daemon steady-state RSS on the same corpus: expect multi-GB reduction;
  record actual (the high-water ratchet should vanish with the per-cycle
  serialize).
- No-op cycle write volume: from ~59 MB to O(dirty rows).
- Reset admission errors: structurally impossible on the db path.

## Non-goals
- Wire protocol / server anything (84 unchanged).
- Hash cache + dircache files (candidates for later consolidation into the
  db; explicitly out to keep the diff reviewable).
- Multi-process writers (daemon stays the single writer).
- Network filesystems: `.rbox` on NFS/SMB is unsupported for the db as for
  the blob today; doctor gains a detection warning at most.

## Risks for the review to attack
- 138 crash-window re-derivation completeness (the normative row table).
- SQLite corruption classes vs JSON corruption classes (integrity_check
  coverage, torn-WAL behavior on power loss, fsync discipline flags).
- bun:sqlite behavior under the crypto-pool worker threads (connections are
  NOT shared across threads — confirm the engine's access topology).
- Migration on the 512 MiB+ pathological states (guarded import must
  refuse exactly as today, leaving the workspace recoverable).
- Query-set completeness: any engine path that secretly wants the whole
  manifest in memory (apply? scan diffing?) — those keep an iterator/cursor
  contract, not a full materialization.
