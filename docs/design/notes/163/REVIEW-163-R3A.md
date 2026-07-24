# Design 163 adversarial review — round 3A

## Findings

1. **MAJOR — The shared decoder is bounded in intent, but its byte-source and
   JSON-machine contracts are not exact enough for two independent
   implementations to accept and reject the same inputs.**

   `ResetJournalByteSource` is named but never defined
   (`docs/design/163-state-plane-sqlite.md:288-294`). In particular, the design
   does not say whether the decoder pulls into a decoder-owned fixed buffer or
   consumes producer-owned chunks, what the maximum chunk is, how a declared
   length is authenticated against the stream, or what length is passed to the
   52x admission check when the length is unknown. An async source can allocate
   and yield an arbitrarily large first chunk before a consumer-side counter
   rejects it; a fixed-buffer `readInto` source cannot. The prose therefore
   does not yet prove its claimed pre-allocation bound for the interface it
   publishes.

   The token grammar also leaves observable choices open
   (`docs/design/163-state-plane-sqlite.md:300-313,386-397`). “8,192 tokens”
   does not define whether keys, scalar values, container-open/close events,
   punctuation, and EOF count. A maximum SQLite journal with 256 Z entries has
   3,611 object members; a semantic-event counter using key + scalar + both
   container events is about 7,996 tokens, while a normal lexical-token counter
   including punctuation is about 14,957. One implementation admits that
   schema-valid document and another rejects it. The same ambiguity affects
   whether the root counts as container level zero or one.

   Escapes need equally explicit rules. For example, `"v"` and `"\u0076"`
   must be declared the same decoded member for duplicate detection; otherwise
   a raw-lexeme bitset misses a semantic duplicate. The design also does not
   decide BOM handling, escaped unpaired surrogates in an otherwise permitted
   `stream`, or whether base64's “input byte-for-byte” comparison is against
   the decoded JSON string or its raw JSON lexeme (so `"\u0051Q=="` is
   ambiguous). `decodeResetJournal`'s return union and typed error union are not
   specified even though all consumers are required to produce the same typed
   halt (`:399-412`). Freeze the pull interface, normalized return type, error
   codes, token accounting, decoded-key comparison, Unicode-scalar policy, and
   base64 comparison domain. The raw 512 KiB, member, nesting, aggregate-string,
   Z, and decoded-payload ceilings otherwise do prevent an unbounded
   schema-value allocation.

2. **MAJOR — J0/W2 precedence cannot be implemented for malformed journals
   because the candidate and archive paths themselves require journal fields
   that W2 must not decode.**

   The canonical candidate path contains `journal.id`, and the archive path
   contains `journal.old.stateNonce` and `journal.old.stateSha256`
   (`docs/design/163-state-plane-sqlite.md:224-227`). Yet W2 must win before
   decode for a valid *or malformed* journal (`:399-406,430-432,459-461`), while
   J0 says that after decoder rejection no journal field or artifact path is
   interpreted (`:403-408,459`). For a journal rejected because `id` is
   duplicated, missing, overlong, or late-invalid, the specification supplies
   no candidate/archive paths whose sidecars can be tested. Two implementations
   can therefore classify the same disk image as J0 or W2 depending on whether
   they trust a partially scanned id, scan every namespace entry, or inspect
   only active sidecars. Both rows halt, but they have different typed evidence,
   and the prompt's required unique recovery row is not met.

   The no-journal side is also incomplete. W1 requires every “discovered”
   candidate/archive DB to be S0 (`:460`), but neither the discovery namespace,
   traversal/entry bound, nor overflow behavior is defined. Meanwhile the
   ordinary active-S0 paragraph mentions only active (`:463-470`), leaving
   exact Q + valid active S0 + an orphan candidate WAL either ordinary state or
   an “unrecognized signature.” Define one bounded, no-follow namespace
   inventory independent of decoded journal fields (including its behavior on
   special entries and too many entries), or narrow W2/J0/W1 to explicitly
   named paths and print the remainder. As written, the advertised exhaustive
   sidecar cross-product is not exhaustive.

