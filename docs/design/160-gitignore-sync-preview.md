# 160 — Gitignore sync preview: show what will and won't sync before first sync

Status: **ALIGNED + PARKED** (founder call 2026-07-19: preview feature
parked; the honest-copy relabel shipped separately as a copy-only PR. v5;
4 review rounds — r4 ALIGNED with 3 editorial LOWs, fixed + self-certified). Origin: validation item #9, founder greenlit design pass
2026-07-18 (design only; ship decision separate).

## Problem (field evidence)

The gitignore step (`GITIGNORE_CHOICES`, `src/cli/init-cmd.ts:111`) asks
"How should rbox handle gitignored files?" as a blind policy choice. The
founder's validation dir had no root `.gitignore`, making the choice feel
unverifiable — the user can't see what it means for THEIR tree before a first
sync of 100k+ files.

## ⚠ FOUNDER DECISION REQUIRED (surfaced by review r1, exists TODAY)

The engine respects the workspace-root `.gitignore` in BOTH modes
(`buildIgnoreMatcher` adds it to the legacy layer unconditionally,
`src/engine/ignore.ts:281-288`; design 72 §preserved-legacy). Builtin rules
(`.env`, `node_modules/`, …) and `.rboxignore` also apply in both modes. The
`respect-gitignore` flag toggles nested-`.gitignore` honoring AND tracked
protection (r3 f4 — the two effects together produce the inverse set B′
below). So the shipped option-2 label "Sync gitignored files too"
overpromises **today**: a root-ignored untracked file is not synced under it
(unless a `.rboxignore` negation re-includes it — r3 f2 correction; the
choice VALUES and default stay unchanged either way; only the label text is
in question). Options: (a) relabel option 2
honestly ("Also sync files ignored by nested .gitignores…"), or (b) change
engine semantics so option 2 ignores the root `.gitignore` layer too. This
design assumes **(a) relabel** (semantics changes are a non-goal here) but the
call is the founder's; the preview below tells the truth either way.

## Mechanism — preview as an ACTION row in the existing select

The two policy VALUES and the default stay unchanged (option 2's label text
is pending the founder call above; the old label is shown for placement
only). A third,
non-policy row is appended to the PROMPT LIST (not to `GITIGNORE_CHOICES`,
which stays two-valued):

    › Skip gitignored untracked files (recommended)
      Sync gitignored files too (end-to-end encrypted)      ← label per founder call above
      Preview what each choice syncs…

**Widget contract (r1 f6 accepted):** `@inquirer/select` rows always complete
the widget — there is no non-answering row at the widget layer. The preview
row completes the select with a sentinel value and `short: "Previewing…"`
(truthful transcript), the preview prints, and the select re-renders. Loop
until a policy row answers. Tested at the wrapper level (transcript-visible
behavior), not just a mocked sentinel.

**Shared step (r1 f7 + r2 f4 accepted):** new `src/cli/gitignore-step.ts`
exporting `runGitignoreStep(root, deps): Promise<"true" | "false">` — deps
inject select, preview runner, stderr writer, clock/budget. `root` MUST be
absolute and planner-resolved: direct init passes
`path.resolve(cwd, next.root ?? cwd)` (exactly the `resolveInitPlan` rule,
init-plan.ts:168-170) so a relative `--root` can never preview a different
tree than first sync targets; setup passes its already-resolved `dir`
unchanged. Live-call-site test: relative `--root` + injected `cwd` ≠
`process.cwd()`. BOTH call sites switch to the helper; the sentinel can never
escape as a policy value (return type forbids it). Existing pinned tests keep
pinning `GITIGNORE_CHOICES`; new tests pin the step's mapping at both call
sites (init stores the string; setup converts `=== "true"` — r2-verified
sound).

## The preview computation

**Four-set model (r1 f1 + r2 f1 + r3 f2 accepted):** the sets are defined
EXTENSIONALLY by the truth table of final resolver results under
`(respectGitignore: true, respectGitignore: false)` — never by rule source:
- **A = (skip, skip)** — common causes: builtin rules, positive `.rboxignore`
  matches, root `.gitignore` on untracked files.
- **B = (skip, sync)** — common cause: nested-`.gitignore` matches on
  untracked files.
