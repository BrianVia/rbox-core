# Adversarial design review — 159 typeahead directory picker (round 4)

## Verdict: CHANGES-REQUIRED

V4 resolves all four round-3 findings and leaves no architectural objection to
the picker. One normalization edge remains: the live editor model and the
submission contract still derive different values from the same visible input.

## Findings

1. **MED — Live editor derivation bypasses the normalization pipeline, so the highlighted row can differ from the submitted answer.**

   V4 keeps the visible string as state and derives `resolved`, `boundary`,
   `listDir`, and `filterTerm` directly from `input`
   (`docs/design/159-typeahead-directory-picker.md:27-40`). It then says the
   synthetic row answers with that raw resolved input
   (`docs/design/159-typeahead-directory-picker.md:68-69`). Separately, every
   submission must run trim → `expandUserPath` → `resolve`
   (`docs/design/159-typeahead-directory-picker.md:39-44`), matching the current
   implementation (`src/cli/prompt.ts:94-101`).

   Those rules diverge for whitespace-edged input. With `cwd=/work` and visible
   input `" foo "`, the stated editor derivation labels row 1 as
   `/work/ foo ` and filters on `" foo "`, while Enter trims and returns
   `/work/foo`. More seriously, `" ~user"` appears answer-bearing under the raw
   derivation, but submission trims it to `~user` and must enter the separate
   no-answer `UnsupportedPathError` state. That violates both “Enter answers the
   highlighted row” and the invalid-expansion transition.

   Define one normalized semantic projection of the visible editor string for
   resolution, row labels, error classification, and listing/filter derivation;
   retain the raw visible spelling separately for basename-preserving Tab
   rewrites. Pin leading/trailing-whitespace picker transitions, including
   whitespace before `~user`.

All prior-round findings are otherwise resolved by v4.
