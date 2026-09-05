# Design 293 review — round 1

Verdict: **NOT ALIGNED**, revised before implementation.

The adversarial review identified three blockers:

1. Global root/tip validation must finish before an earlier unowned tip may return `would-drop`.
2. Per-tip partition fallback cannot reconstruct legacy no-drop's root-first global marker precedence; the design now separates successful shared observation from an exact private legacy no-drop anomaly fallback.
3. The G5a evidence-only and G5b production commit boundary, plus exact final acceptance and rig gates, must be explicit.

The design was revised to resolve all three findings before round 2.
