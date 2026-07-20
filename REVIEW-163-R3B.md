# Design 163 adversarial review — round 3B

## Verdict: CHANGES-REQUIRED

V3 closes the r2 tracked-path and pull/push outcome omissions, gives the common
M0–M7 success path durable high-water records, and confines all implementation
to `2.0`. It is still not a closed implementation specification under this
review's lenses. The current apply-receipt oracle has a manifest-sized proof
peak for which `ApplyPlanPort` supplies no executable cursor/admission contract;
the wire estimator proves retained size rather than construction peak; migration
source invalidation and M6 cleanup produce states that the claimed exhaustive
correlations cannot represent; and U0's terminal API cannot perform the
owner-loss cleanup it promises or exclude settled-but-unapplied worker results
from publication.

## Findings

1. **MAJOR — The scoped apply-receipt oracle is still a manifest-sized access
   path with only a label, not an explicit bounded adapter contract.**

   The real engine path starts from JSON-backed manifests in both
   `oracleFromPull` and `oracleFromState` (`src/engine/apply-receipt.ts:715-763`).
   On first use it retains three complete path maps plus the touched set
   (`:341-348,414-423`), projects three complete repo-subtree arrays and another
   set (`:426-444`), builds receiver-equivalence grouping maps (`:245-258`), and
   accumulates a complete subtree inventory and two token maps (`:565-609`). Its
   fallback accumulates a complete scanned `FileEntry[]` plus both token maps
   (`:624-641,639-707`). Finally, `canonicalReceipt` sorts complete expected and
   observed arrays and `JSON.stringify`s the complete proof (`:157-162`). For a
   workspace-sized root repository, each of those is N-sized.

   V3 assigns “apply/preflight/receipt/oracle” to `ApplyPlanPort`, but the only
   numeric contract is 512 actions/8 MiB, an oversize action, body streaming,
   and the phrase “proof scratch plan-backed”
   (`docs/design/163-state-plane-sqlite.md:1109-1112`). The earlier assertion
   that receipts and collision indexes live in the plan DB (`:889-896`) does
   not specify an oracle snapshot binding, scoped-scan sink, filesystem-token
   table, receiver-equivalence join, receipt-hash stream, number of simultaneous
   pages, or failure behavior after Git has consumed a prior proof. Action-row
   admission does not bound any of those proof collections. This is precisely
   an adapter whose peak remains implicit despite the claim that every current
   whole-manifest access has one explicit budget (`:1098-1101`).

   Specify a named receipt/oracle port (or a complete sub-contract of
   `ApplyPlanPort`) that stages projected expected/oracle/observed rows and
   tokens, performs bounded equivalence joins and a streaming canonical receipt
   hash, states its simultaneous cursor windows, and defines retry/indeterminate
   semantics. Merely banning the current maps at import time does not define
   their replacement.

2. **MAJOR — `WireAllocationLedger` admits final retained size, not the peak
   needed to construct it, so its advertised allowance is not a hard admission
   budget.**

   `RetainedEstimateV1` assigns constants to the final graph and planned final
   map/set entries (`docs/design/163-state-plane-sqlite.md:1173-1189`). Its only
   calibration gate says CI fails when *measured retained heap* exceeds `E`
   (`:1190-1192`). The actual allowance then adds exact live buffers and a flat
   32 MiB workspace (`:1192-1196`). This does not bound proportional transient
   construction storage: `JSON.parse` parser scratch and shape construction,
   Map/Set growth and rehash backing stores, canonical-string/UTF-8 conversion,
   and compressor/encrypter workspace can coexist temporarily with the final
   object or collection. A retained-heap measurement after construction cannot
   observe storage already released, and no derivation says why 32 MiB covers
   those peaks for every admitted token count up to the 64 MiB logical manifest
   limit (or the separately admitted 512 MiB envelope intermediates at
   `:1215-1225`).

   The adapter inventory is substantially better and enumerates the intended
   long-lived graphs (`:1142-1166`), but the ledger must reserve a tested upper
   bound for each construction phase, including transient backing-store overlap,
   or phase construction so old and new storage provably cannot overlap. The CI
   fail-closed assertion must be against peak live bytes during construction,
   not only retained heap. Until then a request can satisfy `ledger <= A` and
   still exceed `A` while materializing an admitted graph.

