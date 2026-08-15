import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalManifestHashStreaming, type GitSection } from "../engine/index.js";
import type { LockIdentitySource } from "../engine/lockfile.js";
import {
  applyStateSavePacket,
  loadState,
  manifestFromMeta,
  saveStateUnsafeLegacyOrTest,
  validManifestMeta,
  type GlobalManifestMeta,
  type SyncState,
} from "./config.js";
import { composeStateSavePacket, saveStateSource } from "./sync-state.js";

const stream = "https://api.test::ws_84::root";
const nonce = "8".repeat(32);
const sha = (c: string) => c.repeat(64);
const meta: GlobalManifestMeta = { encManifestSha: sha("a"), manifestHash: sha("b"), accountEpoch: 1, keyEpoch: 2, chain: [], chainBytes: 0, snapshotBytes: 123, gitRepos: {} };
const section = (c: string): GitSection => ({ bundleSha: sha(c), bundleEncSha: sha(c === "c" ? "d" : "c"), bundleCipherSize: 1, head: "ref: refs/heads/main", refs: {}, refScope: "all", generatedAt: "" });
const state = (): SyncState => ({ stream, stateNonce: nonce, stateRevision: 0, lastSyncedSequence: 1, lastSyncedManifest: { generatedAt: "one", files: [] }, manifestMeta: meta });
const identity: LockIdentitySource = { current: async () => ({ hostId: "84", bootId: "84", pid: 84, startTime: "1" }), probe: async () => ({ status: "alive", startTime: "1" }) };
const lock = () => ({ identity, token: () => "8".repeat(32) });
let root: string;

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-meta84-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("validManifestMeta", () => {
  test("accepts a complete valid value and rejects malformed values wholesale", () => {
    expect(validManifestMeta(meta)).toEqual(meta);
    const bad = [
      { ...meta, snapshotBytes: undefined }, { ...meta, manifestHash: "no" },
      { ...meta, chain: Array(17).fill(0).map((_, i) => i.toString(16).padStart(64, "0")), chainBytes: 1 },
      { ...meta, chain: [sha("c"), sha("c")], chainBytes: 1 }, { ...meta, chain: [sha("a")], chainBytes: 1 },
      { ...meta, accountEpoch: -1 }, { ...meta, keyEpoch: Number.NaN }, { ...meta, snapshotBytes: 1.5 },
      { ...meta, chainBytes: 1 }, { ...meta, chain: [sha("c")], chainBytes: 0 },
      { ...meta, gitRepos: undefined }, { ...meta, gitRepos: [] }, { ...meta, gitRepos: { "../bad": section("c") } },
    ];
    for (const value of bad) expect(validManifestMeta(value)).toBeUndefined();
  });
});

