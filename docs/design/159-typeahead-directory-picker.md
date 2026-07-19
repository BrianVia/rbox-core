# 159 — Typeahead directory picker for "Which directory should rbox sync?"

Status: DRAFT — review loop pending. Origin: validation item #8
(`docs/validation-2026-07-18-new-user-flow.md`), founder-greenlit design pass
2026-07-18.

## Problem (field evidence)

The workspace step asks "Sync which directory?" via `promptPath`
(`src/cli/prompt.ts:84`; call sites `init-cmd.ts:83`, `setup-cmd.ts`) — a
plain text input defaulting to CWD. The founder's validation run (112k-file
home dir) found: no hint that you can type, no completion, no way to iterate
into subdirectories without typing full paths blind. Wanted: "hit enter or
start typing", typeahead fuzzy-match on the tree, Tab jumps to the next slash
point like unix path completion, and correct behavior when the target is 1–2
levels below CWD.

## Mechanism

Replace the text input with an interactive **directory search prompt** built
on the already-wrapped inquirer `search` prompt (`promptSearch`,
`src/cli/prompt.ts:60`) — no new prompt engine, no new dependency.

### Source set (per keystroke)
- Anchor = the picker's current base directory, initially CWD.
- Candidates = child directories of the anchor (one `readdir` with
  `withFileTypes`, directories only), plus the anchor itself as the first row
  ("use this directory"). Dotfolders listed last; `.git`, `node_modules`,
  and `.rbox` filtered out of suggestions (still reachable by typing the
  literal path).
- Input containing `/` re-anchors: everything before the last `/` resolves
  against the current anchor (or absolute/`~` — reuse `expandUserPath`,
  prompt.ts:74); the remainder is the filter term.
- Filter = case-insensitive subsequence match (fuzzy), ranked: prefix matches
  first, then substring, then subsequence; ties alphabetical. Pure function,
  unit-tested. No fuzzy library — the candidate set is one directory's
  children, so a 30-line matcher is enough (growing-complexity rule: stay on
  the battle-tested primitive, `readdir` + simple ranking).

### Keys
- **Type** → filter within the anchor. **Enter** on a highlighted child →
  select it as the answer IF the input names it exactly or the list has one
  match; otherwise Enter on the anchor row answers with the anchor.
- **Tab** → "next slash point": complete the input to the highlighted
  candidate and re-anchor into it (append `/`), like shell completion.
- **Bare Enter with empty input** → answer = anchor (CWD on first render) —
  preserves today's "just hit enter" fast path exactly.
- **Backspace across the boundary `/`** → re-anchor to parent.
- Esc/ctrl-c semantics unchanged from other prompts.

### Copy
Message: `Sync which directory?` + dim hint
`hit Enter for this directory, or start typing to pick another (Tab completes)`.

### Guards
- Selection must exist and be a directory; the existing validation from
  `promptPath` (permissions, UnsupportedPathError) is reused on the final
  answer — the picker changes HOW a path is chosen, not what is accepted.
- Non-interactive/flag paths (`--root`) untouched.
- Huge directories: cap rendered suggestions (~12) with `+N more`; readdir of
  one level is O(children), never a tree walk — no recursive scanning.

## Contracts
- `promptPath` keeps its signature; internally becomes the picker when TTY,
  falls back to today's text input when not (or under `RBOX_PLAIN_PROMPTS=1`
  escape hatch for tooling/tests that drive stdin).
- The regress rig drives this prompt in flows (`fresh-setup-to-handoff` etc.)
  — flows that today type a literal path then Enter MUST keep working via the
  fallback or by the same keystrokes producing the same answer; the design
  requires a flow assertion for both the fast path (bare Enter) and a
  typed-descent (type, Tab, Enter).

## Tests the implementation MUST write
- Ranking matcher unit tests (prefix/substring/subsequence, ties, case).
- Re-anchoring on `/`, `~`, absolute input; backspace-to-parent.
- Enter-fast-path answers CWD; Tab-completes-and-descends; filtered dotdirs.
- Fallback parity: non-TTY behaves byte-identically to today.

## Non-goals
- No recursive fuzzy search over the whole tree (perf + noise; one level at a
  time like a shell).
- No file selection — directories only.
- No persistence/MRU of previous answers.
