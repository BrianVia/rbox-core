/**
 * Design 267 — the delta-scoped state save, exercised through the REAL
 * `saveStateSource` orchestration on both backends.
 *
 * Packet-level fixtures cannot see a minimal packet's provenance, so every case
 * here composes through `saveStateSource` with a pull-shaped `StateSource` and
 * compares result state, durable state, revisions, and the base generation —
 * the durable proof that no O(N) stage was built, promoted, or fsynced.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalManifestHashStreaming, type FileEntry, type GitSection, type Manifest } from "../../../engine/index.js";
import { manifestFromMeta, type GlobalManifestMeta, type StateSavePacket, type SyncState } from "../../sync-state-model.js";
import { elisionReceipt, type ElisionReceipt } from "../../sync-state-elision.js";
import { pullElisionReceipt } from "../../sync/pull-state-save.js";
import { composeStateSavePacket, saveStateSource, type StateSource } from "../../sync-state.js";
import { authorityMarkerBytes } from "../authority-marker.js";
import { sqliteResetPaths, statePath } from "../paths.js";
import { createStateStore, openStateStore } from "../store/open.js";
import { openReadSnapshot } from "../store/read-snapshot.js";
import { applyStateSavePacket, ensureTelemetryBindingId, loadRawState } from "./whole-state-compat.js";

const STREAM = "https://api.test::ws_267::root";
const AUTHORITY = "a".repeat(32);
const LINEAGE = "b".repeat(32);
const NONCE = "c".repeat(32);
const SEQ = 5;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  delete process.env.RBOX_SAVE_NOOP_ELIDE;
});

const file = (name: string, seed: number): FileEntry => ({
  path: name, sha256: seed.toString(16).padStart(64, "0"), size: seed,
  mode: 0o644, mtimeMs: seed, type: "file",
} as FileEntry);

const hex = (length: number, seed: number): string => seed.toString(16).padStart(length, "0");

const SECTION: GitSection = {
  bundleSha: hex(64, 11), bundleEncSha: hex(64, 12), bundleCipherSize: 21,
  head: hex(40, 13), refs: {}, config: {}, refScope: "all",
  generatedAt: "2026-08-16T00:00:00.000Z",
};

const MANIFEST: Manifest = {
  generatedAt: "2026-08-16T00:00:00.000Z",
  files: [file("one.txt", 1), file("two.txt", 2)],
};

const META_FIELDS: GlobalManifestMeta = {
  encManifestSha: "1".repeat(64),
  manifestHash: "0".repeat(64),
  accountEpoch: 1,
  keyEpoch: 1,
  chain: [],
  chainBytes: 0,
  snapshotBytes: 4096,
  gitRepos: {},
};

async function tempRoot(prefix: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `rbox-267-${prefix}-`));
  roots.push(root);
  await fsp.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  return root;
}

function baseGeneration(root: string): number {
  const store = openStateStore(sqliteResetPaths.active(root), { readonly: true });
  try {
    return openReadSnapshot(store).token.baseGeneration;
  } finally {
    store.close();
  }
}

interface Seeded { root: string; state: SyncState; meta: GlobalManifestMeta }

/**
 * A workspace that has already adopted `MANIFEST` at `SEQ` with one repo record,
 * whose persisted meta describes exactly the persisted manifest. The meta hash is
 * computed from the state as it READS BACK, so the §3.2.3 self-check has a
 * truthful operand rather than one this test asserted into existence.
 */
async function seededSqlite(prefix: string, manifest: Manifest = MANIFEST): Promise<Seeded> {
  const root = await tempRoot(prefix);
  createStateStore(sqliteResetPaths.active(root), {
    authorityId: AUTHORITY, lineageId: LINEAGE, stream: STREAM,
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  }).close();
  await fsp.writeFile(statePath(root), authorityMarkerBytes(AUTHORITY));
  const first = await applyStateSavePacket(root, {
    expectedStream: STREAM, expectedNonce: NONCE, sourceGlobalSeq: SEQ,
    global: { manifest, manifestMeta: META_FIELDS },
    repos: [{ relPath: "repo", expectedRepoGen: 0, newRecord: { sourceSeq: SEQ } }],
  });
  expect(first.status).toBe("accepted");
  if (first.status !== "accepted") throw new Error("seed save was refused");
  const meta = {
    ...META_FIELDS,
    manifestHash: canonicalManifestHashStreaming(manifestFromMeta(first.state.lastSyncedManifest, META_FIELDS)),
  };
  const second = await applyStateSavePacket(root, {
    expectedStream: STREAM, expectedNonce: NONCE, sourceGlobalSeq: SEQ,
    global: { manifest, manifestMeta: meta }, repos: [],
  });
  if (second.status !== "accepted") throw new Error("seed meta save was refused");
  return { root, state: second.state, meta };
}

