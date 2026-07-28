# Verdict: NOT-READY

V5 should not become implementation authority yet. C2b’s future-control pair is substantially repaired, but current `src/` has drifted beyond the “field-complete” schema, the mixed-fleet fence is unsafe, and C4 still omits reachable reset states.

Review basis: `origin/main` at `b1ca2a3f`; the checkout was four commits behind, though those commits do not change the reset/state conclusions. The current reset baseline passes: 82 tests passed, 2 skipped.

## Findings, ranked by severity

1. **CRITICAL — The “field-complete” schema would lose live `RepoRecord` state.**

   The normative table and one-for-one field list omit:

   - `packedRefsIdentity`
   - `attempt`
   - `resolutionReceipt`

   Compare [design §RepoRecord](/home/via/Development/Personal/rbox-core/docs/design/163-state-plane-sqlite.md:2475) and its claimed exhaustive list at [line 2519](/home/via/Development/Personal/rbox-core/docs/design/163-state-plane-sqlite.md:2519) with the current interface at [sync-state-model.ts:288](/home/via/Development/Personal/rbox-core/src/cli/sync-state-model.ts:288). These are known operational fields, including held-follow and uncertain-ack evidence; treating them as incidental `extras_cjson` would contradict the promised typed mapping and make normal SQLite updates unable to preserve their semantics reliably.

   Required: rebase the complete schema, codecs, digest framing, CAS transitions, fixtures, and compile-time coverage over current `SyncState`/`RepoRecord` types.

2. **CRITICAL — An already-running degraded legacy operation can overwrite `Q`.**

   The design assumes every legacy writer operates under the workspace/state fence ([lines 63–68](/home/via/Development/Personal/rbox-core/docs/design/163-state-plane-sqlite.md:63), [1767–1778](/home/via/Development/Personal/rbox-core/docs/design/163-state-plane-sqlite.md:1767)). Current code deliberately supports `degraded-unlocked` operation and continues with legacy saves ([sync-mutex.ts:140](/home/via/Development/Personal/rbox-core/src/cli/sync-mutex.ts:140)). Pull and push pass `forceLegacy` in this state ([pull.ts:414](/home/via/Development/Personal/rbox-core/src/cli/sync/pull.ts:414), [push.ts:531](/home/via/Development/Personal/rbox-core/src/cli/sync/push.ts:531)), and that path writes a stale whole JSON state without rereading `Q` or acquiring the state lock ([sync-state.ts:342](/home/via/Development/Personal/rbox-core/src/cli/sync-state.ts:342), [sync-state-store.ts:338](/home/via/Development/Personal/rbox-core/src/cli/sync-state-store.ts:338)).

   Therefore a pre-Q operation can publish JSON after M6, destroying the sole authority marker. Invalid-JSON refusal protects only operations that read after Q.

   Required: ship and bake a Q-before-every-write barrier in the supported stable line, pin an exact minimum safe version, and add an M0 capability/quiescence predicate plus a fixture for an already-running degraded writer.

3. **HIGH — C4 conflicts with committed legacy quarantine cleanup authority.**

   V5 says an exact legacy candidate is permanently inert, never deleted, and survives M0–M7 and Q unchanged ([lines 381–393](/home/via/Development/Personal/rbox-core/docs/design/163-state-plane-sqlite.md:381)). But a committed quarantine bundle durably owns later deletion of that exact candidate after journal removal ([reset-quarantine.ts:199](/home/via/Development/Personal/rbox-core/src/cli/reset-quarantine.ts:199)); doctor creates candidates with `cleanup:"remove-exact"` ([reset-journal-doctor.ts:138](/home/via/Development/Personal/rbox-core/src/cli/reset-journal-doctor.ts:138)), and the crash test confirms resumed deletion ([reset-quarantine.test.ts:77](/home/via/Development/Personal/rbox-core/src/cli/reset-quarantine.test.ts:77)).

   Migration settles only a standing journal, not pending quarantine bundles.

   Required: either finish and fence every valid quarantine before M0, including malformed/partial handling, or make Q revoke cleanup against original legacy paths. Add `COMMITTED + journal absent + candidate present` fixtures before and after Q.

4. **HIGH — C4’s reset-temp branch is not a closed inventory.**

   The design admits unspecified “recognized positively identified protocol temps” under an “existing owner-specific cleanup rule” ([lines 320–335](/home/via/Development/Personal/rbox-core/docs/design/163-state-plane-sqlite.md:320)). Current reset machinery can leave two different crash-durable forms:

   - `.rbox-tmp-<pid>-<counter>-<basename>` from `writeFileAtomic` ([fsutil.ts:29](/home/via/Development/Personal/rbox-core/src/engine/fsutil.ts:29))
   - `.rbox-tmp-<pid>-<16hex>-<basename>` from reset archive copying ([reset-io.ts:245](/home/via/Development/Personal/rbox-core/src/cli/reset-io.ts:245))

   Candidate and archive creation place them inside the inventoried reserved directories ([reset-journal.ts:435](/home/via/Development/Personal/rbox-core/src/cli/reset-journal.ts:435)). There is no crash-time owner authentication or restart cleanup; the live-call `finally` cannot handle `SIGKILL`.

   Required: freeze exact temp grammars, dispositions, and cleanup authority. Otherwise implementations must either reject supported crash debris or invent the forbidden broad wildcard.

