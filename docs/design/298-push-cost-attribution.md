# 298 — Push-cost attribution

## Measured problem

On via-desktop (2026-09-05), a zero-change push over 188K files and 125 repositories took 9.0s. Git planning took 3.8s (1.1s discovery, 2.4s capture), and state save took 2.3s, but the frozen push line could identify neither the repository nor the state-save phase responsible.

## Ownership and output

`src/cli/sync-git/plan.ts` and `GitPlanStats` own per-repository `{rel, fingerprint, captureMs, discoverMs}` attribution gathered in the existing planning loops. When aggregate capture plus discovery exceeds 500ms, the planner emits one `git-plan slowest: <rel> fp=<hit|miss|untrusted> cp=<ms> d=<ms>; ...` line, sorted by repository cost and capped at three entries.

`src/cli/sync-state.ts:saveStateSource` owns composition/apply attribution. A save attempt over 500ms emits at most one line per invocation: `state-save slow: compose=<ms> apply=<ms> repos=<n> global=<full|delta|elided|none> ops=<n> attempt=<k>`.

Both thresholds are module constants. The change adds no traversal, flag, environment variable, metric series, persistence write, or push-line grammar change. Paths are no broader than the existing git-sync detail line.

## Protected behavior and validation

Planning, capture, state composition, CAS retries, legacy fallback, logs below threshold, and the frozen push summary remain unchanged. No code is approved for deletion and no incidental requirement is challenged; the requested bounded diagnostics reuse existing owners and logger seams.

Focused tests cover sorted/capped slow repository output, silence for a fast plan, and full/delta/elided state-save classification. The existing git-sync, grammar-freeze, push-span, typecheck, lint, and rig paths protect compatibility, crash/retry behavior, and performance-sensitive orchestration.

Delete these lines once F2/F4/G5 make an empty push faster than one second and both lines remain quiet for a release.
