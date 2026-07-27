# Adversarial design review — 159 typeahead directory picker (round 1)

## Verdict: CHANGES-REQUIRED

The user problem is real, but the proposed mechanism is not implementable as specified on the pinned `@inquirer/search` primitive, and it changes an intentional path-acceptance contract. In particular, setup currently accepts a nonexistent typed path and then asks whether to create it; an existing-directory-only picker removes that behavior and breaks a live regress flow. The design also needs a concrete, testable state machine for the stock search widget, an explicit rig strategy, and a cache/performance contract before implementation.

## Findings

1. **BLOCKER — The existing-directory guard changes accepted behavior; it is not “existing `promptPath` validation.”**

   The design requires the answer to exist and be a directory and says `promptPath` already supplies permissions/type validation, so only *how* a path is chosen changes (`docs/design/159-typeahead-directory-picker.md:55-58`). The code says otherwise: `promptPath` only asks, trims, expands a leading tilde, and calls `path.resolve`; it performs no `stat`, access, type, or permissions check (`src/cli/prompt.ts:83-102`). Create-new setup deliberately receives an arbitrary path, catches `ENOENT`, asks whether to create it, and calls recursive `mkdir` only after consent (`src/cli/setup-cmd.ts:707-731`). That contract is pinned both by the unit test that cycles `/missing` → `/file` → `/done` (`src/cli/setup-cmd.test.ts:701-730`) and by `typo-no-phantom`, which types two nonexistent names and expects the create confirmation without a remote workspace appearing (`scripts/ux/flows/typo-no-phantom.flow.ts:8-21`).

   The design must preserve free-form nonexistent answers where callers support them, or split the picker policy by call site and justify the behavior change. It must also retract the claim that existence/permissions are reused from `promptPath`.

2. **BLOCKER — The proposed Enter/Tab model has no executable mapping onto the wrapped search prompt.**

   `promptSearch` only forwards the stock search configuration (`src/cli/prompt.ts:60`). The installed and locked implementation (`@inquirer/search` 4.2.1 via `@inquirer/prompts` 8.5.2, `bun.lock:179`) gives callers `source(term, {signal})`, `validate(value)`, choices, and theme; it does not expose a key handler. It resets the active item to the first selectable result after source refresh (`node_modules/@inquirer/search/dist/index.js:53-79`), Enter validates/submits the highlighted value or performs the widget's own autocomplete (`:96-119`), and Tab merely replaces the line with `selectedChoice.name` (`:121-125`).

   That conflicts directly with “anchor is always the first row” (`design:25-30`): after typing, the refreshed first selectable row remains the anchor, so `type, Tab, Enter` can complete/select the anchor unless the user sends an undocumented Down key. The primitive also cannot directly observe “Tab” to append `/`, or enforce “Enter submits a child only on exact input/one match,” without an encoding trick through choice names/values and validation. The design needs to spell out that encoding, including row order/selectability and what Enter does for a partial multi-match; otherwise it must admit a custom `@inquirer/core` prompt or a fork instead of claiming the existing wrapper is sufficient.

3. **HIGH — “Filtered out but reachable by literal path” is unsupported, as is raw unmatched input generally.**

   The design removes `.git`, `node_modules`, and `.rbox` from choices while promising that typing the literal path can still reach them (`design:26-30`). Stock search can return only a highlighted choice. With no selected choice, Enter restores the current term and remains in the prompt; it never returns raw input (`node_modules/@inquirer/search/dist/index.js:95-119`). The same gap is why a nonexistent path cannot reach setup's create confirmation. A symlink to a directory is another omitted source edge: `Dirent.isDirectory()` is false for the symlink even though current downstream `stat`-based behavior can accept its target.

   Specify an exact-literal synthetic choice/free-form acceptance rule, including excluded names, symlinked directories, absolute paths, `~`, and nonexistent paths permitted by the caller. Add end-to-end tests that prove the returned value, not merely matcher output.