3. **MAJOR — Source-change retirement can manufacture artifact-behind states
   that the migration restart table requires to halt.**

   The design permits 1.7.x to change authoritative JSON between 2.0 migration
   attempts and says the controller then performs id-scoped
   “retirement/restart” (`docs/design/163-state-plane-sqlite.md:1368-1379`). The
   authority matrix and restart table repeat that action for M0-M4 and M5
   (`:1283-1285,1454`). No durable invalidation/retirement high-water or ordered
   cleanup correlation is defined, however. The table's global rule admits
   only the current artifact or one printed next-phase artifact and explicitly
   halts on artifact-behind state (`:1440-1444`).

   M5 gives a concrete unavoidable counterexample. With changed `L`, exact M5
   control, and exact prepared active DB, deleting/fsyncing the non-authoritative
   active DB first and crashing leaves `L + active absent + exact M5`; the
   authority matrix admits active-absent exact control only for M0-M4. Retiring
   control first and crashing leaves `L + C + absent control`, which the matrix
   deliberately treats as an unadoptable orphan/reserved-path halt
   (`:1288`). The same problem exists when retiring an M2/M3 staging main or
   its sidecars: cleanup before control makes the artifact fall behind its
   witness, while control before cleanup creates an orphan that absent-control
   M0 does not own. Add a monotone, durable invalidation/retirement state with
   complete partial-cleanup rows, or specify another ordering whose every crash
   image is already admitted. The current “restart with a new id” sentence is
   not a crash protocol.

4. **MAJOR — M6 creates a durable Q sibling that is absent from the claimed
   exhaustive M5 restart correlations.**

   M6 first builds and fsyncs an exact Q sibling, then revalidates source/DB,
   renames it over `.rbox/state.json`, fsyncs `.rbox`, and publishes M6
   (`docs/design/163-state-plane-sqlite.md:1426-1431`). A kill after the sibling
   fsync but before rename therefore leaves a durable, self-created
   artifact-ahead state under M5. Unlike revision-scoped control temps, whose
   inert behavior is explicitly specified (`:1356-1365,1448`), the Q sibling
   has no exact path/identity, no absent/exact/foreign disposition, and no M5
   restart action. The M5+L row mentions only active/staging/source/backup and
   tells the implementation to “resume Q creation” (`:1454`); an exclusive
   creator may collide, while an implementation that deletes or adopts the
   sibling has no authorization for that mutation. This also contradicts the
   rule that the one-next-phase artifact-ahead state must be explicitly printed
   (`:1440-1444`). Name and bind the sibling to the control, enumerate crashes
   before/after its fsync and rename (including power-loss old/new observations),
   and specify reuse/removal plus parent fsync.

## Verified portions

- The P0/P0A/P1/P2/P3.k/R0/R1/R2/I0/I1/I2/I3.g/Z0 table is a faithful
  substitution of DB main files for the 16 extracted design-138 boundaries in
  `RESEARCH-138-BOUNDARIES.md:254-269`. It preserves the R0/R1/R2 outcomes
  around cross-directory rename, destination fsync, source unlink, and source
  fsync. Every printed P/R/I/Z row additionally requires S0 for active,
  candidate, and archive, so no regression was found in that correlated main
  file table itself.
- The current legacy decoder does reject the new SQLite branch: current
  `parseJournal` dispatches numeric v2 and `validateResetJournalV2` requires the
  exact legacy root key set (`src/cli/reset-journal.ts:194-218`), so
  `stateFormat` and the other SQLite keys cannot be silently accepted by an old
  binary. The frozen legacy nested shapes agree with the current validators at
  `src/cli/reset-journal.ts:136-204`, and the decimal application id
  `1380077400` correctly equals `0x52424f58`.
- The design correctly identifies the current duplication it must replace:
  `reset-journal.ts` and `reset-journal-doctor.ts` own separate 512 KiB
  constants/parsers, while quarantine restore currently reads the bundled
  journal with the 2 GiB stream cap before handing it to `parseJournal`
  (`src/cli/reset-journal-doctor.ts:19,65-77,127-130`;
  `src/cli/reset-quarantine.ts:329-334`; `src/cli/reset-io.ts:5-8`). The proposed
  `src/cli/reset-journal-codec.ts` does not yet exist, as expected for this
  pre-implementation design.
- Quarantine retains the safety ordering in the repository: bundle bytes and
  COMMITTED are verified/durable before journal removal, and restore publishes
  candidate/archive before the journal (`src/cli/reset-quarantine.ts:248-301,
  309-369`). Keeping `VACUUM INTO` optional and strictly after durable journal
  absence avoids replacing an O/N witness with vacuumed bytes. I found no
  additional quarantine publication regression.
- The targeted current-code suite passed: 82 passed, 2 skipped, 0 failed across
  `reset-journal-classifier`, `reset-io`, `reset-quarantine`,
  `reset-journal-doctor`, and `sync-git/reset-journal`. Those tests validate the
  v2 keystone/current implementation, not the missing v3 codec and migration
  correlations above.

## Verdict

**CHANGES-REQUIRED**
