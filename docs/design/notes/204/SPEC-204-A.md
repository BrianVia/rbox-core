# SPEC 204-A — enforce-mode server regression + preflight-delta default-on

Authoritative spec: docs/design/204-delta-scoped-publish.md §3 + §6 tests 1-4.
Read it fully first. This unit is Parts "test 3" + "Part A" ONLY.

## Order of work (HARD)
1. FIRST write the enforce-mode server regression (§6 test 3) and get it
   green against the CURRENT server code. If it fails, STOP and report the
   failure verbatim — do NOT fix server code, do NOT proceed to step 2.
2. Only then flip the client default (§3.3) and write tests 1, 2, 4.

## Step 1 — server regression (apps/api/test/)
- New or extended test file exercising the WorkspaceSync commit endpoint
  under RBOX_COMMIT_DELTA_ADMISSION="enforce" (testEnv currently caps at
  off|shadow — widen its type/plumbing as needed, test-side only).
- Case (a): parent commit with refs P; child carries ref X from P; X is
  prune-marked (blob_ref_candidates row) and its blobs row present=0 ⇒
  commit returns 422 error:"unsatisfied_blobs" with X in `missing`, head
  sequence unchanged.
- Case (b): marked-probe over-cap ⇒ full-refset admission fallback (insert
  FENCE_SET_MAX+1 = 50,001 marker rows via batched bulk insert; assert the
  fallback outcome — see shouldUseDeltaAdmission + metrics/fallback field).
- Mirror fixture patterns from apps/api/test/commit-delta-shadow.test.ts.

## Step 2 — client flip
- Add exported `preflightDeltaEnabled = () => process.env.RBOX_PREFLIGHT_DELTA !== "0"`
  (put it next to the existing flag reads in src/cli/sync-recovery.ts or a
  small shared module); BOTH read sites (src/cli/sync-recovery.ts:185 and
  :295) consume it. No other behavior change.
- Tests per §6: 1 (default-on delta arm in BOTH serialized and pipeline
  arms; =0 restores legacy byte-shape incl. undeduped duplicates), 2
  (recovery union + forceFullAudit overflow latch), 4 (ambient env hygiene:
  force-delete RBOX_PREFLIGHT_DELTA AND RBOX_PREFLIGHT_FULL in beforeEach
  of every touched suite; update src/cli/sync/sync.test.ts:733-746,750-759
  to set ="0" explicitly where the legacy arm is the intent).

## Constraints
- Do NOT touch Part B (e2ee-remote/push deltaBase/pull) or Part C (plan.ts).
- Do NOT modify apps/api/src/** (server production code) — test-only there.
- No new migrations.

## Acceptance (run yourself; all must be green)
- bun run test:api
- bun test src/cli/sync/sync.test.ts src/cli/sync-recovery* 2>/dev/null || bun run test:affected
- bun run typecheck
Report: files changed, test results verbatim, and the step-1 verdict
(green/failed) explicitly.