4. **HIGH — Literal-then-Enter can submit a stale row while asynchronous `readdir` is still loading.**

   The search widget starts a new asynchronous `source` call for each term and aborts only application of stale results (`node_modules/@inquirer/search/dist/index.js:59-92`). Its Enter branch is not gated on `status !== "loading"`; it can validate and return the previous `selectedChoice` while the new source is pending (`:96-105`). Only arrow navigation is loading-gated (`:126-140`). The regress driver sends a whole literal with one `tmux send-keys -l` invocation and then Enter immediately in the next invocation, with no settle barrier (`scripts/ux/tui.ts:146-155`; `scripts/ux/regress.ts:131-134`). With the proposed per-keystroke filesystem read, this is a concrete race back to the old anchor or an earlier match.

   The design must require one of: a custom prompt that ignores Enter while the current term is unresolved, a synchronous cached filter after an anchor read, or an explicit pending-term/result-generation check. Slowing only the rig would hide, not fix, the user race.

5. **HIGH — The fallback contract does not cover the actual regress rig, and a global fallback conflicts with the required picker assertion.**

   Production directory prompts are already TTY-only: interactive init calls `promptMissing` only when stdin is a TTY (`src/cli/init-cmd.ts:161-166`), while guided setup exits before the workspace step when stdin is not a TTY (`src/cli/setup-cmd.ts:170-177`). The regress rig also runs setup under tmux in a real PTY (`scripts/ux/tui.ts:111-116`) and drives it with `tmux send-keys` (`:146-155,177`). Neither the tmux environment nor `containerRboxEnv` sets `RBOX_PLAIN_PROMPTS` (`scripts/ux/tui.ts:111-115`; `scripts/ux/container.ts:95-98`), and the flow schema has no per-TUI environment field (`scripts/ux/flow.ts:13-22,97-104`). Therefore the rig will take the picker, not the proposed non-TTY fallback.

   Define which existing flows exercise the real picker and update their keystrokes/assertions. If some flows intentionally use plain prompts, add a per-session environment contract; setting the escape hatch globally would make the required interactive `type, Tab, Enter` assertion impossible in that same run.

6. **HIGH — The performance argument caps rendering, not the expensive work, and repeats the field failure shape per keystroke.**

   The field case is a home directory with 112k entries (`design:9-16`). `readdir({withFileTypes:true})` must enumerate all entries—including files—before the implementation can retain only directories. The proposed source performs that read “per keystroke” (`design:24-38`). Rendering about 12 rows does not cap enumeration, allocations, filtering, or sorting (`design:60-61`). The widget's AbortSignal prevents stale results from committing, but the design gives no cancellable `readdir` or cache contract (`node_modules/@inquirer/search/dist/index.js:59-92`), so rapid input can launch overlapping full reads.

   Read and cache entries once per anchor, filter synchronously for subsequent characters, and invalidate only on a real re-anchor (with a documented filesystem-change tradeoff). Require a benchmark/test shaped as many files plus few directories, rapid typing, and repeated descent; “O(children)” alone is not an interaction latency bound.

7. **HIGH — The anchor/visible-input invariant is self-ambiguous and can double-resolve paths.**

   The design defines a mutable “current anchor,” then says the prefix before the last slash resolves against that current anchor (`design:25,31-33`). After Tab changes `foo` to visible `foo/` and re-anchors to `<cwd>/foo` (`design:44-45`), applying the stated rule on the next source call can resolve `foo` against `<cwd>/foo`, producing `<cwd>/foo/foo`. Stock Tab necessarily leaves `selectedChoice.name` in the line (`node_modules/@inquirer/search/dist/index.js:121-125`); it offers no separate re-anchor callback. “Backspace across `/` re-anchors to parent” has the same ambiguity because the source sees only the new term, not a boundary event.

   Choose and specify one canonical model: either the visible input is always resolved against an immutable initial base, or descent mutates the anchor and rewrites/clears the visible term accordingly. Cover trailing/repeated slashes, `/`, `..`, absolute paths, `~/`, and backspacing from both `foo/` and `/foo/` with state-transition tests.

8. **MED — Filesystem and path-parse errors have no recoverable prompt contract.**

   `readdir` can reject with `EACCES`, `ENOENT`, or `ENOTDIR` while the user edits/re-anchors, and `expandUserPath` intentionally throws for `~user` (`src/cli/prompt.ts:66-79`). The stock search implementation catches a rejected source and records its message but does not restore `status` to idle (`node_modules/@inquirer/search/dist/index.js:59-92`), leaving navigation disabled by its loading check (`:126-140`). The design incorrectly waves this at “existing validation” (`design:55-58`) and specifies no error row, parent escape, retry, or final validation race if the directory changes after listing.

   Require the source adapter to classify expected path/read errors into recoverable results, preserve a way to edit/back out, and revalidate the final answer at submission. Ctrl-C remains covered by the existing `run` wrapper (`src/cli/prompt.ts:31-37`); the new filesystem errors do not.

