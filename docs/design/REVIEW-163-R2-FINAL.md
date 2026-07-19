# Design 163 adversarial review — round 2

## Verdict: CHANGES-REQUIRED

The v2 reset P/R/I/Z table is a faithful SQLite-payload re-derivation of the
extraction, the byte-exact witness/backup architecture is now coherent, and the
declared `SyncState` and `RepoRecord` fields are all mapped. The design is not
yet implementable as a closed specification, however. The actual reset-journal
decoder does not provide the duplicate-key or consumer-local byte-limit
guarantees claimed by v2; the U2 memory model omits live N-sized tracked-path
and operation-result contracts; and the migration state machine neither defines
durable control-phase publications nor enumerates their crash signatures. Those
are safety and bounded-memory closure failures, not editorial nits.

## Findings

1. **CRITICAL — The migration control-phase protocol is absent, so M0–M7 is not
   an implementable crash state machine.** The durable control is specified to
   contain `phase` (`docs/design/163-state-plane-sqlite.md:886-902`), and M0
   relies on a “recorded M1–M4 or M5” to select resume behavior (`:869-875`).
   But the ordered phases never say when or how `control.phase` is advanced,
   whether publication precedes or follows the phase's artifact work, or how
   the control overwrite and parent directory are made durable (`:914-955`).
   The crash table consequently has no rows for interruption during a control
   publication, artifact completion with the old control phase, or a newly
   published phase before its first artifact mutation (`:957-972`). Missing
   correlated boundaries include at least M3 commit→M4, M4 proof→M5, M5
   rename/fsync→M6, Q publication→M7, and every control overwrite on either
   side of those transitions. R1 required point 4 is not closed.

2. **HIGH — The claimed existing journal duplicate-key rejection and uniform
   512 KiB decoder bound do not exist.** The design says the decoder first
   applies the existing 512 KiB bounded read and duplicate-key rejection, and
   that recovery, doctor, and quarantine use that one decoder
   (`docs/design/163-state-plane-sqlite.md:232-240,270-274`). In code,
   `parseResetJsonBytes` is plain `JSON.parse` (`src/cli/reset-io.ts:292-301`),
   which accepts duplicate members with last-wins semantics. The later
   `exact()` helper sees only collapsed `Object.keys`
   (`src/cli/reset-journal.ts:113-117`), so none of the envelope or nested exact
   checks at `:147-180,194-204` can detect duplicates. Live journal reads are
   capped by their callers at 512 KiB (`:221-223,353-364`), but `parseJournal`
   itself applies only the generic 512 MiB parse-admission ceiling
   (`:207-218`; `src/cli/reset-io.ts:281-289`). Quarantine restore reads bundled
   journal bytes with the 2 GiB `RESET_STREAM_BYTE_LIMIT` before calling
   `observeResetJournalBytes` (`src/cli/reset-quarantine.ts:329-334`;
   `src/cli/reset-io.ts:8`). Doctor also owns a second local 512 KiB constant
   (`src/cli/reset-journal-doctor.ts:19,69,127`). Closed-key validation after a
   parse is usable, but the claimed composition is false. U1 needs one
   journal-specific raw-byte decoder that owns the 512 KiB limit, rejects
   duplicate keys before ordinary object materialization, and is used by every
   live and bundled consumer.

3. **HIGH — The M3-after-commit row assumes a staging directory entry is durable
   before the design fsyncs its parent.** M3 creates and commits the exclusive
   staging sibling (`docs/design/163-state-plane-sqlite.md:937-940`), while the
   first explicit state-directory fsync is at the end of M4 (`:941-945`). The
   crash table nevertheless says every M3-after-commit or M4 crash leaves a
   complete staging DB (`:965`). Unless a specifically pinned SQLite VFS
   guarantee is made part of the contract, a power loss before the parent fsync
   may lose the staging name or expose a main/sidecar combination not in the
   table. The design must either durably publish the staging name before relying
   on it or enumerate staging-absent and sidecar-without-main restart actions.