3. **BLOCKER — Source-change “retirement/restart” has no durable subprotocol;
   every deletion order has a normal crash state outside the exhaustive table.**

   V3 correctly lets a stable 1.7.x writer change authoritative JSON between
   2.0 controllers and says that a changed source forces id-scoped retirement
   and restart (`docs/design/163-state-plane-sqlite.md:1368-1379`). The authority
   matrix makes the same promise for M0–M4 (`:1283-1285`), and the M5 restart
   row explicitly directs the controller to retire the exact prepared DB and
   control and start with a new id (`:1454`). There is no retirement phase,
   tombstone, artifact-ahead row, or publication order for doing that.

   A concrete M5 crash demonstrates the hole:

   1. Start with exact `L`, exact M5 control, and exact prepared active `C`.
   2. A permitted old writer changes `L` between controllers.
   3. The 2.0 controller takes all locks, detects the new source, and follows
      the mandated retirement.
   4. If it durably removes `C` first and crashes before retiring the control,
      restart observes `L` + active absent + exact M5. The matrix admits active
      absence only for exact M0–M4 (`:1284`), while the M5 crash row requires an
      exact active prepared DB (`:1454`). The general rule classifies an
      artifact-behind state as a zero-write halt (`:1440-1444`).
   5. If it retires the control first and crashes before removing `C`, restart
      observes `L` + `C` + absent control, which is the reserved-path halt at
      `:1288`, not a resumable retirement.

   ENOSPC on either unlink/rename parent fsync or on a compensating control
   publication produces the same gap. M2–M4 source invalidation has the analogous
   problem once a staging identity/committed staging DB exists: removing an
   artifact while its old high-water remains makes it artifact-behind, whereas
   removing the control first leaves an unowned reserved artifact. JSON remains
   the sole state authority in these interleavings, so this is not a dual-state
   election, but the on-disk evidence is ambiguous to the specified controller
   and turns a supported old-writer race into a permanent doctor halt. A durable,
   correlated retirement state machine is required.

4. **MAJOR — M6 permits partial M7 cleanup that its exact `haltResources`
   witness cannot encode, especially on ENOSPC.**

   The closed control schema says each reserve/emergency resource is
   `available` with its exact fsynced identity, `consumed-for-halt`, or
   `retired`, and that `retired` is legal only at M7 after absence and parent
   fsync (`docs/design/163-state-plane-sqlite.md:1307-1315`). M1 records both
   resources available (`:1347-1349`). M7 then removes emergency/private/id-
   scoped artifacts before publishing M7 (`:1432-1435`), while the M6 restart
   row explicitly permits cleanup to be partial (`:1456`).

   Consider exact M6, then durably unlink the emergency resource, then receive
   ENOSPC on a later cleanup write or fsync. The old M6 record still says the
   exact resource is available even though it is durably absent. A phase-
   preserving `cleanup-deferred` halt cannot say `retired` at M6, cannot say
   `available`, and cannot truthfully say `consumed-for-halt` because cleanup
   removed it before the failure rather than to create publication runway
   (`:1485-1494`). Thus either the supposedly admitted partial-M6 observation
   fails its own exact resource witness, or the implementation silently weakens
   `available`. The same contradiction exists after an ordinary crash between
   resource cleanup operations; the ENOSPC branch additionally has no exact
   durable halt record it can publish.

   Give M6 a correlated cleanup prefix/same-phase resource-disposition revision,
   or reorder cleanup around a separately durable state that makes each absent
   resource legal. The broad phrase “cleanup may be partial” is not an exact
   restart signature.