/** The same seeded shape on the legacy-JSON arm, written directly. */
async function seededLegacy(prefix: string): Promise<Seeded> {
  const root = await tempRoot(prefix);
  const meta = {
    ...META_FIELDS,
    manifestHash: canonicalManifestHashStreaming(manifestFromMeta(MANIFEST, META_FIELDS)),
  };
  const state: SyncState = {
    stream: STREAM, stateNonce: NONCE, stateRevision: 4,
    lastSyncedSequence: SEQ, lastSyncedManifest: MANIFEST, manifestMeta: meta,
    repoRecords: { repo: { repoGen: 1, sourceSeq: SEQ } },
  };
  await fsp.writeFile(statePath(root), JSON.stringify(state));
  return { root, state: (await loadRawState(root))!, meta };
}

function pullSource(seed: Seeded, overrides: Partial<StateSource> = {}): StateSource {
  return {
    expectedStream: STREAM,
    sourceGlobalSeq: SEQ,
    globalManifest: MANIFEST,
    manifestMeta: seed.meta,
    observedRepos: ["repo"],
    values: {},
    elisionReceipt: receiptFor(seed),
    ...overrides,
  };
}

const receiptFor = (seed: Seeded, evidence: Partial<ElisionReceipt> = {}): ElisionReceipt | undefined =>
  elisionReceipt(seed.state, { noActions: true, storedBaseIsRemote: true, manifestMeta: seed.meta, ...evidence });

/** The real adapter, with every packet it is handed recorded. */
function capturing(packets: StateSavePacket[], interleave?: () => Promise<void>): typeof applyStateSavePacket {
  let pending = interleave;
  return async (root, packet, options) => {
    packets.push(packet);
    if (pending) {
      const run = pending;
      pending = undefined;
      await run();
    }
    return applyStateSavePacket(root, packet, options);
  };
}

// --- M1: the minimal packet -------------------------------------------------

test("red-first: without a receipt the no-op save still builds the whole global stage", async () => {
  const seed = await seededSqlite("red-first");
  const packets: StateSavePacket[] = [];
  const before = baseGeneration(seed.root);
  const { elisionReceipt: _none, ...noProvenance } = pullSource(seed);
  const saved = await saveStateSource(seed.root, seed.state, noProvenance, { apply: capturing(packets) });

  expect(packets).toHaveLength(1);
  expect(packets[0]!.global?.manifest.files).toHaveLength(MANIFEST.files.length);
  expect(packets[0]!.repos.map((repo) => repo.relPath)).toEqual(["repo"]);
  expect(packets[0]!.elisionExpectation).toBeUndefined();
  // A global section landed, so a fresh BASE generation was staged and promoted.
  expect(baseGeneration(seed.root)).toBe(before + 1);
  expect(saved.stateRevision).toBe(seed.state.stateRevision! + 1);
});

test("M1 flips it: the proven no-op sends a minimal packet and stages nothing", async () => {
  const seed = await seededSqlite("minimal");
  const packets: StateSavePacket[] = [];
  const before = baseGeneration(seed.root);
  const saved = await saveStateSource(seed.root, seed.state, pullSource(seed), { apply: capturing(packets) });

  expect(packets).toHaveLength(1);
  expect(packets[0]!.global).toBeUndefined();
  expect(packets[0]!.repos).toEqual([]);
  expect(packets[0]!.elisionExpectation).toEqual({ nonce: NONCE, stateRevision: seed.state.stateRevision! });
  expect(baseGeneration(seed.root)).toBe(before);
  // The save is never skipped: every accepted CAS still advances the revision.
  expect(saved.stateRevision).toBe(seed.state.stateRevision! + 1);
  expect(saved.lastSyncedManifest.files).toEqual(seed.state.lastSyncedManifest.files);
  expect(saved.manifestMeta).toEqual(seed.meta);
});

