# 280 — Stuck held repos escalate: one actionability predicate on the honest clock

Status: DRAFT r3. Review ledger: r1 → codex + opus parallel
(CHANGES-REQUIRED, convergent). r2 → final serial opus review
(CHANGES-REQUIRED: 3 blockers — git-busy landing contaminates doctor's
healthy-set AND the stale-lock hygiene sweep would DELETE the deferral so
the clock never accumulates; shared.ts:172 proves the offline-wake false
positive is real; the needs-you headline sentence is false for stuck
download failures — plus 6 conditions). r3 folds all nine, adopts the
reviewer's `artifact` landing, and REVERSES the r2 ledger decision on
#781's typed deferral: the FM capture shows the live rows persist no
discriminator (the schema's `detail` exists but is unpopulated, and 278
M0 forbids prose as the verdict carrier), so the typed code is the only
sanctioned gate for the remedy offer — #781's original ask was right. FM captures 2026-08-20 (rows +
durable deferral records) pinned below.

Issues: **#781**, **#792** (foundation), touches **#775** (scope boundary
recorded). Builds on designs 273 and 278.

## 0. Field ground truth (FM, 2026-08-20 — empirical, not asserted)

| repo | reason | story | action | needsYou today | resolvable |
|---|---|---|---|---|---|
| claude-containers, savvy-core-v1, savvy-demo, bird, AutoGPT (+ savvy-rewards-network since 08-18) | `artifact` | `sync-download-failed` | self-healing | **false** | **apply-resolvable** |
| pegasus, savvy-core | `unreadable` | `repo-unreadable` | repair-text | **true** (doctor: blocked ≥1h) | apply-resolvable |

So the design's target is the **self-healing artifact class** (6 repos
now). The unreadable pair already counts needs-you and already reads
blocked in doctor — their gap is copy quality only, and that copy cannot
live on the `repo-unreadable` story (it is shared by SIX reasons —
unreadable, ref-read-unreadable, config, containment, ignored-target,
unsupported; journal-specific re-clone advice there would misadvise five
of them). Journal-class copy is **out of scope here**, owned by #775's
root-cause work (ledger row §5).

Also in the capture: 40+ `local-index` rows on a pull-only host — FM's
"47 waiting on you" headline is dominated by a different class entirely;
this design does not touch it (recorded so the field acceptance is not
graded against noise it does not own).

## 1. Problem (restated on the corrected ground)

Six FM repos broken for 2–4 days tell a self-healing story on every
glance surface ("Nothing needs you"), never escalate in doctor (the
`!needsYou || quiet` short-circuit, doctor-triage.ts:113), and the
status listing's existing 24h stuck arm prints vague copy pointing at a
doctor that then dead-ends. Design 273's story contract even promises
"escalates when the retrying has gone on too long" — unimplemented.
Meanwhile the cause codes escalation would build on are polluted: #792 —
transient proof-execution failures are branded `connectivity-unproven`
(checkout-txn.ts:291–312 blanket catch), and 278's promised
repaired-graph liveness test was never written.

## 2. The two primitives (reviewers' frame, adopted)

### Primitive 1 (Slice A, #792): a proof-result classifier with explicit degraded semantics

`defaultConnectivityProof` returns `connected` | `unproven` (rev-list /
fsck RAN and exited nonzero) | `unavailable` (spawn/EPERM-on-spawn/
maxBuffer — the proof could not execute).

- `unproven` → today's behavior exactly: typed `connectivity-unproven`
  defer, skip-eligible.