5. **MAJOR — U0 cannot guarantee terminal cleanup or exclude a stale publish
   with the specified capability/token and worker-settlement APIs.**

   Every successful replacement invalidates all earlier mutation tokens, and
   both terminal APIs require the live owner plus the latest token
   (`docs/design/163-state-plane-sqlite.md:727-745`). Nevertheless the design
   promises that owner loss, retry abandonment, cancellation, and thrown worker
   work all reach one of those terminal APIs in `finally` (`:745-747`). Owner
   loss is impossible to service through that signature: once the capability
   object that keys the isolate-private `WeakMap` is lost (`:716-718`), no caller
   can pass it to `discardGeneration`, and a `WeakMap` supplies neither
   enumeration nor a reliable finalization callback. The candidate's arena
   retains therefore have no specified releaser.

   Cancellation has a related token hole. Worker result A can successfully
   replace a path and advance `t0` to `t1`; cancellation can then run an outer
   `finally` that still owns `t0`. By contract, `discardGeneration(owner,t0)` is
   stale and changes no retain/reference state. The spec names a serialized
   owner method queue but never names the single coordinator token custodian,
   makes token advancement atomic with that custodian, or provides an
   unconditional owner-abort operation that consumes the internally current
   token. “Every error edge” tests (`:760-762`) cannot choose the missing API
   semantics.

   Publication also refuses only while registered worker results are
   “unsettled” (`:751-757`). It does not define whether a resolved/rejected
   worker result remains unsettled until its serialized replacement/discard
   callback has completed. If the registry marks a result settled on message or
   promise resolution, `publishGeneration` may observe zero unsettled work,
   consume the owner, and publish the old entry while the already-returned
   replacement is merely queued. That callback then sees a consumed owner and
   is discarded: a stale publication despite all workers having returned.

   The contract needs one serialized owner-controlled current-token cell, a
   terminal abort that cannot fail because a caller's token is stale, an
   explicit owner-loss reclamation mechanism (or removal of that guarantee),
   and a worker state machine in which “pending” lasts through result
   application/discard and resource release—not merely promise settlement.

## M0–M7 phase audit

The authority predicate itself held under attack: I found no phase in which an
exact `L` and exact `Q` can both elect their associated state, and the complete
lock set leaves only the 2.0 controller (or explicit doctor delegation) as the
migration actor. The remaining phase-by-phase result is:

| Phase high-water | Durable witness / restart observation / sole authority | Adversarial result |
|---|---|---|
| M0 | Exact source/id/path control; partial reserve/emergency work resumes under JSON; only the 2.0 controller mutates migration artifacts. | No ordinary M0 crash or ENOSPC dual-authority/ambiguous observation found. A failed first control publication leaves JSON and no durable phase. |
| M1 | Admitted source plus durable halt resources; backup creation is idempotent under JSON and the controller. | No ambiguity in ordinary M1/M2 backup work. Source-change retirement becomes underspecified once later id-owned artifacts exist, as finding 3 records. |
| M2 | Durable history/fixed backup plus absent-or-recorded durable staging identity; exact zero-file and committed-completion create-ahead forms are printed. | Ordinary M3 create/commit crashes are correlated. A changed source followed by cleanup of the recorded stage has no retirement correlation (finding 3). |
| M3 | Exact committed completion and durable stage identity; WAL recovery/proof remains controller-only under JSON. | Ordinary checkpoint/proof crash and ENOSPC paths are unambiguous. Source-change retirement of the required committed stage is artifact-behind if interrupted (finding 3). |
| M4 | Exact closed/S0 physical+semantic proof; staging-only and rename-ahead active-only/both forms resume M5 under JSON. | No ambiguity in the printed rename/fsync convergence. Source invalidation during retirement is not represented (finding 3). |
| M5 | Exact prepared active DB; `L` keeps JSON authority, while artifact-ahead exact `Q` immediately and solely elects SQLite. | No dual authority found across the Q rename/fsync window. The explicit changed-JSON retirement action has no crash-safe ordering and yields an unlisted state (finding 3). |
| M6 | Exact Q/matching DB/parent-fsync witness; only 2.0 performs cleanup under SQLite. | Authority is unambiguous, but partial M7 cleanup contradicts the exact resource witness and cannot always publish an exact ENOSPC halt (finding 4). |
| M7 | Exact Q/matching DB and completed cleanup; only control unlink+state-parent fsync remains. | No M7 terminal ambiguity found: restart sees exact M7 and retries retirement, or absent control and terminal SQLite authority. |

## U0 and rollout closure

The exact-entry comparison, path/slot ABA tokens, retain-before-swap ordering,
worker DTO confinement, and stale expected-version rejection are otherwise
coherent. Finding 5 means r2 finding 9 is not closed because terminal ownership
and settlement still lack implementable semantics.

The rollout requirement is closed. The Rollout section says every U0–U5
implementation change lands only on the long-lived `2.0` branch, `main` remains
the stable 1.7.x line, the bake is a 2.0 prerelease, and no design-163 barrier or
partial implementation rides 1.7.x
(`docs/design/163-state-plane-sqlite.md:97-113`). U0 repeats that it is
implemented on `2.0` and is not a 1.7.x release vehicle (`:674-677`). I found
no contradictory implementation authorization elsewhere in the design.

Open point 3, open point 4, and r2 finding 9 therefore remain materially open.
The verdict is **CHANGES-REQUIRED**.
