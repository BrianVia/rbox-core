# Design 161 adversarial review — round 1

**Verdict: CHANGES-REQUIRED.** The machine-scaled default is directionally reasonable for the reported 96 GiB Mac, but the draft cannot lower admission from the arbitrary-JSON multiplier merely because the pathname is `state.json`. That directly reverses design 138's Round-8 fail-closed ruling. The Linux memory source, one stated regression result, and the benchmark enforcement also need correction before implementation.

## Findings

1. **CRITICAL — A state-specific pre-parse multiplier violates design 138's arbitrary-JSON fail-closed contract.**

   **Evidence.** Design 161 proposes `RESET_PARSE_STATE_MULTIPLIER` for “admission of state files” and claims the fail-closed property remains preserved (`docs/design/161-reset-parse-budget.md:31-46`). Design 138 explicitly reached the opposite ruling: the corpus must be the JSON-grammar worst case, not the state schema, because `JSON.parse` runs before schema validation; the bound therefore must cover arbitrary admitted bytes (`docs/design/138-reset-path-hardening.md:288-315`, especially `:300-308`). The checked-in benchmark repeats that invariant in its own contract comment (`src/cli/reset-memory-benchmark.ts:16-26`).

   The implementation has no pre-parse evidence that bytes are state-shaped. `boundedJsonRead<T>` admits from file size, materializes the bytes, admits again, and then calls generic `JSON.parse`; `T` is erased and no validator runs first (`src/cli/reset-io.ts:248-270`, with `JSON.parse` at `:236-244`). `loadRawState` merely calls `boundedJsonRead<SyncState>(statePath(root))` and returns the cast result (`src/cli/config.ts:384-401`). The reset preflight likewise admits and parses before checking even `stream` and `stateNonce` (`src/cli/config.ts:1064-1069`). A corrupt state file can be the existing mixed-container flood outright; if a future discriminator checks only a prefix/envelope, the flood can be placed in an otherwise state-looking member. Keeping 52x “as the adversarial reference” in CI does not apply that bound at runtime.

   **Required change.** Keep `RESET_PARSE_EXPANSION_MULTIPLIER` (the maximum arbitrary-JSON flood pin) for every call that reaches `JSON.parse`. A lower state multiplier is defensible only after a separate bounded-memory parser/structural pass has proved the complete input eligible without first incurring the allocation being bounded. A pathname, TypeScript generic, or post-parse schema validator is not such proof. With the current architecture, design 161 should be budget-scaling-only.

