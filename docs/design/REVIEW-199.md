# Review 199 — git-cmd decomposition

## Round 1 — implementer design check

Verdict: sound after three ownership corrections. The two-command + presentation
split is real; the only defects are in the design's illustrative helper lists,
not its placement rule. Corrections below follow the rule ("each helper lives
with the module that owns its semantics; no cycles; fewer edges better").

Corrections (rule beats illustrative list):

1. `emit` → resolve-command, NOT resolve-presentation. `emit`'s signature is
   `(output: ResolveOutput, json, deps: GitResolveDeps, root)`. `GitResolveDeps`
   is the resolve command's DI seam (capabilityProbe, mutexOptions,
   confirmedPush, progressScheduler…) and `ResolveOutput` references
   `ResolveRefusalCode`/`GitResolveVerb` — all command semantics. Keeping `emit`
   in presentation forces presentation→resolve-command imports, i.e. a cycle
   with resolve-command→presentation. Putting `emit` in resolve-command makes
   resolve-presentation a pure leaf and preserves the design's command→
   presentation direction. `ResolveOutput`, `GitResolveDeps`, `GitResolveVerb`,
   `ResolveRefusalCode`, `ResolveEnvironment`, `ProgressScheduler`,
   `ResolveSnapshot`, `HumanReason`, `SnapshotIdentity` all stay in
   resolve-command.

2. `displayField`, `briefField` → deferrals-command, NOT resolve-presentation.
   Real usage: `displayField` at 240 (inside `briefField`) and 314
   (`gitDeferralsCmd`); `briefField` at 247/251/322/323/328/329/331 — all
   deferrals. Neither is called by any resolve-presentation renderer
   (`printShow`/`printDiscardReport` use `humanRefLabel`/`humanResolveCommand`/
   `laneLabel`). By usage they are deferrals-owned.

3. `checkoutBrief` → deferrals-command. Design self-flagged this ("if resolve-
   or deferrals-owned by usage"). Used only at 330 (`gitDeferralsCmd`).

Consequences / clean-ups:

- resolve-presentation is a leaf: `GitResolveShow`, `HUMAN_LOCAL_ONLY_CAP`,
  `humanRefLabel`, `humanResolveCommand`, `printShow`, `laneLabel`,
  `printDiscardReport`, `keepMineConfirmCommand`, `safeResolveText`,
  `safeResolveOutput`, `refusalMessage`. Imports only externals (path,
  shQuote, status-view, config type, resolution-intent type). No fs access —
  satisfies the design's "never: filesystem access" for presentation.
- deferrals-command imports NOTHING from resolve-command or resolve-presentation
  (design's tentative edges dropped — `resolveCommand`/`shouldOfferResolve`/
  `remediationLines` are all deferrals-local). So "nothing imports
  deferrals-command except the facade" holds trivially.
- resolve-command imports from resolve-presentation only: `printShow`,
  `printDiscardReport`, `keepMineConfirmCommand`, `safeResolveOutput`,
  `refusalMessage`, `type GitResolveShow`.
- Three dead imports in the pre-split file are dropped, not rehomed:
  `applyStateSavePacket` (config), `carryRepoBaseProof`, `recordOriginLineage`
  (base-composer) — imported but unreferenced.

Final graph (acyclic):
```
git-cmd.ts (facade)
  ├── git/deferrals-command.ts   (leaf; externals only)
  ├── git/resolve-command.ts ──> git/resolve-presentation.ts
  └── git/resolve-presentation.ts (leaf; externals only)
```

Facade surface (7, unchanged): `GitDeferralsCmdDeps`, `GitDeferralsCmdOptions`,
`gitDeferralsCmd` (deferrals-command); `GitResolveShow`, `safeResolveText`
(resolve-presentation); `ResolveRefusalCode`, `gitResolveCmd` (resolve-command).

## Round 2 — post-implementation self-review

Move fidelity: confirmed. Sliced the moved line ranges out of
`HEAD:src/cli/git-cmd.ts` and diffed against each new module's body region
(below its import header, with the five added `export` keywords and the one
`../sync-git` inline-import rewrite normalized back). All three diffs are CLEAN
— bodies are byte-identical; nothing reordered, reformatted, or renamed.

Dependency direction: confirmed acyclic. deferrals-command and
resolve-presentation import only externals (verified: neither imports the
other, resolve-command, or the facade). resolve-command imports from
resolve-presentation only (`printShow`, `printDiscardReport`,
`keepMineConfirmCommand`, `safeResolveOutput`, `refusalMessage`,
`type GitResolveShow`). No module imports the facade. resolve-presentation has
no `node:fs`/filesystem import, satisfying its "never: filesystem access"
constraint.

Surface preservation: confirmed. Facade re-exports exactly the pre-refactor 7
symbols with no `export *`; `git-cmd-surface.test.ts` locks the 3 runtime keys
and 4 compile-time types. `main-dispatch.ts` dynamic
`import("./git-cmd.js")` and both consumer test files
(`git-cmd.test.ts`, `sync-git/git-sync.test.ts`) were left untouched and pass.

Adjustments made during implementation: (1) dropped three dead imports
(`applyStateSavePacket`, `carryRepoBaseProof`, `recordOriginLineage`) — they
were imported but unreferenced in the pre-split file and have no owning module;
(2) added a CODEMAP `git-cmd.ts` line group where none existed (the file was
absent from CODEMAP before this change), using the four lines the design
specified. No behavior, copy, exit-code, or ordering changes.
