# 199 — Decompose git-cmd by command ownership

Status: IMPLEMENTED (2026-07-24).

## Problem

`src/cli/git-cmd.ts` is 1,283 lines and owns two largely independent commands
plus their shared presentation:

1. `rbox git deferrals` — projection, remediation copy, and resolve-offer
   policy for deferred Git repos;
2. `rbox git resolve` — the much larger snapshot/confirm/discard resolution
   workflow: snapshot identity, reconcile logs, manual-protocol preflight and
   settlement, refusal codes, and JSON/human emission;
3. presentation helpers (field formatting, show/discard printers, refusal
   copy, root-path scrubbing) used by the resolve workflow's outputs.

A reader changing deferrals remediation copy scans resolution-transaction
machinery; a reader changing resolve refusal semantics scans deferrals
projection. The two commands only share a handful of small helpers, so the
coupling is accidental, not essential.

## Goal

Separate the two commands and the resolve presentation into explicit modules
while preserving every existing import from `src/cli/git-cmd.ts`, all runtime
behavior, and every public type. Structural refactor only — byte-identical
bodies except import/export plumbing, following the 194/195 precedent.

## Ownership

### `src/cli/git/deferrals-command.ts`

Owns `rbox git deferrals`: `gitDeferralsCmd`, its deps/options interfaces,
deferral projection rendering, remediation lines, resolve-offer policy
(`shouldOfferResolve`), and the suggested `resolveCommand` string builder.
Never: resolution snapshots, confirmation, discard, or manual-protocol
preflight/settlement.

### `src/cli/git/resolve-command.ts`

Owns `rbox git resolve`: `gitResolveCmd`, verb dispatch, snapshot building
and identity (`buildSnapshot`, `snapshotId`, `reconcileLog`,
`normalizedAfterAuthoredRefs`), recover-first, checkout-journal detection,
manual-protocol preflight and committed-artifact settlement, refusal codes,
and the `ResolveEnvironment`/`GitResolveDeps` seams.
Never: deferrals projection policy or presentation formatting bodies.

### `src/cli/git/resolve-presentation.ts`

Owns resolve output rendering: `GitResolveShow`, `printShow`,
`printDiscardReport`, human ref labels and command strings, lane labels,
field formatting (`displayField`, `briefField`, `checkoutBrief` if resolve-
or deferrals-owned by usage — see placement rule), refusal message copy,
`safeResolveText`/`safeResolveOutput` root scrubbing, and `emit`.
Never: resolution state machines, snapshot identity, or filesystem access.

Placement rule for helpers used by both commands (e.g. `normalizedRepo`,
`incomingFor`, small formatters): place each with the module that owns its
semantics; the other imports it. No shared-utils junk-drawer module. No
cycles: `deferrals-command` may import from `resolve-presentation` (or
`resolve-command` for `resolveCommand`-string reuse) but nothing imports
`deferrals-command` except the facade.

### `src/cli/git-cmd.ts`

Becomes a compatibility facade of explicit named re-exports only (the 194/195
pattern; no `export *`). External callers do not change: `main-dispatch.ts`
keeps its dynamic `import("./git-cmd.js")` for both commands, and both test
files keep importing the facade.

## Dependency direction

```text
git-cmd.ts (facade)
  ├── git/deferrals-command.ts ──> git/resolve-command.ts (resolve-offer string only, if needed)
  │                            └─> git/resolve-presentation.ts (shared formatters, if needed)
  └── git/resolve-command.ts ────> git/resolve-presentation.ts
```

No module imports the facade. If `deferrals-command` needs nothing from the
other two after placement, drop those edges — fewer is better.

## Behavioral invariants

- Every current export of `git-cmd.ts` remains importable from `git-cmd.ts`
  with identical types: `GitDeferralsCmdDeps`, `GitDeferralsCmdOptions`,
  `GitResolveShow`, `ResolveRefusalCode`, `gitDeferralsCmd`, `safeResolveText`,
  `gitResolveCmd`.
