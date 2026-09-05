# Design 292 — Claude Fable 5.1 review, round 1 (2026-09-05)

Verdict: **aligned, merge-ready as a test-only compatibility commit.** No further round required.

Reviewed directly in worktree `codex/astra-sync-git` at `c36a2eccf`, not from a forwarded packet.

## What was checked

- `src/cli/push-spans.test-helper.ts`: the helper delegates to the existing owner `PushSpans.run`
  (`AsyncLocalStorage.run` at `push-spans.ts:167`) with `PhaseReport.disabled("push")`. One fresh
  `PushSpans` per registered test, so there is no shared mutable owner and no global fallback.
  Sync and async bodies are awaited inside the scope; the owner's `finally` path still finalizes.
- Six migrated suites keep every test name, timeout argument, assertion and negative control;
  only the `beforeEach` + module-level `firstPublishTiming` were removed, and callbacks that read
  timing now take it as the parameter.
- `enterPushSpansForTest` remains in use by `upload-grant.test.ts`, which enters context inside
  its own callback, so it is not dead and was correctly left alone.
- Production code is untouched by this commit (`push-spans.ts`, `upload-lane-timing.ts`).
- No workflow change: CI still selects Bun `latest`; the fixture repair makes the suites
  runtime-independent instead of pinning.

## Executed evidence (this host, Bun 1.4.0)

```
bun test <nine suites>   → 93 pass / 1 skip / 0 fail / 15,307 expect() calls
bun run typecheck        → clean (root, apps/api, scripts)
bun run lint:affected    → 8 warnings, all verified present on origin/main at the same lines
```

Bun 1.4.2 evidence is the PR head's own CI (all shards green after this commit landed on the
branch), which is the exact runtime that originally failed.

## Notes

- The P/K cap timeout in shard 2/6 (run 33976813037) stays **suspected environmental**: the
  same-SHA rerun is not available now that the head moved, and the later head is green. No
  timeout, cap, or fixture change is warranted from one occurrence.
- Design 292 is a fixture-ownership repair, not a design 291 review round; the four feature
  commits keep their separate identities.