4. **HIGH — Plain process crashes and observed capacity failures select
   contradictory migration actions.** The M1 row covers both crash and ENOSPC
   but directs publication of a `filesystem-full` halt
   (`docs/design/163-state-plane-sqlite.md:961-962`); the M3-precommit row also
   directs that halt for an ordinary crash (`:964`). In contrast, the authority
   matrix says an exact control resumes recorded M1–M4 work (`:871-875`), while
   a durable halt suppresses later startup attempts until explicit doctor retry
   (`:1004-1011`). A killed process leaves no evidence that a capacity error
   occurred. The table needs separate crash/no-durable-halt and observed
   ENOSPC-or-`SQLITE_FULL`/halt-publication branches.

5. **HIGH — The optional durable halt is missing from the claimed exhaustive M0
   authority matrix.** The control may contain an optional typed halt
   (`docs/design/163-state-plane-sqlite.md:888-890`), and the fault plan promises
   before/after halt-publication injection (`:1015-1018`), but the M0 matrix
   classifies control only as absent, exact, or foreign and assigns exact
   controls to resume (`:863-880`). It does not correlate halt presence and
   phase with staging/active/Q state, nor cover interruption of halt
   publication. That leaves the cross-process suppression rule without a unique
   restart action.

6. **HIGH — The materialization inventory omits the retained Git tracked-path
   matcher.** `TrackedRepoSet` retains full `paths` and `dirPrefixes` sets
   (`src/engine/ignore.ts:256-262`). `loadTrackedRepoSet` materializes complete
   `git ls-files -z` output through `split/filter/map`, then constructs both
   sets (`:593-624`); the subprocess itself permits a 50 MiB output buffer
   (`:636-639`). This path is enabled for gitignore and purge-safety evaluation
   (`:279-295`; `src/cli/sync/policy.ts:88-94`) and the daemon retains the
   resulting matcher (`src/cli/daemon/daemon.ts:419,2076-2080`). The purported
   complete cache-v2 schema has no tracked-member/prefix relation
   (`docs/design/163-state-plane-sqlite.md:589-623`), while “ignore partitions”
   are placed in a later sealed plan (`:634-640`) even though scan needs these
   queries before that plan exists. Therefore the scanner's 512-entry/4 MiB
   budget and the categorical N-sized-collection ban (`:643-651,766-778`) are
   not implementable. U2 needs streamed `ls-files` ingestion and a named
   file-backed membership/prefix lookup with fail-closed semantics for scan,
   daemon, status, and purge.

7. **HIGH — The ordered architecture stops before the current N-sized pull/push
   result contracts.** Pull returns `Action[]`
   (`src/cli/sync/pull.ts:55-71,196-208,311-319`), and callers consume the full
   collection for summaries, conflict paths, lockfile nudges, daemon telemetry
   and rule refresh, and chain-repair concatenation
   (`src/cli/sync-cmd.ts:33-52,69-85`;
   `src/cli/daemon/daemon.ts:1349-1387,1784-1798`;
   `src/cli/chain-repair.ts:8-11,51-69`). Push returns a complete
   `Manifest` plus deferred/retry arrays (`src/cli/sync/push.ts:92-95`), which
   the daemon retains and consumes (`src/cli/daemon/daemon.ts:1155-1184`). V2
   defines a file-backed action plan and
   narrow `applyCasPacket` results, but no bounded `PullOutcome`/`PushOutcome`,
   conflict/deferred cursor, summary projection, or post-apply plan ownership
   and cleanup contract (`docs/design/163-state-plane-sqlite.md:671-716,
   1438-1451`). Discarding the plan after apply loses data that current callers
   still need; returning it recreates the prohibited N-sized arrays. R1 required
   point 3 remains open.