test("the elided shape returns exactly the durable reload", async () => {
  const seed = await seededSqlite("projection");
  const saved = await saveStateSource(seed.root, seed.state, pullSource(seed));
  expect(saved).toStrictEqual((await loadRawState(seed.root))!);
});

test("the kill switch restores the full packet", async () => {
  process.env.RBOX_SAVE_NOOP_ELIDE = "0";
  const seed = await seededSqlite("kill-switch");
  const packets: StateSavePacket[] = [];
  await saveStateSource(seed.root, seed.state, pullSource(seed), { apply: capturing(packets) });
  expect(packets[0]!.global?.manifest.files).toHaveLength(MANIFEST.files.length);
  expect(packets[0]!.elisionExpectation).toBeUndefined();
});

// --- §3.2 negative controls -------------------------------------------------

test("every missing or false predicate input composes today's full packet", async () => {
  const seed = await seededSqlite("negatives");
  const cases: Array<[string, (live: Seeded) => StateSource]> = [
    ["one action", (live) => pullSource(live, { elisionReceipt: receiptFor(live, { noActions: false })! })],
    ["scoped straddling (base is a projection)",
      (live) => pullSource(live, { elisionReceipt: receiptFor(live, { storedBaseIsRemote: false })! })],
    ["missing meta", (live) => pullSource(live, { elisionReceipt: elisionReceipt(live.state, { noActions: true, storedBaseIsRemote: true })! })],
    ["a newer sequence", (live) => pullSource(live, { sourceGlobalSeq: SEQ + 1 })],
  ];
  for (const [name, build] of cases) {
    const packets: StateSavePacket[] = [];
    const live: Seeded = { ...seed, state: (await loadRawState(seed.root))! };
    await saveStateSource(seed.root, live.state, build(live), { apply: capturing(packets) });
    expect(packets[0]!.global, name).toBeDefined();
    expect(packets[0]!.global!.manifest.files, name).toHaveLength(MANIFEST.files.length);
  }
});

test("an ignored-path-only change keeps the full packet — `actions` is not the evidence", async () => {
  const seed = await seededSqlite("ignored-only");
  const packets: StateSavePacket[] = [];
  // The filtered action list is empty; the UNFILTERED one is not, and only the
  // unfiltered one reaches the receipt.
  const source = pullSource(seed, { elisionReceipt: receiptFor(seed, { noActions: false })! });
  await saveStateSource(seed.root, seed.state, source, { apply: capturing(packets) });
  expect(packets[0]!.global).toBeDefined();
  expect(packets[0]!.global!.manifest.files).toHaveLength(MANIFEST.files.length);
  // The repo record still composes to itself, so §3.3 elides that transition on
  // its own evidence — which is exactly why the packet must carry the binding.
  expect(packets[0]!.elisionExpectation).toBeDefined();
});

test("a changed repo record is never elided, and the unchanged ones still are", async () => {
  const seed = await seededSqlite("repo-change");
  const packets: StateSavePacket[] = [];
  const source = pullSource(seed, {
    observedRepos: ["repo", "other"],
    values: { pending: { repo: SECTION } },
  });
  await saveStateSource(seed.root, seed.state, source, { apply: capturing(packets) });
  // `other` has no stored record: absence is a distinct durable outcome, so it
  // is transitioned rather than elided.
  expect(packets[0]!.repos.map((repo) => repo.relPath).sort()).toEqual(["other", "repo"]);
  const durable = (await loadRawState(seed.root))!;
  expect(durable.repoRecords!.repo!.pending).toMatchObject({ bundleSha: SECTION.bundleSha });
});

test("durable encSha drift under zero actions fails the content self-check and heals", async () => {
  // The persisted manifest carries a different entry than the meta describes:
  // the r1 counterexample. The §3.2.3 hash is what catches it.
  const drifted: Manifest = { ...MANIFEST, files: [file("one.txt", 1), file("two.txt", 9)] };
  const seed = await seededSqlite("enc-drift", drifted);
  const trueMeta = {
    ...META_FIELDS,
    manifestHash: canonicalManifestHashStreaming(manifestFromMeta({ ...MANIFEST, gitRepos: undefined }, META_FIELDS)),
  };
  const packets: StateSavePacket[] = [];
  const source: StateSource = {
    ...pullSource(seed),
    manifestMeta: trueMeta,
    elisionReceipt: receiptFor(seed, { manifestMeta: trueMeta })!,
  };
  const saved = await saveStateSource(seed.root, seed.state, source, { apply: capturing(packets) });
  expect(packets[0]!.global).toBeDefined();
  expect(saved.lastSyncedManifest.files).toEqual(MANIFEST.files);
  expect(saved).toStrictEqual((await loadRawState(seed.root))!);
});

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

