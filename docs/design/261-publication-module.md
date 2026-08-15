# 261 — Publication: name the push, pin its loop, retire the false split-debt

Status: ALIGNED v3 (architecture-loop task #39, the capstone)
Round history: R1 parallel wave (R1A mechanism + R1B protected-behavior,
both CHANGES-REQUIRED) → full rescope to v2 → R2 serial confirm
(CHANGES-REQUIRED, five narrow findings with reviewer-supplied exact
fixes, "other v1 defect classes coherently retired") → v3 folds all five
verbatim; residuals self-certified per the convergence rule (each round
strictly narrower: structural → mechanism → contract-edge).
v1 → v2: complete rescope after two independent adversarial reviews
(CODEX-R1A mechanism angle, CODEX-R1B protected-behavior angle) both
returned CHANGES-REQUIRED with converging evidence that v1's mechanism
(six extracted phases + one port factory + spans prologue ownership +
pendingPushReports deletion) was unimplementable without changing deep-owner
interfaces, physical-effect ordering, or guard-pinned file residence.
Depends on: 257 (PushSpans), 258 (git-plan three owners), 244, 204, 108, 98.

## The v1 findings and rulings (round 1, both reviewers)

Accepted in full — each of these kills a piece of v1's mechanism:

1. `preparePublishCandidate` already owns capture-execute + observation
   persistence + identity sealing (publish-candidate.ts:217-318). A
   separate capturePhase would change that deep owner's interface. ACCEPT
   → no phase extraction.
2. Real success ordering is `commit → settleRepublish + KPI → acknowledge →
   first-publish finalization`, and a resolution transition settles and
   returns WITHOUT publisher ack (push.ts:863,898-950). v1's phase order
   was wrong. ACCEPT → the attempt function stays cohesive.
3. The three port literals close over attempt-mutable values (`state`
   reassigned by capture-save and keep-mine arm/disarm; `api`/`matcher`
   rebuilt per attempt at push.ts:489-494; `committed` exists only
   post-upload), and none of the port interfaces carries
   `PublicationIdentity` — identity rides effect plans and receipts. One
   `buildPublicationPorts()` factory cannot exist and cannot bind identity.
   ACCEPT → no factory.
4. `pendingPushReports` cannot be deleted: the daemon measures prologue
   before the report exists, `PhaseReport` starts its clock in its
   constructor (phase-report.ts:129), and the scheduler settles the report
   after mutex release; failure ordering is contract-pinned
   (daemon-publish-transition.contract.test.ts:219-278). ACCEPT → spans
   ownership change dropped entirely.
5. Guard suites pin file residence: sync-mutex.test.ts:186 requires the
   literal `await pull(root, cfg, deps)` in push.ts; reset-consent.test.ts
   :151 and whole-state-compat.test.ts:338-345 pin push.ts's `loadState`
   reach and say whole-state reach may only DECREASE, never relocate.
   ACCEPT → no code moves out of push.ts.
6. The retry loop is not untested: six-attempt 409 exhaustion, deadline
   surrender, shrinking-unsatisfied progress, non-shrinking exhaustion,
   files-first fallback are pinned (sync.test.ts:902-1281,
   files-first.test.ts). ACCEPT → the new test is characterization
   CONSOLIDATION plus coverage of the unpinned arms, not "first contract".
7. The daemon seal is NOT an exact duplicate: `localFileObservationForScan`
   deep-clones collision groups; `sealPublishRequest` aliases them
   directly. The three `deferManifest` sites have three different
   authorities (scan-time transient, daemon GC fence, upload-time churn).
   ACCEPT-MODIFIED → the dedup below is one call-site substitution with the
   aliasing difference named as a deliberate behavior decision, not a
   "duplicate deletion".
8. Anchor/count corrections (RecoveryAction :173, loop :354-419,
   PushAttemptState :425-444, ports :510-612/:792-833/:907-926 = 165
   nonblank, SyncDeps 34 fields / 12 callbacks, daemon literal 18
   explicit keys + `...this.e2ee` spread [R2 re-count — R1A/R1B
   disagreed], sync.test.ts 2,071 lines). ACCEPT — used throughout v2.

## Problem (what is actually wrong, post-review)

1. **The naming vacuum is real.** CONTEXT.md carries `publisher-ACK` and
   `publish attempt` but no owner noun for the end-to-end process; the
   identity-binding rule is documented as "~6 enforcement sites …
   consolidation is unbuilt work" (CONTEXT.md:143-172). A reader cannot ask
   "where is the push?" and get one answer.
2. **The composition's pins are scattered.** The loop's semantics are
   pinned across sync.test.ts (2,071 lines) and files-first.test.ts;
   three RecoveryAction arms (`pull-first`, `epoch-stale`, `reupload`
   including the RECOVER_ACCUM_MAX cap at push.ts:188-190) have no direct
   pin anyone could name.
3. **push.ts carries a false debt marker.** Its allowlist entry reads
   "pending split — 944 nonblank lines and 50.1 KiB"
   (file-size.test.ts:92). Two independent reviews just established the
   opposite: the attempt function is a cohesive deep module whose
   decomposition would REQUIRE changing deep-owner interfaces, physical
   ordering, or guard-pinned residence. The standing instruction to split
   it is wrong, and per the repo rule ("never split a cohesive deep Module
   … merely to stay below a threshold") it should be retired, not left as
   perpetual TODO.
4. **One honest duplicate.** The daemon's observation ternary
   (daemon-publish-transition.ts:78-81) re-derives what
   `localFileObservationForScan` (push.ts:247-255) expresses, modulo the
   aliasing difference in finding 7.

## Level-set (what "helped" looks like)

- CONTEXT.md answers "what is a Publication and who owns each leg" in one
  entry; the five scattered nouns point at it.
- One test file consolidates the loop's contract and adds pins for the
  three unpinned RecoveryAction arms.
- The "pending split" marker on push.ts is replaced by an audited
  cohesion verdict citing this design — the loop's ceremony-kill.
- The daemon ternary is one helper call with a named aliasing decision.
- Could get WORSE: essentially nothing structural changes, so the risk
  surface is the new test's flake potential (mitigate: structural
  assertions, no wall-clock timing) and the daemon deep-clone decision
  (behavioral delta, named below).

## Substrate-primitive check

The reviews themselves were the check: the "stronger primitive" for #39
turned out to be the code as it already stands. The composition
(pushManifestInner + runPushAttempt) is the Publication module — it needs a
name and a consolidated contract, not a rewrite. No new mechanism, no new
state, no new production files; two test-only files (the contract test +
the FakeRemote `*.test-helper.ts` extraction R2 required).

## Design

### 1. The noun (CONTEXT.md)

Add **Publication** to CONTEXT.md's domain terms:

> **Publication** — the domain process taking one publish request through
> capture → candidate → encrypt/upload → commit to a classified outcome,
> with publisher acknowledgement as the CONDITIONAL final leg: ordinary
> acceptance proceeds to `acknowledgePublishedGitTransitions`
> (push.ts:927); a resolution transition settles and returns WITHOUT
> publisher ack (push.ts:863) — that terminal branch is part of the
> contract, not an exception to it. Its owner is `pushManifest` →
> `pushManifestInner` (`sync/push.ts`): the bounded in-process retry loop
> (`RecoveryAction`, push.ts:173; the `for(;;)` at :354;
> `PushAttemptState` :425) IS the module; its legs are the four deep
> owners (`publish-candidate` → `manifest-commit-executor` →
> `publisher-ack-transition`, spans via `PushSpans`). In-process bounded
> retry lives inside; the daemon's long-horizon retry (recovery probe,
> git-busy ladder) lives outside by design (push.ts:296-300). One
> publication = one `pushManifest` call.

