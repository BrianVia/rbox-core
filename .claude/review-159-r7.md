# Adversarial design review — 159 typeahead directory picker (round 7)

## Verdict: CHANGES-REQUIRED

V7 finally makes the lexical → expanded → resolved projection itself singular
and executable. Boundary, filtering, Tab rewriting, and ordinary non-empty
Enter now compose under that projection. However, the candidate-row and Enter
rules still sit outside it and reintroduce an undefined `input` plus two
competing empty-Enter transitions. The document therefore does not yet have
exactly one complete state model.

## Findings

1. **HIGH — Candidate-row presence still uses an undifferentiated `input`, so whitespace-only Enter cannot be derived from the canonical stages.**

   The canonical model says there is no undifferentiated `input`, assigns
   semantic emptiness to `lexical`, assigns the row-1 label and answer to
   `resolved`, and says raw participates in exactly two rules
   (`docs/design/159-typeahead-directory-picker.md:31-56`). The candidate
   section nevertheless creates row 1 whenever “input is non-empty” and says
   it answers with the “raw resolved input” (`:77-80`).

   Take `raw = "   "` with `default !== cwd`. Then `lexical === ""`,
   `resolved === cwd`, `listDir === resolve(cwd, normalizedDefault)`, and the
   raw-empty fast path is ineligible. If candidate “input” means `lexical`,
   there is no use-input row; `use this directory (<listDir>)` is the first
   selectable row, so “Enter otherwise answers the highlighted row” returns
   the default (`:87,96-98`). That contradicts the explicitly pinned cwd answer
   (`:51-56`). If “input” means raw, the intended cwd answer is implementable,
   but raw also owns candidate presence/highlight construction, contradicting
   the exactly-two-rules claim, while “raw resolved” weakens `resolved`'s stated
   ownership.

   Make the transition explicit: for example, the use-input row exists when
   `raw !== ""` and its label/answer is `resolved`; then update the raw-ownership
   statement accordingly. Equivalently, define a normal-submission Enter branch
   that does not depend on a row. Either way, the whitespace case must follow
   from named fields rather than an undefined `input`.

2. **HIGH — Raw emptiness alone cannot key the default fast path after arrow navigation.**

   Highlight index is state, arrow keys move it, and Enter is specified to act
   on the highlighted row (`:27-30,57-60`). At raw-empty initial state,
   `filterTerm` is empty, so the picker exposes the use-this-directory row and
   child rows (`:33-38,87-88`). Arrowing from the first row to a child does not
   edit raw. The raw-empty fast path nevertheless says only raw emptiness keys
   Enter and that bare Enter returns the default (`:48-51,96-98`).

   If that fast path wins, an initial child can be highlighted but never
   selected: Enter returns the default. If highlighted-row Enter wins, raw
   emptiness does not by itself key the fast path. Define precedence using the
   state already present—for example, take the default only when `raw === ""`
   and the highlight remains on the initial use-this-directory row; otherwise
   Enter answers the highlighted row. This must be pinned by an initial
   ArrowDown → Enter child-selection transition.

3. **MED — The candidate section repeats the pre-round-3 default formula instead of referencing the canonical pipeline.**

   The canonical exception correctly defines semantic-empty `listDir` through
   today's trim → expand → resolve pipeline applied to `default ?? ""`, and
   explicitly covers `~`, unsupported `~user`, and no default (`:42-47`). The
   later rule instead says bare Enter answers `opts.default ?? cwd` “resolved
   against cwd” (`:96-97`). Taken literally, `default = "~"` becomes
   `<cwd>/~` rather than home, unsupported `~user` does not take the retry
   transition, and the no-default input is cwd rather than the empty string.
   This is the alternate formula already rejected in round 3
   (`.claude/review-159-r3.md:53-69`). Replace it with a direct reference to the
   canonical default pipeline and its raw-empty gate.

## Verified aligned

- The staged projection at `:31-47` is now the only path projection: lexical
  owns emptiness/boundary/filtering, expansion owns `~user` failure, and
  resolved owns path answers and listing location.
- Empty, slash-terminated, and bare-`~` boundaries select the intended
  directory before expansion can erase spelling information. Non-boundaries
  list `dirname(resolved)` and filter on the last lexical segment.
- Relative, `../`, absolute, repeated-slash, and `~/` Tab rewrites re-resolve
  to the selected child. Bare `~` correctly lists home and rewrites to
  `~/<child>/`. Whitespace-only Tab lists the normalized default and emits an
  absolute child when that default is outside cwd.
- Valid non-empty Enter and unsupported `~user`/whitespace-prefixed `~user`
  compose as specified. The remaining defects are the ownership and precedence
  of empty/semantically-empty Enter, not the staged path projection itself.
