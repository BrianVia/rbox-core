# Adoption fetch-union baseline comparison

2026-09-05, macOS, Apple Git 2.50.1, Bun 1.4.0 (`34cbb9a40`), `TMPDIR=/private/tmp`. No source in the working tree or Git index was modified during this investigation.

The parent's broad suite exposed failures in `src/cli/adopt-git.test.ts` (design 166). Isolated current-tree command:

```sh
TMPDIR=/private/tmp PATH=/private/tmp/rbox-bun140/node_modules/.bin:$PATH bun test src/cli/adopt-git.test.ts
```

Result: **1 pass / 11 fail / 25 assertions / 5.46s** (`rbox-289-adopt-isolated.txt`).

Comparison used `git archive HEAD src package.json tsconfig.json` at `c4aa22bbb81c8754230735a73c5a58a28a64b4f7`, extracted under `/private/tmp/rbox-289-adopt-baseline`, with only `node_modules` symlinked to the installed working-tree dependencies. The exact baseline command:

```sh
TMPDIR=/private/tmp PATH=/private/tmp/rbox-bun140/node_modules/.bin:$PATH bun test /private/tmp/rbox-289-adopt-baseline/src/cli/adopt-git.test.ts
```

Result: **1 pass / 11 fail / 25 assertions / 3.80s** (`rbox-289-adopt-baseline.txt`). Same failed test names and assertions. This establishes that these failures predate G1/F1/F2 in this environment; it does not assert that they occur on Linux or CI.

One diagnostic-only console statement was then added to that temporary baseline test, immediately after `runGitAdoption`, and its first test rerun with `--test-name-pattern 'eligible checked-out ahead'`. The recorded parked reason was `ENOENT: no such file or directory, open '/dev/fd/36/repo'` (`rbox-289-adopt-baseline-diagnostic.txt`). `adopt-fs.ts:fdPath/openAdoptDirectory` uses macOS `/dev/fd/<fd>/<child>` traversal; containment parks before candidate branch enumeration/fetch. The assertion therefore sees no branch state. The implicated adoption containment code does not call the changed Git identity/fingerprint functions.

No adoption implementation or tests were changed in the repository. A macOS native descriptor-relative traversal correction would be a separate design/fix, not a reason to weaken Git-capture regressions. The temporary archive was subsequently reused for closure-only commit validation; the baseline log above was produced before those temporary candidate edits.
