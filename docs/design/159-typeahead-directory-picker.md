# 159 — Typeahead directory picker for "Which directory should rbox sync?"

Status: DRAFT v3 (folded review rounds 1–2 — rulings in Decisions; reviews at
`.claude/review-159-r1.md`, `-r2.md`). Origin: validation item #8,
founder-greenlit design pass 2026-07-18.

## Problem (field evidence)

The workspace step asks for a directory via `promptPath` (`src/cli/prompt.ts:84`)
— a plain text input defaulting to CWD. Founder validation (112k-file home
dir): no hint you can type, no completion, no way to iterate into
subdirectories without typing blind. Wanted: typeahead, Tab like unix
completion, "hit enter or start typing", correct behavior 1–2 levels deep.

## Mechanism

A **custom prompt built on `@inquirer/core`** (r1 f2 accepted — the stock
`search` widget cannot express this keystroke model: no key handler, Tab
overwrites the line, Enter can submit during load). `@inquirer/core` is
already in the dependency tree (it is what `@inquirer/prompts` widgets are
built from) — no new dependency. `promptPath` keeps its exported signature
and becomes this picker on a real TTY; `opts.input` (the test/embedding seam)
forces the legacy plain-input path (r1 f10).

### Canonical state model (r1 f7 accepted — no mutable anchor)

- State: the **visible input string** plus a **highlight index** that resets
  to row 1 on every edit (r2 f2). The resolution base is always the immutable
  `opts.cwd` (r2 f5 — `opts.default` keeps today's meaning: the bare-Enter
  answer, resolved against cwd exactly as now; it is NOT a resolution base).
  `~` and absolute forms via `expandUserPath`.
- Derived, never stored: `resolved = resolve(cwd, input)`;
  **boundary = `input === "" || input.endsWith("/")`** (r2 f1 — empty input
  is a boundary, so the initial listing shows `resolve(cwd, default ?? ".")`,
  not its parent); `listDir = boundary ? (input === "" ?
  resolve(cwd, default ?? ".") : resolved) : dirname(resolved)`;
  `filterTerm = boundary ? "" : basename(input)`. Initial-state test must pin
  BOTH the displayed directory and the bare-Enter answer = default.
- **Key split (r2 f2, the round-2 BLOCKER):** Enter acts on the HIGHLIGHTED
  row — which resets to the pinned use-input row after every edit, so
  type-literal-then-Enter always answers the literal (typo-no-phantom
  contract). Arrow keys move the highlight for Enter selection. **Tab ignores
  the highlight** and completes the visible input to the BEST-RANKED CHILD's
  path + `/` (no-op when no child matches). So `pro` + Tab → `project/`,
  while `pro` + Enter → `use "<cwd>/pro"`. Both contracts hold by
  construction; the type-Tab-Enter flow proves the Tab side.
  Backspace is just string editing — deleting past a `/` naturally re-lists
  the parent because `listDir` is derived. Trailing/repeated slashes, `..`,
  absolute, and `~/` all fall out of resolve(); state-transition tests
  required for each.

### Candidate rows (r1 f1+f3 accepted — free-form input is always accepted)

1. **`use "<resolved>"`** — synthetic row pinned first whenever input is
   non-empty; answers with the raw resolved input, existing or not. This
   preserves the current contract where setup accepts a nonexistent path and
   offers to create it (`setup-cmd.ts:707-731`, pinned by `typo-no-phantom`)
   — the picker changes how paths are found, never what answers are legal.
   Caller-side validation (create-confirm, ENOENT handling) is untouched;
   the v1 claim that `promptPath` validates existence is RETRACTED (it never
   did).
2. **`use this directory (<listDir>)`** — when filterTerm is empty.
3. Child directories of `listDir`, filtered + ranked (below). `.git`,
   `node_modules`, `.rbox` are hidden from suggestions but reachable via
   row 1 by typing them. **Symlink policy (r2 f4):** a dirent that is a
   symlink gets ONE follow-`stat` to classify; symlinks-to-directories are
   listed as children (matching the downstream `stat`-based acceptance in
   setup-cmd.ts:713-718); descent through one simply resolves through it.
   Broken symlinks are omitted from suggestions (row 1 still reaches them).
   The symlink test pins this policy.
- Bare Enter with empty input answers `opts.default ?? cwd` resolved against
  cwd — today's fast path exactly.
- Enter otherwise answers the highlighted row. **Listing policy (r2 f3):**
  cache miss uses BLOCKING `readdirSync` — there is no asynchronous source
  anywhere in the prompt, so no loading window, no generation/abort state,
  and the rig's literal-then-Enter keystroke pattern cannot race. Tradeoff
  accepted and stated: first descent into a very large directory briefly
  blocks the render (same order of cost the eventual scan pays anyway);
  subsequent keystrokes filter the cached listing synchronously.

### Listing + performance (r1 f6 accepted)