- **B′ = (sync, skip)** — the INVERSE set: root-gitignored syncable entries
  (files AND symlinks — tracked protection covers any non-directory,
  ignore.ts:426-437) that the resolver protects as tracked or POSSIBLY
  tracked (unavailable index ⇒ protected, ignore.ts:391).
- **C = (sync, sync)** — includes `.rboxignore`-negation rescues of
  root-ignored paths.
The listed causes are typical, not definitional; fixtures must include a
tracked symlink or unavailable-index inverse case.
Rendering: when B′ is empty, delta framing ("either way rbox skips: …(A)…;
'skip gitignored' additionally skips: …(B)…"). When B′ is nonempty, switch to
per-choice framing (one "would skip" summary per row) — delta copy cannot
state an inverse set without misleading. The parity fixture MUST include a
tracked file matched by the ROOT `.gitignore` (nested-only fixtures miss this
edge).

**Decision source (r1 f2, f4, f5 accepted):**
- Decisions come from the production resolver — never a reimplementation.
  New construction option `buildIgnoreMatcher(root, { …, readOnly: true })`:
  identical decisions, but tracked-set cache misses compute in memory WITHOUT
  `writeTrackedCache` — no `.rbox/` creation or mutation pre-workspace.
  Contract test: before/after filesystem snapshot on a real git repo with an
  index and no `.rbox`.
- **Attribution:** the resolver exposes inclusion booleans, not winning
  patterns (`IgnoreMatcher`, ignore.ts:191-205). The summary key is therefore
  **skipped groups/paths**, not patterns: top-level skipped directories with
  estimated descendant counts from the preview's own descent, plus named
  top-level skipped files. Copy says "groups", never "+N more patterns".
- **Walker:** a dedicated bounded inventory walker (streaming `fs.opendir`)
  that — unlike the scanner — DESCENDS into skipped directories to estimate
  their size. Explicitly not walker-parity with `scanManifest`; only the
  per-path DECISION comes from the shared resolver. **Ancestor-prune state
  (r3 f1):** traversal carries an independent ancestor-pruned flag PER
  POLICY. Once a policy's `prunes(dir)` is true, every syncable descendant is
  classified skipped for THAT policy without further resolver consultation
  for that policy (descent continues only for bounded count/size estimates —
  and never consults descendant `.gitignore` files for a pruned policy,
  preserving the "effective rule files" count). When `prunes(dir)` is false
  but `ignores(dir)` is true, descendants are classified INDIVIDUALLY —
  a directory is never group-labeled from its own `ignores()` result
  (root-ignored dirs can hold tracked-protected descendants,
  ignore.ts:440-452). The pruned-directory fixture asserts per-policy group
  counts under exactly this contract. Symlinks: classified as single entries,
  never followed. Unreadable dirs: counted once + noted. Paths vanishing
  mid-walk: skipped silently.

**Budget (r1 f3 + r2 f2/f3 accepted):** ONE shared internal **work-unit**
budget spans matcher PREPARATION (repo discovery — made streaming too — and
per-repo trackedness loads) and traversal, threaded as
`buildIgnoreMatcher(root, { readOnly: true, budget })`; ~2s cooperative
deadline checked between fs/subprocess operations (single blocked syscall or
`spawnSync` can overshoot — stated limitation). **Result shape (r3 f3):**
budgeted construction alone returns a discriminated result —
`{ complete: true, matcher } | { complete: false, reason }` — via overload;
the existing unbudgeted call sites keep the plain `IgnoreMatcher` return.
The preview builds BOTH policy matchers from the SAME budget and exposes
neither unless both are complete. **Cap during PREPARATION fails closed:**
the build returns the incomplete result and the preview ABORTS with honest
copy (`this tree is too large to preview quickly —
the choice still applies as described`) — a partially prepared matcher must
never present decisions (undiscovered repos would misclassify tracked files
as untracked). Cap during the inventory walk truncates normally. Work units
(dirents + repo probes, possibly double-charged across phases) are INTERNAL;
the rendered count uses a separate distinct-inventory-entries counter:
`previewed the first N entries — larger trees are sampled`. Cap tests at all
THREE boundaries (mid-discovery; BETWEEN per-repo tracked-set loads on a
multi-repo fixture, asserting the same incomplete abort with zero rendered
decisions; and mid-walk), asserting both counters and the rendered copy.

**Capped-copy honesty (r1 f8 accepted):** "found" counts only *encountered,
effective* `.gitignore` files (files under pruned/excluded parents are not
consulted by the resolver and are not counted). No-root case renders:
`among the entries previewed, found 14 effective .gitignore files in
subfolders (none at the root)` — "effective" is defined as files consulted
by the `respectGitignore: true` policy (the false policy consults none; one
owner prevents conforming implementations from rendering different counts). Under cap, never print exact remainder
claims; use `additional rules may exist beyond the preview limit`.

## Output sketch (dim, ≤15 lines)

    found 14 effective .gitignore files in subfolders (none at the root)
    either way rbox skips: node_modules/ (~9,400 files) · .env · dist/ (~1,100) · +3 groups
    "skip gitignored" additionally skips: coverage/ (~800 files) · build/ (~350) · +2 groups
    everything else syncs under both choices (~101,000 files, ~1.8 GB)
    previewed the first 20,000 entries — larger trees are sampled

## Tests the implementation MUST write
- **Parity oracle (r1 f9 accepted, the load-bearing one):** on an UNCAPPED
  fixture, for every syncable file/symlink, preview classification under each
  policy equals `scanManifest` inclusion with the corresponding production
  matcher options. Fixture must include: root + nested rules, a
  tracked-but-ignored file, an untracked ignored file, builtin `.env`,
  `.rboxignore` negation under an ignored parent, a symlink, a pruned
  directory, and a `.gitignore` beneath an excluded parent. Cap mechanics and
  sampled-copy honesty are tested separately — never mixed into the oracle.
- Read-only mode: identical decisions to default mode + zero fs mutations
  (snapshot assert) + zero network.
- Step loop: preview never answers; both call sites map policy rows
  identically; sentinel unrepresentable in the return type.
- Budget: entry accounting covers discovery + git probes + walk; large-dir
  fixture confirms streaming (no full-listing allocation blowup).

## Non-goals
- No engine semantics changes (the option-2 label question is the founder's
  separate call; if (b) is chosen a subsequent revision redefines the sets).
- No per-pattern toggling (`rbox ignore --review` is separate backlog).
- No third POLICY; two choices, one preview action.

## Decisions (r1 + r2 rulings)
R1, all 9 accepted: f1 set model (+ founder flag above); f2 readOnly resolver
mode with snapshot test; f3 single cooperative budget with overshoot
semantics + streaming opendir; f4 groups-not-patterns summary; f5 dedicated
descending walker, resolver-only sharing; f6 sentinel-completes-widget
transcript contract + wrapper-level test; f7 named shared step with typed
return; f8 effective/encountered counting + honest cap copy; f9 parity
oracle as specified.
R2, all 4 accepted: f1 FOUR-set model (inverse B′ = tracked root-ignored;
per-choice copy when B′ nonempty; root-tracked parity fixture); f2 budget
threaded into matcher preparation, streaming discovery, fail-closed
incomplete result — never partial decisions; f3 internal work units separated
from rendered inventory count; f4 seam requires absolute planner-resolved
root (init resolves via the planner rule; live-call-site test with injected
cwd). R2 also confirmed readOnly feasibility (suppress only the
writeTrackedCache call at ignore.ts:608; all cache branches preserved).
R3, all 4 accepted: f1 per-policy ancestor-prune state in the walker (pruned
policy stops resolver consultation; ignored-but-unpruned dirs classify
descendants individually); f2 truth-table set definitions, B′ broadened to
tracked/possibly-tracked non-directories incl. symlinks, founder-warning
`.rboxignore`-negation correction; f3 discriminated budgeted-build result,
both policy matchers share one budget, neither exposed unless both complete;
f4 three cap boundaries incl. between tracked-set loads; policy prose fixed
(flag toggles nested honoring AND tracked protection).

## Future evolution (founder idea, 2026-07-19 — separate design when picked up)

When setup finds `.gitignore` files (the scanner already discovers them
recursively), offer a SUGGESTED `.rboxignore`: scan for secret-shaped file
NAMES only — `.env`, `.env.*`, `.dev.vars`, and similar patterns — by
EXISTENCE, never reading contents, and propose the inverse (`!.env`,
`!.dev.vars`) so a solo dev's secrets sync E2EE between machines without
being committed. The pitch: gitignored build/test outputs stay unsynced,
but the files you gitignore *because they're secrets* are exactly the files
an E2EE sync should carry. Opt-in suggestion, never automatic; composes
with this design's preview (the suggestion could render inside it).
