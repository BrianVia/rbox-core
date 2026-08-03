# Design 200 v8 — Codex alignment review, round 7

Date: 2026-07-25  
Reviewed: `docs/design/200-worktree-lifecycle-resilience.md` v8,
`REVIEW-200-R2-CODEX.md` through `REVIEW-200-R6-CODEX.md`, designs 130/176/177,
and the current implementation

## Verdict

**NOT-ALIGNED.**

Step G closes the exact wire-omission hole from round 6 at the ref-map level, and C3
correctly identifies the apply lane as the destructive lane. Neither mechanism is complete
at its other boundaries. G can advertise an OID absent from a full capture's declared pack
links, and its normalizer backstop refuses legitimate post-apply omissions. C3 loses its
protection through its own sequence predicate, a second pre-reconciliation push, and an
unrelated ACK.

The `deletion-pending` rank and server-first telemetry ordering are sound, but the consumer
sweep is incomplete. The keep-mine authority is now correctly `publisher-ack`, but v8
describes design 176's obsolete persisted-intent lifecycle rather than design 177's shipped
synchronous rider.

## Per-finding verification

- **R6 B1 — NOT-CLOSED:** G prevents an unproved ref-map omission, but post-capture insertion can produce an unimportable section, and the proposed normalizer refusal rejects a legitimate omission after a remote deletion has already retired BASE.
- **R6 B2 — NOT-CLOSED:** the apply-side force hold is the right safety action, but C3's drop, overwrite, and ACK-clear lifecycle can all remove that hold before the accepted tombstone is consumed.
- **R6 M1 — NOT-CLOSED:** rank 5, blocker-derived presentation, held-skip mapping, whole-packet API rejection, and server-first release order are coherent, but required compile-time and runtime consumers are absent from the implementation inventory.
- **R6 M2 — NOT-CLOSED:** candidate-absent resolution and publisher-ACK retirement are correct, but the specified persisted-intent/next-push execution path does not exist in the current binary.

## New findings

### BLOCKER 1 — Step G can advertise an OID that the section's pack links do not contain

Evidence: design 200 §3.2b; `src/cli/sync-git/shared.ts:135-141`, `:214-248`;
`src/engine/git/capture.ts:257-304`; `src/engine/git/shared.ts:473-543`.

G is specified after capture: capture reads the live refs and builds the bundle, then the
planner adds absent `R = X` to `candidate.refs`. That works only when the candidate retains
an incremental `packChain` covering BASE.

Full capture has no such guarantee. Incremental capture is disabled when configured off,
capture is forced, the basis falls back, the chain cap is hit, or byte-bound recompaction
runs. In all of those paths the bundle is built from live refs, where R is
absent, and the returned section has no BASE pack chain. G then adds X only to metadata.
A fresh receiver imports exactly `packChain + newest`; it has no path to the older bundle
that contains X, so the section can assert a ref whose object is missing.

This is the bundle-coverage half of the P4 landmine, even though X was physically held rather
than merely pending. G must participate in capture/bundle inputs, or the resulting section
must retain and validate a pack link covering every re-advertised tip across full, forced,
basis-fallback, and recompaction paths.

### BLOCKER 2 — the normalizer refusal rejects a fully authorized remote deletion

Evidence: design 200 §§3.2b, 3.6(c);
`src/cli/sync-git/publisher-tombstones.ts:54-59`, `:108-122`;
`src/cli/sync-git/apply.ts:1438-1456`; `src/cli/sync-state.ts:235-253`.

The proposed refusal condition is decidable for the advertised half: with the new proof map,
the normalizer can see `advertised.refs[R]` present, candidate R absent, and no L proof.
It cannot distinguish why BASE no longer holds R.

A normal follower path reaches exactly that state:

1. this device last advertised `R = X`;
2. it applies a peer's attested omission under §3.6(c), and the pull ref transaction retires
   BASE[R];
3. a terminal apply clears pending, while `record.advertised` remains this device's last ACK;
4. the next outgoing section correctly omits R, but W/L produce no proof because BASE is
   already absent.

The backstop therefore refuses forever: advertised is positive, candidate is absent, and the
locked-proof map is empty. An ACK is the only operation that could advance advertised, and
the refusal prevents that ACK.

The normalizer needs an authority for an already-applied omission, or a narrower predicate
that remains total without resurrecting X. The proposed “one deletion authority” condition
cannot ship as written.

### BLOCKER 3 — C3 drop condition 2 is true in the exact lost-ACK state it must protect

Evidence: design 200 §3.2c; `src/cli/sync/push.ts:791-819`;
`src/cli/sync/pull.ts:98-105`, `:362-372`; `src/cli/sync-git/apply.ts:322-327`.

The arm is written while the durable record is at sequence N, with
`attemptedSequence = N + 1`. If POST is accepted and the ACK state save is lost, the record
still has `sourceSeq = N`. Thus the literal condition
`record.sourceSeq < attemptedSequence` is true after a landed POST as well as after a failed
POST.

The authenticated incoming head sequence can decide the intended predicate, but the old
record cannot. C3 must define the test against the authenticated head passed to pull/apply
(and order its use before the tombstone transition), not against `record.sourceSeq`.

