# REVIEW-138 — Reset-path hardening

## Round 1 — adversarial code review

**Verdict: CHANGES-REQUIRED.** The incident diagnosis is correct, but the
proposed mechanism does not yet establish the claimed consent or read-only
boundaries, the 2 GiB ceiling is not a safe memory ceiling for the existing
whole-file implementation, and fail-soft journal handling would allow sync to
mutate an indeterminate reset transaction. The doctor escape hatch is also not
safe or reachable as specified.

### Findings

1. **CRITICAL — `RebindConsent` is attached above the destructive boundary, so
   unconsented callers can still reset state.** The design adds the token only
   to `loadState` (`docs/design/138-reset-path-hardening.md:35-55`), while the
   actual primitive remains an exported
   `resetSyncState(root, nextStream, heldMutex)` with no authorization argument
   (`src/cli/config.ts:1025-1035`). `init` calls that primitive directly
   (`src/cli/init-cmd.ts:188-195`), and `track` directly resets every differing
   prior binding (`src/cli/track-cmd.ts:85-116`); the latter is an ordinary CLI
   path (`src/cli/main-dispatch.ts:156-159`) and its scripted `--workspace`
   surface is documented (`src/cli/help-registry.ts:223-235`). Gate
   `resetSyncState` itself, or make raw reset initiation private behind a
   capability-checked API. The capability must be bound to the exact root,
   observed old stream/nonce, and intended next stream (and preferably be
   single-use); an unscoped reusable brand could authorize a later reset that
   the user never approved. Check authorization before `fs.mkdir`, lock or
   recovery work.

2. **CRITICAL — `init-cmd.ts:190` is not a consent context and cannot mint the
   token safely.** The same `runInit`/`executeInitPlan` path is entered by direct
   `rbox init` (`src/cli/main-dispatch.ts:145-149`), guided setup
   (`src/cli/setup-cmd.ts:498-502`), and noninteractive keyed setup
   (`src/cli/setup-keyed.ts:73-94`). The only existing setup rebind confirmation
   covers `choice === "new"` (`src/cli/setup-cmd.ts:453-472`); choosing a
   different existing workspace takes `:438-450` and receives no consequence
   confirmation. `resolveInitPlan` accepts scripted `--workspace`/`--new`
   without a force-class rebind affordance (`src/cli/init-plan.ts:126-176`).
   Consent must therefore be minted at the actual confirmation/explicit flag
   boundary and passed out-of-band; `executeInitPlan` cannot infer it from an
   ordinary plan. Direct init, keyed setup, and track must refuse a mismatch
   absent that proof. Also preflight this refusal before remote workspace
   creation at `src/cli/init-cmd.ts:158-164`, which currently precedes inspection
   of the previous binding at `:181-190`.

3. **HIGH — the missing-state/incarnation path bypasses the proposed mismatch
   branch.** When `state.json` is absent, `loadRawState` can reconstruct state
   from `state-incarnation.json` (`src/cli/config.ts:362-383`). `loadState` then
   returns that state only when its stream matches; on a differing marker stream
   it silently returns a fresh state for the caller's requested stream
   (`src/cli/config.ts:702-706`). That erases the known foreign lineage in memory
   and lets a later save rebaseline without ever reaching the proposed
   `state.stream !== stream` guard at `:712-725`. The typed, consent-gated
   mismatch policy must cover the incarnation-marker case too, with a regression
   test.

4. **CRITICAL — the promised no-write ordering is not defined for a standing
   reset journal.** Today `loadState` reads and recovers a journal, including
   acquiring a workspace mutex, before it reads the active state
   (`src/cli/config.ts:682-710`); only then does it compare streams at `:712`.
   Recovery acquires Git/state locks (`src/cli/reset-journal.ts:341-355`) and may
   create a candidate/archive/recovery refs, replace state, write the incarnation
   marker, retire refs, and remove artifacts (`:272-335`). Simply moving the
   active-state comparison earlier is still wrong: a valid `ready` journal
   deliberately has the old active state until the rename (`:288-302`), and a
   poisoned journal can have an active state matching the caller but a foreign
   `next.stream` (journal old/next binding is recorded at `:383-390`). Specify a
   non-mutating classification of active state plus validated journal, including
   every phase and both `old.stream`/`next.stream`, before any recovery mutation.
   Tests must cover prepared/ready/installed/z-retired with the config bound to
   old, next, and neither; otherwise the literal contract in
   `docs/design/138-reset-path-hardening.md:39-45` is not implementable safely.

5. **HIGH — the `loadState` inventory and acceptance matrix are incomplete.** A
   production search finds 20 call sites, not just the five examples:

   - pull: `src/cli/sync/pull.ts:38,67,102`; push:
     `src/cli/sync/push.ts:63,345`
   - status: `src/cli/status-cmd.ts:267,294`; doctor:
     `src/cli/doctor-cmd.ts:393`; ignore: `src/cli/ignore-cmd.ts:110`
   - chain repair: `src/cli/chain-repair.ts:36,67`; daemon:
     `src/cli/daemon/daemon.ts:693,2230`
   - Git deferral/resolution paths: `src/cli/git-cmd.ts:272,621,655,687,730,960,975`

   The acceptance text tests only status/pull/push
   (`docs/design/138-reset-path-hardening.md:94-98`). Require the explicit full
   inventory and command-level no-write coverage for doctor, ignore, repair,
   daemon startup/pump, and Git surfaces too. A default of `"throw"` is useful
   defense for future callers, but it does not prove that existing commands do
   no mutation before their load.

6. **CRITICAL — 2 GiB is not a memory-safe ceiling for this implementation.**
   `noFollowRead` whole-buffers the file with `handle.readFile()`
   (`src/cli/reset-journal.ts:141-150`). Recovery keeps cap-sized `oldBytes` and
   `candidate` alive together (`:261-264`), then the `ready` path allocates
   `currentCandidate` and `currentState` while those outer bindings remain live
   (`:288-290`). Other phases read archive/reload/exact copies as well
   (`:267-283,305-319`). Reset initiation separately whole-buffers state,
   converts it to a UTF-8 string, and parses the full object
   (`src/cli/config.ts:1009-1014,1044-1063,1084-1096`); those raw reads are not
   governed by `MAX_STATE_BYTES` at all. A 65 MiB test proves the immediate fleet
   regression only; it gives no peak-RSS or daemon-survival evidence near the
   proposed ceiling. Use bounded streaming hash/equality/copy and cap every raw
   reset read, or select a materially lower ceiling backed by an explicit
   worst-case peak-memory proof and constrained-process test. Streaming cannot
   remain a non-goal while 2 GiB is advertised as a safe readable ceiling
   (`docs/design/138-reset-path-hardening.md:62-75,113`).