- `unavailable` → defer with reason **`artifact`** and NO typed code
  (one arm at ref-plane-transaction.ts:369-372). r2's `git-busy` landing
  was refuted by the final review: `git-busy` sits in doctor's
  REPOSITORY_PROVEN_HEALTHY set (doctor-triage.ts:60-67 — "repository is
  healthy" for a proof that never ran), its presentation claims "another
  Git process is using this repository" (git-projection.ts:49 — false),
  and deferral-hygiene selects git-busy rows into the stale-lock sweep
  where a lock-free repo gets the deferral DELETED or reason-rewritten
  with a fresh reasonSince (deferral-hygiene.ts:129-130, :390-397) — the
  24h clock could never accumulate. `artifact` yields the self-healing
  sync-download-failed story, no skip (held-blockers.ts:73 gates on the
  typed code), no attempt latch (follow.ts:208), no hygiene selection,
  and honest doctor text. Ruling folded from the review: an
  `unavailable` landing on an already-artifact row does not restamp
  reasonSince (shared.ts:172) and therefore keeps escalating — correct,
  because the repo has genuinely been broken for that long; pinned as
  (d).
- **Named limitations** (in-code + here): (1) a git child that exits
  nonzero because of EACCES/EIO *inside* the repo still reads `unproven`
  — the taxonomy separates could-not-run from ran-and-failed, it does
  not audit git's own errno. (2) `unavailable` is NOT skip-eligible, so
  a host whose proof permanently cannot spawn pays the full
  fetch/decrypt/import on every pull — the exact cost 278's skip
  removed. Named trade: spawn failure is expected to be transient
  environment noise; a host where it persists 24h has a real problem the
  escalation will now surface. Perf differential on the close-out
  watches for this shape.
- **The 278-promised liveness test** (red-first): break the graph, enter
  the skip fixpoint, repair (unpack the missing objects), cross the
  hourly floor ⇒ the next re-prove FOLLOWS and clears the deferral.

### The typed code becomes durable (reversing r2's ledger decision — #781 was right)

The 2026-08-20 durable-record capture (§0) shows the live artifact
rows persist no discriminator: `GitDeferral` HAS a durable
`detail?: string` (sync-state-model.ts:187, written by
shared.ts:180-181) but the artifact defer sites do not populate it —
and design 278 M0 explicitly forbids prose as the verdict carrier
("The typed code is the ONLY carrier of the connectivity verdict; the
human reason stays a log string", ref-plane-transaction.ts:361-362).
So `reason: "artifact"` covers both "fetch/decrypt/import failed" and
"graph connectivity unproven" with nothing recorded to tell them
apart, and the code — not detail prose — is the sanctioned
discriminator. But the remedy differs: take-theirs re-runs
`stageIncoming` (resolve-take-theirs.ts:233 → follow.ts:63), which
REPAIRS the connectivity sub-class (genuine re-fetch/import) and
DEAD-ENDS on the fetch-failure sub-class (same stage, same refusal —
resolve-take-theirs.ts:268-283; safe, but a dead-end command violates
the 273 bar). So Slice A also stamps the blocker's existing typed code
into the deferral record: `setDeferral` gains an optional `code` carried
from `TypedBlocker.code` when the deferring blocker has one — local
durable state only (the telemetry contract's reason set is untouched;
codec coverage updated). This IS #781's "typed structural deferral",
adopted on evidence after r2 declined it. The resolve-offer gate (below)
reads it; rows without a code (pre-existing deferrals, fetch-failure
sub-class) simply get no resolve offer.

### Primitive 2 (Slice B): ONE effective actionability predicate, on `reasonSince`

`rowNeedsYou(row, now)` = `row.story.needsYou || rowStuck(row, now)`;
`rowStuck` = `story.action.kind === "self-healing" && now −
parse(reasonSince) > DAY_MS && now − parse(lastSeen) < 6h` (invalid/
future timestamps ⇒ not stuck, pinned). **Clock**: `reasonSince` —
`deferredSince` survives reason changes (shared.ts:172), so a 30-day
episode that flipped to `artifact` this morning must NOT escalate until
the *current cause* is 24h old. **Wake guard**: shared.ts:172 proves the
same-reason arm NEVER re-stamps reasonSince, so a host asleep for days
would wake straight into escalation (final-review blocker 3). The guard
is `lastSeen` (shared.ts:173, re-stamped on every re-observation — FM
capture shows it fresh to the minute): a row only escalates while its
cause is still being actively re-observed. Both clocks pinned with the
reason-flip, mixed-lane, and wake fixtures.

Every consumer moves to the one predicate — enumerated, no survivors:

1. `gitPauseCounts` (git-story-render.ts:40) — headline flips.
2. Group ordering comparator (git-story-render.ts:110), grouping key
   (:79), and the doctor summary's lead-story choice (:258).
3. Stuck rows split out of their young group before rendering (the
   group's oldest-row copy otherwise smears one old row over young
   siblings — codex F2 tail): a stuck sub-group renders the stuck arm +
   action; the young remainder keeps "rbox is handling these".
4. `doctor-triage` severity: the stuck arm goes **before** the
   two-term short-circuit `!needsYou || quiet` (doctor-triage.ts:113 —
   after it, it is unreachable). Safe today because a 24h row can never
   be quiet (git-projection.ts:213-217 requires young+transient) —
   stated and pinned. The ladder for stuck rows is fed from
   **reasonSince**, not oldestDeferredSince (a corrupt/future
   deferredSince would otherwise read "unknown" → attention,
   text.ts:26-29); with a valid 24h reasonSince, stuck ⇒ blocked on the
   SAME existing ladder — one ladder, not three.
5. `status --json` (status-render.ts:189) and `rbox git deferrals
   --json` (deferrals-command.ts:127): both allowlist emitters gain
   `stuck` and emit `needsYou` from the predicate. `schemaVersion`
   unchanged (additive field); the exact-shape pin at
   status-cmd.test.ts:914 updated intentionally.
6. Ambient status counts (ambient-status.ts:284) — RboxBar needs no app
   change (it renders totals; verified StatusReader.swift:215).
7. Shell sidecar (activity.ts:428) — inherits via the projection counts
   it already reads; verified, pinned.
8. Doctor's collapsed items view (doctor-triage.ts:518) — stuck rows
   count as needs-you there too (final-review condition 4).
9. **The needs-you headline itself grows a stuck-aware arm**: the
   sentence "rbox paused git sync there so nothing you did gets
   overwritten" (git-story-render.ts:69, :266-267) is FALSE for a stuck
   download/proof failure — the 273 contract at :45-48 forbids claiming
   it for the self-healing family (final-review blocker 5). Stuck
   self-healing groups get their own headline clause ("N repos have
   been stuck syncing for over a day — rbox needs your help to get them
   moving"), copy passed through the 273 banned-vocabulary replay
   test.

**Telemetry: explicitly NOT included.** The contract emitter builds its
own shape (telemetry/sync-state.ts:27, contract.ts:209) and the API
ingest rejects unknown fields — fleet-visible stuckness is a wire+ingest
+schema change and is recorded in §5 as a founder decision, not smuggled
in. r1's claim is withdrawn. With that, "local presentation only, no
kill switch, revert-is-the-switch" is true as stated.

### The remedy is rbox's own command, not prose

All six target rows are `apply-resolvable` today (§0). The stuck arm
renders the EXISTING resolve block that `groupActionLines`
(git-story-render.ts:163-176) already owns but never prints for
self-healing groups — gated on the group's every-row-resolvable
predicate AND on the durable typed code being `connectivity-unproven`
(the sub-class take-theirs actually repairs — see the typed-code
section; the fetch-failure sub-class would dead-end in the identical
stage, resolve-take-theirs.ts:268-283). No `stuckRepair` prose table; no
`git fetch`/`git fsck` homework (r1's copy failed the 273 "rbox states
the verdict" bar and the minimize-typing law). Stuck groups without the
code or not resolvable keep the existing stuck copy ("longer than it
should take" + doctor pointer) — no invented remedies, no dead-end
commands.

**Precondition, validated in the rig, never live-first**: BOTH artifact
sub-classes get scenarios — (i) connectivity-broken repo (missing
objects, bundle fetch fine): take-theirs re-stages, repairs, clears the
deferral; (ii) fetch-failure repo: the resolve offer is NOT rendered
(gate holds), and a forced take-theirs refuses cleanly with only the
known quarantine-bundle litter (quarantine.ts:18-46). If (i) is
falsified the resolve offer is withdrawn and the design returns to
review (hard gate — founder machines are never the first test of
take-theirs, standing rule).

## 3. What deliberately does not change

Ownership holds (`branch-in-use-elsewhere`, instruction-action — can
never be self-healing, minted at one site, git-stories.ts:126; pinned
incl. the mixed-lane display case), quiet young transients, every
needs-you story's behavior, the hourly re-prove cadence **for the
`unproven` class** (the `unavailable` class deliberately loses skip
eligibility — §2 named limitation 2), the frozen `git deferred` log
grammar, `repo-unreadable` copy (owned by #775), the 40-repo
`local-index` class (separate investigation), auto-repair (still
refused).

## 4. Validation

Slice A pins: (a) spawn-failure ⇒ reason `artifact` defer, no typed
code, no skip, no hygiene selection, re-prove next pull; (b) rev-list
nonzero ⇒ typed code + skip (today's behavior); (c) repaired-graph
liveness (red-first — the 278 debt); (d)
unavailable-on-already-artifact-row ⇒ no reasonSince restamp, keeps
escalating (the ruling in §2).

Typed-code pins (the new durable field): (l) a defer whose blocker
carries `connectivity-unproven` persists `code` and reads it back
through the codec; (m) a legacy row without `code` ⇒ no resolve offer;
(n) a fetch-failure defer (no typed code) ⇒ no resolve offer; (o) the
offer renders exactly for stuck ∧ resolvable ∧ code ===
"connectivity-unproven".

Slice B pins: (e) reason-flip clock (30d episode, new reason 1m ⇒ not
stuck; same reason 25h ⇒ stuck); (f) mixed-lane repo (ownership lane +
old artifact lane) never escalates via the ownership lane's age; (g)
headline/doctor/JSON/ambient/shell/collapsed-view all agree on one
fixture (the consistency matrix as a red test); (h) stuck sub-group
split rendering + the stuck-aware headline arm (never "nothing you did
gets overwritten" for stuck self-healing); (i) ownership-hold + quiet
regression pins; (j) doctor stuck-arm precedes the two-term
short-circuit (doctor-triage.ts:113) and feeds the existing ladder from
reasonSince; (k) wake guard: reasonSince 3d old + lastSeen 3d stale ⇒
NOT stuck; same row with lastSeen fresh ⇒ stuck (opus R10, resolved by
the §2 lastSeen guard).
Rig: BOTH §2 precondition scenarios — (i) connectivity repair via
take-theirs clears the deferral, (ii) fetch-failure row gets no offer
and a forced take-theirs refuses cleanly — plus the FAST suite.
Field: FM acceptance graded ONLY on the artifact class — 6 repos flip
the headline and doctor shows blocked; the resolve command appears only
after a row re-defers under the new build and mints its durable code
(the 6 live rows carry none today, and any fetch-failure row never
will); one rig-validated take-theirs on a founder-approved repo clears
one of them end-to-end.

## 5. Requirement-challenge ledger

| Requirement | Cost | Alternative | Decision |
|---|---|---|---|
| #781's "typed structural deferral" | a durable optional `code` on the local deferral record | r2 declined it; the r3 FM capture proved no discriminator exists and the remedy gate needs one | **ADOPTED in r3** (Slice A stamps TypedBlocker.code; local-only, telemetry reason-set untouched) |
| Journal-specific re-clone copy for pegasus/savvy-core | a new reason code or persisted detail on a 6-reason shared story | #775 owns the journal class; copy stays generic-but-true | deferred to #775, founder visibility |
| Fleet-visible stuck telemetry | client wire + strict ingest + schema + rbox-admin surface | local-only (this design) | founder decision, not blocking 2.0 |
| Kill switch | flag + owner + deletion condition | local presentation only; revert-is-the-switch | no flag |
| Auto-repair | mutating user repos on inference | resolve-command offer (rig-validated) | rejected — state-surgery bar |
| errno-audit of git children (EACCES/EIO inside repo reads as unproven) | parsing git stderr taxonomies | named limitation, bounded by floor + resolve-shaped remedy | accepted, documented |
