# Adversarial design review — 159 typeahead directory picker (round 8)

## Verdict: ALIGNED

V8 folds all three round-7 findings without introducing a competing path or
Enter rule. The normative model now has one state tuple (`raw`, highlight), one
staged path projection (`lexical` → `expanded` → `resolved`, with the explicit
semantic-empty default pipeline for `listDir`), one row construction, and one
Enter precedence rule. I found no remaining load-bearing ambiguity.

## State-model audit

- `raw` is the named editor value. Its direct gates are exhaustively stated:
  editor display, default-fast-path eligibility, and use-input-row presence.
- `lexical = trim(raw)` alone owns semantic emptiness, boundary detection,
  filtering, and the Tab branch. This preserves trailing-slash and bare-`~`
  spelling long enough to derive listing and rewrite behavior.
- `expanded = expandUserPath(lexical)` alone owns live unsupported-tilde
  failure. `resolved = resolve(cwd, expanded)` owns the typed-literal row's
  label and answer. `listDir` is derived from boundary/resolved, with the one
  explicit semantic-empty exception through the same canonical submission
  pipeline applied to `default ?? ""`.
- Candidate presence and Enter precedence now refer only to those named fields:
  the synthetic row is present iff `raw !== ""` and answers `resolved`; the
  default fast path requires both `raw === ""` and the highlight on the initial
  row; every other successful Enter answers the highlighted row.

The remaining appearances of the English word “input” are ordinary prose
(such as “visible input string” and “semantic-empty input”), the public
`opts.input` injection seam, the explicitly named “use-input row,” or historical
decision-log quotations. None introduces an unnamed model variable or an
alternate derivation.

## Enter derivations verified

1. **Initial bare Enter, including defaults.** `raw === ""` gives
   `lexical === ""`, a boundary, and no synthetic use-input row. `listDir` is
   obtained by trim → expand → resolve of `default ?? ""`. With the highlight
   still on the initial row, the default fast path returns that same canonical
   result. Thus no default resolves the empty answer under `cwd`, `~` resolves
   home, and `~user` takes the named unsupported/retry transition. The deleted
   `opts.default ?? cwd resolved against cwd` formula does not survive elsewhere.

2. **Whitespace-only Enter with `default !== cwd`.** After the edit,
   `raw !== ""` and the highlight resets to row 1, while `lexical === ""` and
   live `resolved === cwd`. The raw-non-empty rule creates row 1 as
   `use "<cwd>"`; raw non-emptiness disables the default fast path; highlighted-
   row Enter therefore returns `cwd`. The default affects listing through
   `listDir` but cannot replace this answer.

3. **Arrow navigation from the raw-empty initial state.** ArrowDown changes the
   named highlight field without changing `raw`. Although `raw === ""`, the
   highlight is no longer on the initial row, so the conjunction required by
   the default fast path is false. Enter takes the selected child row (or other
   highlighted candidate), never the default. Editing afterward resets the
   highlight according to the stated transition.

4. **Typed literal and invalid expansion.** For valid `raw !== ""`, the pinned
   first row answers the staged `resolved` value, so literal-then-Enter is
   deterministic. For `~user` (including whitespace-prefixed spelling),
   expansion fails before `resolved`; the document explicitly removes the
   use-input row and makes Enter inert, leaving no competing answer.

Whitespace/default/arrow-navigation Enter behavior therefore falls out of the
named state and row rules, with no special-case prose capable of selecting a
second result.
