# 160 — Gitignore sync preview: show what will and won't sync before first sync

Status: DRAFT — review loop pending. Origin: validation item #9
(`docs/validation-2026-07-18-new-user-flow.md`), founder: "table this for now
but worth exploring" → design pass greenlit 2026-07-18 (design only; ship
decision separate).

## Problem (field evidence)

The gitignore step (`GITIGNORE_CHOICES`, `src/cli/init-cmd.ts:111`) asks
"How should rbox handle gitignored files?" as a blind policy choice. The
founder's validation dir had NO root `.gitignore`, making option 1 ("skip
gitignored") feel unverifiable — the user can't see what the choice means for
THEIR tree before committing to a first sync of potentially 100k+ files.
Original idea: a third option that previews what will/won't sync; founder
amendment: when there's no root .gitignore, recursively find ignore patterns
and surface a truncated summary of what was found.

## Mechanism — preview as an ACTION, not a third policy

Keep exactly two policy choices (founder decision d-2026-07-18 pinned:
default stays "Skip gitignored (recommended)"). Add a non-answering action
row to the same select:

    › Skip gitignored untracked files (recommended)
      Sync gitignored files too (end-to-end encrypted)
      Preview what each choice syncs…

Choosing "Preview…" runs the preview then RE-RENDERS the same select (loop
until a policy row is picked) — the pattern the wizard already uses for
info-then-reprompt navigation. It never becomes the answer, so the choice
mapper's two-value contract (and every pinned test/flow) stays two-valued.

### The preview computation
- Reuse the engine's existing ignore machinery — the scanner already resolves
  gitignore + .rboxignore decisions (design 133 lineage; `respect-gitignore`
  flip). The preview MUST call the same resolver the real scan uses (single
  source of truth; a parallel reimplementation WILL drift). If the current
  resolver is not cleanly callable pre-workspace, extracting that seam is
  part of this design's implementation.
- Bounded walk: breadth-first from the chosen root, hard caps (e.g. 20k
  entries or 2s wall clock, whichever first) — this is a PREVIEW, not an
  audit; on cap, say so: `previewed the first 20,000 entries`.
- Output (dim, ~15 lines max):
  - `found N .gitignore files (root: yes/no)` — the founder's no-root case
    reads `found 14 .gitignore files across subfolders (none at the root)`.
  - Top ignored-by-size/count summary: `would skip: node_modules/ (~9,400
    files), dist/ (~1,100), .env, …` truncated with `+N more patterns`.
  - One line for the flip side: `sync-everything would additionally upload
    ~X files / ~Y size` (from the same walk's tally).
- No network, no writes, no state; pure read + print.

### Copy contract
The preview must name CONSEQUENCES, not mechanisms: "would skip" / "would
also upload", never "pattern matched". Secrets framing stays honest: the
existing option-2 description already covers E2EE; the preview adds
`.env would be skipped` visibility precisely where Max-class users worry.

## Contracts
- `GITIGNORE_CHOICES` stays exported with two policy values; the preview row
  is additive with a distinct non-policy value consumed by the wizard loop.
- Non-interactive paths never preview.
- Works in both `rbox init` and `rbox setup` (shared step module).

## Tests the implementation MUST write
- Preview-then-choose loop: preview never answers; each policy row still maps
  identically (pinned like `startSyncActions`).
- Resolver parity: a fixture tree where preview's skip-set EQUALS the real
  scanner's skip-set (the anti-drift test — this is the load-bearing one).
- Cap behavior: truncation line renders at the cap; no unbounded walk.
- No-root-gitignore fixture renders the "across subfolders" line.

## Non-goals
- No interactive per-pattern toggling (that's `rbox ignore --review`,
  separate backlog idea).
- No third POLICY. Two choices, one preview action.
- No change to .rboxignore semantics or defaults.

## Open decision for review
Whether the preview walk can reuse the scanner's walker directly (with an
early-stop visitor) vs. a dedicated bounded walker sharing only the ignore
resolver — pick whichever keeps ONE ignore-decision code path; the walker may
differ, the RESOLVER may not.
