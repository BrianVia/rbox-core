import { expect, test } from "bun:test";
import type { SyncState, WorkspaceConfig } from "../config.js";
import { gitDivergenceStatus } from "./status.js";

test("gitDivergenceStatus projects durable lanes read-only even when git sync is disabled", async () => {
  const since = "2026-07-01T00:00:00.000Z";
  const state: SyncState = {
    stream: "s",
    lastSyncedSequence: 1,
    lastSyncedManifest: { generatedAt: since, files: [] },
    repoRecords: {
      repo: {
        repoGen: 2,
        sourceSeq: 1,
        deferrals: {
          apply: {
            lane: "apply",
            reason: "local-edits",
            deferredSince: since,
            reasonSince: since,
            lastSeen: since,
            subjectKey: "opaque",
            bytesChanged: true,
          },
          config: {
            lane: "config",
            reason: "config",
            deferredSince: since,
            reasonSince: since,
            lastSeen: since,
          },
        },
      },
    },
  };
  const cfg = { syncGit: false } as WorkspaceConfig;
  expect(await gitDivergenceStatus("/unused", cfg, state)).toEqual({
    count: 0,
    indeterminate: false,
    pendingOnly: false,
    configChecking: [],
    configDisabled: [],
    conflictSnapshots: { total: 0, prunable: 0 },
    deferrals: [
      { relPath: "repo", lane: "apply", reason: "local-edits", deferredSince: since, bytesChanged: true },
      { relPath: "repo", lane: "config", reason: "config", deferredSince: since },
    ],
  });
});

/** Design 271 §2.7.5: `detail` is curated once at the deferral-writing site and
 * must survive every projection surface between state and the rendered row. */
test("a curated deferral detail reaches the divergence projection verbatim", async () => {
  const since = "2026-07-01T00:00:00.000Z";
  const detail = "the standing present-artifact could not be settled after its BASE was committed";
  const state: SyncState = {
    stream: "s",
    lastSyncedSequence: 1,
    lastSyncedManifest: { generatedAt: since, files: [] },
    repoRecords: {
      repo: {
        repoGen: 2,
        sourceSeq: 1,
        deferrals: {
          apply: { lane: "apply", reason: "artifact", deferredSince: since, reasonSince: since, lastSeen: since, detail },
        },
      },
    },
  };
  const status = await gitDivergenceStatus("/unused", { syncGit: false } as WorkspaceConfig, state);
  expect(status.deferrals).toEqual([{ relPath: "repo", lane: "apply", reason: "artifact", deferredSince: since, detail }]);
});