7. **HIGH — the cap anchor is inaccurate and the read can exceed the cap during
   an in-place grow.** There are 13 `noFollowRead` invocations, including ten
   state-cap-bearing sites (`src/cli/reset-journal.ts:164,244,261,263,267,282,289,290,306,317`),
   not “all five” (`docs/design/138-reset-path-hardening.md:67-68`). More
   importantly, `noFollowRead` validates `lstat`, opened-file identity, and size
   only before `handle.readFile()` (`src/cli/reset-journal.ts:141-150`). A regular
   file that grows in place after the check can be read past the cap, and there
   is no post-read size/identity check. Use an exact bounded read/stream with a
   hard byte counter and post-read identity validation. Add a concurrent-growth
   test in addition to the static `>2GiB` rejection test.

8. **CRITICAL — “Sync continues” is unsafe for a journal-processing failure.** A
   failure may describe a real mid-transaction state, as the design itself notes
   (`docs/design/138-reset-path-hardening.md:79-89`). At `ready`, recovery may have
   created recovery refs but not replaced state; at `installed`, state has been
   replaced while the incarnation marker and Z retirement may be incomplete
   (`src/cli/reset-journal.ts:278-322`). If sync is allowed to advance that state,
   a later installed-phase recovery explicitly rewrites any non-exact active
   state back to the journal's genesis bytes (`:305-310`), discarding the newer
   advancement. A malformed journal does not even reveal which phase is active.
   The safe fail-soft contract is “the daemon stays alive and status remains
   available, but sync is halted until recovery succeeds or a phase-safe operator
   action is completed,” not the proposed status text at
   `docs/design/138-reset-path-hardening.md:82-84`.

9. **HIGH — the proposed F2b suppression/status mechanics do not cover the paths
   that actually fail.** Daemon startup calls `loadState` before constructing the
   daemon (`src/cli/daemon/daemon.ts:2218-2239`, call at `:2230`), so a poisoned
   journal exits instead of entering any in-memory suppression. During pumping,
   the pre-op load at `:829` is outside the per-op catch beginning at `:838`; the
   existing consecutive-message dedup at `:931-970` therefore cannot handle it.
   Status likewise calls `loadState` before reading daemon activity or rendering
   anything (`src/cli/status-cmd.ts:263-278`) and may call it again at `:294`, so
   it cannot currently display the promised action line. Restructure startup,
   pre-op, and status around a typed recovery-halt result; persist enough health
   state for status, keep the process alive without syncing, and schedule a
   bounded retry. “Per distinct message” also needs a bounded
   `Map<message,lastLoggedAt>`-style policy: the existing single
   `lastErrMsg`/`errRepeat` streak logs first and every tenth consecutive error,
   so alternating A/B/A errors evade suppression. Test poisoned-at-startup,
   poisoned-after-startup, A/B/A within one hour, and the hour boundary.

10. **CRITICAL — `doctor reset-journal --quarantine` is neither reachable nor a
    safe phase-agnostic operation as specified.** Current doctor dispatch ignores
    the positional subcommand and calls ordinary `doctorCmd`
    (`src/cli/main-dispatch.ts:319-325`); its registered flags do not include
    `--quarantine` (`src/cli/help-registry.ts:503-511`). More importantly,
    ordinary doctor collection invokes `workspaceShape` (`src/cli/doctor-cmd.ts:452-470`),
    which calls `loadState` (`:392-399`) and will hit the poisoned journal before
    rescue. The rescue branch must run before normal doctor collection and must
    handle malformed/oversized bytes without requiring `readResetJournal`, which
    rejects them at `src/cli/reset-journal.ts:227-232`.

    Quarantine must also take the same non-degraded workspace/recovery fences and
    perform identity-checked, durable rename ordering; otherwise it can race
    recovery after recovery has read the journal (`src/cli/reset-journal.ts:259-335`).
    Moving only `reset-v1.json` can strand candidate/archive/recovery refs or an
    installed-but-not-retired state, so define phase-specific eligibility and the
    complete artifact bundle/restoration semantics. A generic `.rbox/trash/`
    destination is unsuitable without protection: that namespace has retention
    and pruning behavior (`src/engine/trash.ts:9-22,109-185`), so a forensic reset
    record may become invisible or be deleted. Use a dedicated protected reset
    quarantine namespace. Finally, “origin” is not present in the exact journal
    schema (`src/cli/reset-journal.ts:40-59,100-103`); define and version it, or
    render it as unknown. Corrupt journals must likewise report stream/age as
    best-effort unknown rather than making the rescue command fail.

### Required design changes before implementation

1. Put a root/from-lineage/to-stream-bound consent capability at the reset
   initiation boundary, and identify the exact prompt/flag that mints it for each
   entry point. Unconsented direct init, keyed setup, and track must fail before
   external or filesystem mutation.
2. Define one non-mutating classifier for raw state, incarnation marker, and every
   reset-journal phase. Separate read-only inspection from authorized recovery;
   prove phase/config combinations with zero-write snapshots.
3. Replace the 2 GiB whole-buffer plan with a bounded-memory protocol (including
   every uncapped `config.ts` read), or lower the cap to a proven safe ceiling.
4. Keep the daemon alive but halt sync on journal uncertainty. Define persistent
   health, retry, hourly per-message logging, and a degraded status path that does
   not require successful `loadState`.
5. Specify a pre-doctor rescue dispatcher and a fenced, phase-aware, durable,
   restorable quarantine bundle in a protected namespace; define behavior when
   journal metadata cannot be parsed.

## Round 2 — ruling verification and new contract-edge review

**Verdict: CHANGES-REQUIRED.** v2 adopts the right high-level direction, and
Round-1 f3, f5, f7, and f8 are now genuinely specified: the standalone
incarnation-marker mismatch is refused, the 20-site `loadState` inventory and
command-level tests are explicit, bounded streaming reads get a hard counter
and post-read check, and journal uncertainty halts sync. The remaining rulings
do not yet close under the actual control flow: f1/f2 reopen in findings 1-2,
f4 in findings 3-4, f6 in finding 5, f9 in findings 6-7, and f10 in findings
8-9. These are protocol gaps, not implementation-detail choices.

### Findings