9. **MED — Ranking is not a total, unambiguous order.**

   Three independent rules compete: anchor first, dotfolders last, and prefix > substring > subsequence with alphabetical ties (`design:25-38`). The design does not state whether dot-last overrides match class (for example, a dotfolder prefix versus a visible-directory substring), whether the anchor participates in filtering, or how case-insensitive/Unicode/case-only alphabetical ties are broken. It also calls the result fuzzy ranking but gives no within-class score, so query `ab` can rank a very sparse `a---b` ahead of a tight `axb` solely by alphabetic name.

   Define a total comparator and its precedence (for example: anchor sentinel, visibility group, match class, gap/span score if desired, normalized name, raw code-point fallback). Test empty input, dot-prefixed queries, case-only siblings, Unicode, identical normalized keys, and sparse subsequences. If category-only ranking is intentional, say so explicitly.

10. **MED — “Keeps its signature” and “byte-identical fallback” omit existing `default` and injection semantics.**

   Today an arbitrary `opts.default` is accepted by the input widget on bare Enter and then resolved by `promptPath` (`node_modules/@inquirer/input/dist/index.js:11,33-40`; `src/cli/prompt.ts:84-97`). The design always initializes the anchor to CWD and makes bare Enter return CWD (`design:25,46-47`). Current production callers happen to pass `default: cwd` (`src/cli/init-cmd.ts:83`; `src/cli/setup-cmd.ts:657,710`), but that does not preserve the exported function contract. Likewise, `opts.input` is an explicit test/embedding seam (`src/cli/prompt.ts:88-93`); on a TTY, the proposed predicate would bypass it unless injected input itself forces legacy mode.

   Define whether the initial anchor is `default` or `cwd`, whether `opts.input` forces plain mode, and exactly what “byte-identical” covers (prompt config, stderr bytes, resolved answer, and retry behavior). The picker hint must not leak into a supposedly byte-identical plain fallback. Note also that whole-CLI non-TTY parity cannot be observed at these call sites because init skips the prompt and setup rejects before it; test the `promptPath` seam explicitly.

11. **MED — Prompt copy differs at the real call sites and changing it will stall current flows before keys are sent.**

   Init passes `Sync which directory?` (`src/cli/init-cmd.ts:82-84`), but both setup branches pass `Which directory should rbox sync?` (`src/cli/setup-cmd.ts:657,710`). The design mandates the former copy (`design:51-53`) without saying whether `opts.message` remains authoritative. Current regress flows wait for the setup wording before sending input—for example `gitignore-default` (`scripts/ux/flows/gitignore-default.flow.ts:12-16`), `tilde-expansion` (`scripts/ux/flows/tilde-expansion.flow.ts:9-13`), and `typo-no-phantom` (`scripts/ux/flows/typo-no-phantom.flow.ts:8-16`). `waitFor` times out and never advances if the regex does not match (`scripts/ux/regress.ts:140-148`).

   Either preserve caller-provided copy and add the hint separately, or explicitly update both call sites and every affected flow as part of the compatibility contract.

12. **LOW — The design cites the wrong regress flow.**

   `fresh-setup-to-handoff` never drives the directory prompt; it stops at the browser-approval screen (`scripts/ux/flows/fresh-setup-to-handoff.flow.ts:8-27`). Actual prompt-driving coverage includes `gitignore-default`, `status-healthy`, `tilde-expansion`, `typo-no-phantom`, `declined-rebind-menu`, and `empty-join-copy`. Correct the contract and name the exact flow(s) that will prove bare Enter, literal compatibility, nonexistent-path handling, and interactive Tab descent.

## Verified claim with no finding

Explicit/headless `--root` remains outside the picker: `promptMissing` skips `promptPath` when `root` is already present (`src/cli/init-cmd.ts:82-84`), non-interactive init skips `promptMissing` (`:161-166`), and the planner resolves the flag against the injected CWD (`src/cli/init-plan.ts:168-170`). That part of the proposed scope is aligned.
