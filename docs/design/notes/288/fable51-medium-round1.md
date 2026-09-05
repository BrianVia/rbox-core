# Fable 5.1 — medium effort — round 1

Model confirmed by CLI usage: `claude-fable-5-1`; invocation used `--effort medium`. Review input was design288 plus a short executed-results summary, not source code. Verdict concerns the specification; claims about unseen fixtures require local verification.

**Verdict: CHANGES REQUIRED.** The slice is correctly scoped as red diagnostic tests with no product change, but the fixtures as written do not yet reliably distinguish a missing artifact from accidental object or shared-index availability, and one fixture likely does not construct the defect it claims to test.

**Issues that must be fixed**

- **Test 2 fixture may not produce stage-only objects.** A normal merge conflict leaves stage 1, 2, and 3 blobs reachable through the merge base, HEAD, and MERGE_HEAD. A bundle would then carry them and the test could go green for the wrong reason, or red for a reason unrelated to the defect. Construct the stages explicitly with `hash-object -w` plus `update-index --index-info`, or delete the refs after the conflict, and assert the precondition: each stage blob is absent from `rev-list --all --objects --reflogs` but present in `rev-list --indexed-objects`.
- **Receiver needs a negative precondition before import.** Assert `cat-file -e` fails for every stage blob in the receiver before the artifacts are applied. Without this, a receiver that inherited objects passes silently.
- **Receiver construction must be specified.** Require a fresh `git init` in its own directory. Forbid clone, `--reference`, `--shared`, or copying the sender's git directory. Assert `objects/info/alternates` does not exist after import.
- **Environment scrub must be in the design, not only in the evidence.** Unset or override `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`, and `GIT_TEST_SPLIT_INDEX`. Point global and system config at empty files so an inherited `core.splitIndex` cannot mask or create the split-index case. Run all receiver commands with `-C receiver`, never from the sender's cwd.
- **Test 1 needs a split-index precondition and a nontrivial delta.** Assert before capture that the source index carries the link extension and a shared-index file exists. Make the split delta include an add, a delete, and a modified entry relative to the shared index, otherwise an empty-delta index could read correctly by accident.
- **Define "expected staging" and "usable" as exact assertions.** For both tests, compare full `ls-files --stage` output including modes, hashes, and stage numbers against a fixed expectation. For test 2 add `cat-file -p` on each stage blob and a clean `fsck` in the receiver.
- **Separate fixture failure from defect failure.** Every precondition and the source-side positive control must be its own earlier assertion. Only the final receiver verification should be the red assertion, so a Bun 1.3.14 lock failure or a broken fixture is not mistaken for the defect.
- **Source immutability must cover the shared-index file too.** Hash both the index and the shared-index file before and after capture, and assert no new shared-index file or `index.lock` appears. The capture step must not refresh the source index.
- **Import must use the product apply path.** State that the receiver is populated through the existing restore or apply primitive, not a hand-run `git bundle unbundle`. Otherwise the test exercises Git rather than the capture owner.

**Smaller alignment points**

- The evidence describes three tests while the design lists two. List the fresh-apply variant of test 1 explicitly.
- Do not assert byte equality between the received index artifact and the source index. That would canonize the current defect.
- Record the Git version alongside the Bun version in the evidence, since split-index and fsck behavior vary by release.
- On failure, dump the recorded commands and outputs before fixture cleanup runs.

Nothing here requires the future normalization, identity, or protocol work. All items are fixture and assertion changes within the test-only slice.