1. **CRITICAL — create-new setup cannot mint the capability v2 specifies.** The
   capability must be minted at setup's confirmation and already bind the exact
   `nextStream` (`docs/design/138-reset-path-hardening.md:33-44`), while the
   mismatch preflight must happen before remote creation (`:52-55`). For a new
   workspace, however, `nextStream` includes `remoteWorkspaceId`
   (`src/cli/config.ts:618-622`), and that high-entropy ID is assigned and first
   returned by the create POST (`src/cli/remote/api.ts:207-224`; caller at
   `src/cli/init-cmd.ts:158-164`). The prompt therefore cannot mint the stated
   token, and minting or filling it after the POST is no longer minting only at
   the consent boundary. Specify a two-stage, unforgeable witness (confirmed
   creation intent bound to root/old lineage, then a one-time narrowing to the
   returned ID under the same invocation) or another protocol. Test that a
   returned/adopted workspace ID cannot be substituted during narrowing.

2. **CRITICAL — lineage re-verification is not an atomic authorization
   boundary.** “Re-verifies before mutating” plus “authorization before any
   lock” (`docs/design/138-reset-path-hardening.md:33-37`) permits an unlocked
   check followed by a TOCTOU. The workspace mutex is not the state CAS:
   `applyStateSavePacket` writes under `state.json.lock` without requiring that
   mutex (`src/cli/config.ts:498-570`), and `assertSyncMutex` only compares the
   root string (`src/cli/sync-mutex.ts:163-165`). Reset preparation can recover
   checkout journals, settle/repair P, and settle A before the final state-byte
   check and journal publication (`src/cli/config.ts:827-982,1009-1014,1088-1100`).
   The design must separate the side-effect-free token check from a
   lock-protected `{stream, nonce}` recheck and state exactly which locks fence
   that recheck through the first reset-side mutation. A barrier test must
   advance the nonce after token validation but before reset publication and
   prove that neither Git artifacts nor `.rbox` changed.

3. **CRITICAL — the classifier's recovery allow-rule is impossible for an
   ordinary rebind and cannot distinguish the incident journal from an
   authorized one.** v2 classifies the caller as old/next/neither but permits
   recovery only when both journal endpoints “belong to” the caller's stream
   (`docs/design/138-reset-path-hardening.md:80-90`). A reset journal
   deliberately records `old.stream !== next.stream`
   (`src/cli/reset-journal.ts:383-390`), so equality with one caller stream can
   never satisfy that rule. If “belong” instead means authorized provenance,
   the exact v1 schema contains no consent/version witness
   (`src/cli/reset-journal.ts:40-59,100-138`); a valid pre-hardening v1 journal
   and a newly authorized journal are observationally identical after a crash.
   Moreover, init resets before saving the next config
   (`src/cli/init-cmd.ts:181-212`), so an authorized crash can leave
   config=old/journal.next=different—the same shape the prose calls poisoned.
   Define a durable, versioned authorization fact, legacy-v1 policy, and exact
   old-config/next-config recovery outcomes before claiming behavior-pinned
   recovery.

4. **CRITICAL — `phase × (old|next|neither)` is not a complete classifier over
   the recovery states the code can produce.** `prepared` can have partial
   candidate/archive/recovery-ref creation before the ready phase write
   (`src/cli/reset-journal.ts:272-285`). `ready` can mean active-old with a
   candidate, or active-next with no candidate after rename but before the
   installed phase write (`:288-302`). `installed` can have an absent, old, or
   new incarnation marker and Z retired for only some common-dir groups
   (`:305-322`). The matrix at
   `docs/design/138-reset-path-hardening.md:80-90,163-165` has no axes for active
   absent/malformed/exact-old/exact-next/other, same-stream wrong nonce/hash,
   candidate/archive/marker presence and hash, or per-group Z disposition. The
   omission of the marker also reintroduces a journal-phase form of the lineage
   ambiguity fixed for the standalone f3 path. Specify the physical-state table
   with exact hashes/nonces and the read-only observations allowed for every
   crash subphase; stream labels alone cannot prove safe recovery or zero-write
   halt.

5. **CRITICAL — the 2 GiB plan is still not a bounded-memory reset protocol at
   the actual initiation sites.** Streaming the hash/equality/copy cluster in
   `reset-journal.ts` is feasible, but reset initiation still retains a full
   `Buffer`, creates a UTF-8 string and parsed object, and carries full bytes
   through artifact preparation (`src/cli/config.ts:799-803,1009-1014,
   1044-1063,1084-1096`). The constrained test covers only 512 MiB recovery
   (`docs/design/138-reset-path-hardening.md:109-112`), not this higher-peak
   initiation path; saying ordinary daemon load already parses JSON does not
   account for the extra retained buffer. Reset preparation also reloads through
   uncapped `loadRawState` at `config.ts:906,958`, whose implementation is a raw
   `fs.readFile(..., "utf8")` at `:362-365`, outside the read list at design
   `:102-103`. Finally, permitted whole-file reads need the same hard byte
   counter and pathname/open-handle identity checks as streaming reads; a
   pre-stat plus `readFile` does not enforce the cap during in-place growth or
   rename replacement. Add constrained reset-initiation coverage and cap every
   reset-preparation reload, or choose a lower proven whole-parse ceiling.

6. **CRITICAL — the named daemon seams do not actually enforce a mid-run halt
   or define startup recovery.** The proposed pre-op check at `daemon.ts:829`
   is `this.syncBase ?? await this.loadSyncBase()`
   (`src/cli/daemon/daemon.ts:827-835`); startup populates `syncBase`, so a
   journal appearing later bypasses that check. Full/deep scans then need not
   call `loadState` at all, while pull/push discover a halt only in later
   op-specific code. Require an unconditional read-only journal classification
   at every op boundary after acquiring the sync mutex and before any scan,
   pull, or push work. At startup, handling only `runDaemon`'s preload is also
   insufficient: `RboxDaemon.start()` loads again, dereferences the state to
   seed manifest/sequence/matcher, scans, pumps, and arms watcher/WS/timers
   (`:437-478`). Define an explicit
   `halted -> recovering -> bootstrapping -> ready` state machine, what remains
   live while halted, and an exactly-once healing transition. Test a poisoned
   startup, a poison inserted with cached `syncBase`, and successful hourly
   recovery without duplicate watchers/timers or pre-heal mutation.

7. **HIGH — `RecoveryHalt` has no coherent result, persistence, or status
   ownership contract.** v2 says it is a typed result rather than an exception
   and flows through `loadState` callers, but only specifies startup, one pump
   seam, and status (`docs/design/138-reset-path-hardening.md:123-138`); the other
   inventoried callers still require `SyncState`. Status cannot simply replace
   the first load with the health side-file: attribution, scans, JSON, and text
   rendering dereference state throughout
   `src/cli/status-cmd.ts:280-405,500-623`. It needs a defined early degraded
   text/JSON result that performs no state-dependent scan or remote work. There
   is also a direct contradiction between foreign/ambiguous classification's
   zero-write snapshot (`docs/design/138-reset-path-hardening.md:86-90,163-165`)
   and persisting a halt file under `.rbox/state` (`:131-133`). Keep the
   classifier pure and name the callers allowed to persist health (or explicitly
   narrow the zero-write guarantee), then define durable clearing only after
   successful recovery/quarantine and behavior for a stale record after journal
   disappearance. Add direct-CLI/daemon races and restart-after-heal tests.

