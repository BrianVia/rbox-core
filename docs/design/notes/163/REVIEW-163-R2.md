# Design 163 v2 adversarial review — round 2

## Verdict: ALIGNED FOR ORCHESTRATOR JUDGMENT

This round reviewed the completed v2 proposal in
`docs/design/163-state-plane-sqlite.md`. Three independent read-only passes
covered crash/reset, schema/CAS, and engine/migration. Each pass initially
returned changes required; the document was revised and redispatched until all
three returned `ALIGNED`. No reviewer edited the proposal.

## Crash/reset pass

Resolved:

- added `archiveBaseline` to every P/R/I/Z signature and removed contradictory
  deny-remainder wording;
- restored the two-pass journal-derived repository-fence order;
- prohibited opening/VACUUMing canonical DB artifacts while a reset journal
  stands and retained exact quarantine publication;
- made the SQLite journal branch exact-key/capped/canonical-base64 with one
  parser across recovery, doctor, and quarantine;
- identity-bracketed sidecars, closed the no-journal remainder, corrected
  checkpoint-before-writer-close order, and added process-kill/power-cut tests;
- replaced the false universal WAL byte-cap claim with explicit connection
  leases, threshold checkpointing, and 256 MiB write backpressure.

Final verdict: `ALIGNED` — no crash-table/keystone/WAL/VACUUM blocker.

## Schema/CAS pass

Resolved:

- replaced O(N) main-DB generation membership with stable BASE/LOCAL membership
  plus changed-generation stamps and external stages;
- added complete optional-container presence, raw legacy evidence, extras,
  exact FileEntry domains, per-path legacy precedence, and active-lineage
  selection;
- defined REMOTE Git stage ports, explicit BASE proof/pending fallback, logical
  snapshot tokens, and bounded projection materialization;
- removed the false 256 durable-RepoRecord premise: repo transitions and retry
  views are file-backed sealed stages with bounded ordered cursors;
- made every stage seal cover header/presence/extras/files/all Git roles/proofs/
  bindings, then checkpoint-close-S0-fsync/physical-hash it and revalidate it
  into private TEMP input before `BEGIN IMMEDIATE`.

Final verdict: `ALIGNED` — no field-mapping, plane, stage, snapshot, CAS, or
retry blocker.

## Engine/migration pass

Resolved:

- moved HashCache, DirCache, and EncryptAddressCache from N-sized JS maps to a
  separate cursor-backed rebuildable cache DB;
- specified U0 generation retain/release and U2's 8,192-entry/8 MiB arena cap;
- enumerated validator/fold/refset/LRU/snapshot/delta wire peaks and added hard
  RepoRecord/transition-row canonical and retained-memory admission;
- separated sealed `PushDecisionPlan` from the still-building encrypted
  WIRE-CANDIDATE, which is sealed only after final invariants;
- durably invalidated LOCAL before pull filesystem mutation and required a full
  post-apply scan before later trust;
- replaced long snapshot transactions with version-tokened short batch reads;
- completed the M0–M7 authority matrix, immutable hash-addressed legacy backup
  history, old-reader `Q` barrier, exact completion/genesis records, and every
  filesystem/SQLite ENOSPC outcome with truthful halt durability.

Final verdict: `ALIGNED` — no ordered-engine, materialization, WAL topology,
journal, migration, genesis, or ENOSPC blocker.

The design remains a proposal; the founder/orchestrator makes the ratification
decision.
