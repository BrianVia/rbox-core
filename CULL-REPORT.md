# Redundant test cull report

## Scope and result

Deleted all 64 tests adjudicated in `KILL-LIST.json`, and no unlisted tests. The cull changed test code only: 23 test files retain their unlisted tests, and 6 files that lost all tests were removed. No production source file was edited.

One source block in `src/cli/autostart/command.test.ts` generated two named test cases from a loop. Removing that block accounts for both corresponding kill-list entries; together with the file's third test block, this removed the file's three adjudicated tests.

## Tally by file

| Test file | Tests deleted | Disposition |
|---|---:|---|
| `apps/api/test/notify.test.ts` | 1 | retained |
| `apps/api/test/slackpipes.test.ts` | 7 | retained |
| `apps/api/test/stripe-coupon.test.ts` | 3 | retained |
| `apps/api/test/unit2-config-docs.test.ts` | 3 | removed |
| `scripts/rig/lib/git-fixtures.test.ts` | 1 | retained |
| `scripts/rig/scenarios/index.test.ts` | 1 | removed |
| `scripts/rig/scenarios/preamble.test.ts` | 1 | removed |
| `scripts/storage-truth-live-unit.test.ts` | 1 | retained |
| `scripts/ux/regress.test.ts` | 1 | retained |
| `src/cli/account-cmd.test.ts` | 3 | retained |
| `src/cli/account-profile.test.ts` | 1 | retained |
| `src/cli/adopt-binding-matrix.test.ts` | 2 | retained |
| `src/cli/adopt-lifecycle.test.ts` | 2 | retained |
| `src/cli/auth-cmd-surface.test.ts` | 3 | removed |
| `src/cli/auth-cmd.test.ts` | 4 | retained |
| `src/cli/autostart/command.test.ts` | 3 | removed |
| `src/cli/daemon/watcher-backend.fixture.test.ts` | 1 | retained |
| `src/cli/front-door.test.ts` | 1 | retained |
| `src/cli/remote/resilient.test.ts` | 1 | retained |
| `src/cli/setup-cmd.test.ts` | 9 | retained |
| `src/cli/shell-init.test.ts` | 3 | retained |
| `src/cli/state-plane/authority-bootstrap.test.ts` | 1 | retained |
| `src/cli/state-plane/reset/capability.test.ts` | 1 | retained |
| `src/cli/sync-git/held-composer-skip.test.ts` | 1 | retained |
| `src/cli/transfer-progress.test.ts` | 1 | removed |
| `src/cli/trash-cmd.test.ts` | 2 | retained |
| `src/cli/watcher-retrust.test.ts` | 1 | retained |
| `src/cli/workspace-picker.test.ts` | 4 | retained |
| `src/engine/manifest-walk-abort.fixture.test.ts` | 1 | retained |
| **Total** | **64** | **23 retained, 6 removed** |

## Files fully removed

- `apps/api/test/unit2-config-docs.test.ts`
- `scripts/rig/scenarios/index.test.ts`
- `scripts/rig/scenarios/preamble.test.ts`
- `src/cli/auth-cmd-surface.test.ts`
- `src/cli/autostart/command.test.ts`
- `src/cli/transfer-progress.test.ts`

## Imports, helpers, and empty containers pruned

- Removed the now-unused `formatNewAccount` import from `apps/api/test/slackpipes.test.ts`.
- Removed the `formatNewAccount` `describe` block after its seven listed tests left it empty.
- Imports and file-local setup belonging to the six fully removed test files disappeared with those files.
- No shared helper module and no non-test source file was changed. No other surviving test file had an import, helper, or constant made unused by this cull.

## Validation

- Exact-match guard: all 64 kill-list entries resolved to one authorized test case/source block; no unlisted test block was selected.
- Per-file tests: all 23 retained test files passed individually. The 20 Bun-native files were run with `bun test`; the 3 API files passed individually under their required Cloudflare Vitest harness because `bunfig.toml` intentionally excludes `apps/api/test/**` from Bun's native runner.
- Fixture coverage: the two retained subprocess fixture tests also passed with `RBOX_WATCHER_BACKEND_FIXTURE=1` and `RBOX_WALK_ABORT_FIXTURE=1` respectively.
- `bun run typecheck`: passed.
- `bun run lint:affected`: passed. It reported only pre-existing warning patterns on unchanged surviving lines; the deletion introduced no new warnings.
- `git diff --check`: passed.

## Protected functionality and deletion boundary

All production behavior, commands, protocols, migrations, compatibility paths, performance paths, and unlisted behavioral tests remain protected and unchanged. The only approved deletion authority was `KILL-LIST.json`; nothing outside that adjudicated test surface was treated as dead or retired.

## Pass-3 addendum (folded by hand after /tmp loss)
- src/cli/sync/format.test.ts — 'renders the push epilogue spans' (kill-e: exact rendered-copy pins)
- src/cli/sync-git/base-composer.test.ts — 'closed authority union has exactly all eight members' (kill-b: satisfies-checked literal re-asserted at runtime)

Final totals: 66 tests deleted across 31 files (6 files removed whole); classification corpus: 4,286+605 verdicts by ox-alpha over 3 passes, adjudicated by Fable (7 overturned to keep).