8. **CRITICAL — the quarantine bundle is neither atomic nor phase-coherent, and
   its advertised restore can overwrite later state.** Journal, candidate, and
   archive live at separate paths (`src/cli/reset-journal.ts:83-86`), so they
   cannot be moved “as one bundle” by one atomic rename
   (`docs/design/138-reset-path-hardening.md:146-150`). The transaction also
   includes active state, the incarnation marker, recovery/active Z refs across
   external Git common dirs, and their phase dispositions
   (`src/cli/reset-journal.ts:196-219,288-327,341-355`). A warning for installed
   phase is not an eligibility or commit protocol. If sync advances after
   quarantine, restoring an installed journal lets recovery replace non-exact
   active state with genesis bytes (`:305-310`). Moving the old archive is also
   semantically destructive: that archive is durable rebind provenance consumed
   by `hasResetLineageArchive` (`src/cli/config.ts:331-345,727-733`), not merely a
   transient journal artifact. Specify a crash-recoverable quarantine manifest
   and rename/commit order, phase-specific eligibility, exact active/marker/ref
   preconditions for restore, and whether durable archives are copied rather
   than removed. Malformed metadata also needs a bounded policy because it
   cannot safely identify the referenced candidate/archive.

9. **HIGH — the proposed “protected” destination is currently ordinary,
   deletable trash.** `pruneTrash` enumerates every directory under
   `.rbox/trash` and removes eligible unmarked batches for age, size pressure,
   and `trash empty` (`src/engine/trash.ts:109-185`). A name such as
   `reset-quarantine-<ts>` receives no protection. Put forensic bundles in a
   structurally excluded namespace (preferably outside `TRASH_REL`) or specify
   and test an explicit exclusion. Required tests must prove survival under age
   pruning, cap pruning, and `rbox trash empty`, not only immediate quarantine
   and restore.

### Required design changes before implementation

1. Define two-stage create-new consent and a lock/CAS protocol that makes the
   capability's lineage recheck atomic with every reset-side mutation.
2. Version durable reset authorization and replace the 5-by-3 classifier with a
   physical crash-state table covering state, marker, candidate, archive, and Z
   dispositions.
3. Bound reset initiation as well as recovery, including every `loadRawState`
   reload and a constrained-memory initiation test.
4. Specify the daemon halt/heal state machine and a state-independent degraded
   status/JSON path, with one owner and clearing rule for persisted health.
5. Define a crash-recoverable, phase-aware quarantine/restore transaction whose
   storage is excluded from all ordinary trash retention.

## Round 3 — v3 control-flow verification

**Verdict: CHANGES-REQUIRED.** Round-2 f3, f7, and f9 are genuinely closed:
the v2 journal distinguishes newly authorized resets from legacy v1, classifier
and daemon health ownership are separated, and quarantine is outside every
ordinary trash-pruning path. The unconditional pump-op boundary also closes the
warm-`syncBase` bypass if applied literally before all four operation branches.
The remaining findings change the protocol or APIs the implementer must build:
f1 reopens in finding 1, f2 in finding 2, f4 in finding 3, f5 in finding 4,
f6 in finding 5, and f8 in findings 6-8.

### Findings

1. **CRITICAL — the Stage-A create witness still does not bind the exact
   consented destination.** The witness's `create-new` intent contains no
   destination coordinates (`docs/design/138-reset-path-hardening.md:25-34`),
   but the stream is composed from `remoteUrl`, `remoteWorkspaceId`, and
   `projectId` (`src/cli/config.ts:618-622`), and the create helper accepts the
   remote URL and project independently of the returned workspace id
   (`src/cli/remote/api.ts:211-224`). Consequently, “the id came from a create
   call made under this witness” still permits the same witness to stamp a POST
   to a substituted remote or project. This affects existing-workspace consent
   too: binding only the workspace id does not bind the full intended stream.
   Stage A must bind every already-known next-stream coordinate (at least the
   canonical remote URL and project); Stage B may narrow only the previously
   unknowable server-assigned workspace id, and the create helper must verify
   its call arguments against those bindings.

2. **CRITICAL — the fenced recheck cannot be implemented by holding the named
   state lock across the existing preparation helpers.** v3 requires
   `state.json.lock` from the lineage recheck through checkout recovery, P/A
   settlement, and journal publication
   (`docs/design/138-reset-path-hardening.md:50-60`). Today preparation first
   acquires common-directory operation locks (`src/cli/config.ts:827-982`),
   while P settlement and P repair acquire the state protocol class and call
   `applyStateSavePacket` (`src/cli/sync-git/p-settlement.ts:146-153`;
   `src/cli/sync-git/p-repair-state.ts:95-105,171-181`), which itself acquires
   `state.json.lock` (`src/cli/config.ts:500-570`). Acquiring state first would
   invert the repository protocol-lock order and then re-enter the same state
   lock; the legacy-lineage migration also currently performs a state CAS before
   preparation (`src/cli/config.ts:1069-1085`). “Reorder it or document it” is
   therefore not a complete protocol. Specify the concrete canonical lock
   acquisition and held-lock-aware CAS/preparation APIs: acquire every required
   earlier Git/protocol fence before state, perform the witness recheck under
   the complete fence, and use non-reacquiring state mutations while holding it
   through journal publication (or define an equally precise gap-free CAS
   scheme).

3. **CRITICAL — the claimed expected-signature table is still prose axes, not
   the crash-state rows `reset-journal.ts` can produce.** The design names
   per-artifact dispositions and gives one `ready` example
   (`docs/design/138-reset-path-hardening.md:82-98`), but recovery refs and active
   Z refs are different axes with different atomicity. In `prepared`, candidate
   and archive copies occur in order, then recovery refs are created one entry
   at a time (`src/cli/reset-journal.ts:272-285,196-205`), so a crash can leave a
   prefix/mixed subset of recovery refs even within one common directory. In
   `installed`, active refs retire atomically per common-directory group but
   groups can be partially retired (`src/cli/reset-journal.ts:208-219,305-322`).
   A single group disposition of `retired | pending | other` cannot represent
   both transitions, and independent per-axis allow sets would admit impossible
   cross-products (for example, archive present while candidate is absent in
   `prepared`). The implementation needs an explicit correlated row/dependency
   table for every write boundary: separate recovery-ref and active-ref
   dispositions, prefix/group atomicity, and the legal marker states (ordinary
   state CAS removes the marker at `src/cli/config.ts:563-568`). Otherwise the
   safety-critical allow set is still left to the implementer.

