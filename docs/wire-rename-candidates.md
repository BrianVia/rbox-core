# Wire rename candidates

Shape-named fields that anti-slop flags but that could not be renamed in place:
they are serialized wire keys, durable record members, or values hashed into
stored evidence.

**Status 2026-08-21 — the 2.0 cutover pass is done.** Founder ruling
2026-08-20 put all twelve candidates in scope before the 2.0 tag. Nine landed;
four fields across three entries are DEFERRED behind one shared blocker (see
"Deferred cluster" below), pending a founder decision.

Each entry records what actually constrained it, verified against the code.
Several original entries overstated their blast radius; those corrections are
kept here because they are the reason the rename was safe.

---

## DONE

### `DiagnosticsBundle.workspaceShape` → `workspaceSize`

Class: CLI↔API wire key. **Dual-accept window open on the API.**

The CLI sends only `workspaceSize`. The API accepts `workspaceSize`
(preferred) or the legacy `workspaceShape`, exactly one of the two — both
present is rejected as an ambiguous producer, neither is rejected as missing.
Stored reports always normalize to `workspaceSize`. Validation error strings
name the key the sender actually used, so a 1.x CLI keeps reading
`workspaceShape.fileCount …`. Legacy sightings are logged with the bundle
version.

Stored R2 reports needed no shim: nothing in the codebase reads a diagnostics
report back. The only `diagnostics/` prefix operations are put, delete,
`sweepDiagnostics`, and `purgeDiagnosticR2`; retrieval is a manual
`wrangler r2 object get` (`docs/diagnostics.md`).

**Deletion condition:** drop the legacy branch once rbox-admin version
telemetry shows no device below the first 2.0 release for 30 days.

### `RepairProof.claimShape` → `claimState`

Class: durable D1 record. **No compat window — none was needed.**

The original entry called this evidence-chain-critical. It is not:
`scrubbed_evidence_sha256` is computed in one place and written in one place,
is never recomputed and never compared, and its only production read is an
`IS NOT NULL` existence check in `account-delete.ts`. No index, unique
constraint, or dedupe is keyed on it. `proof_json` is never parsed by any
code — it is read only as an opaque string and fed byte-for-byte into the
hash. No CLI, web, or RboxBar code reads the key.

The rename therefore changes the digest inputs of newly written rows only,
and nothing verifies either old or new rows. `canonicalEvidence`'s field list
is untouched: it names DB columns, and no column was renamed. No D1 migration
was required or added.

### `GitResolutionBinding["config"].shape` → `storeIdentity`

Class: local durable/derived. **No shim; intentionally token-invalidating.**

The original entry said this was hashed into resolution receipts and needed
the 2.0 receipt-format break. The receipt part was wrong:
`GitResolutionPublicationReceipt` carries `confirmedReportHash`, which hashes
the discard report, not the binding, and the binding has no column in
`repo_records`.

What the binding feeds is `snapshotId`, surfaced as
`Confirmation token: <id>` and compared across processes when `--confirm` is
typed back from an earlier `resolve … show`. So the rename's real effect is
that a token captured before the upgrade produces the existing designed
`snapshot-mismatch` — "review the fresh summary and confirm again". Nothing is
corrupted. Covered by a regression test.

`snapshotId` uses `JSON.stringify`, not canonical JSON, so insertion order is
byte order — the member kept its position in the object literal.

### `"base-shape-mismatch"` → `"base-refs-mismatch"`

Class: durable record + git-ref blob. **Dual-accept read.**

Durable in two places: `GitPartialApply.pRepaired` inside `partial_cjson`, and
the Q blob under `refs/rbox-recovery/base-present/v2/…`, which lives in the
user's git repo and outlives any state reset. Closed-validated on read by
`parsePRepairQ`, reached on every pull, whose throw is not caught — a naive
rename would fail every pull on any repo holding a legacy Q.

Writers emit only the new spelling; the reason union and its `includes` gate
keep the legacy spelling read-only. **`parsePRepairQ` must stay
identity-preserving** — normalizing a legacy value on read would change the Q
blob OID and wedge `resumeAcceptedPRepair`.

The `v2` ref namespace was deliberately not bumped: `v2` is hardcoded in nine
places and cross-bound by regex to `refs/rbox-local/base-present/v2`.

**Deletion condition:** drop the legacy union member and its `includes` entry
after the first 2.0 release has been fleet-live for one full `pRepairEviction`
cycle on every founder host, verified by grepping their recovery ref
namespaces for the legacy spelling.

