# 164 — Suite-wide timeout and shard hardening

Status: **REVIEWED v3**

Scope is limited to Bun per-test timeout arguments and CI shard placement. Test
assertions, product/functional fixtures, product logic, and sync-engine module
ownership are unchanged; only the synthetic sharder guard fixture follows the
placement configuration. `docs/CODEMAP.md` is unchanged.

## Evidence and policy

The sweep covers all 287 repository test files, not only the CI-sharded source
tree. These local JUnit runs passed before implementation:

```text
bun test --reporter=junit --reporter-outfile=/tmp/all-src-junit.xml ./src/
  2,457 tests / 202 files / 251.11s
bun test --timeout 120000 --reporter=junit --reporter-outfile=/tmp/scripts-all-junit.xml ./scripts/
  290 tests / 36 files / 5.96s
(cd apps/api && bunx vitest run --configLoader runner --reporter=junit --outputFile=/tmp/api-all-junit.xml)
  781 tests / 46 files / 57.37s
(cd apps/web && npx svelte-kit sync && npx vitest run --reporter=junit --outputFile=/tmp/web-all-junit.xml)
  25 tests / 3 files / 0.04s
```

For uncapped source tests, "effective cap" means the CI sharder default of 15
seconds; a timeout argument in the test source overrides it. Direct unsharded
Bun runs instead default to five seconds. Script and API tests use the timeout
from their own runner/config unless overridden in source.

Treat an individual test as heavyweight when its measured local runtime is
greater than two seconds. Its effective cap must be at least three times the
observed runtime. Existing caps that already meet that ratio stay unchanged.
The full inventory is:

| Test (file; abbreviated name) | Local | Effective cap | 3x | Change |
| --- | ---: | ---: | ---: | ---: |
| `dircache-bench.test.ts` — 50k-file structural gate | 5.456s | 120s | 16.367s | none |
| `blob-batch.test.ts` — persistent corruption retries | 4.253s | 30s | 12.759s | none |
| `credentials.test.ts` — main contention/live fence | 4.166s | 20s | 12.498s | none |
| `design85-layer-a.test.ts` — daemon safety/deep coverage | 4.086s | 10s | 12.257s | **20s** |
| `daemon-activity.test.ts` — quota probe refresh | 3.004s | 15s CI | 9.013s | none |
| `git-cmd.test.ts` — exhaustive show-me JSON | 2.317s | 15s CI | 6.951s | none |
| `manifest-delta.bench.test.ts` — 124k-entry fast fold | 2.296s | 60s | 6.887s | none |
| `storage-truth.test.ts` — Phase-1 cap fixture | 2.290s | 60s | 6.869s | none |
| `daemon-activity.test.ts` — quota error recovery | 2.115s | 15s CI | 6.346s | none |
| `dircache.test.ts` — pruned scan equivalence | 2.047s | 15s CI | 6.142s | none |
| `dircache.test.ts` — type swaps/new rule | 2.047s | 15s CI | 6.141s | none |
| `dircache.test.ts` — rule/deadline/clock failures | 2.046s | 15s CI | 6.139s | none |
| `dircache.test.ts` — structural mutations | 2.045s | 15s CI | 6.135s | none |
| `daemon-activity.test.ts` — pump-error halt | 2.028s | 15s CI | 6.084s | none |
| `git/lockfile.test.ts` — hung identity subprocess | 2.002s | 15s | 6.005s | none |

No API or web testcase exceeded two seconds. The separately configured
heavyweight source-suite run also found no additional deficient ratio.

- Treat the E2EE sync transport describe block as one heavyweight family: it is
  greater than two seconds locally and four members exhausted 15–30 second caps
  together on a contended shard. Apply the prior incident-hardening multiplier:
  raise the 30-second cap to 120 seconds and make each inherited 15-second CI
  cap an explicit 60-second per-test cap.
  An isolated JUnit run measured the four tests at 0.503s, 0.322s, 0.220s, and
  0.110s, while the transport family measured 2.33s in the full run. These caps
  are incident-contention hardening, not values derived from 3x isolated time.
- Raise the only additional deficient ratio found by the full sweep, the design
  85 daemon safety-mode test, from 10 to 20 seconds (local runtime 4.086s).

## Shard placement

- Make the unsplit `src/cli/e2ee-sync.test.ts` file a member of the existing
  `git-sync-process` anti-affinity group alongside the five dedicated git-sync
  subprocess-heavy tests.
- Keep six shards in both CI and `scripts/guards.ts`. Six group members then
  force exactly one heavyweight family onto each shard.
- Do not split E2EE tests by name: the current splitter intentionally covers two
  known split files, and nested describe names do not share its leaf-name
  matching shape. Whole-file placement changes no test execution semantics.
- Extend the sharding guard fixture to include the configured E2EE file and
  verify that all six anti-affinity members occupy distinct shards. Preserve the
  existing failure when a group has more members than the shard count.
- The expected deterministic post-change indices are: pending+422 on 0, D2 on
  1, E2EE sync on 2, ref-wiping on 3, sha_mismatch on 4, and design 53 on 5.

## Validation

1. Run each touched heavy suite once and retain JUnit timing evidence.
2. Run `bun test scripts/guards.test.ts` and the six-shard plan/guard.
3. Run `bun run typecheck && bun run guards`.
4. Confirm the diff contains only timeout arguments, shard configuration/guard
   coverage, this design/review record, and the requested `CODEX-DONE` marker.
