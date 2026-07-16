import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitSection, Manifest } from "../engine/index.js";
import type { LockIdentitySource } from "../engine/git/lockfile.js";
import {
  applyStateSavePacket,
  expectedStateNonce,
  loadState,
  MAX_LEGACY_GIT_SIDECAR_REPOS,
  repoRecordsForState,
  resetSyncState,
  saveStateUnsafeLegacyOrTest,
  type RepoRecord,
  type StateSavePacket,
  type SyncState,
} from "./config.js";
import {
  changedSidecarRepoKeys,
  completeConfigApply,
  composeStateSavePacket,
  daemonBindingMatches,
  observedRepoKeys,
  orderedDeferralUpdates,
  savePublishedRepoIntent,
  saveStateSource,
  stampConfigAck,
  type StateSource,
} from "./sync-state.js";
import { acquireWorkspaceSyncMutex, releaseWorkspaceSyncMutex, workspaceSyncMutexDegraded } from "./sync-mutex.js";

const stream = "https://api.test::ws_93::root";
const nonce = "a".repeat(32);
let root = "";
let tokenCounter = 0;

const identity: LockIdentitySource = {
  current: async () => ({ hostId: "aa93", bootId: "bb93", pid: 9300, startTime: "1" }),
  probe: async () => ({ status: "alive", startTime: "1" }),
};
const lock = () => ({ identity, token: () => (++tokenCounter).toString(16).padStart(32, "0") });