4. **CRITICAL — a 512 MiB initiation test does not make a 2 GiB whole-parse
   ceiling memory-safe.** v3 keeps the 2 GiB cap while retaining whole-file
   materialization wherever JSON parsing is required, and validates initiation
   only with a 512 MiB state
   (`docs/design/138-reset-path-hardening.md:108-118,207-210`). The cap bounds
   bytes read, but not the simultaneous `Buffer`, UTF-8 string, parsed object,
   and preparation state that made Round-2 f5 critical; “not a buffering
   license” does not alter those allocations. A peak-RSS threshold at one
   quarter of the accepted maximum does not prove the maximum survivable.
   Define a separately justified whole-materialization ceiling (the streaming
   copy/hash ceiling may remain larger), or validate the actual maximum under a
   stated process-memory budget and fail before allocation when that budget is
   unavailable.

5. **CRITICAL — successful journal recovery does not imply the daemon may
   bootstrap with its cached binding.** v3 says `config=old` is eligible and
   rolls the reset forward, then makes recovery success transition
   unconditionally through bootstrapping to ready
   (`docs/design/138-reset-path-hardening.md:99-101,128-137`). Init performs the
   reset before saving the next config (`src/cli/init-cmd.ts:188-212`), so a
   crash can leave a recoverable journal and old durable config; after recovery,
   active state is next while config remains old. A live daemon can likewise
   retain its boot-time authenticated `cfg` across an external rebind. Reusing
   `RboxDaemon.start()` seeding with that old remote is unsafe. Before
   bootstrapping, under the operation fence, require agreement among the
   daemon's boot stream, a freshly loaded durable config stream, and the
   recovered active-state stream/nonce. On disagreement, remain halted awaiting
   completion of the rebind or stop for a clean restart; do not enter `ready`.
   The direct startup scan at `src/cli/daemon/daemon.ts:454-471` must also remain
   inside the design's universal pre-scan boundary, not merely the pump-loop
   check at `:812-882`.

6. **CRITICAL — quarantine and restore still have no mutual-exclusion protocol
   with recovery, daemon writes, or Git ref mutation.** The F2c steps
   (`docs/design/138-reset-path-hardening.md:158-189`) never require the
   non-degraded workspace mutex, sorted common-directory operation locks, state
   lock, or an under-lock reclassification. Recovery holds the Git operation
   locks and state lock while it can advance phase, rename the candidate, write
   the marker, and retire refs (`src/cli/reset-journal.ts:259-355`). Doctor can
   therefore classify/copy `ready+old`, race recovery to `installed`, then
   commit and remove the live journal. Restore's active-hash/marker/ref checks
   have the same TOCTOU against a ready daemon. Specify the canonical recovery
   fence (or equivalent CAS), reclassify all eligibility/preconditions under it,
   and hold it through the quarantine removal or restore publication point.

7. **CRITICAL — the quarantine commit boundary is not yet durable or isolated
   from a subsequent reset.** Step 3 fsyncs copied artifacts, but step 5 only
   says to write `COMMITTED` before unlinking the journal
   (`docs/design/138-reset-path-hardening.md:174-181`). The marker and bundle
   directory must themselves be atomically persisted and fsynced before the
   journal unlink and its parent-directory fsync; otherwise reboot can yield
   journal-gone/marker-gone and the specified partial-bundle cleanup destroys
   the only complete copy. Resume must remove a canonical original only when it
   is absent or still manifest-exact, never a replacement. Finally, recovery
   refs are deterministic from old lineage/target
   (`src/cli/reset-journal.ts:120,196-205`). If a crash occurs after journal
   removal but before step 7, a new reset from the same lineage can reuse those
   refs; later resuming the old bundle could delete refs now owned by the new
   journal. The assertion that all remaining originals are inert is false.
   Keep a durable cleanup fence that reset initiation honors, change the removal
   order/protocol, or leave shared deterministic refs in place.

8. **CRITICAL — restore has preconditions but no crash-resumable publication
   protocol.** “Restore copies back, verifies, then removes the bundle”
   (`docs/design/138-reset-path-hardening.md:183-189`) permits publishing the
   journal before its candidate/refs and crashing, which exposes an intentionally
   invalid physical signature; retry then fails the stated “no journal”
   precondition. The precondition list also omits absent-or-manifest-exact checks
   for every non-journal destination, so retry cannot distinguish its own partial
   restore from a foreign replacement. Under the finding-6 fences, restore must
   revalidate bundle hashes and destinations, copy/fsync/verify all inert
   artifacts first, atomically publish the journal last, and define idempotent
   handling of exact already-restored or already-recovered states before bundle
   removal. It must also require a durable config stream eligible for that
   journal (old or next), not only an unchanged active-state hash.

### Required design changes before implementation

1. Bind both witness stages to the complete intended stream and replace the
   current preparation call graph with a canonical, non-reentrant fenced CAS
   protocol.
2. Write the actual correlated physical-signature rows, separating recovery-ref
   creation from active-ref retirement, and justify whole-parse memory at its
   real accepted maximum.
3. Gate daemon bootstrap on fresh config/state/boot-binding agreement after
   recovery.
4. Define quarantine and restore as fenced, durably committed, idempotently
   resumable transactions, including pending-cleanup isolation and journal-last
   restore publication.

## Round 4 — v4 ruling verification

**Verdict: CHANGES-REQUIRED.** Round-3 f5, f6, and f8 are now closed: the
daemon cannot pass recovery into startup seeding unless its boot stream, a
fresh durable-config stream, and the recovered state agree; quarantine and
restore reclassify while holding the recovery fence; and restore publishes the
journal last after its inert artifacts. The destination coordinates required by
Round-3 f1 are present, but the create-new witness is not mintable at the named
prompt under the current setup order (finding 1). Round-3 f2, f3, f4, and f7
remain open in findings 2-5. These are implementation-shaping protocol gaps.

### Findings

