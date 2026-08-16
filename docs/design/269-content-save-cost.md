# 269 — Delta-staged content saves, zero new durable state

Status: DRAFT r4. Parent 267 §5 (M4); grandparent 235 §5. Review ledger:
r1 (2 opus lanes) reversed the staging thesis with measurement and killed
A2; r2 (2 opus lanes) killed the chained plane digest, both new columns,
and the adapter-internal placement; r3 serial confirm killed the plumbed
`SyncState.baseGeneration` (it broke the cross-backend read-differential
pin and could leak into state.json via the legacy-unsafe arm) and caught
the pull-only eligibility hole — every kill made the design smaller.
Codex quota-benched; opus-only lanes.

## 1. Measured cost model (r1 lane-B harness, N=120k, real ext4)

Steady one-changed content save 2,660ms (Mac field analog 5.9s):
consume streamFiles→TEMP 910 (34%) · stage build 855 (32%) · intern 371
(14%) · consume digest re-derivation 180 (7%) · promote 134 (5%) ·
physical hashes+fsyncs 159 (6%) · COMMIT 22 · read-back ~385 (outside
the 2,660; ~25-35% of the Mac number). 80% of the save is O(N) work only a delta
stage removes (the re-derivation and CSPRNG buckets are rider wins that
help both kinds). Consume-pass waste: `randomBytes(16)` minted per
row then discarded for every interned row (~120-150ms); the consume
re-encode is asserted equal to `entry_cjson` anyway.

## 2. Mechanism

**One sentence:** a content save may carry, alongside today's
whole-manifest packet, a caller-composed delta (ops + predecessor
binding); the SQLite CAS verifies the binding and applies the ops through
a delta-only path, while the complete-stage save remains verbatim as
genesis, repair, fallback, and the JSON arm's only shape.

### 2.1 Placement and packet shape (r2-B C1)

`composeStateSavePacket` (`sync-state.ts:290-329`) is the only frame
holding both manifests; it composes, in ONE walk over the file-only
projections of `snapshot.lastSyncedManifest` and `source.globalManifest`
(r2-B M5 — never the git-carrying manifests):

```
packet.globalDelta?: GlobalDelta
GlobalDelta = { binding: DeltaBinding; ops: readonly DeltaOp[] }
DeltaBinding = { nonce: string; stateRevision: number }
DeltaOp = { kind: "upsert"; entry: FileEntry } | { kind: "delete"; path: string }
```

Named exported types (founder bar). `packet.global` stays whole-manifest
— the legacy-JSON arm consumes it unchanged and ignores `globalDelta`.
Cross-backend authority rule: ops and manifest come from the same walk,
and the `saveStateSource`-level differential asserts
`apply(ops, predecessor) === packet.global.manifest` — stated honestly:
`write-differential.test.ts`'s packet-level fixtures give ZERO delta
coverage; the §6 gate is the authority for this seam.

### 2.2 Predecessor binding (r3 serial confirm — zero new fields anywhere)

The binding is `{nonce, stateRevision}` — the exact shape 267's
`ElisionReceipt` already ships, durable on BOTH backends, already in
`SYNC_STATE_KEYS`, already differential-clean. `write-packet.ts:267-268`
bumps `state_revision` on EVERY accepted CAS, so revision equality proves
no writer of any kind interleaved since the composer's load — strictly
stronger than generation equality. Cost, named: a repo-only interleave
causes a spurious retryable rejection + recompose, the trade 267 already
proved safe. The binding travels as its OWN frozen input on the CAS
packet (r3-C2: `CasExpectation` and the transition-stage snapshot token
stay LIVE-derived and untouched — `sqlite-state-save.ts:111-116`'s
deliberate asymmetry is preserved; a naive reuse of
`expected.baseGeneration` would turn interleaves into
`StageChangedError` throws that escape the recompose loop). Mismatch →
retryable `reject` in the `elision-drift` FAMILY — MANDATED (r4-F1): the
legacy mapping must land outside {stream, nonce, owner-lost} or
`sync-state.ts:410-411` throws instead of recomposing; `elision-drift` is
the only shipped reason that qualifies, and `"state-revision"` maps to
terminal `"nonce"` — the obvious-precedent trap. The under-lock reload
(`cas-translation.ts:61` runs `loadRawStateFromStore` on the rejected
branch, covering rebinding) + recompose at the
`sync-state.ts:390-391` loop head with `snapshot = result.state` (`:413`)
produces a fresh delta — no loop. A `stage-delta-v1` artifact WITHOUT a
caller-minted binding is structurally inadmissible (`assertPairing`
neighborhood, a throw not a reject). The nonce half additionally binds
the on-disk artifact to the incarnation so a stray sealed delta cannot
replay across a reset (not redundant with `expectedNonce`, which guards
the packet). Why mandatory: `cas-steps.ts:97` admits equal-sequence
saves; deltas are safe under that only because of this binding. NO
plane_digest, NO file_count, NO schema change, NO new SyncState member.

