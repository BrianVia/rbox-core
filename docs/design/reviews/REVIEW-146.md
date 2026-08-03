# design 146 review

## Round 1 — findings

The adversarial review found that the first draft missed stale expectation
references, blurred live-report facts with fixture-derived config values, used
an underspecified no-plan assertion, needed repo-free B state checks, and did
not re-probe after fixed-point settlement. It confirmed that stderr diagnoses
the broken `git add` as a no-repository operation, not a lazy-fetch failure.

## Round 1 — response

Accepted. The design now distinguishes report evidence from fixture pins,
requires an exact empty-plan surface, names the repo-free B checks, re-probes
after settlement, adds a repo-wide stale-term gate, and explicitly forbids
changes to the offline cell and shared partial helpers.

## Round 2 — findings and response

The reviewer found that a literally empty search for all hydration terminology
would contradict the mandated correction note and historical supersession text,
and that the annex requirement needed the user's exact wording. Accepted: the
gate now targets only stale expectation phrases, and both annex copies must say
`hydration artifact of round-1 observation error; no engine gap`.

## Implementation review

The first implementation review required two stronger pins: the live empty-plan
metric tuple and complete A/B repo-record absence before and after settlement.
Both were added. The final review accepted the implementation, including the
repo-free/native state-helper simplification, and confirmed that
`runPartialOffline` plus the shared partial fixture/probe/push/no-op helpers are
behaviorally unchanged.
