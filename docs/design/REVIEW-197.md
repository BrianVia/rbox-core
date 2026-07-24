# Review 197 — Privacy-safe onboarding funnel telemetry

## Round 1

Verdict: aligned after revision.

Fable review of PR #418 raised one substantive finding and two minor nits.

### Finding 1 — survivorship bias in failure categories (substantive)

`firstFailure` rode only the `onboarding_activation` record, which is emitted
only on eventual sync success. A user whose initial sync failed and never
recovered emitted no activation record, so their failure category never reached
the server; the only server trace was an `onboarding_flow` `exited`/`interrupted`
event with `lastStep=initial_sync` and no category. §2 question 5 and §9
panels 6–7 were therefore answerable only for users who recovered —
systematically excluding the never-recovered population the funnel most needs
to expose.

Revision:

- added the already-bounded §5.5 failure enum as `firstFailure` on the
  `OnboardingFlowSample` wire record (§6.1), `none` when no failure was observed
  or `initial_sync` was not reached;
- documented the emission rule for every flow event (`started` always `none`;
  terminal events carry the first bounded failure family even without an
  activation record);
- appended `firstFailure` to the `client.onboarding_flow` Analytics Engine blob
  list with explicit position — last blob before the `elapsedMs` double (§6.3);
- confirmed and annotated the journal's existing "first bounded failure
  category" as the shared source feeding both wire records (§7.2);
- redefined §9 panel 6 (failure distribution) over terminal flow events plus
  activations, and relabeled panel 7 (recovery rate) as recovery-conditioned,
  with a footnote that failure categories cover only flows that produced a
  terminal event or activation;
- extended §11 tests (drift, AE layout position, and a recorder case for a
  terminal event carrying the failure category or `none`);
- added a §13 acceptance criterion for the new field.

The privacy posture is unchanged: one allow-listed enum blob reconstructed from
the canonical §5.5 table, nothing free-form.

### Finding 2 — `elapsedMs` semantics for `started` (minor)

`started` records are persisted at flow creation but uploaded later, after
authentication. §6.1 now pins that `elapsedMs` is measured at the milestone's
local occurrence, never elapsed-at-upload, so a `started` record always carries
`elapsedMs = 0`, and the same rule applies to every event. Added a matching
recorder test case in §11.2.

### Finding 3 — tombstone clock rollback (minor)

§7.4's opt-out tombstone compares a record's local start time against
`disabledAtMs`. A wall-clock rollback after opt-out can make genuinely new flows
appear pre-marker and be over-deleted. Added one sentence stating this
over-deletion is the intended privacy-safe failure direction: over-deleting
suppressed history is acceptable; under-deleting it (leaking pre-opt-out data)
is not.

## Adversarial self-review

Ran the internal-consistency checklist on the revised document:

- every wire-record field appears in the §6.3 AE layout with a stated order —
  the `onboarding_flow` blob order now matches its interface field order
  (`event`, `lastStep`, `entry`, `enrollmentRoute`, `recoveryOffered`,
  `recoverySelected`, `firstFailure`) with `elapsedMs` as the sole double;
- the `firstFailure` enum in §6.1 matches the §5.5 category table exactly
  (15 values, `none` … `other`);
- flow-event emission rules remain exhaustive and non-overlapping, and the new
  `firstFailure` rule is defined uniformly across all four events;
- journal contents (§7.2) cover everything the two wire records need;
- §13 acceptance criteria now cover the new field;
- no contradiction with §4.3's honest-limit framing: never-returning pre-auth
  users stay invisible, and both the panel text and the §9 footnote state that
  failure categories cover only flows that produced a terminal event or
  activation.

Additional items caught and fixed beyond the three findings:

- added an explicit §9 footnote scoping failure categories to flows with a
  terminal event or activation, keeping the panels honest against §4.3;
- pinned the AE layout test to `firstFailure`'s exact position (last
  `onboarding_flow` blob before `elapsedMs`) rather than relying on the generic
  position assertion.

No finding was rejected; all three fold in cleanly. Verdict: aligned.