1. **HIGH — the create-new Stage-A value is not available at the confirmation
   boundary v4 names.** The witness is minted at the rebind confirmation and its
   `create-new` intent includes `name`; the create helper must verify its call
   arguments against those bindings
   (`docs/design/138-reset-path-hardening.md:27-35`). In the actual setup flow,
   however, the confirmation runs at `src/cli/setup-cmd.ts:457-472` and the
   workspace-name prompt does not run until `:475-488`. The later name therefore
   cannot equal a value captured by the witness at mint time (except by leaving
   an unbound/mutable slot, which defeats the stated immutable argument check).
   Move the name prompt before the consequence confirmation, mint a second
   non-authorizing metadata value after confirmation, or remove `name` from the
   security binding and say explicitly that the helper checks only the complete
   stream-selecting tuple. Keep `remoteUrl` and `projectId` immutable through the
   POST and Stage-B narrowing either way.

2. **CRITICAL — the enumerated “complete fence” still acquires `state` before
   lower lock classes that P settlement must acquire.** v4's order is workspace
   mutex → all common-directory `operation` locks → `state`, and it moves P/A
   settlement inside that fence
   (`docs/design/138-reset-path-hardening.md:58-71`). But the repository order is
   `operation(3) → reflog(4) → origin(5) → git(6) → ... → state(10)`
   (`src/engine/git/protocol-locks.ts:8-19`). Exact-P settlement enters
   `withRepoProtocolLocks` and then `runPreparedUpdateRefTransaction` before its
   state CAS (`src/cli/sync-git/p-settlement.ts:92-100,146-152`), while P repair
   similarly holds operation/reflog/origin and enters a prepared Git transaction
   before CAS (`src/engine/git/p-repair-transaction.ts:375-398,408-411`). Calling
   either after the proposed outer state acquisition produces `state → reflog`
   or `state → git` inversion; making only `applyStateSavePacket` held-lock-aware
   fixes the final state-lock re-entry but not those earlier acquisitions.
   Specify held-lock-aware preparation APIs and the complete pre-state lock set
   (including canonical identities/order for every reflog/origin/Git lock), or a
   different gap-free protocol that performs no reset-side mutation before the
   fenced witness recheck. Add a protocol-lock trace test for exact settlement
   and moved-P repair, not only the nonce barrier snapshot.

3. **CRITICAL — v4 still does not contain the correlated physical-signature
   rows it says the implementation will use.** The entire “table” is prose
   listing axes plus two constraints
   (`docs/design/138-reset-path-hardening.md:93-112`); there are no rows keyed by
   the actual writes. The current recovery has distinct durable windows after
   candidate creation, archive creation, each recovery-ref update, the `ready`
   phase write, candidate→active rename, the `installed` phase write, state
   repair, marker write, each common-directory active-ref retirement, and the
   `z-retired` phase write (`src/cli/reset-journal.ts:272-335`). Those windows
   also differ on whether candidate absence is a legal post-rename state and
   whether the marker may be absent because an ordinary state CAS removed it.
   Saying that a future “design table enumerates” them leaves the safety-critical
   allow set to the implementer—the exact defect Round-3 f3 required the design
   to close. Put the concrete correlated rows (or an executable equivalent with
   the same reviewable dependencies) in the design before implementation.

4. **CRITICAL — 512 MiB is asserted, not justified, and the proposed admission
   check cannot prove parse memory from byte length.** v4 never states the
   process-memory budget promised by its test or the exact budget formula; it
   only estimates buffer + UTF-8 string + parsed object at “~3-4× file size”
   (`docs/design/138-reset-path-hardening.md:131-140`). `JSON.parse` runs before
   schema validation, so a file containing very many small arrays/objects can
   have parsed-heap expansion well above that multiplier even if it is later
   rejected. Current reset initiation additionally keeps state structures alive
   while preparation discovers and settles repositories. A pre-allocation check
   based on file size and a 3-4× estimate can therefore admit a 512 MiB input
   that exceeds the heap/RSS budget; one passing fixture at the ceiling does not
   bound hostile or worst-shape JSON. Define the actual runtime budget,
   heap/external-memory/headroom calculation, and a defensible worst-case parser
   bound, or use a structurally bounded/streaming validator before whole parse
   and lower the materialization ceiling accordingly. Test the maximum-expansion
   accepted shape as well as the ordinary 512 MiB fixture.

5. **CRITICAL — `COMMITTED` is fsynced but is not specified as an atomic,
   self-validating commit record, and `manifest.json` data is not explicitly
   synced.** The protocol writes the manifest, fsyncs copied artifacts, then
   says “write `COMMITTED`, fsync it” and later decides recovery solely from
   `COMMITTED` presence (`docs/design/138-reset-path-hardening.md:211-226`). A
   crash during that write can leave a present but partial marker; a crash after
   directory fsync but without a manifest-file fsync can leave a durable marker
   naming missing/corrupt manifest contents. Resume would then take the committed
   branch and may remove the canonical journal even though no independently
   verifiable bundle was committed. Publish an exact/versioned commit record by
   temp-file write + file fsync + atomic rename + directory/parent fsync, fsync
   the manifest file itself, and treat only a valid marker whose manifest hash
   matches a fully reverified bundle as committed. Add crashes during marker
   write/rename and manifest persistence to the step-boundary matrix.

### Required design changes before implementation

1. Reconcile Stage-A's immutable fields with the actual setup prompt order.
2. Extend the reset fence across all lower P-settlement/P-repair lock classes,
   then use held-lock-aware state operations through journal publication.
3. Supply the actual correlated crash rows and a real worst-case memory budget
   for the 512 MiB whole-parse ceiling.
4. Make the quarantine commit record and its manifest atomically durable and
   self-validating before journal removal.

## Round 5 — v5 ruling verification

**Verdict: CHANGES-REQUIRED.** Round-4 finding 1 is closed: `name` is now
explicitly display-only, while the create witness binds and verifies the full
stream-selecting tuple available at confirmation. The complete F1b lock-order
protocol and held-lock-aware preparation APIs close the original local
`state -> reflog/Git` inversion, but an older incompatible definition remains
in F2c (finding 1). The concrete F1c allow rows now cover every write boundary
in `reset-journal.ts`, including prefix recovery refs, group-atomic active-ref
retirement, `R2`, and the intentionally duplicate `I0`/`I1` observation. The
embedded ready-row recovery action is not safe for one of the physical states
that `R2` represents (finding 2). Round-4 findings 4 and 5 remain open in
findings 3 and 4. These are implementation-shaping durability and resource
bounds, so the design is not yet aligned.

### Findings