### BLOCKER 4 — arm → lose → arm can overwrite the ref that the first attempt protected

Evidence: `src/cli/sync/push.ts:272`, `:790-819`, `:827-838`, `:853-899`,
`:364-370`.

A single per-repository field cannot be replaced blindly:

1. attempt A omits R; POST lands; its ACK is lost; the field protects R;
2. R is re-created, and a different S is deleted;
3. before pulling, another push arms attempt B with only S, replacing R;
4. B posts against the stale parent and receives 409;
5. 409 recovery pulls A's accepted omission after R's protection is gone.

Push startup reconciles only `resolutionReceipt`; no C3 reconciliation precedes the second
arm. Definitely failed repeated pushes merely churn a bounded field and do not wedge, but an
ambiguously accepted attempt cannot safely be overwritten. Reconcile the outstanding attempt
before planning another push, or represent and preserve multiple outstanding attempt
generations.

### BLOCKER 5 — clearing C3 on every ACK can clear an ACK that still advertises the omission

Evidence: design 200 §3.2c; `src/cli/sync-git/plan.ts:174-182`, `:987-989`,
`:1029-1055`; `src/cli/sync/push.ts:937-1005`.

Normalization precedes final pending-supersession proof. If that proof fails for another ref,
`revertCapture` replaces the normalized local candidate with the exact pending section.
That pending section may be the omission C3 is protecting. An unrelated file change can
still commit it.

The proposed ACK transition clears `absencePublicationAttempt` for every repository whose
section the ACK recorded. In this case BASE remains X, advertised still omits R, and local R
is present, so neither semantic drop condition 1 nor 3 holds. Clearing the whole field loses
the force hold while the destructive section remains current.

ACK clearing must be per entry and evaluated against the actual post-ACK BASE/advertised/live
state. “This ACK recorded a section for the repository” is not enough.

### MAJOR 1 — the normalizer has no specified per-repository refusal path

Evidence: `src/cli/sync-git/publisher-tombstones.ts:173-192`;
`src/cli/sync-git/plan.ts:165-182`, `:987-989`.

Today normalization is a total map transform after all captures. It returns sections plus
non-fatal findings. Throwing from the proposed rule aborts the whole push; returning a finding
still publishes the unsafe section. The design compares the refusal to capture's per-repo
self-validation, but does not specify a typed refusal result, proof-map plumbing through
`normalizeOutgoingGitSections`, or the `revertCapture`/`deferOne` fallback and bookkeeping.

This remains necessary after BLOCKER 2 narrows the predicate.

### MAJOR 2 — C3's current-branch example does not terminate in the promised two cycles

Evidence: design 200 §3.2c; `src/cli/sync-git/follow.ts:722-726`, `:553-585`,
`:1191-1215`; `src/cli/sync-git/pending-supersession.ts:99-105`;
`src/cli/sync-git/plan.ts:781-789`.

The design expressly names `git checkout -b R X` as a recreation source. If R is current,
the forced hold sets `checkoutRefReason`, classification produces an unsafe checkout, and
follow returns a whole-checkout defer. The changed HEAD also makes pending supersession carry,
so the next capture cannot re-advertise R and satisfy drop condition 3.

The ref remains safe, but it needs checkout movement or keep-mine. This is not a purely
per-ref, automatic two-cycle outcome. State the current-branch exception and its human exit;
retain the two-cycle claim only for a non-current `git branch R X` recreation.

### MAJOR 3 — the `GitDeferralReason` consumer inventory is not total

Evidence: `src/cli/git/resolve-presentation.ts:113-134`;
`src/cli/sync-git/breadcrumb-veto.ts:56-78`;
`src/cli/shell-init.ts:189`;
`src/cli/telemetry/contract.test.ts:48`; `src/cli/status-view.test.ts:143`.

Adding `deletion-pending` as specified leaves two deliberate exhaustive consumers unable to
compile: `refusalMessage`'s `Record<GitDeferralReason, string>` and
`breadcrumbGateForReason`'s `assertNever` switch. The generated shell prompt has a separate
exact allowlist; without the new member it rejects the whole prompt-state file at runtime.
Two tests also pin the old member count/list.

Rank 5 itself is sound. I found no consumer that assumes the literal numeric value; consumers
of the primary order use the generated rank table. The missing sites are still required
design decisions, not routine fallout to discover during implementation.

### MAJOR 4 — case (b) specifies the lifecycle deleted by design 177

Evidence: design 176 `:88-102`; design 177 `:31-47`, `:51-86`;
`src/cli/git/resolve-command.ts:657-703`, `:755-770`;
`src/cli/sync-state-model.ts:352-368`;
`src/cli/sync-git/resolution-intent.ts:215-220`, `:348-352`.

The v8 authority correction is right: design 176 does say keep-mine folds through
`publisher-ack`, candidate-absent is `not-subsumed`, Y remains in
`discardedIncomingOids`, and force-discard is required. Manual preflight is take-theirs-only.

