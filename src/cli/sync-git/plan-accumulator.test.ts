/**
 * Issue #793: a permanent-carry repo must not mint an empty (ops=0) sequence.
 *
 * `plan().changed` is the publish oracle: publish-candidate skips its no-op
 * admission whenever it is true, so a `changed` that disagrees with the wire
 * delta publishes a manifest the remote already holds. The pull lane never
 * refreshes `record.advertised` (only a publisher ACK does), so an adopted
 * remote section leaves the state-derived "previous" permanently stale — one
 * empty publication per adopted git-section change on any repo the plan can
 * only carry.
 */
import { expect, test } from "bun:test";
import type { GitSection } from "../../engine/index.js";
import { GitPlanAccumulator } from "./plan-accumulator.js";
import type { SyncState } from "../config.js";

const sha = (n: number): string => n.toString(16).padStart(64, "0");
const oid = (n: number): string => n.toString(16).padStart(40, "0");

const section = (extra: Partial<GitSection> = {}): GitSection => ({
  bundleSha: sha(1),
  bundleEncSha: sha(2),
  bundleCipherSize: 1,
  head: "ref: refs/heads/main",
  refs: { "refs/heads/main": oid(7) },
  refScope: "all",
  refTombstones: {},
  refTombstoneGeneration: 0,
  generatedAt: "2026-08-17T00:00:00.000Z",
  ...extra,
});

/** State after a pull ADOPTED `wire` for `.` while this host's last publication
 *  (`advertised`) still names the older section. */
const adoptedState = (wire: GitSection, advertised: GitSection, withMeta = true): SyncState => {
  const state: SyncState = {
    stream: "test",
    stateNonce: "a".repeat(32),
    lastSyncedSequence: 1,
    lastSyncedManifest: { generatedAt: "remote", files: [], manifestSchema: 2, gitRepos: { ".": wire } },
    repoRecords: { ".": { repoGen: 1, sourceSeq: 1, base: wire, advertised } },
  };
  if (withMeta) {
    state.manifestMeta = {
      encManifestSha: sha(3),
      manifestHash: sha(4),
      accountEpoch: 1,
      keyEpoch: 1,
      chain: [],
      chainBytes: 0,
      snapshotBytes: 400,
      gitRepos: { ".": wire },
    };
  }
  return state;
};

const accumulatorFor = (state: SyncState): GitPlanAccumulator =>
  new GitPlanAccumulator("/ws", state, { onGitLog: () => {} });

test("#793: carrying a section adopted from a pull is not a publish", () => {
  // The peer re-captured the SAME refs (no branch value superseded, so design 130
  // authors no tombstone) with fresh artifact bytes and stamp — exactly the field
  // shape: `mde delta ops=0` while `plan().changed` was true.
  const wire = section({ bundleSha: sha(21), bundleEncSha: sha(22), deviceId: "dev_peer", generatedAt: "2026-08-18T00:00:00.000Z" });
  const accumulator = accumulatorFor(adoptedState(wire, section()));
  accumulator.carry(".", accumulator.base["."]!);
  // The outgoing bytes ARE the remote's bytes: the delta would carry zero ops.
  expect(accumulator.plan().gitRepos?.["."]).toEqual(wire);
  expect(accumulator.plan().changed).toBe(false);
});

test("#793: a section that differs from the wire base still publishes", () => {
  const wire = section({ refs: { "refs/heads/main": oid(9) } });
  const accumulator = accumulatorFor(adoptedState(wire, section()));
  accumulator.capture(".", section({ refs: { "refs/heads/main": oid(11) }, generatedAt: "2026-08-19T00:00:00.000Z" }));
  expect(accumulator.plan().changed).toBe(true);
});

test("#793: a repo the plan drops still publishes its removal", () => {
  const wire = section({ refs: { "refs/heads/main": oid(9) } });
  const accumulator = accumulatorFor(adoptedState(wire, section()));
  expect(accumulator.plan().changed).toBe(true);
});

test("#793: ACK-armed plans still publish against identical wire bytes (design 244 b2)", () => {
  const wire = section({ refs: { "refs/heads/main": oid(9) } });
  for (const arm of ["superseded", "resolved", "authoredCfg"] as const) {
    const accumulator = accumulatorFor(adoptedState(wire, section()));
    accumulator.carry(".", accumulator.base["."]!);
    if (arm === "superseded") accumulator.supersededPending.add(".");
    if (arm === "resolved") accumulator.resolvedPending.add(".");
    if (arm === "authoredCfg") accumulator.authoredCfgHashByRepo["."] = sha(5);
    expect(accumulator.plan().changed).toBe(true);
  }
});

test("#793: without an admissible manifest meta the reconstruction still decides", () => {
  const wire = section({ refs: { "refs/heads/main": oid(9) } });
  const accumulator = accumulatorFor(adoptedState(wire, section(), false));
  accumulator.carry(".", accumulator.base["."]!);
  expect(accumulator.plan().changed).toBe(true);
});