test("elision drift is retryable and never rides the terminal nonce translation", async () => {
  const seed = await seededSqlite("drift-reason");
  const stale = { ...seed, state: { ...seed.state, stateRevision: seed.state.stateRevision! - 1 } };
  const packet = composeStateSavePacket(seed.state, pullSource(stale));
  expect(packet.elisionExpectation).toBeDefined();
  const result = await applyStateSavePacket(seed.root, packet);
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") expect(result.reason).toBe("elision-drift");
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

test("legacy JSON elides and returns the same durable state as the store", async () => {
  const seed = await seededLegacy("json-accept");
  const packets: StateSavePacket[] = [];
  const saved = await saveStateSource(seed.root, seed.state, pullSource(seed), { apply: capturing(packets) });
  expect(packets[0]!.global).toBeUndefined();
  expect(packets[0]!.repos).toEqual([]);
  expect(saved.stateRevision).toBe(seed.state.stateRevision! + 1);
  expect(saved.lastSyncedManifest.files).toEqual(MANIFEST.files);
  // `toEqual`, not `toStrictEqual`: the JSON arm has always returned its composed
  // state, whose absent lanes are present-and-undefined, while the file it wrote
  // cannot carry an undefined. That asymmetry predates design 267.
  expect(saved).toEqual((await loadRawState(seed.root))!);
});

test("legacy JSON rejects a drifted receipt on the revision predicate, exactly as the store does", async () => {
  const seed = await seededLegacy("json-drift");
  const stale = { ...seed, state: { ...seed.state, stateRevision: seed.state.stateRevision! - 1 } };
  const packet = composeStateSavePacket(seed.state, pullSource(stale));
  expect(packet.elisionExpectation).toBeDefined();
  const result = await applyStateSavePacket(seed.root, packet);
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") expect(result.reason).toBe("elision-drift");
  // An ordinary intervening JSON save preserves the nonce, so nonce alone would
  // have accepted this packet.
  expect(packet.expectedNonce).toBe(seed.state.stateNonce!);
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
  expect(saved).toEqual((await loadRawState(seed.root))!);
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
    // Each arm binds to its OWN revision; what must match is whether it binds.
    expect(composed[0]!.elisionExpectation?.nonce).toBe(composed[1]!.elisionExpectation?.nonce);
    expect(composed[0]!.elisionExpectation?.stateRevision).toBe(store.state.stateRevision);
    expect(composed[1]!.elisionExpectation?.stateRevision).toBe(json.state.stateRevision);
    // … and the same durable outcome, modulo each arm's own lineage identity.
    const shed = (state: SyncState) => ({
      ...state, stateNonce: undefined, stateRevision: undefined, telemetryBindingId: undefined,
      lastSyncedManifest: { ...state.lastSyncedManifest, gitRepos: undefined },
    });
    expect(shed(results[0]!)).toEqual(shed(results[1]!));
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

test("only the standalone pull line mints provenance", () => {
  const state: SyncState = {
    stream: STREAM, stateNonce: NONCE, stateRevision: 3,
    lastSyncedSequence: SEQ, lastSyncedManifest: MANIFEST,
  };
  const input = {
    deps: {},
    state,
    scoped: { storedBaseIsRemote: true },
    manifestMeta: META_FIELDS,
    noActions: true,
    elisionEligible: true,
  } as Parameters<typeof pullElisionReceipt>[0];
  expect(pullElisionReceipt(input)).toBeDefined();
  // Chain repair, resolution-receipt reconciliation, and push-conflict recovery
  // adoption never set the flag.
  expect(pullElisionReceipt({ ...input, elisionEligible: false })).toBeUndefined();
  // A degraded pull observes less than a whole pull does.
  expect(pullElisionReceipt({ ...input, deps: { syncMutex: { degraded: true } } as never })).toBeUndefined();
});

// --- protected empty-packet contracts ---------------------------------------

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