5. **HIGH — The M6 cleanup set is called closed but never enumerated.**

   `cleanup.order` refers to “private/migration-id artifacts” without a literal role/path inventory ([lines 1859–1866](/home/via/Development/Personal/rbox-core/docs/design/163-state-plane-sqlite.md:1859)); the C1 vector repeats the undefined category ([lines 1801–1808](/home/via/Development/Personal/rbox-core/docs/design/163-state-plane-sqlite.md:1801)). V5 exhaustively correlates the future controls only after the final item has been chosen. It does not define which items must reach that runway.

   Required: enumerate every role, canonical path, allowed starting disposition, order, and terminal disposition.

6. **HIGH — Downgrade and rollback remain a policy statement, not an operational recovery story.**

   After Q, the kill switch hard-errors; backups are explicitly non-authoritative; automatic downgrade, dual-write, and fenced export are absent ([lines 1646–1656](/home/via/Development/Personal/rbox-core/docs/design/163-state-plane-sqlite.md:1646)). That is split-brain-safe only while Q survives, and provides no recovery route for a post-Q 2.0 semantic defect.

   The rollout text is also stale: it calls `main` the 1.7.x line ([lines 112–121](/home/via/Development/Personal/rbox-core/docs/design/163-state-plane-sqlite.md:112)), while current `main` identifies as 1.10.1 ([package.json:1](/home/via/Development/Personal/rbox-core/package.json:1)). No exact downgrade floor is normative.

   Required before default-on: either a fenced export/restore design or an explicit full-workspace snapshot rollback procedure, plus exact supported legacy binary versions and mixed-process fixtures.

7. **MAJOR — C2b is internally closed, but v5 does change a v4 contract.**

   The good news: the `b…b+4` ledger closes absent/create-ahead/building/finish-ahead/exact preparation; H binds the immutable S/M7 record; halted retry reuses S; and terminal-control-last survives ([lines 1933–2080](/home/via/Development/Personal/rbox-core/docs/design/163-state-plane-sqlite.md:1933)). I found no remaining crash-image hole in the pair itself.

   However, v4 required doctor to durably CAS-clear a halt before delegating. V5 authorizes unlink/fsync of the final item while H is still canonical and makes H→M7 the durable clear ([lines 2035–2061](/home/via/Development/Personal/rbox-core/docs/design/163-state-plane-sqlite.md:2035)). That is a narrow, potentially valid exception, but it contradicts the fold’s claim that every v4 closure is unchanged.

   Required: record it explicitly as a refinement/deviation and freeze the single-use delegation token’s creation, lifetime, crash loss, and sole accepted action.

8. **MAJOR — Migration can safely refuse precisely the large states that motivated it, indefinitely.**

   Migration retains the monolithic JSON materialization and 52× admission. The design acknowledges that a 512 MiB state needs 26 GiB of parse headroom ([lines 2197–2206](/home/via/Development/Personal/rbox-core/docs/design/163-state-plane-sqlite.md:2197)); current code performs that admission and then `JSON.parse` ([reset-io.ts:281](/home/via/Development/Personal/rbox-core/src/cli/reset-io.ts:281), [reset-io.ts:292](/home/via/Development/Personal/rbox-core/src/cli/reset-io.ts:292)).

   Safe refusal is not migration completeness. Define the supported migratable envelope and fleet treatment for larger states, or specify a streaming import path.

## Simpler alternatives missed or insufficiently rejected

- Make Q plus durable M6 terminal authority and leave a small identity-bound control/reserve artifact for later doctor GC. This removes most of the future-control runway.
- Permanently retain the bounded reserve instead of deleting the last allocation resource under ENOSPC.
- Backport Q-before-read/write refusal to stable 1.x/1.10.x and bake telemetry before enabling any migration.
- Ship a backend-first SQLite authority phase through the already-centralized state/CAS seam, temporarily retaining a production whole-state adapter, then replace materialization with cursor ports. V5 currently couples authority migration, engine rewrite, reset conversion, and rollout into one large-bang 2.0 branch without adequately rejecting this sequencing.
- Make all U3 migration entry unreachable until U4 reset/quarantine support is complete, not merely default-off.

The core v5 `.json` candidate/archive filename grammar is correct, and C2b’s future-control correlation is now technically strong. Those successes do not compensate for the authority, schema, and reset-inventory blockers above.

CODEX-REVIEW-COMPLETE
