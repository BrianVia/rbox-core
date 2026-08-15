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
