# Adversarial design review — 159 typeahead directory picker (round 3)

## Verdict: CHANGES-REQUIRED

V3 resolves all five round-2 mechanism findings: empty input is now a path
boundary, Enter and Tab have separate executable targets, cache misses are
explicitly blocking, symlink directories are classified by following `stat`,
and typed paths remain cwd-relative while `default` remains the bare-Enter
answer. The remaining issues are narrower contract edges and specification
ambiguities, not objections to the picker architecture.

## Findings

1. **MED — The `~user` error state cannot also retain the promised selectable use-input row.**

   V3 says every non-empty input gets a pinned `use "<resolved>"` row that
   answers with the resolved input, and that free-form input is always accepted
   (`docs/design/159-typeahead-directory-picker.md:52-58`). Its error contract
   then says `~user`/`UnsupportedPathError` renders like a read error, where row
   1 remains selectable (`docs/design/159-typeahead-directory-picker.md:92-98`).
   But `expandUserPath` throws for every leading `~user` form before a resolved
   value exists (`src/cli/prompt.ts:66-78`). Current `promptPath` catches that
   error and re-prompts rather than returning the raw path
   (`src/cli/prompt.ts:94-101`), behavior pinned by
   `src/cli/prompt.test.ts:16-27`.

   Specify the invalid-expansion transition separately from filesystem listing
   errors: there can be no answer-bearing use-input row for `~user`, Enter must
   remain in the editor, and editing must remain live. Add a real-picker test
   for that state; the required plain-mode parity test alone does not pin it.

2. **MED — Tab's visible-path rewrite is undefined when `default !== cwd`.**

   Empty input intentionally lists children of `resolve(cwd, default)` while
   every subsequent relative visible input resolves against cwd
   (`docs/design/159-typeahead-directory-picker.md:27-38`). The only concrete
   completion rule/example is `pro` to `project/`
   (`docs/design/159-typeahead-directory-picker.md:39-46`). With
   `{ cwd: "/work", default: "/suggested" }`, initial Tab may choose the shown
   `/suggested/child`; rewriting the line to `child/` would immediately derive
   `/work/child`, a different directory. Production currently passes
   `default === cwd` at all three sites (`src/cli/init-cmd.ts:82-84`;
   `src/cli/setup-cmd.ts:657,710`), so this is an exported-contract edge rather
   than a live-call-site blocker.

   Define completion construction exactly. For example, replace only the
   textual basename for non-empty inputs, but emit an absolute or cwd-relative
   path when completing a child from an empty-input default outside cwd. The
   same rule should state whether `~/`, `../`, absolute, and repeated-slash
   spellings are preserved; the named transition tests currently do not state
   their expected visible strings (`docs/design/159-typeahead-directory-picker.md:47-50,141-145`).

3. **MED — The explicit default formulas omit today's trim-and-tilde normalization pipeline.**

   Current `promptPath` applies `.trim()`, then `expandUserPath`, then
   `path.resolve(opts.cwd, ...)` to the widget answer, including an answer
   supplied by `opts.default` (`src/cli/prompt.ts:94-101`). V3 instead writes
   the initial-list formula literally as `resolve(cwd, default ?? ".")` and
   describes bare Enter only as resolving `opts.default ?? cwd` against cwd
   (`docs/design/159-typeahead-directory-picker.md:32-38,71-72`). Thus a default
   of `~` is written as listing `<cwd>/~` even though today's bare Enter returns
   the home directory; whitespace-bearing defaults are similarly unspecified.
   Also, with no default and a relative injected cwd, resolving `cwd` against
   itself is not equivalent to today's resolution of the empty answer.

   State one canonical submission/default normalization pipeline and use the
   empty raw answer—not cwd itself—for the no-default case. Pin a tilde default,
   whitespace normalization, and unsupported-tilde default retry if the claim
   remains “today's fast path exactly.”

4. **LOW — The cache freshness contract gives mutually exclusive revisit behavior.**

   “ONE ... per distinct `listDir`” cached for the prompt's lifetime requires a
   lifetime map, so an A → B → A revisit must reuse A's old listing
   (`docs/design/159-typeahead-directory-picker.md:81-85`; reiterated by the
   one-read test at `:148-149`). The next sentence says the cache invalidates
   when `listDir` changes and that directories created mid-prompt appear after
   re-anchor (`docs/design/159-typeahead-directory-picker.md:85-87`). If
   re-anchor means leaving and returning, that requires rereading A and violates
   the one-read rule; if it means first entry into another directory, it never
   refreshes A.

   Choose lifetime memoization (mid-prompt changes to an already visited
   directory never appear) or current-anchor eviction/re-read-on-return, then
   make the prose and A → B → A cache test agree.

## Verified aligned

The round-2 fixes themselves match the current code and installed primitive:
`promptPath` currently resolves typed answers against `opts.cwd` and treats the
default as the widget's answer (`src/cli/prompt.ts:83-101`); setup follows
symlinks through its injected `stat` (`src/cli/setup-cmd.ts:619,713-718`); and
the installed `@inquirer/core` exposes the key/state primitives needed for the
explicit Enter/Tab split. Blocking `readdirSync` removes the stale-row race
identified in rounds 1-2 rather than merely hiding it in the rig.