- ONE blocking `readdirSync(listDir, { withFileTypes: true })` per distinct
  `listDir` (+ one follow-`stat` per symlink dirent), cached for the prompt's
  lifetime; keystrokes filter the cache synchronously. Cache invalidates only
  when `listDir` changes (documented tradeoff: directories created mid-prompt
  appear only after re-anchor).
- Perf test fixture: many files + few directories (the 112k-entry home-dir
  shape) with rapid typing and repeated descent; interaction latency after
  the initial listing must be allocation-light and synchronous.

### Errors (r1 f8 accepted)

The lister classifies `EACCES`/`ENOENT`/`ENOTDIR` into a recoverable state:
a dim non-selectable notice row (`can't read <dir>: permission denied`) with
row 1 still selectable and editing still live — never a stuck loading state.
`~user` (UnsupportedPathError) renders the same way. The final answer is
revalidated at submit time only by the CALLER, as today.

### Ranking — total comparator (r1 f9 accepted)

Precedence: (1) synthetic use-input row, (2) use-this-directory row,
(3) match class: prefix > substring > subsequence, (4) within class: shorter
match span first (tighter fuzzy wins: `axb` beats `a---b` for `ab`),
(5) non-dot before dot, (6) case-insensitive alphabetical, (7) raw
code-point. Case-insensitive matching; Unicode compared via
`localeCompare`-free normalized form (deterministic across platforms). Cap
rendered rows ~12 with `+N more`. Pure function, exhaustively unit-tested
(empty input, dot-prefixed query, case-only siblings, sparse subsequence).

### Copy (r1 f11 accepted)

`opts.message` stays authoritative — call sites keep their exact current
strings (init: `Sync which directory?`, setup: `Which directory should rbox
sync?`; flows key off these). The picker adds its own dim hint line below:
`Enter = this directory · type to filter · Tab completes`.

## Rig/flow compatibility (r1 f5+f12 accepted)

The rig runs a real PTY, so it drives the REAL picker — there is no global
plain-mode escape (that would make picker assertions impossible). The flows
that exercise this prompt are `gitignore-default`, `status-healthy`,
`tilde-expansion`, `typo-no-phantom`, `declined-rebind-menu`,
`empty-join-copy` (NOT `fresh-setup-to-handoff` — v1 citation corrected).
Compatibility rule that makes most of them survive unchanged: a typed
literal followed by Enter answers that literal (via row 1's pinned-first
position), matching today's type-then-Enter transcripts. Flows must be
audited one-by-one in implementation; new flow coverage required for: bare
Enter fast path, typed-descent (type, Tab, Enter), nonexistent-path →
create-confirm, and a filtered-name literal (`node_modules`).

## Contracts

- `promptPath` signature unchanged; TTY → picker, `opts.input` provided or
  no TTY → byte-identical legacy plain input ("byte-identical" scope: prompt
  config, stderr bytes, resolved answer, retry behavior — the hint line must
  not leak into plain mode).
- `--root`/headless paths untouched (r1 verified aligned).
- No new package.json dependency (uses in-tree `@inquirer/core`).

## Tests the implementation MUST write

- Comparator unit tests (full precedence table + tie cases).
- State transitions: Tab-descend, backspace-past-slash, `..`, `~/`, absolute,
  repeated slashes, double-Tab (no `foo/foo` double-resolution).
- Row-1 acceptance: nonexistent path returns verbatim resolved input;
  hidden-name literal reachable; symlink-to-dir selectable.
- Cache: one readdir per listDir; synchronous filter; no Enter-during-load
  window (no async source at all post-listing).
- Error rows recoverable; plain-mode byte-parity via the `opts.input` seam.
- Flow updates per the audit above.

## Non-goals

- No recursive whole-tree fuzzy search; one level at a time.
- No file selection; no MRU/persistence.
- No change to caller-side create/validation semantics.

## Decisions (r1 + r2 rulings)

R1: f1 free-form answers via pinned `use "<input>"` row, existence claim
retracted; f2 custom @inquirer/core prompt (r2 verified: @inquirer/core
11.2.1 in-tree, exports createPrompt/useKeypress/isTabKey); f3 folded into
row-1 rule; f4 collapsed (now fully, via readdirSync); f5 rig drives the real
picker, flow audit enumerated; f6 one listing per listDir + sync filter +
perf fixture; f7 single input state + derived listDir; f8 recoverable error
rows; f9 total comparator with span score; f10 revised by r2 f5; f11 caller
copy authoritative; f12 flow citations corrected.
R2, all 5 accepted: f1 empty input is a boundary (initial listing = the
default's directory, pinned by an initial-state test); f2 (BLOCKER)
Enter/Tab split — highlight resets to row 1 on edit, Enter takes highlight,
Tab always completes the best-ranked CHILD; f3 blocking readdirSync on cache
miss — zero async, zero loading window, brief-block tradeoff stated; f4
symlinks classified via one follow-stat, listed when target is a directory,
broken ones suggestion-omitted; f5 resolution base is ALWAYS opts.cwd and
opts.default stays the bare-Enter answer (today's exported contract
unchanged).