1. **CRITICAL — F2c still redefines the “same canonical recovery fence” with
   the old, inverted lock set.** F1b now correctly requires the complete
   repository order `operation -> reflog -> origin -> git -> ... -> state`,
   canonical identity ordering, held-lock-aware preparation APIs, and trace
   coverage (`docs/design/138-reset-path-hardening.md:62-81`). But quarantine
   and restore still say they acquire the SAME fence as recovery and then spell
   it as `workspace sync mutex -> sorted common-directory operation locks ->
   state lock` (`:350-353`). Recovery creates recovery refs and retires active
   refs through Git (`src/cli/reset-journal.ts:196-219,281,321`); taking the
   latter definition literally reacquires Git after state. Make every reference
   to the canonical recovery/quarantine/restore fence name the complete F1b
   class-swept fence (or define a separately named, proven read-only subset
   where no lower-class operation can follow). The trace tests must exercise
   the fence used by recovery and both doctor transactions, not only the F1b
   reset-initiation path.

2. **CRITICAL — the embedded `R1`/`R2` actions are not safe for rename-source
   resurrection, and the two-parent fsync order is unspecified.** The design
   correctly recognizes that a cross-parent rename can leave `ready + active N
   + candidate N` (`R2`) after power loss (`docs/design/138-reset-path-hardening.md:190-191,241-246`),
   but its action is another candidate-to-active rename. If the resurrected
   candidate and active names resolve to the same inode, POSIX rename succeeds
   as a no-op and leaves both names present; writing `installed` then produces
   an unlisted `installed + candidate N` signature and the strict classifier
   halts on its own output. `R1` should proceed directly to the installed-phase
   write. `R2` must durably unlink the redundant exact candidate (candidate
   parent fsync) and then write `installed`, an action safe whether the two
   names share an inode or not. Also require destination/active-parent fsync
   before source/candidate-parent fsync after the original rename: the
   intermediate crash state is then the listed `R1` or `R2`; the opposite order
   can make source absence durable before destination replacement and produce
   unlisted `ready + active O + candidate absent`. Pin both intermediate fsync
   boundaries in the crash matrix.

3. **CRITICAL — `M = 6` is still an estimate, not a parser bound, and
   `availableBudget` has no live-headroom definition.** The new formula
   (`docs/design/138-reset-path-hardening.md:275-288`) adds an explicit nominal
   budget, but `JSON.parse` still runs before schema rejection, so invalid or
   corrupt small-node JSON is not bounded by the claimed 2-3x object-graph
   factor. A local Node check parsing a 6,000,001-byte array of two million
   empty objects consumed about 134,000,064 bytes of additional heap (22.3x)
   and 232,763,392 bytes of RSS (38.8x), before accounting for the input buffer
   and decoded string. A pinned ordinary-shape benchmark cannot make 6x a
   worst-case admission bound. Additionally, the design switches from `B` to
   `availableBudget` without defining subtraction of live heap, external/RSS
   use, runtime heap limit, and required reserve. Add a structurally bounded
   streaming prevalidator before whole parse (or provide a defensible maximum-
   expansion bound and corresponding lower ceiling), define the live-headroom
   calculation, and test the maximum-expansion admitted shape under the
   enforced budget.

4. **CRITICAL — the commit record is now atomic and self-validating, but its
   manifest is still not explicitly durable before that record.** F2c creates
   `manifest.json`, fsyncs “every copy,” verifies the bundle, then atomically
   publishes the commit record (`docs/design/138-reset-path-hardening.md:358-366`).
   The manifest is not an artifact copy, and neither bundle-directory fsync nor
   a record containing its hash makes the manifest file's data durable. A crash
   can therefore retain a valid durable commit record while losing/corrupting
   the manifest; after step 6 has removed the canonical journal, treating that
   bundle as “no commit” cannot restore the stated originals-intact invariant.
   Finalize `manifest.json` by temp write, file fsync, atomic rename, and bundle-
   directory fsync before publishing the commit record. Add explicit crash
   boundaries after manifest write/fsync/rename and during commit-record
   write/rename; resume may remove the canonical journal only after the full
   record-to-manifest-to-artifact verification succeeds.

### Required design changes before implementation

1. Use one complete repository-order recovery fence everywhere it is named.
2. Replace the embedded `R1`/`R2` actions with direct install / durable
   redundant-candidate unlink, and specify/test destination-then-source fsync.
3. Bound parser expansion with structural admission plus a live-headroom
   formula, rather than the unproven 6x multiplier alone.
4. Durably publish `manifest.json` before the self-validating commit record.

## Round 6 — v6 ruling verification

**Verdict: CHANGES-REQUIRED.** Round-5 finding 1 is closed: F2c now names
the complete F1b repository-order fence, including canonical common-directory
ordering and `state` last, and explicitly supersedes the old shorthand
(`docs/design/138-reset-path-hardening.md:359-368`). Finding 4 is also closed:
`manifest.json` is file-fsynced before the commit record, and the record's
publication then fsyncs the bundle directory and its parent before any original
is removed (`:369-390`). A crash before publication becomes durable still has
the originals-intact/no-commit recovery path. Findings 2 and 3 remain open in
the normative recovery actions and parser admission rule below. Both change the
implementation, so the design is not yet aligned.

### Findings

1. **CRITICAL — the normative `R1`/`R2` row actions still specify the unsafe
   recovery sequence that Round 5 rejected.** The design says the table is
   amended (`docs/design/138-reset-path-hardening.md:250-255`), but the table
   remains normative and still directs `R1` to re-create the candidate and
   rename/install, and `R2` to rename the candidate over active before writing
   `installed` (`:181-191`). That can preserve the resurrected source name and
   let recovery publish an unlisted `installed + candidate N` state. Amend the
   rows themselves: `R1` proceeds directly to the installed-phase write; `R2`
   verifies and durably unlinks the exact redundant candidate, fsyncs the
   source parent, then writes `installed`. Specify destination-parent fsync
   before source unlink/source-parent fsync, and pin both intermediate crash
   boundaries in the matrix.

2. **CRITICAL — `M = 24` is still not a defensible maximum-expansion bound,
   and `availableBudget` remains undefined.** F2 mandates measuring a
   “representative state-shaped document” and defaults to 24x
   (`docs/design/138-reset-path-hardening.md:282-297`), but Round 5 already
   documented an admitted small-node shape at 38.8x RSS. A representative-shape
   benchmark cannot bound corrupt or adversarial JSON that reaches
   `JSON.parse`, and the design still does not say how `availableBudget`
   subtracts live heap, external/RSS use, the runtime heap limit, and required
   reserve from `B`. Add structural streaming admission before whole parse, or
   derive and enforce a maximum-expansion multiplier with a corresponding
   ceiling; define the live-headroom formula and test the maximum-expansion
   admitted shape under the enforced budget.

### Required design changes before implementation

1. Replace the normative `R1`/`R2` actions and pin destination-first/source-
   second durability crash boundaries.
