# 159 — Typeahead directory picker for "Which directory should rbox sync?"

Status: DRAFT v2 (folded review round 1 — rulings in Decisions; r1 at
`.claude/review-159-r1.md`). Origin: validation item #8, founder-greenlit
design pass 2026-07-18.

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

- ONE piece of state: the **visible input string**. It is always resolved
  against an immutable base = `opts.default ?? cwd` (r1 f10), with `~` and
  absolute forms via `expandUserPath`.
- Derived, never stored: `resolved = resolve(base, input)`;
  `listDir = input ends with "/" ? resolved : dirname(resolved)`;
  `filterTerm = input ends with "/" ? "" : basename(input)`.
- Tab = rewrite the visible input to the highlighted child's path + `/`.
  Backspace is just string editing — deleting past a `/` naturally re-lists
  the parent because `listDir` is derived. Trailing/repeated slashes,
  `..`, absolute, and `~/` all fall out of resolve(); state-transition tests
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
   row 1 by typing them. Symlinks-to-directories are listed (lstat dirent +
   the same acceptance rule as today's downstream behavior; never followed
   for listing).
- Bare Enter with empty input answers `base` — today's fast path exactly.
- Enter otherwise answers the highlighted row. Because filtering is
  synchronous over a cached listing (below), there is no loading window for
  Enter to race (r1 f4).

### Listing + performance (r1 f6 accepted)

- ONE `readdir(listDir, { withFileTypes: true })` per distinct `listDir`,
  cached for the prompt's lifetime; keystrokes filter the cache
  synchronously. Cache invalidates only when `listDir` changes (documented
  tradeoff: directories created mid-prompt appear only after re-anchor).
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

## Decisions (r1 rulings)

f1 ACCEPT — free-form answers preserved via pinned `use "<input>"` row;
existence claim retracted. f2 ACCEPT — custom @inquirer/core prompt; state
machine specified. f3 ACCEPT — folded into row-1 rule (+symlink listing).
f4 ACCEPT — collapsed by synchronous cached filtering. f5 ACCEPT — rig
drives the real picker; no global escape; flow audit enumerated. f6 ACCEPT —
one readdir per listDir + sync filter + perf fixture. f7 ACCEPT — single
visible-input state, derived listDir, immutable base. f8 ACCEPT —
recoverable error rows. f9 ACCEPT — total comparator with span score.
f10 ACCEPT — base = default ?? cwd; opts.input forces plain; byte-identical
scoped. f11 ACCEPT — caller copy authoritative; hint separate. f12 ACCEPT —
flow citations corrected.
