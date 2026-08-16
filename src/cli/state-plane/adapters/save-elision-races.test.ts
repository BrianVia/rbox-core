/**
 * Design 267 §3.2b and §4 — what happens when another writer lands between the
 * proof and the state lock, and what the accepted projection is allowed to be.
 * Every interleave here is a real accepted CAS, not a fabricated revision.
 */
import { afterEach, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import { canonicalManifestHashStreaming, type Manifest } from "../../../engine/index.js";
import { manifestFromMeta, type StateSavePacket, type SyncState } from "../../sync-state-model.js";
import { elisionReceipt } from "../../sync-state-elision.js";
import { composeStateSavePacket, saveStateSource, type StateSource } from "../../sync-state.js";
import { applyStateSavePacket, ensureTelemetryBindingId, loadRawState } from "./whole-state-compat.js";
import { pullElisionReceipt } from "../../sync/pull-state-save.js";
import type { WorkspaceSyncMutex } from "../../sync-mutex.js";
import { authorityMarkerBytes } from "../authority-marker.js";
import { sqliteResetPaths, statePath } from "../paths.js";
import { createStateStore } from "../store/open.js";
import {
  AUTHORITY, capturing, cleanupElisionFixtures, file, LINEAGE, MANIFEST, META_FIELDS, NONCE,
  pullSource, receiptFor, seededLegacy, seededSqlite, SEQ, STREAM, tempRoot, type Seeded,
} from "./save-elision.test-helper.js";

afterEach(cleanupElisionFixtures);

// --- §3.2b: the snapshot binding --------------------------------------------

test("an interleaved content change rejects the elided save and the retry saves in full", async () => {
  const seed = await seededSqlite("interleave-content");
  const packets: StateSavePacket[] = [];
  const interleave = async (): Promise<void> => {
    const live = (await loadRawState(seed.root))!;
    const result = await applyStateSavePacket(seed.root, {
      expectedStream: STREAM, expectedNonce: NONCE, sourceGlobalSeq: SEQ,
      global: { manifest: { ...MANIFEST, files: [file("one.txt", 1)] }, manifestMeta: seed.meta },
      repos: [{ relPath: "repo", expectedRepoGen: live.repoRecords!.repo!.repoGen, newRecord: { sourceSeq: SEQ, idxProj: "moved" } }],
    });
    expect(result.status).toBe("accepted");
  };
  const saved = await saveStateSource(seed.root, seed.state, pullSource(seed), { apply: capturing(packets, interleave) });

  expect(packets).toHaveLength(2);
  expect(packets[0]!.elisionExpectation).toBeDefined();
  expect(packets[1]!.elisionExpectation).toBeUndefined();
  expect(packets[1]!.global).toBeDefined();
  expect(saved).toStrictEqual((await loadRawState(seed.root))!);
});

test("a stale receipt cannot be re-sent: an accepted no-op interleave costs one attempt", async () => {
  const seed = await seededSqlite("stale-receipt");
  const packets: StateSavePacket[] = [];
  // The interleaving save is itself a minimal accepted no-op: every elision
  // predicate is still true afterwards, so only the receipt's revision moved.
  const interleave = async (): Promise<void> => {
    const live = (await loadRawState(seed.root))!;
    const result = await applyStateSavePacket(seed.root, {
      expectedStream: STREAM, expectedNonce: NONCE, sourceGlobalSeq: SEQ, repos: [],
    });
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") expect(result.state.stateRevision).toBe(live.stateRevision! + 1);
  };
  const saved = await saveStateSource(seed.root, seed.state, pullSource(seed), { apply: capturing(packets, interleave) });

  expect(packets).toHaveLength(2);
  expect(packets[0]!.elisionExpectation).toEqual({ nonce: NONCE, stateRevision: seed.state.stateRevision! });
  // Attempt two carries no receipt at all — not a rebound one.
  expect(packets[1]!.elisionExpectation).toBeUndefined();
  expect(packets[1]!.global).toBeDefined();
  expect(saved).toStrictEqual((await loadRawState(seed.root))!);
});

/** A genuinely elided packet, then a real accepted save under it. Nothing about
 * the receipt is fabricated: only the world moves. */
async function driftedElidedPacket(seed: Seeded): Promise<StateSavePacket> {
  const packet = composeStateSavePacket(seed.state, pullSource(seed));
  expect(packet.elisionExpectation).toEqual({ nonce: NONCE, stateRevision: seed.state.stateRevision! });
  const interleaved = await applyStateSavePacket(seed.root, {
    expectedStream: STREAM, expectedNonce: NONCE, sourceGlobalSeq: SEQ, repos: [],
  });
  if (interleaved.status !== "accepted") throw new Error(`interleave was refused (${interleaved.status})`);
  return packet;
}

test("elision drift is retryable and never rides the terminal nonce translation", async () => {
  const seed = await seededSqlite("drift-reason");
  const packet = await driftedElidedPacket(seed);
  const result = await applyStateSavePacket(seed.root, packet);
  expect(result.status).toBe("rejected");
  if (result.status !== "rejected") return;
  // NOT "nonce": that verdict is terminal and `saveStateSource` throws on it.
  expect(result.reason).toBe("elision-drift");
  expect(packet.expectedNonce).toBe(result.state.stateNonce);
});

test("a content-carrying packet may not claim the accepted projection", async () => {
  // §4's precondition is re-derived by the adapter, not trusted from the caller:
  // a packet that wrote something is read back even when a projection is offered.
  const seed = await seededSqlite("projection-guard");
  const lie: SyncState = { ...seed.state, lastSyncedManifest: { generatedAt: "1970-01-01T00:00:00.000Z", files: [] } };
  const result = await applyStateSavePacket(seed.root, {
    expectedStream: STREAM, expectedNonce: NONCE, sourceGlobalSeq: SEQ,
    global: { manifest: { ...MANIFEST, files: [file("one.txt", 1)] }, manifestMeta: seed.meta },
    repos: [],
    elisionExpectation: { nonce: NONCE, stateRevision: seed.state.stateRevision! },
  }, { acceptedProjection: lie });
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") return;
  expect(result.state.lastSyncedManifest.files.map((entry) => entry.path)).toEqual(["one.txt"]);
  expect(result.state).toStrictEqual((await loadRawState(seed.root))!);
});

test("an interleaved telemetry mint preserves the revision and the elided save still holds", async () => {
  const seed = await seededSqlite("telemetry");
  expect(seed.state.telemetryBindingId).toBeUndefined();
  const packets: StateSavePacket[] = [];
  const interleave = async (): Promise<void> => {
    const minted = await ensureTelemetryBindingId(seed.root, STREAM);
    expect(minted.bindingId).toMatch(/^[0-9a-f]{16}$/);
    expect(minted.state.stateRevision).toBe(seed.state.stateRevision);
  };
  const saved = await saveStateSource(seed.root, seed.state, pullSource(seed), { apply: capturing(packets, interleave) });

  expect(packets).toHaveLength(1);
  expect(packets[0]!.elisionExpectation).toBeDefined();
  expect(saved.telemetryBindingId).toMatch(/^[0-9a-f]{16}$/);
  expect(saved).toStrictEqual((await loadRawState(seed.root))!);
});

// --- backend parity ---------------------------------------------------------

/**
 * The JSON arm returns its COMPOSED state, whose absent lanes are
 * present-and-undefined; the file it wrote cannot carry an undefined. That
 * asymmetry predates design 267, so the equality gate is bounded rather than
 * loosened: serializing drops exactly the undefined members and nothing else,
 * and the comparison is strict from there — a genuinely different value fails.
 */
const jsonRoundTrip = (state: SyncState): SyncState => JSON.parse(JSON.stringify(state)) as SyncState;

test("legacy JSON elides and returns the same durable state as the store", async () => {
  const seed = await seededLegacy("json-accept");
  const packets: StateSavePacket[] = [];
  const saved = await saveStateSource(seed.root, seed.state, pullSource(seed), { apply: capturing(packets) });
  expect(packets[0]!.global).toBeUndefined();
  expect(packets[0]!.repos).toEqual([]);
  expect(saved.stateRevision).toBe(seed.state.stateRevision! + 1);
  expect(saved.lastSyncedManifest.files).toEqual(MANIFEST.files);
  expect(jsonRoundTrip(saved)).toStrictEqual((await loadRawState(seed.root))!);
});

test("legacy JSON rejects a drifted receipt on the revision predicate, exactly as the store does", async () => {
  const seed = await seededLegacy("json-drift");
  const packet = await driftedElidedPacket(seed);
  const result = await applyStateSavePacket(seed.root, packet);
  expect(result.status).toBe("rejected");
  if (result.status !== "rejected") return;
  expect(result.reason).toBe("elision-drift");
  // The intervening JSON save preserved the nonce, so the nonce predicate alone
  // would have ACCEPTED this packet — the revision is what closes the race.
  expect(packet.expectedNonce).toBe(result.state.stateNonce);
});

test("legacy JSON: an accepted no-op interleave forces the same single-attempt full retry", async () => {
  const seed = await seededLegacy("json-stale");
  const packets: StateSavePacket[] = [];
  const interleave = async (): Promise<void> => {
    const result = await applyStateSavePacket(seed.root, {
      expectedStream: STREAM, expectedNonce: NONCE, sourceGlobalSeq: SEQ, repos: [],
    });
    expect(result.status).toBe("accepted");
  };
  const saved = await saveStateSource(seed.root, seed.state, pullSource(seed), { apply: capturing(packets, interleave) });
  expect(packets).toHaveLength(2);
  expect(packets[1]!.elisionExpectation).toBeUndefined();
  expect(jsonRoundTrip(saved)).toStrictEqual((await loadRawState(seed.root))!);
});

test("the two backends compose and accept the same save, elided and not", async () => {
  for (const elide of [true, false]) {
    const store = await seededSqlite(`differential-store-${elide}`);
    const json = await seededLegacy(`differential-json-${elide}`);
    const results: SyncState[] = [];
    const composed: StateSavePacket[] = [];
    for (const seed of [store, json]) {
      const packets: StateSavePacket[] = [];
      const source = pullSource(seed, elide ? {} : { elisionReceipt: receiptFor(seed, { noActions: false })! });
      results.push(await saveStateSource(seed.root, seed.state, source, { apply: capturing(packets) }));
      composed.push(packets[0]!);
    }
    // Same shape out of composition …
    expect(composed[0]!.global === undefined).toBe(composed[1]!.global === undefined);
    expect(composed[0]!.repos.length).toBe(composed[1]!.repos.length);
    // An expectation appears iff the global was proven unchanged, on both arms;
    // each binds to its OWN revision.
    expect(composed[0]!.elisionExpectation?.stateRevision).toBe(elide ? store.state.stateRevision : undefined);
    expect(composed[1]!.elisionExpectation?.stateRevision).toBe(elide ? json.state.stateRevision : undefined);
    // … and the same durable outcome, modulo each arm's own lineage identity.
    const shed = (state: SyncState) => ({
      ...state, stateNonce: undefined, stateRevision: undefined, telemetryBindingId: undefined,
      lastSyncedManifest: { ...state.lastSyncedManifest, gitRepos: undefined },
    });
    expect(shed(jsonRoundTrip(results[0]!))).toEqual(shed(jsonRoundTrip(results[1]!)));
    expect(results[0]!.stateRevision).toBe(store.state.stateRevision! + 1);
    expect(results[1]!.stateRevision).toBe(json.state.stateRevision! + 1);
  }
});

// --- provenance and identity preconditions ----------------------------------

test("a receipt needs a minted nonce and a defined revision", () => {
  const evidence = { noActions: true, storedBaseIsRemote: true, manifestMeta: META_FIELDS };
  const capable: SyncState = {
    stream: STREAM, stateNonce: NONCE, stateRevision: 3,
    lastSyncedSequence: SEQ, lastSyncedManifest: MANIFEST,
  };
  expect(elisionReceipt(capable, evidence)).toEqual({ ...evidence, nonce: NONCE, stateRevision: 3 });
  // First save: no lineage identity to bind to.
  expect(elisionReceipt({ ...capable, stateNonce: undefined }, evidence)).toBeUndefined();
  // Legacy nonce-less JSON: the "legacy" sentinel is never elision evidence.
  expect(elisionReceipt({ ...capable, stateNonce: "legacy" }, evidence)).toBeUndefined();
  expect(elisionReceipt({ ...capable, stateRevision: undefined }, evidence)).toBeUndefined();
  process.env.RBOX_SAVE_NOOP_ELIDE = "0";
  expect(elisionReceipt(capable, evidence)).toBeUndefined();
});

/** Provenance itself is proved end to end in sync/pull-elision-provenance.test.ts,
 * through the real pull lanes. This pins the one gate that has no pull of its
 * own: a degraded mutex observed less than a whole cycle did. */
test("a degraded workspace mutex mints no receipt", () => {
  const state: SyncState = {
    stream: STREAM, stateNonce: NONCE, stateRevision: 3,
    lastSyncedSequence: SEQ, lastSyncedManifest: MANIFEST,
  };
  const input = {
    deps: {}, state, scoped: { storedBaseIsRemote: true },
    manifestMeta: META_FIELDS, noActions: true, provenance: "standalone",
  } as const;
  expect(pullElisionReceipt(input)).toBeDefined();
  expect(pullElisionReceipt({ ...input, provenance: "recovery" })).toBeUndefined();
  expect(pullElisionReceipt({ ...input, deps: { syncMutex: degradedMutex() } })).toBeUndefined();
});

// --- protected empty-packet contracts ---------------------------------------

/** The shape `acquireWorkspaceSyncMutex` hands back when the lock is unusable. */
const degradedMutex = (): WorkspaceSyncMutex => ({ root: "/nowhere", degraded: "unsupported" } as WorkspaceSyncMutex);

test("an all-empty packet with no expectation still initializes capable lineage", async () => {
  const root = await tempRoot("lineage-init");
  createStateStore(sqliteResetPaths.active(root), {
    authorityId: AUTHORITY, lineageId: LINEAGE, stream: STREAM, createdBy: "test",
  }).close();
  await fsp.writeFile(statePath(root), authorityMarkerBytes(AUTHORITY));
  const result = await applyStateSavePacket(root, {
    expectedStream: STREAM, expectedNonce: "legacy", sourceGlobalSeq: 0, repos: [],
  });
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") return;
  expect(result.state.stateNonce).toMatch(/^[0-9a-f]{32}$/);
  expect(result.state.stateRevision).toBe(1);
  expect(await loadRawState(root)).toStrictEqual(result.state);
});

test("the nonce-less reset migration's empty packet is unchanged by elision", async () => {
  // reset-state.ts's legacy-lineage migration sends exactly this packet under the
  // held state lock: no global, no repos, no expectation, `legacy` nonce. It must
  // mint the nonce, advance the revision once, and move nothing else.
  const root = await tempRoot("reset-migration");
  const legacy: SyncState = {
    stream: STREAM, lastSyncedSequence: SEQ, lastSyncedManifest: MANIFEST,
    repoRecords: { repo: { repoGen: 3, sourceSeq: SEQ } },
  };
  await fsp.writeFile(statePath(root), JSON.stringify(legacy));
  const before = (await loadRawState(root))!;
  expect(before.stateNonce).toBeUndefined();

  const migrated = await applyStateSavePacket(root, {
    expectedStream: STREAM, expectedNonce: "legacy", sourceGlobalSeq: SEQ, repos: [],
  });
  expect(migrated.status).toBe("accepted");
  if (migrated.status !== "accepted") return;
  expect(migrated.state.stateNonce).toMatch(/^[0-9a-f]{32}$/);
  expect(migrated.state.stateRevision).toBe(1);
  expect(migrated.state.elisionExpectation).toBeUndefined();
  // Everything the migration does not own is byte-identical.
  const shed = (state: SyncState) => ({ ...state, stateNonce: undefined, stateRevision: undefined });
  expect(shed(jsonRoundTrip(migrated.state))).toEqual(shed(jsonRoundTrip(before)));
  expect(jsonRoundTrip(migrated.state)).toStrictEqual((await loadRawState(root))!);
});
