# 235 — Delta-scoped apply: receiver cost scales with the delta, never the workspace

Status: PHASE A RATIFIED (instrumentation only). Mechanisms are explicitly
NOT ratified — codex review r1 (2026-08-12) found the mechanism sections
crossed design 232's measurement knife (§4.3/§7: only a measured over-budget
bucket earns a mechanism). The r1 findings are preserved in §5 as binding
constraints on the future mechanism design.

Founder yardstick: ≤10s end-to-end; small-delta receiver apply in low
single-digit seconds.

## 1. Problem

A one-file pull on a 119k-entry workspace costs 14–23s on the receiver
(fleet bench 2026-08-12, n=5 non-authoritative; sender push op ~10s is a
separate workstream). The disk apply is already delta-sized; the surrounding
stages are O(workspace). Recon found at least six full passes per pull:

| # | Stage | Anchor | Cost today |
|---|---|---|---|
| 0 | Base manifest load | `state-plane/adapters/read-only.ts:31` | read + parse all N rows from SQLite |
| 1 | Delta fold | `engine/manifest-delta.ts:513` | rebuild Map(N), sort N, re-hash N — for a 1-op delta |
| 2 | Manifest validate | `engine/manifest-validate.ts:171` | O(N) + O(N·depth) collision pass |
| 4 | reconcile() | `engine/reconcile.ts:41` | 3 full Maps + 3N-key union |
| 7 | Oracle receipts | `engine/apply-receipt.ts:715` | ~6 full Maps + O(N log N) receipt hash (lazy; git repos only) |
| 8 | State save | `state-plane/adapters/sqlite-state-save.ts:52` | rewrite ALL N entries into a fresh sealed stage, re-read, re-encode, hash the whole file |

Two stages (validate, reconcile+scope+rule-authority) run outside any
`report.phase` wrapper; the oracle is billed opaquely inside `"git-apply"`.
The fleet trace (`propagation_receive`) has exactly three events — the whole
`pull_dequeue → apply_complete` span is one opaque bucket. **We cannot name
the biggest bucket today. That is the only defect Phase A fixes.**

### 1.1 Prior art — most of the delta story already shipped; this may be a regression

- Design 204 (SHIPPED 2026-07-26): delta-scoped PUBLISH. Preflight checks
  only introduced blobs (`RBOX_PREFLIGHT_DELTA`), commits emit a delta
  envelope (`RBOX_MDE_DELTA`), fast-fold pull (`RBOX_MDE_FAST_PULL`).
- Design 202 (SHIPPED): trusted-view pull skips the local scan.
- Design 203 (SHIPPED): lazy per-repo git probes killed the flat ~7s/pull
  git-apply constant.
- **Post-202/203/204 the receive side measured ~4.5s on a 108k-file
  workspace (204 §1). Today it is 14–23s on 119k files.** The delta between
  those two numbers is not "delta-scoped apply was never built" — it is
  suspected regression, with the 2.0 SQLite state plane (163/223: full
  sealed-stage rewrite + whole-file digest per pull, `sqlite-state-save.ts`)
  as prime suspect. Phase A's table confirms or refutes this before any
  mechanism is chosen; if it IS a regression, the founder's revert-first
  option (differential save vs revisit the save contract) is a product
  decision made on that evidence.

## 2. Phase A (ratified): attribute the receiver's time

- Wrap the naked stages in `report.phase`: `"validate"` and `"reconcile"`
  (covering `prepareScopedPull` + `reconcile` + `applyScopedRuleAuthority`).
- **Residual bucket (r2-1, r3-1):** the daemon emits NO wall/residual field.
  The trace already stamps `pull_dequeue` and `apply_complete`; the consumer
  computes `unattributed_ms = (apply_complete − pull_dequeue) − Σ phase_ms`.
  This covers the pre-report span (pin verify + trust sealing before
  `PhaseReport` creation, `daemon.ts:2055-2072`) by construction — nothing
  between dequeue and adoption can hide. Unwrapped work (state-lineage
  validation, mass-delete planning, cache invalidation, post-save
  settlement) is allowed to stay unwrapped ONLY because this residual makes
  it visible; a residual that turns out to be a top bucket earns wrappers in
  a follow-up, not a mechanism.
- Oracle billing (r2-4): the pull instrumentation (not the
  correctness-critical `AppliedManifestOracle` interface) owns an
  observation callback; it aggregates across all `proveRepo`/`reproveRepo`
  calls into `"git-apply"` details: prepare ms (first-proof map builds),
  total receipt-hash ms, entries indexed (size of expected+oracle+preScan
  maps at prepare), repos proved. Zero-use pulls (no git repos consulted)
  emit zeros.
- Trace wiring (r2-2, r3-3), specified against the real path: the daemon's
  adoption callback (`daemon.ts:2608` → `propagation-trace.ts:15
  applyComplete(sequence)`) gains an optional second argument carrying the
  phase-ms snapshot. ONLY standalone `doPull`-owned reports supply it
  (`daemon.ts:2087`); a pull adopted during push-conflict recovery
  (`daemon.ts:1799`) passes nothing and emits today's bare record — its
  report would blend push and pull phases, so it is cut, not handled. Field:
  `phase_ms` (object, ms floats) on the `apply_complete` record. When
  `RBOX_TRACE_PROPAGATION=1`, `doPull` supplies an ENABLED per-operation
  report even if metrics/telemetry are off (`daemon.ts:2072` gains the trace
  gate as an OR-condition); tracing off = today's record, byte-identical.