### `mismatches.baseShape` → `baseRefs`

Class: in-memory only. Never persisted, never on the wire. Renamed outright;
the quoted-key form that dodged the lint is gone with it.

### `"p-repair-shape-mismatch"` → `"p-repair-witness-mismatch"`

Class: durable hold code. **No shim.**

The original entry called this design-176 grammar-frozen wire. It is not —
`design176-grammar-freeze.test.ts` freezes only git log-line grammar and has
no hold-code assertion. The real constraints are permissive: there is no
runtime closed-value check on `attempt.blockers[].code`
(`validateFixedShapes` does not cover `attempt` or `partial`), every consumer
matches rather than validates, and both spellings fall outside the
`composerHoldAllowsSkip` set — so a legacy stored hold keeps vetoing
held-skip exactly as before. Legacy rows self-heal on the next attempt write.

### `EntryStructureError.name === "EntryShapeError"` → `"EntryStructureError"`

Class: emitted text. No in-repo consumer matched on it. The class and imports
were already renamed; the runtime `error.name` now agrees.

### `git-shapes` → `git-layouts` (rig scenario)

Class: dev tooling. The id, symbol, file, findings sidecar, surface constant,
fixture symbols, and scratch paths moved together — renaming only the symbol
would make the registry disagree with the hand-typed CLI id
(`bun run rig run git-layouts`).

Historical design docs (141/145/146/147/148/176/200/260 and notes) and
`STATUS.md` deliberately keep the old spelling: they are dated records of rig
runs that actually happened under that id.

---

## DEFERRED cluster — blocked on one state-store decision

Four fields across three entries. **One root cause: `state.db` has no
migration mechanism at all.**

`applySchemaV1` is a bare `db.exec(SCHEMA_V1_DDL)`; there is no `ALTER TABLE`
anywhere in `src/cli/state-plane/`. `STATE_STORE_DDL_FINGERPRINT`
(`schema/application.ts`) is `sha256(SCHEMA_V1_DDL)` and is written into every
store's `store_meta` at genesis. `validate-open.ts` refuses to open any store
whose stored fingerprint differs, raising `StateAuthorityCorruptError` — whose
message is "rbox has changed nothing and will not try to repair this
automatically." There is no rebuild, re-import, or quarantine path for that
reason.

Separately, `repo_records.canonical_bytes` / `retained_estimate` are checksums
over `canonicalJson(record)` including the TypeScript key spelling;
`decodeRepoRecord` re-encodes on every read and throws
`structural corruption in RepoRecord <relPath>` on mismatch.

| field | suggested | blocker |
|---|---|---|
| `RepoRecordInput.cfgShape` + column `cfg_shape_cjson` | `cfgStore` / `cfg_store_cjson` | column rename changes `SCHEMA_V1_DDL` → changes the DDL fingerprint → every existing store refuses to open, with no repair path |
| `ConfigStoreIdentity.shape` | `repoKind` | nested inside `cfg_shape_cjson`; `shape`(5) → `repoKind`(8) changes the canonical byte length → `canonical_bytes` mismatch → every existing row fails to decode |
| `migration_completion.source_shape_flags_cjson` | `source_presence_flags_cjson` | same DDL-fingerprint block |
| digest token `"source-shape-flags"` | `"source-presence-flags"` | framed into `domainHash("state-semantic-v1")`; technically free today (the legacy-vs-SQL differential has zero production callers and `source_semantic_digest` is always NULL) but meaningless without the column rename |

**This is not a naming problem.** Renaming these requires one of two product
decisions, neither of which belongs in a rename PR:

- **(i) Schema v2 + a migration step at open.** Build the first real
  state-plane migration: bump the schema version and `user_version`, add a
  versioned DDL plus an `ALTER TABLE`/re-encode step under the existing inode
  claim, recompute `canonical_bytes`/`retained_estimate` per row, and settle
  crash-safety and reset-journal interaction. That is a design doc.
- **(ii) 2.0 re-genesis.** Declare that 2.0 mints a fresh state store on every
  device and take these renames for free in the new `SCHEMA_V1_DDL`. Far
  cheaper — *if* re-baselining sync state on every device is acceptable.

Recommendation: **(ii)**, folded into whatever 2.0 does about state stores.
It needs an explicit founder yes, because it costs every device a sync
re-baseline.

**Unblock condition:** a founder ruling on (i) vs (ii). Until then these four
fields keep their current spelling.