const section = (id: string): GitSection => ({
  bundleSha: id.padEnd(64, "0").slice(0, 64),
  bundleEncSha: id.padEnd(64, "1").slice(0, 64),
  bundleCipherSize: 1,
  head: "ref: refs/heads/main",
  refs: { "refs/heads/main": "1".repeat(40) },
  refScope: "all",
  generatedAt: "",
});
const manifest = (name: string, gitRepos?: Record<string, GitSection>): Manifest => ({
  generatedAt: name,
  files: [],
  ...(gitRepos ? { manifestSchema: 2, gitRepos } : {}),
});
const baseState = (records: Record<string, RepoRecord> = {}): SyncState => ({
  stream,
  stateNonce: nonce,
  stateRevision: 0,
  lastSyncedSequence: 0,
  lastSyncedManifest: { generatedAt: "zero", files: [] },
  repoRecords: records,
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-state93-"));
  tokenCounter = 0;
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

describe("design 93 §6 sync-point truth table", () => {
  const postToken = { dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5" };

  test("round-3 and round-4 pinned ownership traces", () => {
    const rows = [
      { name: "round-3: pre is our synced value", record: { sourceSeq: 1, cfgSynced: "ours" }, pre: "ours", basePre: "base", post: "merged", incoming: "remote", want: "merged" },
      { name: "round-4: pre is the apply base", record: { sourceSeq: 1, cfgSynced: "other" }, pre: "base", basePre: "base", post: "merged", incoming: "remote", want: "merged" },
      { name: "remote installed exactly", record: { sourceSeq: 1, cfgSynced: "other" }, pre: "local", basePre: "base", post: "remote", incoming: "remote", want: "remote" },
      { name: "unowned merge leaves sync point", record: { sourceSeq: 1, cfgSynced: "other" }, pre: "local", basePre: "base", post: "merged", incoming: "remote", want: "other" },
    ];
    for (const row of rows) {
      const got = completeConfigApply(row.record, { pre: row.pre, basePre: row.basePre, post: row.post, incoming: row.incoming, postToken });
      expect(got.cfgSynced, row.name).toBe(row.want);
      expect(got.cfgApplied, row.name).toBe(row.incoming);
      expect(got.cfgToken, row.name).toEqual(postToken);
    }
  });

  test("round-5 unrelated ACK stamps only an authored repo", () => {
    expect(stampConfigAck({ sourceSeq: 1, cfgSynced: "b-old" }, undefined).cfgSynced).toBe("b-old");
    expect(stampConfigAck({ sourceSeq: 1, cfgSynced: "a-old" }, "a-new").cfgSynced).toBe("a-new");
  });
});

describe("design 93 §6 transactional unit", () => {
  test("published checkout recovery merges fresh lanes and is idempotent", async () => {
    const oldApply = {
      lane: "apply" as const,
      deferredSince: "2026-01-01T00:00:00.000Z",
      reasonSince: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-01T00:00:00.000Z",
      reason: "conflict" as const,
    };
    const capture = { ...oldApply, lane: "capture" as const, reason: "git-busy" as const };
    const previous = { sourceSeq: 1, base: section("old"), cfgApplied: "old", deferrals: { apply: oldApply } };
    const intended = {
      sourceSeq: 2,
      base: section("next"),
      cfgApplied: "journal-config",
      idxProj: "next-index",
    };
    const initial = baseState({ r: { repoGen: 1, ...previous } });
    const concurrent = baseState({ r: { repoGen: 2, ...previous, cfgApplied: "newer-config", deferrals: { apply: oldApply, capture } } });
    await saveStateUnsafeLegacyOrTest(root, concurrent);
    const recovered = await savePublishedRepoIntent(root, initial, "r", {
      relPath: "r", expectedRepoGen: 1, previousRecord: previous, record: intended,
    });
    expect(recovered.disposition).toBe("superseded");
    expect(recovered.state.repoRecords?.r).toMatchObject({
      repoGen: 3, sourceSeq: 2, base: section("next"), cfgApplied: "newer-config", idxProj: "next-index",
      deferrals: { capture },
    });
    const repeated = await savePublishedRepoIntent(root, recovered.state, "r", {
      relPath: "r", expectedRepoGen: 1, previousRecord: previous, record: intended,
    });
    expect(repeated.disposition).toBe("superseded");
    expect(repeated.state.repoRecords?.r?.repoGen).toBe(3);
    expect(repeated.state.repoRecords?.r?.cfgApplied).toBe("newer-config");
  });

  test("published checkpoint re-proof recovery lands non-base lane clears", async () => {
    const conflict = {
      lane: "apply" as const,
      deferredSince: "2026-01-01T00:00:00.000Z",
      reasonSince: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-01T00:00:00.000Z",
      reason: "conflict" as const,
    };
    const previous = {
      sourceSeq: 4,
      base: section("incoming"),
      resolutionKey: "checkpoint",
      deferrals: { apply: conflict },
    };
    const initial = baseState({ r: { repoGen: 3, ...previous } });
    await saveStateUnsafeLegacyOrTest(root, initial);

    const recovered = await savePublishedRepoIntent(root, initial, "r", {
      relPath: "r",
      expectedRepoGen: 3,
      previousRecord: previous,
      record: { sourceSeq: 4, base: section("incoming"), idxProj: "reproved" },
    });

    expect(recovered.disposition).toBe("landed");
    expect(recovered.state.repoRecords?.r).toMatchObject({
      repoGen: 4,
      sourceSeq: 4,
      base: section("incoming"),
      idxProj: "reproved",
    });
    expect(recovered.state.repoRecords?.r?.resolutionKey).toBeUndefined();
    expect(recovered.state.repoRecords?.r?.deferrals?.apply).toBeUndefined();

    const repeated = await savePublishedRepoIntent(root, recovered.state, "r", {
      relPath: "r",
      expectedRepoGen: 3,
      previousRecord: previous,
      record: { sourceSeq: 4, base: section("incoming"), idxProj: "reproved" },
    });
    expect(repeated.disposition).toBe("already-semantic");
    expect(repeated.state.repoRecords?.r?.repoGen).toBe(4);
  });

  test("published recovery treats lastSeen drift in the same episode as compatible", async () => {
    const oldConflict = {
      lane: "apply" as const,
      deferredSince: "2026-01-01T00:00:00.000Z",
      reasonSince: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-01T00:00:00.000Z",
      reason: "conflict" as const,
    };
    const refreshedConflict = { ...oldConflict, lastSeen: "2026-01-02T00:00:00.000Z" };
    const previous = {
      sourceSeq: 4,
      base: section("incoming"),
      resolutionKey: "checkpoint",
      deferrals: { apply: oldConflict },
    };
    const initial = baseState({ r: { repoGen: 3, ...previous } });
    const concurrent = baseState({
      r: { ...previous, repoGen: 4, deferrals: { apply: refreshedConflict } },
    });
    await saveStateUnsafeLegacyOrTest(root, concurrent);

    const recovered = await savePublishedRepoIntent(root, initial, "r", {
      relPath: "r",
      expectedRepoGen: 3,
      previousRecord: previous,
      record: { sourceSeq: 4, base: section("incoming"), idxProj: "reproved" },
    });

    expect(recovered.disposition).toBe("landed");
    expect(recovered.state.repoRecords?.r?.repoGen).toBe(5);
    expect(recovered.state.repoRecords?.r?.resolutionKey).toBeUndefined();
    expect(recovered.state.repoRecords?.r?.deferrals?.apply).toBeUndefined();
  });

  test("published recovery applies a same-episode set without regressing refreshed lastSeen", async () => {
    const previousDeferral = {
      lane: "apply" as const,
      deferredSince: "2026-01-01T00:00:00.000Z",
      reasonSince: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-01T00:00:00.000Z",
      subjectKey: "incoming",
      reason: "conflict" as const,
    };
    const refreshed = { ...previousDeferral, lastSeen: "2026-01-03T00:00:00.000Z" };
    const intendedDeferral = { ...previousDeferral, lastSeen: "2026-01-02T00:00:00.000Z", reproof: true };
    const previous = { sourceSeq: 4, base: section("incoming"), deferrals: { apply: previousDeferral } };
    const initial = baseState({ r: { repoGen: 3, ...previous } });
    const concurrent = baseState({ r: { repoGen: 4, sourceSeq: 4, base: section("incoming"), deferrals: { apply: refreshed } } });
    await saveStateUnsafeLegacyOrTest(root, concurrent);

    const recovered = await savePublishedRepoIntent(root, initial, "r", {
      relPath: "r",
      expectedRepoGen: 3,
      previousRecord: previous,
      record: { sourceSeq: 4, base: section("incoming"), deferrals: { apply: intendedDeferral } },
    });

    expect(recovered.disposition).toBe("landed");
    expect(recovered.state.repoRecords?.r?.deferrals?.apply).toEqual({
      ...intendedDeferral,
      lastSeen: refreshed.lastSeen,
    });
  });

  test("published recovery never regresses sourceSeq", async () => {
    const previous = { sourceSeq: 2, base: section("old") };
    const initial = baseState({ r: { repoGen: 1, ...previous } });
    const concurrent = baseState({ r: { repoGen: 2, sourceSeq: 9, base: section("old") } });
    concurrent.lastSyncedSequence = 9;
    await saveStateUnsafeLegacyOrTest(root, concurrent);

    const recovered = await savePublishedRepoIntent(root, initial, "r", {
      relPath: "r",
      expectedRepoGen: 1,
      previousRecord: previous,
      record: { sourceSeq: 3, base: section("next") },
    });

    expect(recovered.disposition).toBe("landed");
    expect(recovered.state.repoRecords?.r).toMatchObject({ sourceSeq: 9, base: section("next") });
  });

  test("published recovery preserves and reports a genuinely different apply episode", async () => {
    const previousDeferral = {
      lane: "apply" as const,
      deferredSince: "2026-01-01T00:00:00.000Z",
      reasonSince: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-01T00:00:00.000Z",
      reason: "conflict" as const,
    };
    const newerEpisode = {
      ...previousDeferral,
      deferredSince: "2026-02-01T00:00:00.000Z",
      reasonSince: "2026-02-01T00:00:00.000Z",
      lastSeen: "2026-02-01T00:00:00.000Z",
      reason: "local-edits" as const,
    };
    const previous = { sourceSeq: 4, base: section("old"), deferrals: { apply: previousDeferral } };
    const initial = baseState({ r: { repoGen: 3, ...previous } });
    const concurrent = baseState({ r: { repoGen: 4, sourceSeq: 4, base: section("old"), deferrals: { apply: newerEpisode } } });
    await saveStateUnsafeLegacyOrTest(root, concurrent);

    const recovered = await savePublishedRepoIntent(root, initial, "r", {
      relPath: "r",
      expectedRepoGen: 3,
      previousRecord: previous,
      record: { sourceSeq: 4, base: section("next") },
    });

    expect(recovered.disposition).toBe("superseded");
    expect(recovered.state.repoRecords?.r).toEqual(concurrent.repoRecords?.r);
  });

  test("identity degradation permits legacy save but design 130 forbids fence-free reset", async () => {
    const unavailable: LockIdentitySource = {
      current: async () => { throw new Error("no identity source"); },
      probe: async () => ({ status: "unknown" }),
    };
    const syncMutex = await acquireWorkspaceSyncMutex(root, "cli", {
      lock: { identity: unavailable },
      attempts: 1,
      onDegraded: () => {},
    });
    expect(workspaceSyncMutexDegraded(syncMutex)).toBe(true);

    const initial = baseState({
      r: { repoGen: 3, sourceSeq: 1, base: section("base"), cfgSynced: "old", cfgApplied: "old" },
    });
    const applyDeferral = {
      lane: "apply" as const,
      deferredSince: "2026-01-01T00:00:00.000Z",
      reasonSince: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-02T00:00:00.000Z",
      reason: "unsupported" as const,
    };
    const partial = { incomingKey: "legacy-partial", checkoutPending: true, appliedRefs: {}, heldRefs: {}, configApplied: false };
    let lockedApplyCalled = false;
    const saved = await saveStateSource(root, initial, {
      expectedStream: stream,
      sourceGlobalSeq: 2,
      globalManifest: manifest("two", { r: section("next") }),
      observedRepos: ["r"],
      values: {
        bases: { r: section("next") },
        configLane: { r: { cfgSynced: "new", cfgApplied: "new" } },
        deferrals: { r: orderedDeferralUpdates(undefined, { apply: applyDeferral })! },
        partial: { r: partial },
      },
    }, {
      forceLegacy: workspaceSyncMutexDegraded(syncMutex),
      apply: async () => {
        lockedApplyCalled = true;
        throw new Error("must not acquire the transactional state lock");
      },
    });
    expect(lockedApplyCalled).toBe(false);
    expect(saved.stateNonce).toBeUndefined();
    expect(saved.stateRevision).toBeUndefined();
    expect(saved.repoRecords).toBeUndefined();
    expect(saved.lastSyncedManifest.gitRepos?.r).toEqual(section("next"));
    expect(saved.gitDeferrals?.r?.apply).toEqual(applyDeferral);
    expect(saved.gitPartial?.r).toEqual(partial);
    const restarted = await loadState(root, stream);
    expect(repoRecordsForState(restarted).r).toMatchObject({
      deferrals: { apply: applyDeferral },
      partial,
    });

    await expect(resetSyncState(root, "next-stream", syncMutex)).rejects.toThrow("non-degraded workspace fence");
    const preserved = await loadState(root, stream);
    expect(preserved.stateNonce).toBeUndefined();
    expect(preserved.repoRecords).toBeUndefined();
    expect(preserved.lastSyncedManifest.gitRepos?.r).toEqual(section("next"));
    await releaseWorkspaceSyncMutex(syncMutex);
  });

  test("legacy sidecar maps are bounded and ignored once repoRecords is authoritative", () => {
    const deferral = {
      lane: "apply" as const,
      deferredSince: "2026-01-01T00:00:00.000Z",
      reasonSince: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-02T00:00:00.000Z",
      reason: "unsupported" as const,
    };
    const entries = Object.fromEntries(Array.from(
      { length: MAX_LEGACY_GIT_SIDECAR_REPOS + 1 },
      (_, i) => [`r${String(i).padStart(4, "0")}`, { apply: deferral }],
    ));
    const legacy: SyncState = { ...baseState(), repoRecords: undefined, gitDeferrals: entries };
    expect(Object.keys(repoRecordsForState(legacy))).toHaveLength(MAX_LEGACY_GIT_SIDECAR_REPOS);

    const authoritative: SyncState = {
      ...legacy,
      repoRecords: { kept: { repoGen: 1, sourceSeq: 1 } },
    };
    expect(Object.keys(repoRecordsForState(authoritative))).toEqual(["kept"]);
  });

  test("file-only global candidate rebuilds gitRepos solely from records", async () => {
    await saveStateUnsafeLegacyOrTest(root, baseState({ r: { repoGen: 0, sourceSeq: 0, base: section("old") } }));
    const packet = composeStateSavePacket(baseState({ r: { repoGen: 0, sourceSeq: 0, base: section("old") } }), {
      expectedStream: stream,
      sourceGlobalSeq: 1,
      globalManifest: manifest("one", { stale: section("stale") }),
      observedRepos: ["r"],
      values: { bases: { r: section("new") } },
    });
    expect(packet.global?.manifest.gitRepos).toBeUndefined();
    const result = await applyStateSavePacket(root, packet, { lock: lock() });
    expect(result.status).toBe("accepted");
    const saved = await loadState(root, stream);
    expect(Object.keys(saved.lastSyncedManifest.gitRepos ?? {})).toEqual(["r"]);
    expect(saved.lastSyncedManifest.gitRepos?.r).toEqual(section("new"));
  });

  test("both pending-regression landing orders converge on the newer success", async () => {
    const initial = baseState({ r: { repoGen: 0, sourceSeq: 0, base: section("base") } });
    const older: StateSource = { expectedStream: stream, sourceGlobalSeq: 1, globalManifest: manifest("one"), observedRepos: ["r"], values: { bases: { r: section("base") }, pending: { r: section("pending-old") } } };
    const newer: StateSource = { expectedStream: stream, sourceGlobalSeq: 2, globalManifest: manifest("two"), observedRepos: ["r"], values: { bases: { r: section("success") } } };

    await saveStateUnsafeLegacyOrTest(root, initial);
    await saveStateSource(root, initial, older);
    await saveStateSource(root, initial, newer);
    expect(repoRecordsForState(await loadState(root, stream)).r?.pending).toBeUndefined();
    expect(repoRecordsForState(await loadState(root, stream)).r?.base).toEqual(section("success"));

    await saveStateUnsafeLegacyOrTest(root, initial);
    await saveStateSource(root, initial, newer);
    await saveStateSource(root, initial, older);
    const reverse = repoRecordsForState(await loadState(root, stream)).r!;
    expect(reverse.pending).toBeUndefined();
    expect(reverse.base).toEqual(section("success"));
    expect(reverse.sourceSeq).toBe(2);
  });

  test("pending-after-newer-success wins in both landing orders", async () => {
    const initial = baseState({ r: { repoGen: 0, sourceSeq: 0, base: section("base") } });
    const success: StateSource = { expectedStream: stream, sourceGlobalSeq: 2, globalManifest: manifest("two"), observedRepos: ["r"], values: { bases: { r: section("success") } } };
    const pending: StateSource = { expectedStream: stream, sourceGlobalSeq: 3, globalManifest: manifest("three"), observedRepos: ["r"], values: { bases: { r: section("success") }, pending: { r: section("pending-new") } } };
    for (const order of [[success, pending], [pending, success]]) {
      await saveStateUnsafeLegacyOrTest(root, initial);
      await saveStateSource(root, initial, order[0]!);
      await saveStateSource(root, initial, order[1]!);
      const record = repoRecordsForState(await loadState(root, stream)).r!;
      expect(record.pending).toEqual(section("pending-new"));
      expect(record.sourceSeq).toBe(3);
    }
  });

  test("repoGen prevents value ABA", async () => {
    const episode = { lane: "apply" as const, deferredSince: "2026-01-01T00:00:00.000Z", reasonSince: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-01T00:00:00.000Z", reason: "conflict" as const };
    const initial = baseState({ r: { repoGen: 0, sourceSeq: 0, base: section("A"), deferrals: { apply: episode }, partial: { incomingKey: "a", checkoutPending: false, appliedRefs: {}, heldRefs: {}, configApplied: true } } });
    await saveStateUnsafeLegacyOrTest(root, initial);
    const delayed: StateSavePacket = { expectedStream: stream, expectedNonce: nonce, sourceGlobalSeq: 1, repos: [{ relPath: "r", expectedRepoGen: 0, newRecord: { sourceSeq: 1, base: section("delayed") } }] };
    const toB = { ...delayed, repos: [{ relPath: "r", expectedRepoGen: 0, newRecord: { sourceSeq: 1, base: section("B"), deferrals: { apply: episode }, partial: { incomingKey: "b", checkoutPending: false, appliedRefs: {}, heldRefs: {}, configApplied: true } } }] };
    expect((await applyStateSavePacket(root, toB, { lock: lock() })).status).toBe("accepted");
    const afterB = await loadState(root, stream);
    const backA = composeStateSavePacket(afterB, { expectedStream: stream, sourceGlobalSeq: 2, observedRepos: ["r"], values: { bases: { r: section("A") } } });
    expect((await applyStateSavePacket(root, backA, { lock: lock() })).status).toBe("accepted");
    const rejected = await applyStateSavePacket(root, delayed, { lock: lock() });
    expect(rejected).toMatchObject({ status: "rejected", reason: "repo-generation" });
    expect(repoRecordsForState(await loadState(root, stream)).r).toMatchObject({ deferrals: { apply: episode }, partial: { incomingKey: "b" } });
  });

  test("UNSEEN-PATH ABSENCE: stale global rejects the whole packet", async () => {
    const current = baseState({ x: { repoGen: 0, sourceSeq: 2, base: section("new-x") }, y: { repoGen: 0, sourceSeq: 0, base: section("y") } });
    current.lastSyncedSequence = 2;
    current.lastSyncedManifest = manifest("two", { x: section("new-x"), y: section("y") });
    await saveStateUnsafeLegacyOrTest(root, current);
    const stale: StateSavePacket = {
      expectedStream: stream,
      expectedNonce: nonce,
      sourceGlobalSeq: 1,
      global: { manifest: manifest("one") },
      repos: [{ relPath: "y", expectedRepoGen: 0, newRecord: { sourceSeq: 1 } }],
    };
    const result = await applyStateSavePacket(root, stale, { lock: lock() });
    expect(result).toMatchObject({ status: "rejected", reason: "global-sequence" });
    const saved = await loadState(root, stream);
    expect(saved.lastSyncedSequence).toBe(2);
    expect(repoRecordsForState(saved).y?.base).toEqual(section("y"));
  });

  test("source atomicity rejects global when a repo CAS fails and repos when global is stale", async () => {
    const initial = baseState({ r: { repoGen: 1, sourceSeq: 1, base: section("base") } });
    initial.lastSyncedSequence = 1;
    await saveStateUnsafeLegacyOrTest(root, initial);
    const badRepo: StateSavePacket = { expectedStream: stream, expectedNonce: nonce, sourceGlobalSeq: 2, global: { manifest: manifest("two") }, repos: [{ relPath: "r", expectedRepoGen: 0, newRecord: { sourceSeq: 2, base: section("bad") } }] };
    expect(await applyStateSavePacket(root, badRepo, { lock: lock() })).toMatchObject({ status: "rejected", reason: "repo-generation" });
    expect((await loadState(root, stream)).lastSyncedSequence).toBe(1);

    const staleGlobal: StateSavePacket = { expectedStream: stream, expectedNonce: nonce, sourceGlobalSeq: 0, global: { manifest: manifest("zero") }, repos: [{ relPath: "r", expectedRepoGen: 1, newRecord: { sourceSeq: 0, base: section("bad") } }] };
    expect(await applyStateSavePacket(root, staleGlobal, { lock: lock() })).toMatchObject({ status: "rejected", reason: "global-sequence" });
    expect(repoRecordsForState(await loadState(root, stream)).r?.base).toEqual(section("base"));
  });

  test("equal-sequence no-op transitions isolate unrelated repo bases", async () => {
    const initial = baseState({
      a: { repoGen: 0, sourceSeq: 5, base: section("a"), removedKey: "old" },
      b: { repoGen: 0, sourceSeq: 5, base: section("b") },
    });
    initial.lastSyncedSequence = 5;
    await saveStateUnsafeLegacyOrTest(root, initial);
    const values = { bases: { a: section("a"), b: section("b") }, removed: {} };
    expect(changedSidecarRepoKeys(initial, values)).toEqual(["a"]);
    await saveStateSource(root, initial, { expectedStream: stream, sourceGlobalSeq: 5, observedRepos: ["a"], values });
    const saved = repoRecordsForState(await loadState(root, stream));
    expect(saved.a?.removedKey).toBeUndefined();
    expect(saved.b?.base).toEqual(section("b"));
    expect(saved.b?.repoGen).toBe(0);
  });

  test("stream and nonce mismatches reject the whole packet", async () => {
    const initial = baseState({ r: { repoGen: 0, sourceSeq: 0, base: section("base") } });
    await saveStateUnsafeLegacyOrTest(root, initial);
    const packet = composeStateSavePacket(initial, { expectedStream: stream, sourceGlobalSeq: 1, globalManifest: manifest("one"), observedRepos: ["r"], values: { bases: { r: section("next") } } });
    expect(await applyStateSavePacket(root, { ...packet, expectedStream: "other" }, { lock: lock() })).toMatchObject({ status: "rejected", reason: "stream" });
    expect(await applyStateSavePacket(root, { ...packet, expectedNonce: "b".repeat(32) }, { lock: lock() })).toMatchObject({ status: "rejected", reason: "nonce" });
    expect((await loadState(root, stream)).lastSyncedSequence).toBe(0);
  });

  test("legacy sentinel matches only nonce-less state and first save installs nonce", async () => {
    const legacy = { ...baseState(), stateNonce: undefined };
    await saveStateUnsafeLegacyOrTest(root, legacy);
    const packet = composeStateSavePacket(legacy, { expectedStream: stream, sourceGlobalSeq: 1, globalManifest: manifest("one"), observedRepos: [], values: {} });
    expect(packet.expectedNonce).toBe("legacy");
    expect((await applyStateSavePacket(root, packet, { lock: lock() })).status).toBe("accepted");
    const installed = await loadState(root, stream);
    expect(installed.stateNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(await applyStateSavePacket(root, packet, { lock: lock() })).toMatchObject({ status: "rejected", reason: "nonce" });
  });

  test("same-binding reset regenerates nonce and delayed packet rejects", async () => {
    const initial = baseState();
    await saveStateUnsafeLegacyOrTest(root, initial);
    const delayed = composeStateSavePacket(initial, { expectedStream: stream, sourceGlobalSeq: 1, globalManifest: manifest("one"), observedRepos: [], values: {} });
    const syncMutex = await acquireWorkspaceSyncMutex(root, "cli", { lock: lock(), attempts: 1 });
    await resetSyncState(root, stream, syncMutex);
    await releaseWorkspaceSyncMutex(syncMutex);
    const reset = await loadState(root, stream);
    expect(reset.stateNonce).not.toBe(nonce);
    expect(await applyStateSavePacket(root, delayed, { lock: lock() })).toMatchObject({ status: "rejected", reason: "nonce" });
  });

  test("A→B→A reset changes nonce and daemon iteration revalidation detects it", async () => {
    await saveStateUnsafeLegacyOrTest(root, baseState());
    const mutexA = await acquireWorkspaceSyncMutex(root, "cli", { lock: lock(), attempts: 1 });
    await resetSyncState(root, "stream-B", mutexA);
    await resetSyncState(root, stream, mutexA);
    await releaseWorkspaceSyncMutex(mutexA);
    expect(await daemonBindingMatches(root, stream, nonce)).toBe(false);
    const rebound = await loadState(root, stream);
    expect(await daemonBindingMatches(root, stream, expectedStateNonce(rebound))).toBe(true);
  });

  test("observedRepoKeys includes explicit observed absence without manufacturing branch BASE absence", () => {
    const state = baseState({ absentNow: { repoGen: 1, sourceSeq: 1, base: section("old") } });
    expect(observedRepoKeys(state, {}, {})).toEqual(["absentNow"]);
    const packet = composeStateSavePacket(state, { expectedStream: stream, sourceGlobalSeq: 2, observedRepos: observedRepoKeys(state, {}, {}), values: {} });
    expect(packet.repos[0]?.newRecord.base).toEqual(section("old"));
  });

  test("a rejected packet recomputes in-operation, bounded to three attempts", async () => {
    const initial = baseState({ r: { repoGen: 0, sourceSeq: 0, base: section("base") } });
    const fresh1 = { ...initial, repoRecords: { r: { repoGen: 1, sourceSeq: 1, base: section("one") } } };
    const fresh2 = { ...initial, repoRecords: { r: { repoGen: 2, sourceSeq: 2, base: section("two") } } };
    const attempts: StateSavePacket[] = [];
    const accepted = await saveStateSource(root, initial, {
      expectedStream: stream,
      sourceGlobalSeq: 3,
      observedRepos: ["r"],
      values: { bases: { r: section("three") } },
    }, {
      apply: async (_root, packet) => {
        attempts.push(packet);
        if (attempts.length === 1) return { status: "rejected", reason: "repo-generation", state: fresh1 };
        if (attempts.length === 2) return { status: "rejected", reason: "repo-generation", state: fresh2 };
        return { status: "accepted", state: fresh2 };
      },
    });
    expect(accepted).toBe(fresh2);
    expect(attempts.map((packet) => packet.repos[0]?.expectedRepoGen)).toEqual([0, 1, 2]);

    let count = 0;
    await expect(saveStateSource(root, initial, {
      expectedStream: stream,
      sourceGlobalSeq: 3,
      observedRepos: ["r"],
      values: { bases: { r: section("three") } },
    }, {
      apply: async () => {
        count++;
        return { status: "rejected", reason: "repo-generation", state: fresh1 };
      },
    })).rejects.toThrow(/3 recomputes exhausted/);
    expect(count).toBe(3);
  });

  test("deferral lanes merge across CAS recompute and stale sourceSeq without regressing repo truth", async () => {
    const applyDeferral = {
      lane: "apply" as const,
      deferredSince: "2026-01-01T00:00:00.000Z",
      reasonSince: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-02T00:00:00.000Z",
      reason: "git-busy" as const,
    };
    const captureDeferral = {
      lane: "capture" as const,
      deferredSince: "2026-02-01T00:00:00.000Z",
      reasonSince: "2026-02-01T00:00:00.000Z",
      lastSeen: "2026-02-02T00:00:00.000Z",
      reason: "artifact" as const,
    };
    const initial = baseState({ r: { repoGen: 0, sourceSeq: 5, base: section("five") } });
    initial.lastSyncedSequence = 5;
    initial.lastSyncedManifest = manifest("five", { r: section("five") });
    const concurrent = baseState({ r: { repoGen: 1, sourceSeq: 7, base: section("seven"), deferrals: { apply: applyDeferral }, idxProj: "cached" } });
    concurrent.lastSyncedSequence = 7;
    concurrent.lastSyncedManifest = manifest("seven", { r: section("seven") });
    const packets: StateSavePacket[] = [];
    await saveStateSource(root, initial, {
      expectedStream: stream,
      sourceGlobalSeq: 5,
      observedRepos: ["r"],
      values: { deferrals: { r: orderedDeferralUpdates(undefined, { capture: captureDeferral })! } },
    }, {
      apply: async (_root, packet) => {
        packets.push(packet);
        if (packets.length === 1) return { status: "rejected", reason: "repo-generation", state: concurrent };
        return { status: "accepted", state: concurrent };
      },
    });
    expect(packets[1]?.repos[0]?.newRecord).toMatchObject({
      sourceSeq: 7,
      base: section("seven"),
      idxProj: "cached",
      deferrals: { apply: applyDeferral, capture: captureDeferral },
    });
    const cleared = composeStateSavePacket(concurrent, {
      expectedStream: stream,
      sourceGlobalSeq: 5,
      observedRepos: ["r"],
      values: { deferrals: { r: orderedDeferralUpdates(concurrent.repoRecords?.r?.deferrals, { apply: null })! } },
    });
    expect(cleared.repos[0]?.newRecord).toMatchObject({ sourceSeq: 7, base: section("seven"), idxProj: "cached" });
    expect(cleared.repos[0]?.newRecord.deferrals).toBeUndefined();

    const acceptedCommit = composeStateSavePacket(concurrent, {
      expectedStream: stream,
      sourceGlobalSeq: 8,
      globalManifest: manifest("eight", { r: section("eight") }),
      observedRepos: ["r"],
      values: { bases: { r: section("eight") } },
    });
    expect(acceptedCommit.repos[0]?.newRecord.deferrals?.apply).toEqual(applyDeferral);
  });

  test("same-lane clear and set transitions drop after the predecessor changes during CAS recompute", async () => {
    const old = {
      lane: "capture" as const,
      deferredSince: "2026-01-01T00:00:00.000Z",
      reasonSince: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-01T00:00:00.000Z",
      reason: "artifact" as const,
    };
    const newer = {
      ...old,
      lastSeen: "2026-01-03T00:00:00.000Z",
      reasonSince: "2026-01-03T00:00:00.000Z",
      reason: "git-busy" as const,
    };
    const initial = baseState({ r: { repoGen: 0, sourceSeq: 4, deferrals: { capture: old } } });

    // A observes success (clear); B records a newer standing episode first.
    const afterNewerSet = baseState({ r: { repoGen: 1, sourceSeq: 4, deferrals: { capture: newer } } });
    const clearAttempts: StateSavePacket[] = [];
    await saveStateSource(root, initial, {
      expectedStream: stream,
      sourceGlobalSeq: 4,
      observedRepos: ["r"],
      values: { deferrals: { r: orderedDeferralUpdates({ capture: old }, { capture: null })! } },
    }, {
      apply: async (_root, packet) => {
        clearAttempts.push(packet);
        return clearAttempts.length === 1
          ? { status: "rejected", reason: "repo-generation", state: afterNewerSet }
          : { status: "accepted", state: afterNewerSet };
      },
    });
    expect(clearAttempts[1]?.repos[0]?.newRecord.deferrals?.capture).toEqual(newer);

    // A observes a refreshed set; B clears the observed predecessor first.
    const afterClear = baseState({ r: { repoGen: 1, sourceSeq: 4 } });
    const setAttempts: StateSavePacket[] = [];
    await saveStateSource(root, initial, {
      expectedStream: stream,
      sourceGlobalSeq: 4,
      observedRepos: ["r"],
      values: { deferrals: { r: orderedDeferralUpdates({ capture: old }, { capture: newer })! } },
    }, {
      apply: async (_root, packet) => {
        setAttempts.push(packet);
        return setAttempts.length === 1
          ? { status: "rejected", reason: "repo-generation", state: afterClear }
          : { status: "accepted", state: afterClear };
      },
    });
    expect(setAttempts[1]?.repos[0]?.newRecord.deferrals).toBeUndefined();
  });

  test("explicit lane and partial clears are distinct from omitted values", () => {
    const apply = {
      lane: "apply" as const,
      deferredSince: "2026-01-01T00:00:00.000Z",
      reasonSince: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-01T00:00:00.000Z",
      reason: "conflict" as const,
    };
    const partial = { incomingKey: "k", checkoutPending: false, appliedRefs: {}, heldRefs: {}, configApplied: true };
    const state = baseState({ r: { repoGen: 2, sourceSeq: 4, base: section("base"), deferrals: { apply }, partial } });
    expect(changedSidecarRepoKeys(state, {})).toEqual([]);
    expect(changedSidecarRepoKeys(state, { deferrals: { r: orderedDeferralUpdates({ apply }, { apply: null })! } })).toEqual(["r"]);
    expect(changedSidecarRepoKeys(state, { partial: { r: null } })).toEqual(["r"]);
    expect(changedSidecarRepoKeys(baseState({ r: { repoGen: 0, sourceSeq: 0 } }), { deferrals: { r: orderedDeferralUpdates(undefined, { apply })! } })).toEqual(["r"]);
    expect(changedSidecarRepoKeys(baseState({ r: { repoGen: 0, sourceSeq: 0 } }), { partial: { r: partial } })).toEqual(["r"]);
    const packet = composeStateSavePacket(state, {
      expectedStream: stream,
      sourceGlobalSeq: 4,
      observedRepos: ["r"],
      values: { bases: { r: section("base") }, deferrals: { r: orderedDeferralUpdates({ apply }, { apply: null })! }, partial: { r: null } },
    });
    expect(packet.repos[0]?.newRecord.deferrals).toBeUndefined();
    expect(packet.repos[0]?.newRecord.partial).toBeUndefined();
  });

  test("reset refuses an unbound checkout journal and preserves all reset sidecars", async () => {
    await saveStateUnsafeLegacyOrTest(root, baseState());
    const journal = path.join(root, ".rbox", "state", "git-journal");
    const shell = path.join(root, ".rbox", "state", "shell.deferrals");
    await fs.mkdir(journal, { recursive: true });
    await fs.writeFile(path.join(journal, "entry"), "x");
    await fs.writeFile(shell, "v1\n");
    const mutex = await acquireWorkspaceSyncMutex(root, "cli", { lock: lock(), attempts: 1 });
    await expect(resetSyncState(root, stream, mutex)).rejects.toThrow("unbound or unreadable checkout journal");
    await releaseWorkspaceSyncMutex(mutex);
    expect(await fs.readFile(path.join(journal, "entry"), "utf8")).toBe("x");
    expect(await fs.readFile(shell, "utf8")).toBe("v1\n");
  });
});