8. **MEDIUM — The “exact” SQLite journal branch does not freeze its complete
   schema.** V2 names `stateFormat`, `authorityId`, and `next.dbBytesB64`, but
   calls the remaining members only “application/schema ids” without specifying
   their member names, nesting, JSON scalar encodings, or whether “schema” means
   SQLite `user_version` or `store_meta.schema_version`
   (`docs/design/163-state-plane-sqlite.md:223-240,438-440,1033-1053`). The
   current validator is implementable precisely because every accepted key list
   is a literal (`src/cli/reset-journal.ts:151-180,194-204`). Freeze a full
   discriminated TypeScript/JSON union and exact key arrays before claiming the
   new closed key set. An old binary will reject a SQLite branch that adds a
   top-level key because the current v2 envelope is exact at `:194-200`, but
   that fact does not fill in the new decoder's missing protocol definition.

9. **MEDIUM — U0's aliasing rule is sound for scan/reconcile/filesystem-apply,
   but its independently shippable encryption replacement seam is incomplete.**
   Current scan mutates only unpublished builder arrays and watcher publication
   constructs a new map/array (`src/engine/manifest.ts:98-198,263-377`).
   Reconcile only places entry references in actions
   (`src/engine/reconcile.ts:41-76`), and `applyActions` reads those entries
   without mutating their fields (`src/engine/apply.ts:72-212`). Readonly
   published entries, mutable nonescaping builders, and pure replacement thus
   cover those alias sites. The production field mutation is
   `applyCipherDescriptor` (`src/cli/publish-pipeline/shared.ts:34-44`), called
   on objects obtained from `local.files` (`src/cli/sync-recovery.ts:162-174,
   230-272`; `src/cli/publish-pipeline/pipeline.ts:250-267`). That mutation is
   how the later committed manifest currently acquires cipher descriptors,
   while `encryptAndUpload` returns only sets (`src/cli/sync-recovery.ts:130-140`).
   Replacing the helper with `withCipherDescriptor` does not say how the owning
   manifest/generation reference is atomically replaced—rebinding loop variable
   `f` would do nothing. Early U0 needs a specified owner API such as
   `ManifestBuilder.replace(path,expected,next)` or an encrypted candidate
   generation result, including retry/error lease cleanup.

10. **LOW — The proposal pre-records an alignment outcome contradicted by this
    review.** `docs/design/163-state-plane-sqlite.md:1539-1541` says R2 reached
    alignment before the durable R2 review was produced. That assertion must be
    removed or changed when the technical findings above are addressed.

## Requested verification record

### 1. Crash-window row audit against `RESEARCH-138-BOUNDARIES.md`

No P/R/I/Z correlated signature from the extraction is missing. The complete
boundary crosswalk is:

| Extraction boundary | V2 row/signature | Result |
|---|---|---|
| Prepared publication, archive absent/exact (`RESEARCH-138-BOUNDARIES.md:254-255`) | P0/P0A (`docs/design/163-state-plane-sqlite.md:345-346`) | Exact. |
| Candidate creation (`RESEARCH-138-BOUNDARIES.md:256`) | P1 from P0; P2 directly from P0A (`docs/design/163-state-plane-sqlite.md:347-348`) | Exact; the P0A shortcut is preserved. |
| Archive creation (`RESEARCH-138-BOUNDARIES.md:257`) | P2 (`docs/design/163-state-plane-sqlite.md:348`) | Exact. |
| Each recovery-ref prefix (`RESEARCH-138-BOUNDARIES.md:258`) | P3.k (`docs/design/163-state-plane-sqlite.md:349`) | Exact global prefix, including n=0 alias. |
| Ready publication (`RESEARCH-138-BOUNDARIES.md:259`) | R0 (`docs/design/163-state-plane-sqlite.md:350`) | Exact. |
| Rename before either parent fsync (`RESEARCH-138-BOUNDARIES.md:260`) | R0/R1/R2 (`docs/design/163-state-plane-sqlite.md:350-352`) | All lost/installed/resurrected-source observations admitted. |
| Destination fsync, source still unstable (`RESEARCH-138-BOUNDARIES.md:261`) | R1/R2 (`docs/design/163-state-plane-sqlite.md:351-352`) | Exact. |
| Source unlink before source-parent fsync (`RESEARCH-138-BOUNDARIES.md:262`) | R1/R2 (`docs/design/163-state-plane-sqlite.md:351-352`) | Exact. |
| Source-parent fsync (`RESEARCH-138-BOUNDARIES.md:263`) | R1 only (`docs/design/163-state-plane-sqlite.md:351`) | Exact closed install boundary. |
| Installed publication/state check (`RESEARCH-138-BOUNDARIES.md:264`) | I0/I1 observational alias (`docs/design/163-state-plane-sqlite.md:353-354,359-362`) | Exact; no repair precursor is added. |
| Marker publication (`RESEARCH-138-BOUNDARIES.md:265`) | I2 (`docs/design/163-state-plane-sqlite.md:355`) | Exact. |
| Each active-ref group prefix (`RESEARCH-138-BOUNDARIES.md:266`) | I3.g (`docs/design/163-state-plane-sqlite.md:356`) | Exact, including m=0 alias. |
| z-retired publication (`RESEARCH-138-BOUNDARIES.md:267`) | Z0 (`docs/design/163-state-plane-sqlite.md:357`) | Exact. |
| Journal unlink/parent fsync and terminal candidate cleanup (`RESEARCH-138-BOUNDARIES.md:268-269`) | No standing-journal row (`docs/design/163-state-plane-sqlite.md:364-367`) | Correctly outside the allow table. |

