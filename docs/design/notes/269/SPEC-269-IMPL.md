# Implementation spec — design 269 (delta-staged content saves)

Authority: docs/design/269-content-save-cost.md (r4 ALIGNED, commit
8141a577d) — the contract; read it FIRST and follow its section refs.
Founder rows 1-3 (§2.4) are ACCEPTED (standing keep-it-moving
authorization, revisitable). This spec is the work order only.

## Deliverables (design section owns each)
1. §2.1: GlobalDelta/DeltaBinding/DeltaOp named exported types; the ONE
   file-only-projection walk in composeStateSavePacket producing ops +
   packet.globalDelta; packet.global stays whole-manifest.
2. §2.2: binding {nonce, stateRevision} as its OWN frozen CAS input;
   retryable reject in the elision-drift FAMILY (mapping outside
   {stream,nonce,owner-lost} — the F1 trap is named in the doc);
   missing-binding artifact = structural throw; two-carrier equality
   (sealed binding === frozen input, else throw).
3. §2.3: StateSource.baseIsUnscopedRemote (pull: scoped.storedBaseIsRemote;
   push: unconditional at push.ts:919); eligibility predicate;
   RBOX_SAVE_DELTA kill switch, defaults-ledger registered.
4. §2.4: process-local forceCompleteSave flag (daemon-owned, via
   StateSource), set on idle-audit mismatch, cleared on accepted
   complete save.
5. §2.5: stage-delta-v1 grammar + fused single-pass verification;
   zero-op delta legal; all listed refusal rules.
6. §2.6: cas_delta_upserts/cas_delta_deletes; applyDeltaOpsIntoPlane
   (no delete-absent SQL anywhere reachable); parameterized intern
   statements; changed_generation guard (generations.ts:348-354 shape);
   COUNT post-condition; refusal taxonomy exactly as §2.6 splits it.
7. §3 riders: R1 (synchronous=OFF constants, all 3 builders), R2'
   (fused verify both kinds, LOCAL plane included), R3 (consume-encoder
   variant producing exact_fingerprint + EXACT_MATCH columns minus id;
   intern-INSERT randomblob ids; TEMP entry_id nullable).

## Tests — every §6 bullet, plus
- saveStateSource-level differential comparing read-back AND raw
  plane_entries rows (incl. changed_generation), delta vs
  forced-complete, two-save + save→reject→retry sequences.
- Op-equivalence apply(ops,pred)===packet.global.manifest per packet.
- All §6 structural/negative/drift/crash fixtures; the drift heal chain
  end-to-end; zero-op delta; forged resultFiles red test.
- Bench: save_delta_one_changed case + real-fs root (TMPDIR documented);
  record before/after for all cases IN the design doc §5.

## Process
- Preflight: prove bun test src/cli/state-plane runs (scratchpad wrapper
  '269-' prefix if guard refuses). STOP if not.
- bun run test:affected per iteration; ONE full gate via
  `bun run test:parallel` (NOT serial bun test — 145s vs 550s).
- typecheck (clear .cache/tsbuildinfo after scripted edits);
  lint:affected zero warnings except the 3 documented sync-state-model
  persisted names; no suppressions; files ≤500 lines (decompose, never
  shave); comments ≤1 line, constraint-only; named types, no inline
  anonymous shapes, no Parameters<typeof x>[n] at call sites.
- Logical commits on delta-stage-save; do NOT push.

## Do NOT touch
- stage-semantic-v1 + goldens; promoteFilesIntoPlane; cas_stage_files
  DDL beyond the entry_id nullability; delete-absent SQL; plane_heads /
  state_lineage / any durable schema (ZERO schema change is a design
  invariant); authority pragmas; 267 elision/receipt code paths beyond
  reading proven-state; legacy-json-store; recovery/lock modules (268's
  territory); daemon scheduler.
