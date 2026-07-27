# Adversarial design review — 159 typeahead directory picker (round 5)

## Verdict: CHANGES-REQUIRED

V5 fixes round 4's highlighted-row/submitted-answer mismatch for ordinary
whitespace-edged values and correctly sends whitespace-prefixed `~user` into
the no-answer state. One transition defect remains: the normalized projection
is specified as a single trim → expand → resolve value, but boundary detection
and Tab construction still require lexical information that expansion and
resolution erase.

## Finding

1. **HIGH — The post-normalization projection cannot drive both boundary derivation and basename-preserving Tab rewrites.**

   V5 requires ALL resolution, listing, filtering, and error derivation to run
   on one trim → `expandUserPath` → resolve projection, with the raw visible
   spelling retained only for Tab's rewrite
   (`docs/design/159-typeahead-directory-picker.md:27-36`). The formulas then
   test an undifferentiated `input.endsWith("/")` and take `basename(input)`
   (`docs/design/159-typeahead-directory-picker.md:41-46`). Those cannot both
   mean the fully normalized projection: `expandUserPath("~/")` uses
   `path.join`, and both that operation and `path.resolve` erase the trailing
   slash (`src/cli/prompt.ts:73-78`). The projected home path therefore becomes
   non-boundary, so the required `~/` transition lists the home's parent and
   filters on the home basename instead of listing the home directory.

   The same ambiguity composes incorrectly with Tab. Under the stated
   post-expansion filter, bare `~` can rank the home directory's basename as a
   child of its parent; basename-preserving replacement of the raw `~` with
   that child writes (for example) `via/`, which re-resolves beneath `cwd`, not
   to `/home/via`. That contradicts the guarantee that every rewrite
   re-derives the completed child
   (`docs/design/159-typeahead-directory-picker.md:62-68`). A whitespace-only
   visible string exposes the empty variant of the same problem: its semantic
   projection is empty and may list a default outside cwd, but its raw spelling
   is non-empty, so the current “non-empty input” rewrite branch can emit a
   relative child instead of the required absolute form.

   Define the projection as explicit staged fields rather than one
   undifferentiated scalar—for example, a trimmed lexical token, expanded
   token, and resolved path. State which field drives semantic emptiness,
   boundary, filter term, and the empty/non-empty Tab branch. Boundary must be
   computed before trailing-slash information is discarded. Also pin the
   exact visible result (or deliberate no-op) for bare `~` and whitespace-only
   Tab, in addition to the already named `~/` transition.

## Verified aligned

- For valid non-empty input, Enter uses the same resolved projection for the
  row label and answer, while Tab independently targets the best-ranked child;
  the Enter/Tab split itself is coherent once the projection stages above are
  defined.
- `~user`, including leading whitespace before it, fails during expansion
  before any resolved value or child listing exists. It therefore has no
  use-input row, Enter remains inert, and Tab has no completion target. V5's
  invalid-expansion state composes correctly.
