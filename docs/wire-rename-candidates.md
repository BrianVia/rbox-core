# Wire rename candidates

Shape-named fields that anti-slop flags but that cannot be renamed today: they
are serialized wire keys, durable record members, or values hashed into stored
evidence. Each entry is a candidate for the 2.0 cutover (or a future `/v2` API
surface), not for an in-place rename.

Format: field — file:line — suggested name — blast radius.

## Diagnostics bundle (`workspaceShape`)

- `DiagnosticsBundle.workspaceShape` — `src/cli/doctor-cmd.ts:92`,
  `apps/api/src/diagnostics.ts:73` — suggested `workspaceSize` — blast radius:
  the CLI→API diagnostics upload body, the API's `TOP_KEYS` allowlist
  (`apps/api/src/diagnostics.ts:18`, an exact-keys check that rejects unknown
  keys), every stored `diagnostics/<account>/<id>.json` R2 report, the
  `workspaceShape*` validation error strings, and the sample bundles in
  `src/cli/doctor-cmd.test.ts:144` / `apps/api/test/diagnostics.test.ts:55`.
  Renaming needs a dual-accept window on the API (old and new key) because
  older CLIs keep sending `workspaceShape`, plus a decision on whether stored
  reports are migrated or read through a compatibility shim.
  The in-memory `DoctorContext` field and the local `WorkspaceSize` type were
  already renamed; only the serialized key remains.

## Genesis repair proof (`claimShape`)

- `RepairProof.claimShape` — `apps/api/src/genesis-repair.ts:57` — suggested
  `claimState` (values already read as states: `absent`, `malformed`,
  `old_endpoint_exact`, `repair_tombstone_v1`) — blast radius: the
  `genesis_repair_audit.proof_json` and `completion_observation_json` durable
  columns, the `proof` object echoed in every `/v1/genesis-repair` JSON
  response, `RepairAuditObservation.claimShape`
  (`apps/api/src/genesis-repair.ts:226`), and — critically — the
  `scrubbed_evidence_sha256` digest computed by `canonicalEvidence`, which
  hashes `proof_json` byte-for-byte. Renaming changes the digest of newly
  written rows, so it needs an evidence-version marker (or a reader that
  verifies old rows under the old key ordering) before any historical audit
  row can still be verified.
## `cfgShape` (repo record config lane)

- **Anchor:** `src/cli/sync-state-model.ts:323` (`RepoRecordInput.cfgShape`),
  column mapping `cfg_shape_cjson` at
  `src/cli/state-plane/codecs/repo-record.ts:21`.
- **Suggested name:** `cfgStore` (column `cfg_store_cjson`) — it identifies the
  physical Git config store the lane's baseline was taken against, not a
  "shape".
- **Blast radius:** durable SQLite column + codec validator
  (`repo-record.ts:33,47,83-87`), digest grammar goldens
  (`src/cli/state-plane/digest/grammar-goldens.test.ts:216`), codec coverage
  (`src/cli/state-plane/codecs/coverage.ts:79`), `ConfigLaneState` projection
  (`src/cli/sync-state.ts:34,49,430`), every sync-git config-lane reader and
  writer, and the e2e/pull/contract test assertions. Needs a state migration
  and a client-skew story (records written by older CLIs carry the old key).

## `ConfigStoreIdentity.shape` (repo kind inside the store identity)

- **Anchor:** `src/cli/sync-state-model.ts:137`, written at
  `src/cli/sync-git/config-lane.ts:101`.
- **Suggested name:** `repoKind` — the value is the `RepoCtx.kind`
  (`"dir"` / `"pointer"`), which the rest of the codebase already calls
  `repoKind`.
- **Blast radius:** nested inside the durable `cfg_shape_cjson` JSON, so it
  moves only with `cfgShape` above. Also pinned by the codec exact-object check
  (`repo-record.ts:84-85`), coverage (`coverage.ts:111`), the digest grammar
  goldens, and `sync-git-config-pull.test.ts:449`.

## `GitResolutionBinding["config"].shape`

- **Anchor:** `src/cli/sync-state-model.ts:285`, populated at
  `src/cli/sync-git/resolution-intent.ts:62-67`.
- **Suggested name:** `storeIdentity` — it is the canonicalized
  `ConfigStoreIdentity`, matching the code-symbol name now used everywhere else.
- **Blast radius:** hardest of the three. The binding is canonicalized and
  hashed into resolution receipts, so renaming the key changes every binding
  identity hash — any in-flight resolution recorded by an older CLI stops
  matching. Requires the 2.0 receipt-format break, not a standalone rename.

## `"p-repair-shape-mismatch"` (base composer hold code)

- **Anchor:** `src/cli/sync-git/base-composer.ts:191` (union member), emitted at
  `:434`, `:443`, `:458`; mirrored in the durable hold-code union at
  `src/cli/sync-state-model.ts:234`.
- **Suggested name:** `p-repair-witness-mismatch` — the hold fires when the
  P-repair witness disagrees with the locked proof, not when a "shape" is off.
- **Blast radius:** the value is a hold code carried in composer output and
  persisted with the sync state record, so it is design-176 grammar-frozen
  wire, not a code symbol. Renaming it changes emitted diagnostics and stored
  hold rows that older CLIs and existing records still spell the old way; it
  needs the 2.0 grammar break. The surrounding predicates
  (`branchWitnessWellFormed`, `safeWitnessWellFormed`) were renamed in place.

## `EntryStructureError.name === "EntryShapeError"` (arena error identity)

- **Anchor:** `src/engine/entry-arena/errors.ts:44`.
- **Suggested name:** `"EntryStructureError"`, matching the class after the
  code-symbol rename.
- **Blast radius:** the string is the runtime `error.name` surfaced in
  diagnostics and crash output, so it is emitted text rather than a symbol. No
  in-repo consumer matches on it today, but any captured log or support
  transcript spells it the old way; flip it with the next diagnostics-grammar
  change. The class and every import were renamed to `EntryStructureError`.
