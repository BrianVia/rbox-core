# Design287 general review — round2

**Verdict: ACCEPT / ALIGNED as a staged roadmap. No remaining concrete blocker from general round1 findings R1–R5.** This is not acceptance of all implementation specifications, wire formats or production activation. No new test run: round1's executed read-only-index probe remains the directly applicable evidence.

Reviewed the canonical `plans/sync-git-improvements/plan.mdx` corrections, readiness/dependency map and amended X1 confidentiality boundary. Did not restart the source audit or add unrelated scope.

## Finding dispositions

- **R1 — resolved.** F1 supports owned scratch or identity-bracketed read-only enumeration; a healthy readable index no longer requires a writable live Git directory. The0555/EACCES witness is explicitly in its gates. G1 applies the same rule and requires actual staged split-dependency resolution to be proven, not assumed. No permission relaxation or unowned live-directory write is prescribed.
- **R2 — resolved.** S4d retains account refresh for each consumed head, including known cached rosters, and checks terminal authorization against refreshed evidence. A replacement freshness carrier is a separate design gate. Connected recipient/stale known roster/revoked publisher regression and honest request counts are included.
- **R3 — resolved.** G1b closes the raw-unmerged identity mechanism before activation; G1c couples normalization with compatible identity derivation. Helpers may land disabled, but normalized publication cannot precede convergence/old-artifact compatibility. Paired rollback is conditioned on compatibility, otherwise conservative publication stop. Intro first-cut wording no longer misassigns G1a/G1b deliverables.
- **R4 — resolved.** F3 explicitly states current P7/ref signals do not cover index-only changes and requires bounded F1 index/dependency probes before matcher reuse. Index-only add/remove/replacement/split-dependency fixtures are named. It honestly retains per-repo stat cost instead of claiming change-proportional observation prematurely.
- **R5 — resolved at roadmap level.** X1c explicitly retains encrypted path-bearing nodes, separates logical identity from ciphertext address, requires reviewed binding of signed root/children/encrypted references, and explains that the server cannot decrypt nodes to discover GC roots. Encryption/root details remain unapproved and part of the required focused security/format specification. That specification must characterize the confidentiality of all root/child metadata commitments before network activation; no plaintext-addressed tree is authorized by this roadmap.

## Readiness and dependencies

The new intro correctly distinguishes bounded Fix candidates, focused design closure and protocol experiments. In particular G1 identity activation, F2c ownership, F4 schema/location, S1 alarm primitive, S2 schema/index installation and S4 authentication/freshness are explicitly not implied implementation-ready. This prevents the roadmap's detailed algorithms from being treated as approval of unresolved durable transitions.

Dependencies now distinguish hard correctness requirements from measurement inputs/rollout coordination: F3 depends on F1; S5 can proceed without rich WS; current-codec X1a/b need not wait for cache migration/topology; standalone X3 experiments need not wait for portable worktrees. The wave map remains prioritization, not a needless global blocking chain. Existing ownership and rollback boundaries remain consistent.

## Scope of acceptance

Bounded fixes may now proceed to their focused regression/spec dispatch under the stated workflow. Durable and wire packages must still close the named design questions, run supported-runtime/compiled/rig gates, and prove their activation/rollback policy. Accepting this roadmap neither supplies missing product decisions nor approves deployments or feature retirement. A third general review round is not needed absent substantive changes.

Final clarification checked after verdict: X1 now also explicitly requires ciphertext-derived public addresses, no new plaintext metadata/hash commitment leakage, encryption of all content-bearing nodes, context/order/type binding and dictionary/cross-account substitution tests before a network prototype. This fully states R5's confidentiality constraint. Historical packing wording correctly preserves its current default-on behavior and treats the older regression as historical evidence. Verdict unchanged.