The pre-P0 ref normalization remains outside standing-journal classification.
The added exact `Q`, all-artifact `S0`, W1, and W2 rules explicitly close the
SQLite-only sidecar dimension (`docs/design/163-state-plane-sqlite.md:291-339`).
Thus the physical correlated-row portion of R1 point 1 is closed. Findings 2
and 8 keep the complete journal/classifier point open.

### 2. Exact-schema journal branch against the actual decoder

- Closed legacy-vs-SQLite key sets are implementable by dispatching after a
  bounded raw parse and applying branch-specific `exact()` lists.
- The current decoder's exact-key checks compose with a unique-key parse, and an
  old decoder rejects extra top-level SQLite keys.
- The existing parser does **not** reject duplicate keys, `parseJournal` does
  not own a 512 KiB cap, and quarantine can hand it a much larger buffer.
- The new branch's complete keys and scalar encodings are not yet normative.

Therefore the branch is implementable only after findings 2 and 8; it is not
implementable “as claimed” by reusing the current decoder guarantees.

### 3. `SyncState` / `RepoRecord` field audit

No declared field is dropped.

- `SyncState` is 13/13: `stream`, `lastSyncedSequence`,
  `lastSyncedManifest`, `manifestMeta`, `gitReposRemoved`,
  `gitNeedsResolution`, `gitPendingRemote`, `gitDeferrals`, `gitPartial`,
  `stateNonce`, `stateRevision`, `telemetryBindingId`, and `repoRecords`
  (`src/cli/config.ts:132-175`) all have explicit mappings at
  `docs/design/163-state-plane-sqlite.md:1290-1306`.
- `RepoRecord` is 16/16: `repoGen`, `sourceSeq`, `base`, `advertised`,
  `branchBaseOrigins`, `pending`, `repoAbsent`, `removedKey`,
  `resolutionKey`, `cfgSynced`, `cfgApplied`, `cfgToken`, `cfgShape`,
  `deferrals`, `partial`, and `idxProj` (`src/cli/config.ts:276-300`) map to
  `repo_records` and the exhaustive list at
  `docs/design/163-state-plane-sqlite.md:1197-1248`.
- Source presence, empty-container distinctions, ignored legacy map values, and
  normalized per-path precedence match `repoRecordsForState` and
  `stateFromRepoRecords` (`src/cli/config.ts:408-499`; design `:1232-1239,
  1311-1335`). The semantic digest covers the raw evidence and normalized rows
  (`docs/design/163-state-plane-sqlite.md:1453-1463`).

R1 finding 7 is closed for the requested field mapping.

### 4. Materialization budget against R1's cited call sites

