# Wire rename candidates

Shape-named fields that anti-slop flags but that could not be renamed in place:
they are serialized wire keys, durable record members, or values hashed into
stored evidence.

**Status 2026-08-21 — the 2.0 cutover pass is COMPLETE. All twelve candidates
landed.** Founder ruling 2026-08-20 put them all in scope before the 2.0 tag.
Nine landed first; the last four unblocked on 2026-08-21 when the founder ruled
that **no state.db migration mechanism gets built** (see "Formerly deferred
cluster" below), which let them land plainly in the DDL.

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

## Formerly deferred cluster — DONE in the v2 DDL (2026-08-21)

Four fields across three entries, blocked for one day on one root cause:
**`state.db` has no migration mechanism at all.** `applySchemaV1` is a bare
`db.exec(SCHEMA_V1_DDL)`; there is no `ALTER TABLE` anywhere in
`src/cli/state-plane/`. `STATE_STORE_DDL_FINGERPRINT`
(`schema/application.ts`) is `sha256(SCHEMA_V1_DDL)`, written into every store's
`store_meta` at genesis, and `validate-open.ts` refuses any store whose stored
fingerprint differs. Renaming a column changes the DDL, changes the
fingerprint, and refuses every existing store.

Separately, `ConfigStoreIdentity.shape`(5) → `repoKind`(8) changes the canonical
byte length of every encoded RepoRecord, and `repo_records.canonical_bytes` /
`retained_estimate` are checksums over `canonicalJson(record)` that
`decodeRepoRecord` re-verifies on every read.

### How it was resolved

Two options were live: **(i)** build a real migration at open, or **(ii)**
re-genesis — mint a fresh store when the fingerprint does not match.

(ii) was ruled first and taken through a full design cycle:
`docs/design/283-state-regenesis.md`, twelve adversarial review rounds, PR #805.
That design reached ALIGNED but at a cost that only made sense for a large
fleet: a retained per-generation access port, plus a **permanent** publication
quiesce on every rebuilt device, because no automatic release turned out to be
safe (the client cannot enumerate its own repositories completely — ignored
subtrees are pruned and `readdir` failures are swallowed).

**Founder step-out re-ruling, 2026-08-21 — NO mechanism is built.** Externals
start fresh on 2.0, so only the three founder machines hold v1 stores. A
permanent quiesce and a recurring port tax are the wrong layer for a population
of three. PR #805 was closed with that framing and its branch preserved as the
negative result.

So the renames land **plainly**, and old stores keep refusing:

| field | now | note |
|---|---|---|
| `RepoRecordInput.cfgShape` + column `cfg_shape_cjson` | `cfgStore` / `cfg_store_cjson` | renamed in the DDL |
| `ConfigStoreIdentity.shape` | `repoKind` | nested inside that column's CJSON; the canonical-length change is irrelevant because only freshly created stores exist |
| `migration_completion.source_shape_flags_cjson` | `source_presence_flags_cjson` | renamed in the DDL |
| digest token `"source-shape-flags"` | `"source-presence-flags"` | framed into `domainHash("state-semantic-v1")` |

`STATE_STORE_DDL_FINGERPRINT` moved to
`94b519282f6efaed3c51b96e0bf0ca6b998922f149a0600501eedc0cb2224695`.

**Deliberately NOT changed:** `STATE_STORE_SCHEMA_VERSION` (still 1),
`STATE_STORE_SQLITE_USER_VERSION` (still 1), and both application ids.
`requireOwnedStateStoreFile` (`store/open.ts`) rejects on a `user_version`
mismatch read from the raw file header *before* the database is opened, and
`validateOpen` checks `schema_version` *before* `ddl_fingerprint`. Bumping
either constant would route old stores to an earlier, less informative refusal
and make the fingerprint refusal — the one that now carries the remedy —
unreachable. The fingerprint is the discriminator; the version numbers carry no
operational meaning while exactly one schema is supported.

**The refusal now names its remedy.** A store from another version's DDL
refuses with the same fresh-start instruction the doctor already prints for
`authority-corrupt`: stop rbox, move the workspace's `.rbox` folder aside, then
`rbox adopt`, with files left in place. `doctor` reports it as
`state-from-other-version`. Never "upgrade" — the reader is already running the
binary that refuses.

Founder-fleet crossover (the three machines that hold v1 stores) is an
operational one-time step, not a code path:
`docs/design/283-state-regenesis-resolution.md`.