- Consumer plumbing (r2-3, r3-2): `propagation-report.ts` extends
  `ReceiverStamp` with optional `phase_ms`, `buildHopReport` carries the
  selected exact-joined apply stamp's `phase_ms` into `HopReport` (today it
  copies only the timestamp, `propagation-report.ts:161`), and
  `renderHopReport` prints the per-stage receiver table (phases + computed
  `unattributed_ms` from the dequeue/complete stamps) when present, omitting
  it for old records. The bench (`scripts/bench/propagate.ts`) needs no join
  change.
- No behavior change of any kind: observation only, same rule as the 232
  kernel (a behavioral delta in an observation-only change is a DO-NOT-SHIP).

Exit gate: one traced fleet pull on the 119k workspace names ms per stage
with residual arithmetic closing (Σ phases + unattributed = wall). The top
measured bucket — and only that bucket — earns a mechanism design, appended
here as Phase B with its own review round.

## 3. The primitive inventory (for Phase B, evidence in hand)

Facts recon verified, usable by whichever mechanism the numbers demand:

- `headEnvelope.ops` (`manifest-delta.ts:280`) is an authenticated changed-
  path list — but see r1-1: it exists only on single-link folds; suffix folds
  span multiple envelopes and the evidence short-circuit fetches none.
- Persisted fold evidence (`sync-state-model.ts:118`) proves base identity.
- The state plane is a keyed row store with cursors (`read-snapshot.ts:190`).
- `patchManifestFromPull` (`manifest-update.ts:84`) is the working precedent
  for an O(applied)-lookup merge (array copy still O(N)).
- Scope projection predicate (`scope/projection.ts:77`) is per-entry pure.
- No server change is needed for a changed-path authority; no server
  changed-path endpoint exists either (commit-delta.ts is GC admission).

## 4. What is deliberately NOT built (standing)

- No server changed-path endpoint.
- No second manifest representation on disk, no sidecar state.
- No scheduler/priority changes (232 round 6 killed those).
- No mechanism for any stage the Phase-A numbers say is cheap (232 §7 knife).

## 5. Binding constraints from review r1 (any Phase B must answer these)

1. **Op-list span (CRITICAL):** head ops cover only the final link; suffix
   folds and the evidence short-circuit provide no complete op list. A delta
   authority must be an aggregate op set explicitly bound to (persisted base
   hash → head hash), or the path is ineligible.
2. **Evidence interface (MAJOR):** `latest()` exposes no authenticated
   ops/fold identity to `pull.ts`; telemetry (`LatestTimings.fold`) is not an
   integrity interface. Phase B needs a first-class return contract.
3. **Rule authority acts off-oplist (CRITICAL):** `applyScopedRuleAuthority`
   (`scope/rule-authority.ts:63-84`) can write/delete scoped metadata rule
   files when remote == base. The completeness lemma must cover
   `prepareScopedPull + reconcile + applyScopedRuleAuthority`, not bare
   `reconcile()`.
4. **No differential-write machinery exists (CRITICAL):**
   `write-differential.test.ts` is a JSON/SQLite equivalence harness; the
   TEMP-table apply deletes rows absent from the packet
   (`generations.ts:252-263`). A delta save feeding only dirty rows would
   delete the workspace.
5. **Digest contract (CRITICAL):** `stage-semantic-v1` hashes the complete
   ordered stage; CAS consumes only verified complete sealed artifacts. An
   incremental digest is a NEW versioned digest grammar + CAS protocol, not a
   reuse.
6. **Mass-delete denominator (CRITICAL):** no durable file-count scalar
   exists (`plane_heads` stores none; stages are deleted after CAS). And op
   `del` count ≠ planned-delete count (a remote delete against a locally
   modified file yields no action). Scoped bindings need the projected
   denominator.
7. **encSha check (CRITICAL):** key-availability fail-closed requires
   knowledge of encrypted entries that ops+meta cannot provide. Phase B needs
   a trusted encrypted-entry scalar/index or is ineligible without a KEK.
8. **Trust provenance (MAJOR):** a `TrustedLocalView` is structurally
   forgeable; the gate must consume the daemon's sealed authorization
   (daemon-pull-transition.ts:43-57), not infer trust from the view shape.
9. **O(N) floor honesty (MAJOR):** state load, full canonical hash, and array
   copies remain O(N) unless each gets its own contract change. Claims must
   name which O(N) passes remain and why they are cheap enough.

## 6. Validation (Phase A)

- Observation-only proof (r2-5): enabled/disabled differential fixtures over
  success, refusal (mass-delete, trusted-view), and thrown-error paths
  through the REAL `applyPulledManifest` load/save path — asserting exact
  equivalence of actions, resulting disk tree, durable state bytes, error
  types, and git outcomes; the ONLY permitted difference is the added
  report/trace output.
- Residual arithmetic fixture (consumer-side): Σ phase_ms + unattributed ==
  (apply_complete − pull_dequeue) (±float) on a live-shaped trace pair, and a
  recovery-adoption fixture proving the bare record still renders.
- Trace-off fixture: with tracing disabled, emitted records (none) and
  daemon behavior are byte-identical to today; with tracing on but
  metrics/telemetry off, the report is enabled and `phase_ms` populated.
- Old/new trace fixtures through BOTH consumers (`propagation-report.ts`
  parse + render, bench join): old records render without the receiver
  table, new records with it, joins unchanged.
- Instrumentation overhead measured on the 119k workspace (paired pulls,
  trace on/off) — expected ~0; recorded, not gated.
- Field: one traced pull per fleet receiver on the 119k workspace; the
  resulting table is appended to this doc as the Phase-B evidence record.
