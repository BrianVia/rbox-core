# 288 — Portable Git capture regression baseline

Status: regression specification ALIGNED after two review rounds; red fixtures implemented; no production algorithm change. Parent roadmap: design 287, renumbered from 281 after fetching main. Baseline: `c4aa22bbb81c8754230735a73c5a58a28a64b4f7`; annotated remote tag `pre-astra-changes`.

## First deliverable

Add deterministic failing regressions for two capture defects that were observed on the old audit baseline. First prove each still exists on latest main. Keep normalization/identity changes out of this slice until their compatibility design is accepted.

1. **Split artifact isolation:** use native `git init` for sender and an unrelated receiver; never clone/reference/share/copy the source Git directory. Create a shared index, then add, remove and modify staged entries relative to it. Assert a real source shared-index dependency and source-positive stage listing before capture. Decrypt the actual product-captured index into the independent receiver; require exact `ls-files --stage -z` entries and `ls-files -v -z` flags, with no receiver shared-index dependency. Artifact byte equality to the source is not required.
2. **Split fresh apply:** separately exercise the product `applyGitState` path on a receiver directory with no `.git`. Require successful apply, exact stage/flag listings and successful connectivity checks. The artifact-isolation test intentionally checks the index directly, while this companion tests the complete product apply path.
3. **Ordinary unmerged closure:** explicitly create three distinct loose blobs using `hash-object -w` and inject conflict stages 1/2/3 using `update-index --index-info`. This is not a normal merge whose commits already retain the blobs. Assert each blob exists at the sender, occurs in the index at the specified stage, and is absent from all ref/reflog reachability. Use an unrelated freshly initialized receiver for meaningful negative `cat-file -e` preconditions, then call product `applyGitState` without resolution options. Require exact stage entries, each blob's expected plaintext and connectivity verification. No receiver alternates file may be introduced.

Each precondition precedes the defect assertion. Fixture failures must remain distinguishable from intended red results. Use immutable recorded source listings with known modes/stages/OIDs, not receiver output to define expectations. Snapshot the live index and referenced shared-index bytes before/after capture, and check no new shared-index file or index lock remains. Capture must not refresh the source index. Preserve staging flags.

All fixture Git commands target their own directory with explicit `-C`. Clear inherited repository routing (`GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`), object redirection (`GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`) and `GIT_TEST_SPLIT_INDEX`; global config is `/dev/null` and system config disabled. Product capture/apply inherit the same isolated routing/object/test context for the fixture and the environment is restored afterward. Do not change the production runner to make tests hermetic.

Use existing capture, crypto, blob-store and Git test primitives. Temporary fixtures have isolated configuration and explicit identity; clean up owned fixtures. Tests must assert desired behavior and fail on the current defect rather than canonize the bug, skip it, or weaken verification. Keep output bounded and record exact commands/results.

## Protected functionality and ownership

The existing Git capture owner supplies a complete immutable snapshot; native Git interprets indexes/object graphs. Existing physical-effect journals remain separate from logical state CAS. Protect source index/config bytes, staged modes/content, independent conflict stages, current encrypted artifact format, no-change identity and recovery. No new production owner, flag, persistence or wire field is introduced here.

No deletion or retirement is proposed or authorized. Live-index normalization is explicitly rejected: its incidental write requirement and change-detection effects are unnecessary for a private captured artifact. The follow-on design must prove owned-scratch dependency routing and compatible normalization/identity derivation before enabling a writer.

## Validation and review gates

Run the focused new tests on this exact baseline and preserve evidence. Bun 1.3.14 is currently installed, below required ^1.4.0; diagnostic results are not supported-runtime release acceptance. Distinguish actual fixture failures from unsupported lock runtime failures. The focused review gets at most three rounds, at least one with executed code. Claude/GPT implementation agreement is not implied by historical roadmap reviews.

Product implementation subsequently requires current/old artifact compatibility, repeated no-change convergence, source immutability, split/unmerged/sparse/absent index matrices, crash injection around normalization/pins/bundle retention and a relevant compiled sync-rig run. No product implementation, deployment or production mutation is part of this regression-only first slice.

## Next slices

Settle normalization/identity compatibility, implement the smallest complete capture fix, then validate and review it. Reconcile other roadmap packages against current main before dispatch: several optimizations landed since the audit. Preserve those implementations and their validation rather than recreate them.

## Review clarification

Fable5.1 medium round1 reviewed the design text and requested more explicit fixture construction. The original tests already used `hash-object`/`update-index`, exact entry/flag assertions, product apply, temporary independent directories and recorded Git/Bun versions; no normal merge fixture was used. The revised specification names the three tests and strengthens shared-index immutability and split-delta preconditions. Capture byte equality applies only to the live source before/after observation, not the received artifact. Command/error output is saved in bounded test-run evidence before temporary fixtures are removed.
