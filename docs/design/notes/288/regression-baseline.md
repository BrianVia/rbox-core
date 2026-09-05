# Design 288 — executed regression baseline

Baseline: `c4aa22bbb81c8754230735a73c5a58a28a64b4f7` in the `astra-sync-git` worktree. No product implementation or commits in this slice.

## Tests added

`src/cli/sync-git/capture-identity.test.ts` reuses the existing temporary-repository, local encrypted blob store, native Git, index snapshot and artifact-decryption helpers.

1. **Serialized split-index self-containment:** create staged content plus assume-unchanged/skip-worktree flags and an actual native split index; capture/decrypt the uploaded index into a separate repository without its source shared-index file; require native Git to read identical staging/flags without a shared dependency.
2. **Fresh split-index apply:** capture the same shape and apply into a directory with no `.git`; require successful apply, preserved staging/flags and connectivity.
3. **Ordinary unmerged stage-only closure:** create three different loose blob objects for conflict stages 1/2/3, establish that none is reachable from any source ref, capture without resolution options, and apply into an independent fresh receiver; require exact index stages, each blob's content and successful connectivity verification.

Each capture asserts source index inode, timestamps, size and exact bytes are unchanged before the expected failure. Apply tests repeat the source immutability check after apply. The fixture Git runner explicitly clears alternate object directories, and setup/teardown removes/restores the inherited process variable so production capture/apply calls cannot accidentally borrow source objects through that environment setting. No product runner is modified.

## Executed command and result

```sh
bun test src/cli/sync-git/capture-identity.test.ts --test-name-pattern 'design 288:'
```

Initial targeted run after alternate-directory isolation: **0 pass, 3 fail, 24 filtered out; 50 expect calls; 2.58 seconds; exit 1.** Output: `git-capture-regressions.txt`.

All three are intended red regressions asserting desired behavior:

- Independent native `ls-files --stage -z` fails because `.git/sharedindex.<oid>` is absent.
- Fresh split-index apply returns `applied:false` and rolls back after `update-index --clear-resolve-undo` cannot find that shared index.
- Ordinary unmerged apply returns `applied:false`, `post-apply fsck failed — rolled back` because stage-only object closure was not transported.

None failed for the previously observed compatible-lock runtime limitation, a setup timeout, or unavailable dependencies. Source immutability assertions passed before these failures. Assertions after expected successful apply remain red-path acceptance criteria, not claimed passing checks.

## Environment and additional validation

Bun `1.3.14 (0d9b296a)`, Apple Git `2.50.1 (Apple Git-155)`, macOS. Bun is below the repository's `^1.4.0` requirement; these results characterize current defects and do not constitute supported-runtime release acceptance.

`git diff --check` passes. Required scoped lint was attempted:

```sh
bun run lint:affected --base HEAD
```

It identified the one changed lintable file but could not run oxlint: `bun is unable to write files to tempdir: PermissionDenied` (exit 1). Output: `git-capture-regressions-lint.txt`. Neither this worktree's `node_modules/.bin/oxlint` nor `../../../node_modules/.bin/oxlint` exists, and no global oxlint was found. No dependency installation was attempted.

## Scope boundary

Existing capture owns portable snapshot/object closure; native Git interprets index semantics and validates connectivity. Tests change no production ownership, protocol, flag, persistence, recovery authority or feature policy. No deletion/retirement is proposed. Normalization, raw-unmerged identity compatibility, old-client convergence, sparse/gitlink closure, crash injection and compiled-rig acceptance remain follow-on implementation gates from design 288. No full suite, rig, deployment or external cross-model review was performed by this regression task.


## Amended fixtures after design review

The three existing tests were strengthened without adding product code or a new test framework:

- The split fixture establishes its shared index **before** a staged add, delete and modification. `splitIndex.maxPercentChange=100` prevents Git from folding this tiny delta into another shared base. Preconditions prove the shared path/bytes remain the original base and the staged name/status delta is exactly D/M/A.
- Before/after capture, both split tests compare the complete sorted shared-index filename/byte set and reject any remaining `index.lock`, in addition to the existing live-index inode/timestamp/size/byte comparison. This detects newly introduced shared files as well as changed existing dependencies. The product-apply split test repeats these checks afterward.
- The unmerged fixture proves each source OID is a blob, excludes every OID from `rev-list --objects --all --reflog`, and checks explicit mode/OID/stage/path records for stages 1/2/3. An unrelated freshly initialized B must return native Git exit 1 for each missing OID before product apply; its `objects/info` must have no alternates file before or after apply.
- One fixture-local environment override/save/restore list isolates `GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_TEST_SPLIT_INDEX`, global config and system config. Both helper Git commands and product capture/apply inherit this context. The production runner is unchanged.

Final amended command is the same three-test filter shown above. **0 pass, 3 intended fail, 24 filtered out; 77 expect calls; 3.74 seconds; exit 1.** Full final output: `git-capture-regressions-strengthened.txt`. All added fixture preconditions and source/shared-index immutability checks pass; failures remain the original independent split-index read, split apply missing dependency, and unmerged apply connectivity failure. There are no setup or compatible-lock failures. `git diff --check` passes. The previously recorded unsupported Bun/lint limitations still apply; no full suite or external call was made for this amendment.

### Review requirements already covered or deliberately avoided

The original tests already used explicit `hash-object -w` and `update-index --index-info` stage construction, product capture/apply, exact stage/flag comparisons, temporary independent repositories, source immutability, blob content checks, encryption/decryption and recorded runtime versions. No ordinary merge fixture needed replacement. Received artifact bytes must not equal source split-index bytes: normalization can legitimately change serialization; exact byte preservation applies to the live source only.

The split product-apply receiver deliberately still has **no `.git`**. Initializing it merely to obtain a negative `cat-file` check would remove coverage of fresh materialization. The separately initialized unmerged receiver permits a meaningful absent-object check without that tradeoff. A `cat-file` failure in a directory that is not a repository would prove nothing and was not added. Shared-index bytes are compared exactly, so a redundant hash comparison is unnecessary. No protocol, normalization, identity, compatibility or crash behavior is claimed implemented by these regressions.