- Function bodies move byte-identically; only import specifiers and
  `export` keywords may change.
- Resolve output ordering, refusal codes and copy, JSON shapes, root-path
  scrubbing, and exit codes are unchanged.
- Deferrals rendering, remediation copy, and resolve-offer policy are
  unchanged.
- No test files move or change semantics in this PR (imports may not need to
  change at all since both test files use the facade).

## Compatibility contract

Add `src/cli/git-cmd-surface.test.ts` locking:

- the exact runtime export keys of the facade (`Object.keys(...).sort()`
  equality, the 419 pattern);
- compile-time imports of every exported interface/type.

## CODEMAP changes

Replace the current `git-cmd.ts` line with:

- `git-cmd.ts` — compatibility facade for the git command surface. Never:
  behavior.
- `git/deferrals-command.ts` — `rbox git deferrals` projection, remediation
  copy, resolve-offer policy. Never: resolution transactions or presentation
  bodies.
- `git/resolve-command.ts` — `rbox git resolve` snapshot/confirm/discard
  workflow, manual-protocol preflight/settlement, refusal semantics. Never:
  deferrals policy or output formatting bodies.
- `git/resolve-presentation.ts` — resolve output rendering, human/JSON
  emission, root scrubbing. Never: state machines or filesystem access.

## Deliberate non-goals

- No behavior, copy, or exit-code changes.
- No new abstractions, service objects, or generic frameworks.
- No test relocation.
- No changes to `sync-git/` ownership (deferral data structures stay where
  they are; this splits only the command layer).

## Validation

1. Facade export list equals the pre-refactor export list (surface test).
2. `bun test src/cli/git-cmd.test.ts src/cli/git-cmd-surface.test.ts` green.
3. `bun test src/cli/sync-git/git-sync.test.ts` green (facade consumer).
4. `bun run typecheck` and `bun run guards` green.
5. Move-fidelity audit against main: line-multiset diff plus per-function
   body comparison — every body byte-identical modulo import/export plumbing.
6. CODEMAP updated as specified.

## Result

Built `src/cli/git/{deferrals-command,resolve-command,resolve-presentation}.ts`
and reduced `src/cli/git-cmd.ts` to a 13-line explicit named re-export facade
(7 symbols, no `export *`). Function bodies moved byte-identically; a
move-fidelity diff against `HEAD:src/cli/git-cmd.ts` is CLEAN for all three
modules modulo the only permitted deltas: per-module import headers, five
`export` keywords added in resolve-presentation, and one inline import path
rewrite (`./sync-git/…` → `../sync-git/…`) in `GitResolveDeps.confirmedPush`.

Three ownership corrections vs the design's illustrative lists (rule beats
list; see REVIEW-199.md Round 1): `emit` lives in resolve-command (not
presentation) so presentation stays a cycle-free leaf; `displayField`,
`briefField`, `checkoutBrief` live in deferrals-command by real usage. Final
graph is acyclic: facade → each module; resolve-command → resolve-presentation;
deferrals-command and resolve-presentation are leaves importing only externals.
Three pre-existing dead imports (`applyStateSavePacket`, `carryRepoBaseProof`,
`recordOriginLineage`) were dropped rather than rehomed.

Added `src/cli/git-cmd-surface.test.ts` locking the runtime export keys
(`gitDeferralsCmd`, `gitResolveCmd`, `safeResolveText`) plus compile-time type
imports (`GitDeferralsCmdDeps`, `GitDeferralsCmdOptions`, `GitResolveShow`,
`ResolveRefusalCode`).

Tests: `git-cmd.test.ts` + `git-cmd-surface.test.ts` 44 pass; `git-sync.test.ts`
89 pass / 1 skip; `bun run typecheck`, `bun run guards`, `git diff --check` all
green.
