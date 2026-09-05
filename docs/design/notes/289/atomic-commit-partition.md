# Atomic G1 commit partition

Use **stage-object closure first, portable index second**. No Git index changes or commits were made by the subagent.

## First commit: complete ordinary raw-index object closure

Ready-to-stage full-file representations, prepared from baseline `c4aa22bbb` plus only closure behavior/tests:

- `/private/tmp/rbox-289-stage-closure-capture.ts` → `src/cli/sync-git/capture.ts`
- `/private/tmp/rbox-289-stage-closure-capture-identity.test.ts` → `src/cli/sync-git/capture-identity.test.ts`

Capture changes: remove the resolution-only guard on raw-index stage roots; require valid native mode/OID/stage records; skip foreign gitlinks; deduplicate before native existence checks. Keep baseline `git(... ls-files ..., {env: GIT_INDEX_FILE})`, baseline raw file copy, identity and live clear-REUC behavior. No private-index helper or fingerprint bump belongs in this first commit.

Tests: retain all 24 baseline tests, add ordinary stage-only independent receiver capture, intent-to-add with newline/tab paths plus missing foreign gitlink, and missing ordinary root failure. Shared fixture process-environment save/restore is included because the independent receiver must not borrow inherited object stores. Split helper/imports, split fixtures, REUC matrix, and missing shared-dependency apply integration remain in the second commit.

Executed in the isolated baseline archive (no product changes in the live working tree):

```sh
TMPDIR=/private/tmp PATH=/private/tmp/rbox-bun140/node_modules/.bin:$PATH bun test /private/tmp/rbox-289-adopt-baseline/src/cli/sync-git/capture-identity.test.ts
```

**27 pass / 0 fail / 229 assertions / 32.98s**, `stage-closure-only-commit-tests.txt`. This is executable evidence that the first commit is independently green; no test skip or weakened fixture was used.

## Second commit: portable split-index capture and identity

The remaining full G1 working-tree versions of capture/tests, plus `private-index.ts`, `identity.ts`, and `fingerprint.ts` schema bump. This contains native split detection/output validation, private configuration ownership, normalization/REUC/raw identity, resolution comparison, split artifact/apply regressions, configured ordinary/split partial-conflict matrix, and missing shared dependency through real apply.

The full partial-conflict tests rely on stage roots existing in the independent receiver, so this ordering preserves their strength. `git-state.ts` has no change: live helper semantics remain baseline. Parent owns staging, per-commit documentation allocation, final integration tests and commits. The temporary representations are complete blobs for selective index staging; do not overwrite the final working tree to use them.