V2 does address the principal hotspots: scan accumulation/sort and watcher map
publication (`docs/design/163-state-plane-sqlite.md:643-669`), three-way maps,
action planning, apply preflight and receipts (`:634-640,671-716`), push's
BASE/LOCAL maps and mutable candidate (`:718-764`), the three rebuildable caches
(`:589-632`), and the snapshot/delta/fold/refset/LRU wire peaks (`:780-819`).
The wire exclusions are explicit and measured rather than hidden.

The budget is still incomplete because the tracked matcher in finding 6 exists
before the plan and because the full pull/push outcome contracts in finding 7
survive after it. Both can scale with workspace size outside a named wire
adapter. R1 required point 3 is not closed.

### 5. Migration phase × crash-point completeness

| Phase | Audit result |
|---|---|
| M0 | The main JSON/Q/DB authority split is sound, but halted-control correlations are absent from the matrix. |
| M1 | Reserve/control/emergency artifacts are named; crash and capacity-failure outcomes are incorrectly conflated, and control/halt publication boundaries are absent. |
| M2 | History/fixed-backup link/copy/rename/fsync cases are covered physically; entry/exit control-phase publications are absent. |
| M3 | Pre/post completion-commit is split, but ordinary crash is mislabeled filesystem-full, control transitions are absent, and post-commit staging-name loss is unlisted. |
| M4 | Checkpoint/verify/fsync retry is broadly covered; staging durability before its final parent fsync and M4/M5 control correlations are not. |
| M5 | Staging/active rename and indeterminate parent durability are covered; the durable transition into and out of M5 is not. |
| M6 | Sentinel temp, source recheck, rename, and parent-fsync outcomes are covered; control/halt correlations are not. |
| M7 | Q correctly remains authority through cleanup failures; the optional durable halt/foreign control state and M7 phase publication/retirement are not classified. |

The table is not exhaustive until findings 1, 3, 4, and 5 are resolved.

### 6. U0 interning and mutation audit

The exact-field/optional-presence interning key, collision full-compare,
generation retains, zero-retain eviction, readonly publication, and pure
cipher-descriptor rule are directionally correct
(`docs/design/163-state-plane-sqlite.md:543-587`). Scan, reconcile, and
filesystem apply have no incompatible `FileEntry` field mutation: their array,
map, and action mutations only move/reference entry objects. The current cipher
helper is the one field-mutating seam. Finding 9 identifies the missing owner
replacement API needed to turn the pure-return rule into working early-U0 code.

## R1 five-point closure verdict

| R1 required revision | R2 verdict | Reason |
|---|---|---|
| 1. Complete 138 replacement table + exact old/new witness | **NOT CLOSED** | The physical W/P/R/I/Z table and byte-exact O/N architecture are closed, but the claimed duplicate-safe, uniformly bounded, exact SQLite journal decoder is not specified or present. |
| 2. Available bounded backup/snapshot primitive with durability | **CLOSED** | Reset retains byte-exact bounded copy; general/quarantine diagnostics use staged `VACUUM INTO`, close/S0 verification, fsync, rename, and parent fsync (`docs/design/163-state-plane-sqlite.md:383-422`). |
| 3. Ordered BASE/LOCAL/REMOTE architecture + materialization budgets | **NOT CLOSED** | Core planes/plans/wire walls are specified, but the tracked matcher and pull/push result contracts remain unbounded and unnamed. |
| 4. Resumable migration authority, ENOSPC, semantic proof, downgrade barrier | **NOT CLOSED** | `Q`, backups, completion witness, and semantic verification are strong; durable phase transitions, halted-control states, staging-name durability, and crash-vs-capacity branches are incomplete. |
| 5. WAL/FULL/checkpoint, cheap opens, corrected claims | **CLOSED** | Runtime pragmas, connection topology, checkpoint/backpressure policy, integrity-check placement, status scope, no-op/RSS wording, and isolate ownership are explicit (`docs/design/163-state-plane-sqlite.md:436-498` and `:13-50,105-115`). |

Because required points 1, 3, and 4 remain open, the round-2 verdict is
**CHANGES-REQUIRED**.