### 2.3 Eligibility (one predicate, one owner, BOTH lanes)

The carrier is `StateSource.baseIsUnscopedRemote?: boolean` (r3-M1 —
the r3 receipt-based gate silently excluded push-side content saves, the
most frequent O(N) save on a dev host): pull sets it from
`scoped.storedBaseIsRemote`; push sets it unconditionally (`push.ts:919`; push is structurally
unscoped — `assertMayPublish` is its first statement, `push.ts:298`).
The name states base identity; its operational meaning is "this lane is
audit-covered". Delta-eligible iff: kill switch on AND
`baseIsUnscopedRemote` AND snapshot carries a minted nonce + defined
`stateRevision` AND the packet has a global AND `forceCompleteSave`
(§2.4) is unset. Everything else — genesis, first save, reset, repair,
migration, scoped, JSON-authority (structurally: the delta only alters
the SQLite adapter's staging; `packet.global` stays whole-manifest so
the JSON arm is unaffected regardless — the composer need not know the
backend) — composes today's complete stage unchanged. Kill switch
`RBOX_SAVE_DELTA` (default ON, defaults-ledger registered; owner: this
design; deletion condition: one clean fleet soak + Mac field close-out).

### 2.4 The honest trade (founder decision rows)

Heal mechanism, made implementable (r3-M2): when the idle-cycle audit
(`globalWouldNotChange`'s content hash, `sync-state-elision.ts:98`)
fails on a receipt-carrying cycle, that SAME call already composes the
full packet — the heal is immediate. The only case needing a carrier is
a content-carrying save under known drift: a process-local daemon flag
set on audit mismatch and cleared when a complete save is accepted; lost on
restart, re-derived by the next audit. Zero durable state (ledgered in §8).
KEYED BY STREAM (implementation): one process may hold several workspaces, and
one drifted base is no reason to make another rewrite its manifest. The
implementation carries NO `StateSource` flag — a field with no production
producer is a requirement with no owner — so the audit is the sole carrier.

| Decision | Statement |
|---|---|
| Relative saves | Content saves stop being self-healing rewrites. Audit = the idle-cycle content hash; detection ≈ one idle cycle on daemon hosts, heal immediate-to-next-save. ACCEPT this loss of per-save self-healing, or gate 269 on a stronger audit. |
| Coverage gap | Receipt-less hosts (CLI-only push users, degraded mutex) and scoped workspaces NEVER run the audit: drift there is undetected while a drifted base feeds the 267 §4 chain (wrong deltas to the server). Bound: 4 external users, all daemon-based today. (Scoped workspaces stay complete-save — pre-existing C4 residual, NO new 269 exposure, booked in §7.) Accept, or require a delta-path audit first. |
| Retry budget | A content save now spends a recompose attempt on any interleave that moves `stateRevision`, where a complete save previously won outright (equal-sequence saves are admitted by `cas-steps.ts:97`). The budget is 3 and the recompose is cheap, but a hot repo-write lane raises the rejection rate on the content lane. Watch it in the fleet soak; a delta that exhausts the budget throws today. |
| New digest grammar | `stage-delta-v1` retires 235 §4 / 267 §8's standing "no new digest grammar" — explicit ratification requested. |

### 2.5 Stage grammar `stage-delta-v1`

Length-framed: stage id, plane, complete header, the binding, ordered
ops, result count `resultFiles` — counts and binding COVERED BY the
digest (the `seal(expectedCounts)` precedent). Rules: strictly ascending
path order; no duplicate path within or across op kinds; a delete of a
path absent from the plane is a REFUSAL at apply (a well-formed diff
never emits one — silence would convert base mismatch into no-op); a
ZERO-OP delta with header/meta update is well-formed (r2-A M5 — the
git-only remote commit is the Mac's exact shape and the largest single
win); streamed-op-count refusal mirroring `write-packet.ts:228`.
Verification: single streaming pass accumulates the delta digest and
verifies against the sealed ref at end-of-stream (the fused pattern —
§3 R2′ applies it to complete stages too). Artifact lifecycle
(#745/#746/#747) byte-identical; all physical hashes stay, now O(delta
bytes).

### 2.6 Apply path (r2-A M1 + r3 minors — structural, not asserted)

Delta ops land in TWO temp tables (`cas_delta_upserts`,
`cas_delta_deletes` — r3-m2: one kind-discriminated table would need
NULL-value rows and kind filters in the intern SQL; two tables keep the
statements clean and the negative controls trivial), applied by
`applyDeltaOpsIntoPlane`: the intern statement pair
(`generations.ts:334-341`) is parameterized by table name (it hardcodes
`CAS_FILE_TEMP` today — the port is explicit work, not automatic) and
runs over upserts only; targeted deletes by path. The upsert carries the
same `changed_generation` guard as promote (`generations.ts:348-354` —
r3-m3: a recomposed delta may re-upsert an already-landed value; without
the guard the arms diverge invisibly). NO delete-absent SQL anywhere in
the delta path; `promoteFilesIntoPlane` and `cas_stage_files` never see
delta rows. Negative controls both directions. Post-apply proven
post-condition: base-plane `COUNT(*)` must equal sealed `resultFiles`,
else refuse. The non-file writes (head/meta/chain/meta-wire git in `applyGlobal`;
`rebuildManifestProjection` from `runTransaction`, `write-packet.ts:266`) run
IDENTICALLY for both kinds and is MANDATORY for zero-op deltas —
`read-snapshot.ts:196,212` reads chain/git keyed by the new generation
(r3-m4); the existing no-meta early-return (`cas-steps.ts:155`) keeps
today's clearing parity. The structural fact that makes all this
possible (r3): `plane_entries.changed_generation` semantics already let
unchanged rows keep their rows AND generations — a delta advances the
head without touching N rows by design, not by luck.

Refusal taxonomy (r3-m6): binding mismatch → retryable `reject`
(recompose loop). Delete-of-absent-path, COUNT mismatch, missing
binding, malformed delta → `StageChangedError`-family THROWS —
fail-closed, never retried; `runTransaction` rethrows non-Rejected
(`write-packet.ts:274`) and `translateSavePacket`'s finally deletes the
stages (`sqlite-state-save.ts:190-193`). The binding exists in two carriers —
sealed into the artifact (§2.5) and frozen on the CAS packet (§2.2); they
MUST be equal or it is a `StageChangedError`-family throw (r4-F4 — a ref
is never believed).

## 3. Riders (measured, corrected by r2+r3)

R1 — stage builders `synchronous=OFF`, WAL retained: parameterless
constants change, all three builders; durability point = the seal
`fsync(fd)` (`stage-artifacts.ts:154`); no test pins current pragmas.
RE-SCOPED (r3-M4): its −235ms lives inside the same stage-build bucket
the delta deletes — post-269 it benefits ONLY the complete path
(genesis, repair, fallback). Not additive to §5.

R2′ — fuse digest accumulation into the single `streamFiles` pass for
BOTH stage kinds; verify at end-of-stream. Ordering note (r3-m5): this
inverts verify-before-use to consume-then-verify — safe because the TEMP
copy is SAVEPOINT-contained and precedes `BEGIN IMMEDIATE`; no authority
row exists before verification. Preserves `sealed-stages.ts:1-7`'s
rows-not-columns invariant; covers the LOCAL-plane path.

R3 — the consume path stops asking for an entry id (r3-M3: NOT an owner
move): a stage-consume encoder variant mirroring `encodeFileEntryForStage`
(which already omits the id — the build pass never paid the CSPRNG);
`encodeFileEntry`, `codecs.test.ts:51`, and `migration/import-install.ts`
untouched by construction. Interned ids are generated in the intern
INSERT (`lower(hex(randomblob(16)))`) for NEW values only; the TEMP
tables' `entry_id` columns are nullable. ~120-150ms; the r2 fingerprint
claim stays retracted (no stored fingerprint exists — the sha256 stays).

Rejected ledger (standing): r1-A2 (generation-stamp unsound, 0.2ms
target); r1-A4 restated = the post-accept read-back is KEPT and is the
top post-269 residual (§7); r1-A5 (bench is the attribution authority);
r2 plane_digest + file_count (no unique protection / no reader / schema
brick); r2 adapter-internal placement (impossible at O(delta)); r2-R2
retirement (superseded by R2′); MEMORY journal (voids seal evidence).

## 4. Protected contract

`stage-semantic-v1` + goldens byte-frozen; complete-save path verbatim
incl. delete-absent (235 §5.4) — sole repair authority, load-bearing
forever; physical hash chain on both kinds; #745/#746/#747; authority
pragmas; 267 elision + receipts unchanged (elision composes NO stage;
fully-elided ≠ zero-op delta — the former proves nothing changed, the
latter records a new head with no file ops); JSON-arm whole-manifest
consumption; mass-delete + encSha caller guards (`pull.ts:287,:322-341`
— in-memory, pre-composition, delta-independent); `sealed-stages.ts`
rows-not-columns invariant (R2′ strengthens rather than retires);
`state-semantic-v1` migration digest untouched (no schema change).

## 5. Expected effect (recomputed, r2-B M2; lanes named per r3-M1)

The r1 bench measures the store save path shared by BOTH lanes; §2.3's
carrier makes pull AND push content saves eligible. Linux steady content
save 2,660 → **~180-370ms** save-proper (diff 150-300 + O(delta)
staging/intern/apply 10-50 + COMMIT 22); the phase wall adds the kept
read-back (~385) → **~570-760ms** observed. Mac: NOT
scaled from linux — measured on the Mac during the pre-merge darwin
probe (three darwin field surprises say no arithmetic substitutes);
expectation only: multi-second reduction with read-back + fullfsync
COMMIT as the residual floor. Zero-op delta case (git-only commits — the
Mac field shape) drops the entire 2.3s stage pipeline.

### 5.1 Measured, before/after (implementation close-out)

`scripts/bench/state-plane.ts`, N=119k, desktop, **real ext4**
(`TMPDIR=/home/via/.cache/rbox-bench-269`; the default `/tmp` is tmpfs on this
host and reports a machine nobody runs on). Before = `main` @ `4f544f462`;
after = this branch, two runs, spread under 1%.

| case | before | after | note |
|---|---:|---:|---|
| `save_cold` | 3397 ms | 2936-2948 ms | complete path, R1+R3 only |
| `save_steady_one_changed` | 2771 ms | 2294 ms | complete path, R1+R3 only |
| `save_delta_one_changed` | — | 45-46 ms | the new shape |
| `save_minimal_noop` | 29 ms | 14 ms | 267's minimal packet |
| `load_full` | 385 ms | 385 ms | the kept read-back (§7) |

The one-changed content save is 2771 → **45 ms** of save-proper, below the
§5 estimate of 180-370 (the estimate priced a diff this bench does not pay:
the composer's walk happens upstream in `composeStateSavePacket`). The riders
alone take the surviving complete path down 13-17%, which is what genesis,
repair, and every heal now cost. The read-back is untouched and is now ~89% of
the observed delta-save phase wall — §7's top residual, restated with numbers.

Not measured here: the composer walk (upstream of the store), the Mac, and
both field lanes. The darwin probe and the field close-out remain open.

## 6. Validation

- `saveStateSource`-level differential (THE authority for the seam):
  delta-eligible vs forced-complete over a churn corpus — comparing the
  full read-back AND the durable `plane_entries` rows (path→entry value)
  — r2-A M2: projection-only comparison hides row divergence identically
  in both arms. Two-save and save→reject→retry sequences.
- Op-equivalence: `apply(ops, predecessor) === packet.global.manifest`
  asserted per composed packet in the gate.
- Binding: predecessor mismatch → rejected → recompose produces a fresh
  delta (pinned); delta artifact without binding → structural refusal;
  equal-sequence double-save under deltas → second rejects on binding.
- Structural: negative controls of §2.6; delete-of-absent-path refusal;
  zero-op delta accepted with head advance; COUNT post-condition red
  test (forged resultFiles rejects).
- Drift: corrupt a plane row → content saves proceed (documented window)
  → next zero-action cycle fails the 267 predicate → next save composes
  COMPLETE and heals, byte-compared (the §2.4 trade, pinned end-to-end).
- Crash: post-seal kill → fresh process verifies the sealed delta
  (physical hash, S0, no sidecars). Stage deletion is INLINE after the
  CAS returns (`write-packet.ts`'s consumed-set loop), and there is no
  sweeper: a kill in the window between COMMIT and that delete leaks the
  artifact until an operator removes it. That is the standing behavior of
  `stage-semantic-v1` too — NO new 269 exposure — and the orphan sweep is
  booked in §7 rather than built here. Genesis/reset/scoped pins stay on
  the complete path.
- Riders: R1 post-seal-crash artifact-verify; R2′ digest-mismatch
  refusal still fires (rows tampered post-seal … caught by physical
  hash; stale digest column caught by fused verify); R3 interned-id
  uniqueness + `codecs.test.ts:51` pin survives.
- Darwin probe of the full delta lifecycle BEFORE merge (standing rule);
  bench gains `save_delta_one_changed` + real-fs root (TMPDIR
  documented); field close-out: Mac 1-blob + git-only commit + desktop
  content save, both lanes, appended here.

## 7. Follow-ups (named, not this design)

Post-accept read-back (~385ms linux, top residual) — needs a
content-equality authority; own design. State-load cache (267 §5).
Scoped-workspace drift audit (C4 residual: scoped stays complete-save
until an audit exists).

Two ledger rows this implementation opened:

- **Sealed-stage cursor reader** (`openSealedStage` / `SealedStageReader`,
  exported from `store-facade`). R2′ moved both production consumers (the CAS
  global consume and the LOCAL scan) to the fused single-pass reader, leaving
  the cursor reader with no production caller. NOT deleted: the two shapes are
  not mergeable — fused verification needs the WHOLE ordered stream, which a
  paged random-access cursor by construction never completes, so folding them
  would weaken the invariant R2′ rests on. It stays as the verify-at-open
  reader four suites pin refusals through. Owner: this design. Deletion
  condition: a release in which no consumer (facade export, adapter, or rig)
  reads a stage by cursor, plus the refusal coverage re-homed onto the fused
  reader.
- **Sealed-artifact orphan sweep.** Stage deletion is inline after the CAS
  returns; a kill in that window leaks a sealed artifact. Pre-existing for
  every stage kind and unchanged by 269, but 269 makes stages more frequent.
  Owner: 268's recovery territory. Deletion condition: a sweeper that can
  prove an artifact belongs to no live interval (the id-scoped lock is the
  existing primitive), or a measured decision that the leak is acceptable.

## 8. Concept ledger (honest, r2-B M4)

Added: GlobalDelta/DeltaBinding/DeltaOp types (named, exported), the
`stage-delta-v1` grammar + its fused verification,
`cas_delta_upserts`/`cas_delta_deletes` + `applyDeltaOpsIntoPlane` +
the table-parameterized intern statements, the eligibility predicate
(`StateSource.baseIsUnscopedRemote` + `DeltaEligibility`) + kill switch, the
process-local drifted-stream set (no `StateSource` flag), the COUNT
post-condition, the consume-encoder variant (R3 — must still produce
`exact_fingerprint` and every `EXACT_MATCH` column except the id,
`generations.ts:263-267`), the new rejection reason + its
`LEGACY_REJECTION_REASON` row (F1-constrained), and the `entry_id`
NOT-NULL relaxation on `CAS_FILE_TEMP` (`generations.ts:272` — shipped
TEMP DDL, no migration). NO new SyncState member, NO durable additions
of any kind.
Added by the implementation, beyond the design's own list: a SECOND sealed-stage
reader interface (R2′'s fused `ConsumedStageReader` alongside the cursor
`SealedStageReader` — the split is the §7 ledger row), and four modules the
size gate forced out of files 269 grew (`plane-promotion.ts`, `cas-admission.ts`,
`sync-state-records.ts`, `sync-published-intent.ts`) — each a seam that already
existed, and one of them (`sync-state-model.ts`) left the size allowlist
entirely.
Deleted/avoided: the second consume scan (R2′, both kinds), per-row
CSPRNG mint (R3), O(N/4MB) durable stage commits (R1), r2's chain +2
columns + schema-v2 slice + rollout tooling, r1's A2 branch and A5
channel. Net: one new save shape with structural isolation, priced
against the 85% bucket it deletes.
