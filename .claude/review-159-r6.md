# Adversarial design review — 159 typeahead directory picker (round 6)

## Verdict: CHANGES-REQUIRED

V6 adds the intended semantic-empty Tab branch and basename-preserving rewrite,
but it does not actually define the promised lexical/expanded/resolved
projection in the normative state model. The round-5 defect therefore remains
load-bearing: bare `~` cannot select a child of home under the stated boundary
formula, and whitespace-only input has two different Enter answers depending
on whether the still-undefined `input` means the raw or lexical value.

## Finding

1. **HIGH — The decision log claims staged ownership, but the state model still uses one undefined projection, leaving bare `~` and whitespace-only Enter incoherent.**

   The canonical model still says that all derivation uses ONE trim → expand →
   resolve projection and that raw spelling is retained ONLY for Tab
   (`docs/design/159-typeahead-directory-picker.md:27-40`). Its formulas then
   compute `resolved`, `boundary`, `listDir`, and `filterTerm` from an
   undifferentiated `input` (`:41-46`). `lexical` first appears only in the Tab
   rewrite (`:62-68`), `expanded` is never defined, and the decision log merely
   asserts that the three fields and per-stage ownership exist (`:215-219`).
   That is not an executable staged projection.

   Bare `~` is a concrete failure under every plausible reading of the stated
   formula. The trimmed lexical value `~` is neither empty nor slash-terminated;
   its expanded/resolved value is the home path and is also not slash-terminated.
   Thus `boundary` is false, `listDir` becomes the home's parent, and
   `filterTerm` is either `~` or the home basename. The picker consequently has
   no ranked child of the home directory for Tab to complete. The later sentence
   that bare `~` “normalizes to `~/` first, then appends” (`:67-68`) governs the
   rewrite after a child has been chosen; it does not make home the directory
   from which that child is listed. Define the pre-expansion boundary token (or
   explicitly make bare `~` a boundary) and pin the complete transition, for
   example `~` + Tab → `~/child/` with `child` read from home.

   Whitespace-only input exposes the second missing ownership rule. It is raw
   non-empty but lexically empty. Candidate-row presence is specified for
   non-empty `input` (`:77-80`), while the default fast path is specified for
   empty `input` (`:96-97`). If those checks use lexical emptiness, typing spaces
   and pressing Enter can take the default; with `cwd=/work` and
   `default=/suggested`, that yields `/suggested`, whereas today's stated
   trim → expand → resolve submission pipeline yields `/work`. If they use raw
   emptiness, the design needs to say so and retract the claim that raw spelling
   participates only in Tab rewriting. Assign untouched-empty/default handling,
   candidate-row presence, boundary, filtering, and Enter submission to named
   stages, and pin whitespace-only Enter with `default !== cwd`. The existing
   whitespace-only Tab rule itself is coherent once this distinction is made:
   lexical emptiness lists the default and emits an absolute child when that
   directory is outside cwd.

## Verified aligned

- For ordinary relative, absolute, `../`, and repeated-slash forms, filtering
  on the final lexical segment and preserving the lexical prefix makes Tab's
  rewritten value re-resolve to the selected child.
- `~/` composes when boundary and filtering use the lexical form: it lists home
  with an empty filter, and `~/child/` re-resolves to that child.
- `~user`, including whitespace before it, fails during expansion before a
  resolved value or listing exists; the no-answer row and inert Enter/Tab
  behavior remain coherent.
- The Enter/Tab split remains sound for valid non-empty input: Enter targets the
  highlighted literal row, while Tab independently targets the best-ranked
  child. The remaining defect is choosing the correct directory/filter before
  that split, not the split itself.
