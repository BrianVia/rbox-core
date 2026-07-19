# 162 — Status without scanning: ambient-first rendering + dircache composition

Status: DRAFT — PARKED PENDING 163 (r1 verdict CHANGES-REQUIRED demolished
both central code claims: the trusted path ALREADY skips scanManifest
[contract-tested], and dircache is ALREADY composed behind RBOX_SCAN_PRUNE.
The narrowed real problem — status during active sync / cold daemon — is
largely subsumed by design 163's state-plane move; r1's ambient-
authentication findings [no producer bootId, startup-lie window, capability
gating] remain valuable if an ambient-first path is ever built. Field
follow-up 2026-07-19: steady-state status measured 0.84 s — the 12.2 s case
was the unsettled-daemon fallback, as r1 predicted.) Origin: founder field measurement
2026-07-19 (fresh Mac, v1.7.4): `rbox status` took **12.2 s at 192% CPU**
while a **3-second-fresh** `daemon.status.json` sat beside it containing the
answer; the daemon itself spends ~8 s/cycle scanning (`scan 8.3s` over
112,259 files / 21,807 dirs) with the directory cache disabled (`dc:off`).

## Problem

Two independent costs stack on large workspaces:
1. **CLI-side**: every interactive `rbox status` / bare-`rbox` front door
   loads the full state (59 MB JSON parse) and re-walks the tree itself,
   even when a live daemon published fresh ambient status seconds ago. The
   60 s local-trust machinery (`status-cmd.ts` `trustedLocalSnapshot`)
   substitutes only the ACTIVITY portion — the change-detection scan still
   runs unconditionally.
2. **Daemon-side**: each pull/watch cycle re-scans; the engine's dircache
   (design 107 follow-up, `src/engine/dircache*`) was never composed into
   the scan path (`dc:off` in every telemetry line).

## Mechanism

### A. Ambient-first interactive status (CLI)

When rendering INTERACTIVE status (front door, `rbox status` without
`--json`... open decision below):
- If the bound daemon is live (existing pidfile/boot-id checks) AND its
  ambient status heartbeat is fresh (existing 60 s trust window), render
  ENTIRELY from ambient: state, operation, progress, deferrals (design 124
  already carries them), identity — **no state load, no scan**.
- Ambient gains the small summary the CLI currently derives itself (e.g.
  pending-change count — the "101 changes waiting to upload" figure) so the
  brief line needs nothing local. Additive schema-v1 fields only; version-
  skew safe in both directions (old CLI ignores them; new CLI falls back to
  scanning when they're absent).
- Daemon down/stale/unbound → today's full path, unchanged. Correctness
  stance: ambient rendering is a DISPLAY of the daemon's authoritative
  knowledge, not a second truth source; anything that MUTATES (sync, push,
  resolve) keeps scanning as today.

### B. Compose the dircache into the scan (engine, flag-gated)

- Wire `src/engine/dircache` into `scanManifest`'s walk: directory
  mtime-keyed reuse of per-directory child stats, invalidated by the
  watcher's change events (trusted-watcher state already exists — design
  104 re-trust machinery gates cache reuse: an untrusted watcher forces a
  full walk, preserving today's safety-scan semantics).
- Ship default-ON with `RBOX_DIRCACHE=0` kill switch (founder default-on
  rule; wire-compatible — the cache changes scan COST, never scan RESULTS;
  parity is testable).
- Expected effect: the daemon's steady-state 8 s scan collapses toward the
  changed-directory count; telemetry already prints `dc:` so the flip is
  observable fleet-wide.

## Contracts
- Scan-result parity: with cache on vs off, identical manifests on a fixture
  tree across create/modify/delete/rename/chmod + watcher-distrust events
  (the load-bearing test).
- Ambient render never blocks: any read/parse failure of ambient falls
  through to the scan path silently.
- `--json` output and scripts: unchanged data source (open decision 1).
- No change to what the DAEMON considers truth; ambient stays a projection.

## Open decisions (resolve in review)
1. Does `rbox status --json` also go ambient-first, or stay scan-based for
   script stability? (Lean: ambient-first with a `source: "ambient"|"scan"`
   field so consumers can tell.)
2. Pending-change count semantics in ambient: daemon's last-cycle figure
   (cheap, may lag one cycle) vs watcher-incremental (fresher, more moving
   parts). Lean: last-cycle + age annotation.
3. Whether B lands behind one release of A (sequencing) or together.

## Tests the implementation MUST write
- Ambient-first: fresh-daemon render does zero state-file reads and zero
  directory walks (fs-spy); stale/dead daemon falls back; skew both ways.
- Dircache parity suite as above + cache-effectiveness assertion (second
  scan of an unchanged tree touches O(changed)=0 directories).
- Perf regression pin: status-on-fixture with live daemon under N ms
  (generous bound — the point is catching reintroduced scans, not benching).

## Non-goals
- No daemon-protocol changes beyond additive ambient fields.
- No change to reset/recovery paths (161 territory).
- No watcher-trust semantics changes (design 104 stays authoritative).