describe("manifest metadata packet semantics", () => {
  test("accepted globals replace or clear metadata; stale globals preserve it", async () => {
    await saveStateUnsafeLegacyOrTest(root, state());
    const accepted = composeStateSavePacket(state(), { expectedStream: stream, sourceGlobalSeq: 2, globalManifest: { generatedAt: "two", files: [] }, manifestMeta: meta, observedRepos: [], values: {} });
    expect((await applyStateSavePacket(root, accepted, { lock: lock() })).status).toBe("accepted");
    expect((await loadState(root, stream)).manifestMeta).toEqual(meta);
    const current = await loadState(root, stream);
    const stale = composeStateSavePacket(current, { expectedStream: stream, sourceGlobalSeq: 1, globalManifest: { generatedAt: "old", files: [] }, observedRepos: [], values: {} });
    expect(stale.global).toBeUndefined();
    await applyStateSavePacket(root, stale, { lock: lock() });
    expect((await loadState(root, stream)).manifestMeta).toEqual(meta);
    const clear = composeStateSavePacket(await loadState(root, stream), { expectedStream: stream, sourceGlobalSeq: 3, globalManifest: { generatedAt: "three", files: [] }, observedRepos: [], values: {} });
    await applyStateSavePacket(root, clear, { lock: lock() });
    expect((await loadState(root, stream)).manifestMeta).toBeUndefined();
  });

  test("global-sequence and repo-generation rejection preserve prior metadata", async () => {
    const initial = state();
    initial.lastSyncedSequence = 4;
    initial.repoRecords = { r: { repoGen: 2, sourceSeq: 4, base: section("c") } };
    await saveStateUnsafeLegacyOrTest(root, initial);
    const staleGlobal = { expectedStream: stream, expectedNonce: nonce, sourceGlobalSeq: 3, global: { manifest: { generatedAt: "old", files: [] } }, repos: [] };
    expect(await applyStateSavePacket(root, staleGlobal, { lock: lock() })).toMatchObject({ status: "rejected", reason: "global-sequence" });
    const badRepo = { expectedStream: stream, expectedNonce: nonce, sourceGlobalSeq: 5, global: { manifest: { generatedAt: "new", files: [] }, manifestMeta: undefined }, repos: [{ relPath: "r", expectedRepoGen: 1, newRecord: { sourceSeq: 5 } }] };
    expect(await applyStateSavePacket(root, badRepo, { lock: lock() })).toMatchObject({ status: "rejected", reason: "repo-generation" });
    expect((await loadState(root, stream)).manifestMeta).toEqual(meta);
  });

  test("repo-only base changes and retained newer records preserve metadata", async () => {
    const initial = state();
    initial.repoRecords = { r: { repoGen: 0, sourceSeq: 1, base: section("c") } };
    await saveStateUnsafeLegacyOrTest(root, initial);
    const changed = composeStateSavePacket(initial, { expectedStream: stream, sourceGlobalSeq: 2, observedRepos: ["r"], values: { bases: { r: section("e") } } });
    await applyStateSavePacket(root, changed, { lock: lock() });
    expect((await loadState(root, stream)).manifestMeta).toEqual(meta);

    const newer = state();
    newer.repoRecords = { r: { repoGen: 0, sourceSeq: 5, base: section("c") } };
    await saveStateUnsafeLegacyOrTest(root, newer);
    const retained = composeStateSavePacket(newer, { expectedStream: stream, sourceGlobalSeq: 2, observedRepos: ["r"], values: { bases: { r: section("e") } } });
    await applyStateSavePacket(root, retained, { lock: lock() });
    expect((await loadState(root, stream)).manifestMeta).toEqual(meta);
  });

  test("metadata rides the global despite pending projection; actual unsupported JSON fallback drops it", async () => {
    const clean = composeStateSavePacket(state(), { expectedStream: stream, sourceGlobalSeq: 2, globalManifest: { generatedAt: "two", files: [], manifestSchema: 2, gitRepos: { r: section("c") } }, manifestMeta: meta, observedRepos: ["r"], values: { bases: { r: section("c") } } });
    expect(clean.global?.manifestMeta).toEqual(meta);
    const pending = composeStateSavePacket(state(), { expectedStream: stream, sourceGlobalSeq: 2, globalManifest: { generatedAt: "two", files: [], manifestSchema: 2, gitRepos: { r: section("c") } }, manifestMeta: meta, observedRepos: ["r"], values: { bases: { r: section("c") }, pending: { r: section("e") } } });
    expect(pending.global?.manifestMeta).toEqual(meta);
    const legacy = await saveStateSource(root, state(), { expectedStream: stream, sourceGlobalSeq: 2, globalManifest: { generatedAt: "two", files: [] }, manifestMeta: meta, observedRepos: [], values: {} }, {
      apply: async () => ({ status: "unsupported", error: new Error("lock unsupported") }),
    });
    expect(legacy.manifestMeta).toBeUndefined();
  });

  test("reconstruction replaces projected gitRepos and omits an empty evidence map", () => {
    const described = { generatedAt: "head", files: [], manifestSchema: 2 as const, gitRepos: { r: section("c") } };
    const describedMeta = { ...meta, manifestHash: canonicalManifestHashStreaming(described), gitRepos: described.gitRepos };
    const reconstructed = manifestFromMeta({ ...described, gitRepos: { lagging: section("e") } }, describedMeta);
    expect(reconstructed).toEqual(described);
    expect(canonicalManifestHashStreaming(reconstructed)).toBe(describedMeta.manifestHash);
    expect(manifestFromMeta(described, { ...describedMeta, gitRepos: {} })).not.toHaveProperty("gitRepos");
  });

  test("pre-round-3 metadata without gitRepos normalizes away", () => {
    const { gitRepos: _gitRepos, ...preR3 } = meta;
    expect(validManifestMeta(preR3)).toBeUndefined();
  });
});
