## Verdict: NOT-ALIGNED

I did not revisit the founder’s pre-2.0 posture or no-marker decision.

Round-1 disposition:

1. **Resolved.** Absence is split into zero-bindings silent initialization versus bindings-present error; regeneration is explicit, loss-listing, and confirmed.

2. **Resolved.** `snapshotPreCatalogPolicy` now materializes every field, including legacy `syncGit: false`, and generated options must be complete.

3. **Resolved.** First publication now specifies locking, absence recheck, no-replace publication, loser adoption, race ordering, and retention of ordinary-mutation digest checks.

4. **Resolved.** The four-state/marker/projection/migration model is removed from normative sections and retained only as history.

5. **Resolved against the old slice-1 code**, but subsequent `FolderInventory` changes make §11 stale.

6. **Only partially resolved.** Obsolete gates are gone and most replacement gates exist, but required end-to-end and regeneration-race coverage remains missing.

New/blocking findings:

1. **MAJOR — The final `FolderInventory` Interface cannot represent its promised states.** [`observeFolderAdmission` accepts only a validated snapshot](/home/via/Development/Personal/rbox-core/.claude/worktrees/231-amendment/docs/design/231-folder-config-authority.md:160), yet [`FolderAdmission` includes `damaged`](/home/via/Development/Personal/rbox-core/.claude/worktrees/231-amendment/docs/design/231-folder-config-authority.md:425). A snapshot exists only for authoritative state, so Inventory cannot own damaged classification as specified. The landed API correctly accepts `FolderCatalogState`, but its registry-only row model cannot represent catalog-only unbound/missing roots. Define the final state-bearing Interface and full catalog/registry/desired/current-root union.

2. **MAJOR — Regeneration’s freshness loop is not implementable through its Interface.** `regenerateFolderCatalog(inventory, confirm)` receives one frozen inventory, but [`§6.3 requires restarting after a changed source digest`](/home/via/Development/Personal/rbox-core/.claude/worktrees/231-amendment/docs/design/231-folder-config-authority.md:360). It cannot re-observe bindings or newly added catalog paths. Additionally, unreadable `damaged` files have no byte digest despite regeneration promising to handle them. Use an opaque revision covering absent/readable/unreadable states and either an inventory-provider callback or an outer loop that refreshes state, inventory, loss description, and confirmation together.

3. **MAJOR — Generation is not total or deterministic for supported paths.** Generated labels use the basename and numeric suffixes, but names must be non-empty, trimmed, NFC, and at most 128 scalars. Root `/`, whitespace/NFD/long basenames, or suffix overflow make the mandated recovery command fail validation. Suffix assignment is also not deterministic unless paths are sorted before naming. Specify fallback, normalization, scalar-safe truncation, collision ordering, and tests.

4. **MAJOR — §11 does not match `origin/main`.** `FolderInventory` merged in `dd189f83a`, but [slice 2 remains “IN FLIGHT”](/home/via/Development/Personal/rbox-core/.claude/worktrees/231-amendment/docs/design/231-folder-config-authority.md:551). What landed is only the pre-activation registry wrapper: it lacks `observeFolderGeneration`, catalog-only rows, the complete discovery union, and overlap classification. Mark slice 2 DONE with its actual temporary contract and explicitly assign every remaining §3.2 change to slice 3.

5. **MAJOR — Slice 3 is not independently merge-ready.** [Slice 4 defers move/copy repair, CODEMAP updates, and real validation](/home/via/Development/Personal/rbox-core/.claude/worktrees/231-amendment/docs/design/231-folder-config-authority.md:561), although §7.4 requires repair in the first implementation, repository rules require ownership changes and CODEMAP updates in the same PR, and §12’s compiled/rig checks must gate activation—not follow it.

6. **MAJOR — §12 still does not fully gate the specified mechanics.** Missing gates include:

   - an end-to-end generated-catalog → parsed-catalog → resolved-policy differential, rather than only testing `snapshotPreCatalogPolicy`;
   - catalog edits or simultaneous regeneration invalidating prior destructive confirmation;
   - catalog/registry/desired/current-root union deduplication and catalog-only rows;
   - readable-binding admission despite registry conflict;
   - unreadable/dangling observation reporting after publication; and
   - proof that inventory observation performs no healing or writes.

7. **MINOR — Created-directory durability disappeared from the normative protocol.** [`§8` mentions syncing only the catalog parent](/home/via/Development/Personal/rbox-core/.claude/worktrees/231-amendment/docs/design/231-folder-config-authority.md:488), while the landed foundation also fsyncs newly created directory ancestors. Preserve that behavior explicitly and add a fresh-directory crash gate.

Validation run: slice-1 catalog tests pass **34/34**; the merged `origin/main` inventory tests pass **5/5**. Those tests confirm the dormant foundation and registry wrapper, not the amended activation design.