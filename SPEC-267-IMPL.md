# Implementation spec — design 267 r4 (delta-scoped state save)

Authority: `docs/design/267-delta-scoped-state-save.md` (r4, ALIGNED —
CODEX-267-R4.md). The design doc is the contract; this spec is the work
order. Reviews CODEX-267-R1/R2/R3.md hold the rejected alternatives — do
not reintroduce them.

## Objective

Implement M1 (minimal-packet no-op save: §3.0-3.4) and M2 (elided-path
accepted projection: §4). Zero-change pull state-save on a 120k-file
workspace drops from ~8.4s to sub-second; every contract in §6 preserved.

## Deliverables

1. `ElisionReceipt` (pull-owned, optional field on `StateSource`,
   `src/cli/sync-state.ts:87` area): unfiltered `all` emptiness,
   `storedBaseIsRemote` + incoming `manifestMeta`, snapshot binding
   `{nonce, stateRevision}`. Constructed ONLY in the standalone `doPull`
   path (`src/cli/sync/pull.ts:447` vicinity), only from a
   post-`ensureCapableStateLineage` snapshot with minted non-legacy nonce
   and defined `stateRevision`.
2. Elision in `composeStateSavePacket` (`sync-state.ts:293`): with a
   receipt present, elide `packet.global` per §3.2 predicate (conditions
   1-4, incl. `canonicalManifestHashStreaming(manifestFromMeta(
   state.lastSyncedManifest, persistedMeta)) === manifestMeta.manifestHash`)
   and elide per-repo transitions whose composed `newRecord` deep-equals
   the current record (§3.3). Any predicate input missing/false → today's
   full packet, bit-identical composition.
3. `elisionExpectation?: {nonce, stateRevision}` on `StateSavePacket`
   (`sync-state-model.ts:351` area), set iff composition elided anything.
   BOTH backends check it against live state under the canonical lock:
   SQLite in the CAS (`store/write-packet.ts` / `store/cas-steps.ts`),
   legacy JSON in `applyLegacyJsonSavePacket`
   (`adapters/legacy-json-store.ts:101` guard block). Mismatch → REJECTED
   with NEW public retryable reason `"elision-drift"` — must NOT ride the
   `state-revision`→`nonce` translation at `whole-state-compat.ts:392`.
4. Single-attempt receipts in `saveStateSource` (`sync-state.ts:362`
   rejection handling): on `"elision-drift"`, discard the receipt and
   recompose the FULL packet against the adapter's under-lock reload
   (`whole-state-compat.ts:398`). All other rejection reasons: behavior
   unchanged.
5. M2: for a fully-elided accepted save, `saveStateSource` supplies the
   loaded state as `acceptedProjection` (precedent
   `whole-state-compat.ts:357`); adapter overlays exactly the six token
   fields (`stream`, `lastSyncedSequence`, `nonce`, `stateRevision`,
   `telemetryBindingId`, `lineageExtras`) — extend
   `projectAcceptedSavePacket` (`sqlite-state-save.ts:69`) with the
   missing `lineageExtras`. Every other save shape keeps the full
   read-back, including the rejected path.
6. `RBOX_SAVE_NOOP_ELIDE` kill switch (default ON), registered in
   `src/cli/defaults-ledger.test.ts`.
7. Bench: minimal-packet case added to `scripts/bench/state-plane.ts`
   (note in-code that the elision DECISION is not benchable there — field
   trace is authoritative; keep the note to one line).

## Tests (all named in design §7 — implement every bullet)

Red-first where the design says so. The full fixture list: no-op full-stage
no-receipt characterization (NOT red-first: it passes before M1 too — the
mechanism's discriminating evidence is the mutation record in the fold commit);
corruption/encSha-drift heal, isolated so only the content self-check can refuse;
warmed fast-fold drift through the real E2eeRemote cache; scoped-straddling; empty-packet
lineage-init + reset pins; negative controls (1 action, ignored-path-only,
repo change, missing meta, degraded, recovery); content-change
interleaving; stale-receipt (accepted no-op interleave → elision-drift →
full-save retry attempt 2); backend parity; first-save/nonce-less;
telemetry mint; strict `returnedState === durableReload` for the elided
shape. Differential gate runs through the REAL `saveStateSource`, both
backends.

## Preflight (do FIRST, before writing any code)

Prove tests execute in this worktree:
`bun test src/cli/state-plane/store/write-differential.test.ts`
must run and pass. If the command guard refuses direct `bun test <path>`,
wrap it in a script under the scratchpad dir and run that. If tests cannot
execute at all: STOP and report — do not proceed with static-only tests.

## Acceptance

- All new fixtures green; `bun test src/cli/state-plane` green;
  `bun test src/engine/manifest-delta.test.ts` green; `bun run typecheck`
  green (clear `.cache/tsbuildinfo` if a pass flips without edits).
- `bun run lint:affected` — ZERO anti-slop warnings in every touched file
  (not just new lines), with ONE recorded exception: the three
  `no-shape-in-symbol-names` hits in `src/cli/sync-state-model.ts` (:135
  `ConfigStoreIdentity.shape`, :283 `GitResolutionBinding.config.shape`, :321
  `RepoRecord.cfgShape`). Those are DURABLE PERSISTED field names — renaming a
  code symbol cannot move them without a wire change — and each is already
  listed in `docs/wire-rename-candidates.md` for the 2.0 cutover. Every other
  warning on every touched file is fixed by restructuring; no suppressions, no
  rule-config changes.
- No file exceeds 500 lines; comments only for inexpressible constraints.

## Do NOT touch

- `digest/stage-semantic-v1.ts`, grammar goldens, stage seal/consume/
  delete lifecycle (`stage-artifacts.ts`) — incl. the deletion-path hash.
- Darwin pragmas/config (`store/open.ts` connection setup).
- `applyStateSavePacket` empty-packet semantics (lineage init, reset).
- Any direct packet caller (`push.ts`, `held-skip.ts`, `p-settlement.ts`,
  `p-repair-state.ts`, `deferral-hygiene.ts`, `reset-state.ts`) beyond
  what compiles against the optional new fields.
- Scheduler/daemon loop timing.
