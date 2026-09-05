# Design 289 implementation validation

The portable-index primitive now copies the source index to caller-owned scratch, detects split dependencies with native Git, and flattens split inputs with `core.splitIndex=false`, `core.fsmonitor=false`, and `core.untrackedCache=keep`. The same private configuration is used for resolve-undo clearing, stash creation, write-tree identity, and staged-entry enumeration. Live index/config/shared-index files are never written.

Raw staged-root closure now runs for ordinary as well as resolution captures. It preserves gitlinks as foreign objects, verifies real blob/tree OIDs through Git, deduplicates roots, and keeps the existing fail-closed behavior for missing required objects.

Supported Bun 1.4.0 focused validation:

- `capture-identity.test.ts`: 27 pass, 0 fail, 257 assertions.
- Split capture is self-contained and applies on a fresh receiver.
- Ordinary unmerged stage-only blob roots apply on a fresh receiver.
- Existing identity, worktree, stash, absent-index, rollback and capture suites remain green.
- `bun run lint:affected --base HEAD`: pass with no findings.
- `bun run typecheck`: pass for root, API and scripts.
- `git diff --check`: pass.

Historical broken split artifacts remain fail-closed and are deliberately outside this slice. The fingerprint cache version is not used as a repair-completion marker. A separate migration design is required if old published sections must be repaired automatically.
