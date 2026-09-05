# CI validation


## PR 882 — P/K capacity timeout investigation (2026-09-05)

Status: **suspected environmental timeout; no cap-test or product change**. Failure: [run 33976813037](https://github.com/BrianVia/rbox-core/actions/runs/33976813037), shard 2/6, `A and P/K artifacts > P and K caps independently refuse without eviction`, 15,235.80ms against the shard runner's 15,000ms default. The test does not specify a shorter timeout itself.

`base-artifacts.test.ts`, `base-artifacts.ts`, `protocol-locks.ts`, and `git-spawn.ts` are unchanged from `c4aa22bbb`. The fixture creates 2,048 P refs, deletes those 2,048 P refs, then creates 4,096 K refs using three native `update-ref --stdin` transactions. The CI log ends the child with stdout `start: ok`, exit code null, and no stderr when Bun kills the dangling process at its test deadline. No capacity assertion failed before that deadline. This identifies an unfinished native transaction, not a failed new identity probe; storage or runner contention remains an inference rather than a measured CI cause.

Current-commit (`d49e7d8bc481a7fdc9dc8cead35293979994804d`) full-file isolation on macOS/Apple Git 2.50.1/Bun 1.4.0, including repository preload and process access:

```sh
TMPDIR=/private/tmp PATH=/private/tmp/rbox-bun140/node_modules/.bin:$PATH bun test src/cli/sync-git/base-artifacts.test.ts --timeout 15000
```

**12 pass / 76 assertions / 13.50s** for the file; the P/K case passed in **5,262.22ms** (`rbox-pr882-pk-isolation.txt`). A second bounded run of that case used the existing Git spawn observer from a temporary preload: **1 pass / 2 assertions / 5.30s**, P/K case 5,259.98ms. Its command trace has **zero `--shared-index-path` queries** and no write-tree calls: only repository-directory discovery, three native ref transactions and capacity enumeration (`rbox-pr882-pk-native-commands.txt`). Thus the portable-index change's extra dependency query is not on this test's executed path.

`docs/flaky-tests.md` requires a dated CI failure, green **same-SHA** rerun, and green isolated file before calling a failure a confirmed flake. Only the failure and local isolation witnesses are established here. A green run on a later stats-test-fix SHA will not retrospectively satisfy the same-SHA witness. Keep the classification **suspected**. The parent will rerun the matrix after the separately owned stats-context correction; no timeout increase, cap reduction, skipped assertion, ref-fixture rewrite or product change is justified by this single timeout.
