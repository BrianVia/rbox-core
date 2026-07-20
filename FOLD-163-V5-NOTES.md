# Design 163 v5 fold notes

Source ruling: `REVIEW-163-FINAL.md`, read in full before inspecting or editing
the design. This fold is limited to the verdict's two residual blockers. Apart
from the required status change to v5, the design changes are additive.

| Residual finding | Additive v5 closure in `docs/design/163-state-plane-sqlite.md` |
|---|---|
| **C4 — legal legacy reset namespace** | `Retained legacy-JSON namespace branch` adds only the exact supported 1.7.x forms: `reset-candidates/<lower-hex32>.json` and `lineages/<lower-hex32>/<lower-hex64>.json`. They share the bounded, no-follow entry inventory; exact regular files are permanently inert under SQLite; recognized nonregular forms are `legacy-other`; unknown names remain invalid; `.db`/`.json` coexistence and entry accounting are explicit; and an inventoried DB sidecar still selects W2 before legacy evaluation or journal decode. Retained archives and journal-unlink-before-candidate-cleanup crash artifacts survive M0–M7 and Q unchanged. |
| **C2b — future-control preparation/halted retry** | `V5 future-control preparation and halted-retry closure` makes final intent revision `b` durably prebind both future paths, then gives `b..b+4` exhaustive absent/zero-create-ahead/building/finish-ahead/exact rows. Both inodes exist before render, H deterministically binds S without a digest cycle, and the final item cannot be removed before the pair is exact. Ready M6, prepared halt, direct M7, every old/new power image, and terminal sibling retirement are closed. Explicit retry reuses the same S; exact `promotedHalt` alone receives a doctor-authorized, one-shot delegation for the already-intended item action, and H→S is the sole durable CAS-clear/phase advance. Immutable M7 always carries one identity-bound `exact-or-absent-terminal` H descriptor, so no branch-dependent record or stale rebuilt pair exists. |

Adversarial review completed after the fold. The first pass identified the
generic doctor clear-before-delegate wording as the last literal conflict; the
narrow `promotedHalt` specialization was added, and the second pass returned
`RATIFY` with no remaining C4 or C2b blocker.

Keystone audit: the reset file-swap boundary, closed byte-exact O/N witness,
standing-journal no-open and W2-before-decode rule, single Q authority flip,
terminal-control-last ordering, and 2.0-only implementation confinement are
unchanged. The fold adds no authority source, repair allowance, unknown-name
wildcard, or mutation permission for any other halted row.

Validation: `git diff --check` passed; the v5 header and both new normative
sections occur exactly once. This is a design-only fold, so no implementation
tests were run.
