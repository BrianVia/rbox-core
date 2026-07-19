# 160 — Gitignore sync preview: show what will and won't sync before first sync

Status: DRAFT v2 (folded review round 1 — all 9 findings ruled accepted, see
Decisions). Origin: validation item #9, founder greenlit design pass
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
`respect-gitignore` flag ONLY toggles nested-`.gitignore` honoring. So the
shipped option-2 label "Sync gitignored files too" overpromises **today**:
root-ignored files are never synced under it. Options: (a) relabel option 2
honestly ("Also sync files ignored by nested .gitignores…"), or (b) change
engine semantics so option 2 ignores the root `.gitignore` layer too. This
design assumes **(a) relabel** (semantics changes are a non-goal here) but the
call is the founder's; the preview below tells the truth either way.

## Mechanism — preview as an ACTION row in the existing select

Two policy choices stay exactly as-is (default unchanged). A third,
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

**Shared step (r1 f7 accepted):** new `src/cli/gitignore-step.ts` exporting
`runGitignoreStep(root, deps): Promise<"true" | "false">` — deps inject
select, preview runner, stderr writer, clock/budget. BOTH call sites
(`init-cmd.ts:102-107`, `setup-cmd.ts:796-800`) switch to it; the sentinel
can never escape as a policy value (return type forbids it). Existing pinned
tests keep pinning `GITIGNORE_CHOICES`; new tests pin the step's mapping at
both live call sites.

## The preview computation

**Three-set model (r1 f1 accepted — the policy delta is nested-only):**
- **A. Skipped under BOTH choices:** builtin rules, `.rboxignore`, root
  `.gitignore` (legacy layer).
- **B. Skipped only under "respect nested gitignores"** — the ACTUAL
  difference between the two rows.
- **C. Synced under both.**
The rendered comparison is honest: "either way rbox skips: …(A)…; choosing
'skip gitignored' additionally skips: …(B)…".

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
  per-path DECISION comes from the shared resolver. Symlinks: classified as
  single entries, never followed. Unreadable dirs: counted once + noted.
  Paths vanishing mid-walk: skipped silently.

**Budget (r1 f3 accepted):** ONE shared budget spans the whole preview —
git-repo discovery, trackedness resolution, and traversal. An "entry" = one
dirent processed OR one git repo probed. Caps: 20k entries AND a ~2s
**cooperative deadline** (checked between filesystem/subprocess operations;
a single blocked syscall or `spawnSync` can overshoot — stated limitation,
no abortable-subprocess architecture for a preview). On cap:
`previewed the first 20,000 entries — larger trees are sampled`.

**Capped-copy honesty (r1 f8 accepted):** "found" counts only *encountered,
effective* `.gitignore` files (files under pruned/excluded parents are not
consulted by the resolver and are not counted). No-root case renders:
`among the entries previewed, found 14 effective .gitignore files in
subfolders (none at the root)`. Under cap, never print exact remainder
claims; use `additional rules may exist beyond the preview limit`.

## Output sketch (dim, ≤15 lines)

    found 14 effective .gitignore files in subfolders (none at the root)
    either way rbox skips: node_modules/ (~9,400 files) · .env · dist/ (~1,100) · +3 groups
    "skip gitignored" additionally skips: coverage/ (~800 files) · *.log files in 6 folders
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
  separate call; if (b) is chosen this design gets a v3 with set A redefined).
- No per-pattern toggling (`rbox ignore --review` is separate backlog).
- No third POLICY; two choices, one preview action.

## Decisions (r1 rulings)
All 9 findings accepted: f1 three-set model (+ founder flag above); f2
readOnly resolver mode with snapshot test; f3 single cooperative budget with
overshoot semantics + streaming opendir; f4 groups-not-patterns summary; f5
dedicated descending walker, resolver-only sharing; f6 sentinel-completes-
widget transcript contract accepted + wrapper-level test; f7 named shared
step `runGitignoreStep` with typed return; f8 effective/encountered counting
+ honest cap copy; f9 parity oracle as specified.
