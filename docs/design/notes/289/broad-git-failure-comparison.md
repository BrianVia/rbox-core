# Broad-suite Git failure comparison and test corrections

2026-09-05. Environment: macOS, Apple Git 2.50.1, supported Bun 1.4.0, `TMPDIR=/private/tmp`, process/watcher access approved through escalation. Baseline: `c4aa22bbb81c8754230735a73c5a58a28a64b4f7`. Parent's broad log: `/private/tmp/rbox-astra-affected-canonical.txt` (65 failures / 2 errors).

## Comparison method

Extracted baseline `src`, `package.json`, `tsconfig.json`, **`bunfig.toml` and `scripts/test-preload.ts`** using `git archive`/`git show` into `/private/tmp/rbox-289-git-baseline2`, with installed `node_modules` symlinked. An initial exploratory extraction lacked Bun preload, which changed watcher reproduction; it is superseded by the recorded with-preload comparison. No baseline behavior conclusions rely on the earlier watcher pass. No main worktree or Git index was overwritten for comparison.

Selected command (run from each tree):

```sh
TMPDIR=/private/tmp PATH=/private/tmp/rbox-bun140/node_modules/.bin:$PATH bun test src/cli/daemon/watcher.test.ts src/cli/sync-git/lazy-apply-probes.test.ts src/cli/sync-git/follow.test.ts src/cli/sync-git/git-sync.test.ts --test-name-pattern 'design 172: capture scratch|203.11:|real-git REBASE_HEAD|P2 kill switches|R2-9:|R2-11:|design 174 C:|stable-pair retry' --timeout 30000
```

The pattern also selects the actual case-aliasing R2-9 control, so nine tests run. Exact baseline with preload: **3 pass / 6 fail / 32 assertions / 48.25s**, `rbox-289-git-baseline-with-preload.txt`. Initial candidate comparison used Bun's default 5s timeout, causing P2 timeout and a subsequent async error; the isolated P2 comparison below reran with sufficient timeout to assess its actual assertion. Timeout differences are not treated as regressions.

## Confirmed test assumptions changed by portable capture

1. `lazy-apply-probes.test.ts:203.11` expected a bare `write-tree` after ref observation. The lazy kill switch still restores eager identity probing, but that identity now performs the approved native dependency query and applies explicit private configuration. Updated the exact argv golden with the query and exact configuration prefixes. The lazy path still asserts zero commands and both paths still assert identical state. No broad substring matcher replaced the golden.
2. `git-sync.test.ts:stable-pair retry` injected an edit only when `args[0] === "write-tree"`. With leading native `-c` settings the injection never fired, so the test requested divergence without making an edit. Match the exact final `write-tree` token instead; retain the real synchronous `git add`, `mutated === true`, divergent result, and warmed zero-spawn cache assertions.

Both fixes are test-only and belong in the **portable-index** commit, not the earlier stage-root closure commit. Real-worktree command:

```sh
TMPDIR=/private/tmp PATH=/private/tmp/rbox-bun140/node_modules/.bin:$PATH bun test src/cli/sync-git/lazy-apply-probes.test.ts src/cli/sync-git/git-sync.test.ts --test-name-pattern '203.11:|stable-pair retry' --timeout 30000
```

**2 pass / 8 assertions / 1.82s**, `rbox-289-command-tests-fixed.txt`. Affected lint exits 0, with only the same four pre-existing fingerprint parser warnings; diff whitespace check is clean (`rbox-289-command-tests-lint.txt`). No production change was needed.

## Remaining selected failures predate these fixes

| Test | Baseline evidence / diagnosis |
|---|---|
| design 172 scratch-pin watcher | Fails on exact baseline preload too. Temporary candidate event tracing shows delayed `create .git/refs/heads/main` and initialization lock deletion events. Across capture, main-ref inode, mtime, ctime and bytes are all unchanged. Repeated trace run: 2 pass / 1 fail. This is observed native-event timing in this environment; no evidence supports changing product watcher filtering. |
| real REBASE_HEAD lifecycle | Both versions fail when the fixture invokes GNU-style `sed -i '1s/^pick /edit /'` through GIT_SEQUENCE_EDITOR; macOS sed rejects it before the intended lifecycle behavior. |
| P2 ownership kill switches | With an explicit 30s timeout, candidate and baseline fail the same assertion at follow.test.ts:1696: expected `worktree-ownership`, received undefined. Candidate 8.60s, baseline 8.10s; exact-preload baseline also fails there (7.31s). This is not caused by private argv prefixes. |
| injected NFC/NFD literal twins | Same baseline assertion failure at follow.test.ts:3053 on this filesystem. The actual case-aliasing control passes in both. No receiver-equivalence production change is proposed here. |
| R2-11 refname alias | Both fail during fixture setup: `git branch foo` reports that `foo` already exists on the case-insensitive filesystem; follow is not reached. |
| design 174 many-ref timing | Both hit the test's explicit 30s timeout. This establishes a pre-existing inability to complete under this host gate, not proof of either performance equivalence or product correctness for the timed-out scenario. |

Temporary watcher tracing/source snapshots were confined to `/private/tmp/rbox-289-git-candidate-probes`. They were not copied into product files. Evidence: `rbox-289-watcher-ref-proof.txt`, `rbox-289-p2-{candidate,baseline}.txt`. The previously recorded adoption failures are covered separately in `adoption-baseline-comparison.md`.

Root owns final combined checks, commit/index changes and merge readiness. This investigation fixes the two changed-test assumptions and classifies the selected remaining failures; it does not assert that all 65 broad failures have been resolved or that the broad suite is green.