2. **HIGH — `os.totalmem() / 4` is not a process-memory bound on supported Linux container/cgroup deployments.**

   **Evidence.** The new default trusts only `os.totalmem()` (`docs/design/161-reset-parse-budget.md:21-30`), and admission treats `budget - process RSS` as available without consulting a cgroup/process limit or host memory availability (`src/cli/reset-io.ts:225-233`). This repository pins Bun 1.3.14 (`package.json:6-8`; `.github/workflows/ci.yml:67-70`). On Linux that Bun version implements `os.totalmem()` with `sysinfo().totalram * mem_unit`, i.e. host physical memory, with no cgroup read ([Bun 1.3.14 `node_os.zig` lines 941-963](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/runtime/node/node_os.zig#L941-L963)). Linux x64 and arm64 are shipped targets (`scripts/release.ts:24-37`).

   A daemon in a 4 GiB cgroup on a 96 GiB host therefore derives a 24 GiB budget and can be admitted to a parse requiring many times its hard limit. The kernel can kill it instead of the code returning `ResetMemoryAdmissionError`. Host memory pressure has the analogous, less deterministic issue on macOS: total installed RAM is not currently allocatable RAM. Computing the value per call does not fix either source error because `totalmem` is constant.

   **Required change.** Define an effective-memory source and its fail-closed fallback. On Linux it must at least cap host total by the applicable cgroup v1/v2 hard limit (and specify handling of `max`, nested limits, parse/read errors, and limits below the existing 4 GiB floor). Either incorporate a conservative availability signal/reserve or narrow the claim explicitly: this is a process-policy budget, not proof that Bun can allocate it under concurrent host pressure. Do not let the 4 GiB floor override a smaller known hard limit. Add host-total-greater-than-cgroup and unknown-bound tests.

3. **HIGH — The specified 8 GiB regression expectation is arithmetically false.**

   **Evidence.** The draft says `fileSize = 59,220,693`, `RSS = 1.2e9`, and `totalmem = 8 GB` must fail (`docs/design/161-reset-parse-budget.md:63-65`). The proposed formula floors that machine at 4 GiB (`:21-24`), while current admission fails only when `fileSize * multiplier > budget - RSS` (`src/cli/reset-io.ts:225-233`). At 52x:

   - required = `59,220,693 * 52` = `3,079,476,036` bytes;
   - available = `4,294,967,296 - 1,200,000,000` = `3,094,967,296` bytes;
   - the call therefore **passes by 15,491,260 bytes**.

   It fails only when RSS is greater than `1,215,491,260` bytes (strictly greater because equality is admitted). Any proposed state multiplier at or below 52 only makes the stated test pass by more.

   **Required change.** Use the incident's exact captured RSS, use an unambiguous deliberate value such as 1.2 GiB if that is what was intended, or write boundary tests immediately on both sides of the computed threshold. Do not retain a regression assertion that cannot pass its own test suite.

4. **MEDIUM — The benchmark plan does not establish the new ceiling's multiplier or actual allocatability, and the existing “constrained” pin is neither mandatory nor constrained.**

   **Evidence.** Design 161 calls for one generated state-shaped corpus of at least 64 MiB and says drift will fail CI (`docs/design/161-reset-parse-budget.md:32-46,58-65`). Design 138 instead requires a maximum-admitted-size family sweep and tests at each effective ceiling under an enforced budget (`docs/design/138-reset-path-hardening.md:303-316`). Normal CI currently measures each flood family at only 2 MiB (`src/cli/reset-memory-benchmark.test.ts:33-40`). The maximum-admitted sweep is skipped unless `RBOX_RUN_CONSTRAINED_RESET_MEMORY=1` (`:43-55`); neither the normal package test commands nor the CI shard command sets it (`package.json:12-16`; `.github/workflows/ci.yml:131-133`; `scripts/test-affected.ts:211-220`). A direct run on pinned Bun 1.3.14 reports `1 pass, 1 skip`, confirming that behavior.

   Even when enabled, “constrained” only converts a numeric budget into a corpus size (`src/cli/reset-memory-benchmark.ts:30-33`) and spawns an ordinary child (`src/cli/reset-memory-benchmark.test.ts:16-30,45-54`); it applies no OS, cgroup, or process memory limit. Thus it cannot verify that a parse admitted under B succeeds under B, nor that an over-budget parse fails cleanly rather than being OOM-killed. A 64 MiB point also does not establish linear allocator behavior near the roughly 450 MiB dynamic ceiling at 96 GiB/52x or the separate 512 MiB materialization cap. If a lower state multiplier were ever made safe by a bounded pre-parser, one “realistic row” corpus would still be representative rather than worst-case: `SyncState` contains several optional nested maps/records (`src/cli/config.ts:132-175`) and `FileEntry` has multiple optional shapes (`src/engine/types.ts:10-36`).

   **Required change.** Make the arbitrary-JSON flood gate authoritative and mandatory. Exercise the field size and every materially distinct boundary: 4 GiB floor, 96 GiB/24 GiB dynamic ceiling, 1 TiB/32 GiB cap, and the 512 MiB static cap, with cold and warm RSS. Add a genuinely memory-limited child/harness for the supported release architectures, or explicitly separate a CI multiplier pin from a platform allocatability qualification and require both before changing the constant. If a provably safe state path is later introduced, sweep multiple minimal schema-valid allocation families and pin their maximum rather than one representative corpus.

5. **LOW — The env-override compatibility claim is under-tested during the default refactor.**

   **Evidence.** Current `envBudget()` accepts only a positive safe integer; absent **or invalid** input silently falls back to `DEFAULT_RESET_PARSE_BUDGET_BYTES` (`src/cli/reset-io.ts:218-223`). Design 161 promises unchanged override semantics but lists only “env override precedence” in tests (`docs/design/161-reset-parse-budget.md:27-28,58-60`). Once the fallback becomes a function, an invalid variable must fall back to the machine-scaled value, while a valid override must remain absolute and must not be clamped by the 4/32 GiB default bounds.

   **Required change.** Pin absent, valid below-default, valid above-32-GiB, `0`, negative, nonnumeric, fractional, and greater-than-`Number.MAX_SAFE_INTEGER` cases. State explicitly that invalid values preserve today's silent-fallback behavior (if that is intentional) and fall back to the dynamic machine default rather than the removed 4 GiB constant.

## Verified non-findings / scope checks

- The existing 512 MiB materialization cap is independent and applied before admission (`src/cli/reset-io.ts:225-233`) and `boundedJsonRead` also caps the preflight (`:248-270`). Leaving it unchanged is coherent, but it cannot compensate for underestimating arbitrary JSON below 512 MiB.
- The proposed numeric constants are safe JavaScript integers: 32 GiB and `512 MiB * 52 = 27,917,287,424` are far below `Number.MAX_SAFE_INTEGER`. The release matrix is 64-bit-only (`scripts/release.ts:24-37`), so there is no supported 32-bit address-space case. The design should state that platform assumption; no 32-bit arithmetic fix is required for current artifacts.
- On a 96 GiB host, the formula produces exactly 24 GiB. With RSS = 1.2e9 and the retained 52x flood multiplier, the dynamic limit is `floor((24 GiB - 1.2e9) / 52) = 472,496,226` bytes (about 450.6 MiB), below but reasonably described as near the 512 MiB static cap. The scaling arithmetic itself is not the blocker.

**Final verdict: CHANGES-REQUIRED.** Resolve findings 1-4 before implementation. Finding 1 is the design-138 safety invariant: absent a bounded pre-parse proof of complete shape, the only aligned small diff is machine-budget scaling while retaining the 52x arbitrary-JSON multiplier.