Re-point `publish attempt` and `publisher-ACK` entries at it. Update the
identity-binding entry to name the push-side sites explicitly (planId in
publish-candidate, attemptId in daemon-publish-transition) — the
consolidation stays "unbuilt work", now with a precise map.

Module doc comment at the top of push.ts (~6 lines) stating the same
boundary — the one inexpressible-in-code constraint worth a comment.

### 2. The consolidated contract test

`src/cli/sync/publication.contract.test.ts` — no new PRODUCTION seam
(both reviewers: the fake-port idea required a seam the interface doesn't
have). R2 correction folded: `FakeRemote` and its setup are lexical to
sync.test.ts (:298, :425) and cannot be imported — so the harness is
extracted to `src/cli/sync/publication.test-helper.ts` (test-only file,
following the repo's existing `*.test-helper.ts` convention), and
sync.test.ts imports it back unchanged. R2 also established all four
"new" arms are ALREADY pinned in sync.test.ts (pull-first via
beforeCommit :879, reupload via forced-unsatisfied :955, epoch-stale via
commit override + currentKek :1118, accumulator overflow/full-audit flip
via paged 422 :1176) — this file is therefore PURE CONSOLIDATION:

- One named file where the loop's whole contract can be READ:
  attempt-budget exhaustion; conflict surrender by deadline;
  shrinking-unsatisfied not consuming an attempt; files-first fallback
  cap; the pull-first, epoch-stale, and reupload arms incl.
  RECOVER_ACCUM_MAX and forceFullAudit.
- Structural/range assertions only (per flaky-tests.md:174-182
  discipline); no wall-clock dependence.
- Existing sync.test.ts pins are NOT deleted (protected); the new file
  cross-references them. Consolidation means one canonical place to read
  the contract, not deleting redundant enforcement.

### 3. The cohesion verdict (ceremony kill)

file-size.test.ts:92's allowlist note for `src/cli/sync/push.ts` changes
from "pending split — 944 nonblank lines and 50.1 KiB" to "audited
cohesive (design 261): the Publication attempt loop; decomposition would
require changing deep-owner interfaces or guard-pinned residence — do not
split on size alone". The ratchet pin at :174 stays EXACTLY (940, 49750)
— unchanged numbers, only the justification stops lying. No size limit
increases.

R2 correction folded: a one-entry note rewrite alone would NOT retire the
standing instruction — the gate's generic policy text still calls every
entry "debt waiting on a split" (:37) and the ratchet failure message
still orders "Split it, or shrink it back" (:275). Both generic texts are
updated to recognize a second entry class — "audited cohesive (design N)"
— whose members are exempt from the split ORDER but still fully bound by
the ratchet (any growth still fails; the failure message for audited
entries says "shrink it back or re-audit the cohesion verdict", never
"split it"). The ratchet mechanics change not at all; only the prose
stops prescribing a shallow split for audited-cohesive modules.

### 4. The one dedup (named behavior decision)

`daemon-publish-transition.ts:78-81`'s observation ternary becomes a call
to `localFileObservationForScan(inputs.observationComplete,
inputs.caseCollisions)` — R2 BLOCKER folded: the first argument is the
live `observationComplete` fact, NEVER a hard-coded `false` (which would
always return `preserve` and break the authoritative-seal contract pinned
at daemon-publish-transition.contract.test.ts:136 and
scan-observation.test.ts:7). DELIBERATE behavioral delta: the daemon path
gains the helper's defensive deep-clone of collision groups where it
previously aliased the caller's array. R2 verified the clone safe:
cloneCollisionGroups copies groups and paths (publish-candidate.ts:186),
pushManifestInner re-clones preserve-mode input (push.ts:318), settlement
copies again (:184), and correlation is by attemptId, not object identity
(:145). Pinned by one new assertion in
daemon-publish-transition.contract.test.ts that mutation of the input
array after sealing does not alter the sealed observation — plus the
existing authoritative-seal test must stay green (it is the direct guard
against the hard-coded-false regression). The GC-fence `deferManifest`
application (:75-77) is NOT touched — finding 7 established it as a
distinct authority, not a duplicate.

## Protected functionality (MUST NOT change)

- Every export of sync/push.ts and its module path (daemon-publish-
  transition imports PushResult/PushManifestOptions from sync/push.js).
- All direct callers: daemon.ts:1795, chain-repair.ts:77, ignore-cmd.ts
  :125, resolve-command.ts:842 (and its resolution-result taxonomy),
  init-cmd.ts:597+633 (two-commit, filesFirstStartedAt, gitDeferred,
  mutex span), local-runtime.ts:142, sync/sync.ts:18; indirect command
  surfaces (adopt-cmd two full cycles, recover-cmd chain-repair+push under
  one mutex, front-door). No behavior change reaches any of them except
  the named deep-clone.
- PushConflictExhaustedError class identity (daemon.ts:1397 depends on it).
- Guard suites verbatim: sync-mutex literal-pull residence,
  reset-consent loadState inventory, whole-state-compat reach counts,
  design176 grammar freeze (no log line moves — nothing moves at all).
- Both upload implementations + RBOX_PUBLISH_PIPELINE flag; all wire
  shapes, durable records, identity keys; all five adjacent flake-noted
  timing families (flaky-tests.md:174-182) — untouched.

## Tests the implementation MUST write

1. `publication.contract.test.ts` as specified (§2).
2. The seal-aliasing pin in daemon-publish-transition.contract.test.ts (§4).
3. Nothing else — no golden-report or move-fidelity apparatus is needed
   because nothing moves.

## Validation

- Full suites: sync/, daemon/, publish-pipeline/, sync-git/; file-size +
  duplicate-declarations + grammar-freeze + reset-consent +
  whole-state-compat + sync-mutex guards (the ones v1 would have broken —
  run them explicitly).
- Rig FAST suite (standing cadence; this touches the daemon seal path).
- Field: one daemon pump publish on the desktop dev build; daemon.log
  PhaseReport keys unchanged.

## Non-goals (explicit, carried from v1 + review)

- No phase extraction, no port factory, no spans/prologue ownership change,
  no pendingPushReports change, no SyncDeps narrowing, no attemptId/planId
  unification, no upload-implementation merge, no code movement out of
  push.ts. Each is either blocked by a review finding above or deferred
  with its blocking evidence named.

## Size accounting

push.ts: unchanged (940/49,750, pin unchanged). New test file: test files
are exempt from the production size gate. Net production delta: ~4 lines
(one helper call replacing a ternary) + a module doc comment.

## Ceremony killed (the loop metric)

- The false "pending split" debt marker on push.ts — replaced by an
  audited cohesion verdict. This retires the last standing instruction to
  shallow-split a deep module in the push plane.
- CONTEXT.md's owner-less push vocabulary — five nouns get one owner.
- The daemon's hand-rolled observation ternary.

## Honest accounting

This is the smallest capstone the evidence supports. v1 proposed moving
~600 lines behind new interfaces; two independent reviews demonstrated the
composition is already correctly shaped and every proposed move broke a
pinned contract. The capstone's real deliverable is the verdict itself:
the push is already a module — it was only missing its name, one
consolidated contract file, and the retirement of a standing instruction
to break it.