But design 177 explicitly removed 176's persisted intent and “next ordinary push” gap.
Current confirmation invokes `pushManifest` synchronously with an ephemeral rider, and state
loading strips obsolete intents. Therefore §3.6 steps 2, 4, and 5 and the §9.1 test name a
state and retry promise the binary does not have. Rewrite them around synchronous confirm:
pre-ACK failure preserves pending, not an intent; the same in-process push takes W/L/T and
publisher-ACK.

The quoted amendment to design 176 is historically accurate, but design 200 must also be
consistent with design 177, which supersedes that execution model.

### MINOR 1 — the “not relayed / re-minted origin” rationale overstates invariant 1

Evidence: design 200 invariant 1; `src/cli/sync-git/base-composer.ts:227-229`,
`:356-367`, `:450-460`.

Invariant 1 says a positive BASE value with usable provenance was physically held by this
device, not necessarily captured and published by it. A peer value applied locally receives
a `pull-p` origin. When G re-advertises that same value, publisher-ACK retains the prior
origin because requested equals before; it does not mint a new publisher-ACK origin.

The weaker fact is enough after BLOCKER 1 is fixed: the device held X and the wire has carried
an object source for X. The text and structural-test terminology should say that, not “already
published by this device” or “re-mints.”

### MINOR 2 — the secondary status-order rationale and repair copy are inaccurate

Evidence: `src/cli/status-view.ts:319-328`, `:367-420`, `:475-481`.

`gitDeferralReasonPrecedence` is not used only to break chronic-age ties. It selects the
displayed lane/reason first; age is a later tie-break, while `oldestDeferredSince` is computed
separately. Default rank 5 may still be the right coarse class, but it needs the real
cross-lane argument and a test.

Also, “Nothing to do — this clears once rbox publishes the deletion” is false for §3.6(b)
and C3's current-branch case, both of which may require movement or keep-mine. The companion
can offer keep-mine when pending exists, but the shared repair sentence must not promise
self-clearance unconditionally.

### MINOR 3 — C3 does enable a conservative code path

Evidence: `src/cli/sync-git/apply.ts:1007-1013`.

“No code path can be reached only because the field is set” is literally false:
`forcedHeldRefs` is an explicit `routeThroughFollow` disjunct. The defensible invariant is
that C3 enables no destructive or authority-granting path; it may enable conservative
classification and hold paths.

## Verified claims that do close

- **Today's no-pending behavior:** correct. The advertised-diff loop authors the tombstone,
  normalization runs for the outgoing capture, and `pendingSupersessionAckConverges` is
  consulted only for `pendingSupersessionCandidates` (`publisher-tombstones.ts:108-122`;
  `plan.ts:987-989`, `:1027-1041`).
- **A bare omission is destructive:** correct and load-bearing. An old owned tip is not held
  in `follow.ts:743-751`, survives the stable no-drop pass, and reaches
  `planBranchTransition({ afterOid: null })`; the attestation recheck is entered only for a
  ref already placed in `tombstoneAuthorized` (`follow.ts:773-786`, `:975-998`).
- **C3's destructive lane:** correct. With a lost ACK, live X and stale logical BASE X satisfy
  tombstone attestation, and apply plans the prune. `forcedHeldRefs` is installed before
  transition planning and excluded from the tombstone-waiver loop
  (`follower-protocol.ts:80`, `:120-128`; `tombstone-attestation.ts:101-120`;
  `follow.ts:718-726`, `:773-786`, `:989-1000`).
- **Telemetry compatibility:** correct. `validateSyncState` returns null on the first unknown
  reason and drops the entire item as `bad_state` (`apps/api/src/telemetry-ingest.ts:324-354`).
  Expanding both vocabularies, promoting the API, then tagging the CLI is sufficient; old
  clients emit a subset accepted by the expanded server.
- **Housekeeping:** the landmine table now counts 10 N/A / 12 moot / 12 carried = 34 with
  R4 B1 carried; §9.4 says zero A and zero Z artifacts; and L's transaction-scoped lock
  lifetime is stated accurately. C3 does not yet justify the added phrase that it closes the
  destructive half.
- **Concurrent peer deletion:** no persistent tombstone war is introduced. Commit sequence
  CAS serializes G's X assertion against a peer omission; the loser pulls and replans. If G's
  assertion lands later, the peer's deletion can be lost under the ruled “assertion wins”
  direction, but a device whose BASE was retired does not re-publish the deletion, so the two
  sides do not oscillate.

## Shortest remaining list

1. Make G bundle-complete in every capture mode, and redesign the normalizer backstop so it
   accepts already-authorized applied omissions and has a typed per-repository refusal path.
2. Rework C3 around authenticated-head ordering and non-overwritable outstanding attempts;
   clear entries only from post-ACK predicates, and specify the current-checkout termination
   exception.
3. Complete the `deletion-pending` consumer sweep and correct the secondary display/copy
   claims; keep the server-before-CLI order.
4. Rewrite case (b) on design 177's synchronous ephemeral-rider path while retaining the
   now-correct publisher-ACK, X-not-Y tombstone, force-discard, and preservation semantics.

Until those are specified, **NOT-ALIGNED**.