2. Make whole-parse admission a worst-case bound with an explicit live-
   headroom calculation and maximum-shape test.

## Round 7 — v7 closure verification

**Verdict: CHANGES-REQUIRED.** The new text moves both Round-6 residuals in
the right direction, but neither is closed by the normative contract. The
version label still says v6 (`docs/design/138-reset-path-hardening.md:3`), which
is editorial; the row ordering and parse-admission ambiguity below change the
implementation and are not.

### Findings

1. **CRITICAL — the normative `R1`/`R2` actions still permit publishing an
   unlisted `installed + candidate N` signature.** `R1` says to proceed to the
   installed-phase write and *then* durably unlink/fsync a resurrected source
   (`docs/design/138-reset-path-hardening.md:190`); source-parent durability
   must precede the installed-phase publication. `R2` still prescribes another
   candidate-to-active rename (`:191`) rather than treating active `N` as
   already installed and durably removing the exact redundant candidate. In
   particular, rename may be a no-op when the two names resolve to the same
   inode. The later unlink can make that alternative safe only if the row
   unambiguously requires, before writing `installed`: revalidate active and
   candidate as exact `N`, fsync the destination parent, unlink the candidate
   (absent is success), and fsync the source parent. Pin crashes after the
   destination fsync and after the source unlink/fsync. The prose claim that
   the rows were amended (`:250-255`) cannot override their current ordering.

2. **CRITICAL — measured representative expansion times two is not the
   maximum-expansion admission bound Round 6 required.** F2 measures a
   state-shaped, real-manifest-like document and applies a 2x safety factor
   (`docs/design/138-reset-path-hardening.md:285-295`), but every byte-bounded
   syntactically valid input can still reach `JSON.parse`; the design neither
   structurally excludes higher-expansion shapes nor establishes the benchmark
   corpus as the maximum admitted shape. CI remeasurement therefore detects
   drift only for that corpus, not violation of a worst-case bound. The formulas
   are also internally inconsistent: the normative check first uses
   `measuredM x 2` against `B - currentRSS` (`:288-291`), the parse ceiling uses
   `B` rather than live headroom (`:292-293`), and the next sentence checks only
   `M` against `availableBudget` (`:296-297`). Specify one enforced formula and
   either structural streaming admission plus its maximum-shape test, or a
   defensible maximum multiplier over every shape admitted to whole parsing.

### Required design changes before implementation

1. Make source-name absence durable before `installed` publication in both
   normative rows, with explicit intermediate crash cases.
2. Replace representative-corpus sizing with an enforced maximum-expansion
   admission rule and one consistent `B - currentRSS` formula.

## Round 8 — v8 closure verification

**Verdict: CHANGES-REQUIRED.** Round-7 finding 1 is closed: both normative
`R1` and `R2` actions now require destination durability, source unlink, and
source-parent fsync before the `installed` phase may be published
(`docs/design/138-reset-path-hardening.md:190-191`). The earlier R1 phrase
“proceed to installed-phase write” is editorially awkward, but the explicit
“only AFTER” gate controls the ordering, and crashes on either side of source
durability remain the listed `R2`/`R1` signatures. Round-7 finding 2 remains
open for the admitted input set below.

### Findings

1. **CRITICAL — the measured corpus still does not bound every document
   admitted to whole parsing.** The sole runtime gate is now consistently
   identified as the dynamic byte/headroom check, with 512MiB correctly
   separated as a UX cap (`docs/design/138-reset-path-hardening.md:288-294`).
   But the benchmark covers the worst *schema-legal* small-node state at the
   maximum admitted size (`:295-299`), while no bounded structural/schema gate
   runs before `JSON.parse`. Therefore a byte-bounded, syntactically valid but
   schema-invalid document is still admitted to whole parsing without being
   covered by the measured multiplier; such a shape may expand more than the
   smallest legal state nodes. This does not satisfy Round 7's requirement to
   bound every shape admitted to whole parsing. Add bounded structural
   admission that excludes nonconforming shapes before whole parse, or derive
   and test the maximum multiplier over all syntactically valid shapes that can
   reach `JSON.parse`.

   Separately, the final shorthand `fileSize × M ≤ availableBudget`
   (`:300-302`) should say `fileSize × (measuredM × 2) ≤ B − currentRSS`, or
   define `M` as that safety-adjusted multiplier. Because `:291-294` explicitly
   declares the latter formula THE authoritative gate, this is editorial
   residue rather than a second blocker.

### Required design change before implementation

1. Make the measured maximum cover every shape admitted to `JSON.parse`, either
   by pre-parse bounded structural admission or by benchmarking/proving the
   maximum over the full syntactically valid admitted set.

## Round 9 — v9 closure verification

**Verdict: CHANGES-REQUIRED.** Round 8's admitted-set mismatch is addressed in
intent: the benchmark is now explicitly selected from the full JSON grammar,
not merely schema-legal states, and deep-nesting `RangeError` is mapped to the
typed corruption error with a mandated test
(`docs/design/138-reset-path-hardening.md:294-303`). However, the claimed
worst-case shape is not established, so the maximum-expansion bound remains
open.

### Findings

1. **CRITICAL — maximum node density does not establish maximum heap expansion
   per input byte.** The design names `[0,0,0,...]` as “the maximum
   node-per-byte shape the JSON grammar permits” and concludes that its measured
   multiplier covers any input passing the byte gate
   (`docs/design/138-reset-path-hardening.md:294-303`). That conclusion does not
   follow: JSON values have different runtime representations and per-node
   allocation costs. For example, floods of minimal empty objects or arrays may
   consume more heap per source byte than packed numeric array elements despite
   having lower node density. The design supplies neither a proof of the
   numeric-flood maximum nor a comparative adversarial corpus and conservative
   maximum covering the other grammar families. The deep-nesting error mapping
   gives correct failure semantics for one pathological family but does not
   bound the heap consumed by successfully parsed container-heavy shapes.

   Benchmark/prove the maximum expansion across all admitted JSON grammar
   families (including minimal primitive, string, object, array, and
   mixed/nested container floods), then pin the conservative maximum, or add a
   bounded pre-parse structural admission rule whose accepted shapes have a
   demonstrated maximum.

The final `fileSize x M` shorthand remains editorial because the preceding text
declares `fileSize x (measuredM x 2) <= B - currentRSS` authoritative. The
document's `v8` header is likewise editorial version residue.

### Required design change before implementation

1. Establish rather than assert the maximum-expansion multiplier over every
   JSON shape admitted to `JSON.parse`, and test the shape(s) that realize the
   conservative bound at the effective ceiling.
