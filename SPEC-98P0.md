# SPEC: design 98 §5.1 — FirstPublishStats (P0 instrumentation, behavior-neutral)

Implement EXACTLY design 98 §5.1 (docs/design/98-first-publish-pipeline.md lines ~565–605). Read that section and the §8 gate-8 privacy gate first, plus the referenced code sites.

## Objective
A `FirstPublishStats` details object emitted through the EXISTING `PhaseReport.recordDetails` path (`src/engine/phase-report.ts:167`) under the push report, gated by `metricsEnabled()` (`src/cli/metrics.ts`), piggybacking on the shipped `uploadLaneTiming` accumulator (`src/cli/remote/blob-batch.ts:788–824`). Behavior-neutral: NO change to the publish path's behavior; measurement only. This runs on the CURRENT path (flag-independent) so it produces the Workload-B control baseline BEFORE `RBOX_PUBLISH_PIPELINE` calibration runs.

## Fields (all non-negative integers; counts/bytes/durations ONLY — design 97 discipline)
- timeToFirstReadyCiphertextMs, firstReadyToFirstUploadStartMs
- encryptWallMs, missingCheckWallMs, uploadCriticalPathMs, receiptRedemptionWallMs, commitWallMs
- receiptRedemptionOverlapMs (redemption wall overlapping active upload — 0 on today's serialized path unless the pipeline flag is on; measure honestly, don't fake)
- authCallCount, authCriticalPathMs (critical-path, not summed)
- peakTempDiskBytes, peakQueueHeapBytes, peakUploaderFramingBytes (0 where the owner doesn't exist on the serialized path — emit the field anyway so the schema is stable)
- serverUnsatisfiedTotal, serverSatisfiedSkipped
- uniqueEncryptions, duplicateEncryptions, reEncryptedOnResume
- producerCpuSaturationPct

## Where
- `src/cli/sync-recovery.ts` (encryptAndUpload: stage walls, first-ready/first-upload stamps, encryption counters). The publish-pipeline module from #225 exists behind RBOX_PUBLISH_PIPELINE; instrument BOTH paths where a field applies, sharing one accumulator type so the schema is identical (that is what makes A/B evidence comparable).
- `src/cli/remote/blob-batch.ts` (upload critical path, framing peak, auth counters if auth happens per-batch here).
- Emission point: the push PhaseReport recordDetails, key "firstPublish", with a compact token string for the log line (follow formatCommitTimings style, src/cli/sync.ts:93). Emit only when the push actually uploaded ≥1 blob (avoid noise on no-op pushes).

## Hard rules
- HARD PRIVACY RULE: no raw file names/paths, no 64-hex sha-shaped strings, in any emitted metric/log token (design 98 §8 gate 8). Add a unit test asserting the rendered token line contains no "/" and no 64-hex substring.
- Zero-cost when metrics disabled: follow the disabled-report-singleton pattern (sync.ts phase-report usage); no allocation on the disabled path.
- No behavior change; no new env flags.

## Acceptance
- `bun test ./src/` green except the two known host-only failures (same-SHA metadata heal in src/cli/sync.test.ts, shellStateOf in json-output.test.ts) and the ctime flake.
- `bun x tsc --noEmit -p tsconfig.json` clean.
- New tests: schema completeness (every field present, integers), privacy regex, stage-wall sum sanity on a fake publish, disabled-mode zero emission.

## Do NOT touch
- src/engine/crypto-pool.ts, src/engine/crypto.ts, manifest/e2ee surfaces, apps/api/**, docs/**.
