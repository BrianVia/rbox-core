/**
 * Design 267 M1 — what the no-op proof admits and what it refuses, through the
 * REAL `saveStateSource` orchestration. Packet-level fixtures cannot see a
 * minimal packet's provenance, so every case here composes a pull-shaped source
 * and reads the durable result back.
 */
import { afterEach, expect, test } from "bun:test";
import { canonicalManifestHashStreaming } from "../../../engine/index.js";
import { manifestFromMeta, type StateSavePacket, type SyncState } from "../../sync-state-model.js";
import { elisionReceipt } from "../../sync-state-elision.js";
import { composeStateSavePacket, saveStateSource, type StateSource } from "../../sync-state.js";
import { applyStateSavePacket, loadRawState } from "./whole-state-compat.js";
import {
  baseGeneration, capturing, cleanupElisionFixtures, file, hex, MANIFEST, META_FIELDS, NONCE,
  pullSource, receiptFor, SECTION, seededSqlite, SEQ, STREAM, type Seeded,
} from "./save-elision.test-helper.js";

afterEach(cleanupElisionFixtures);

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

test("repeated elided saves retain the BASE generation, and content still advances it", async () => {
  // The §3.4 trade, pinned: the generation stamp addresses rows, it is not a
  // freshness signal. Two elided cycles must leave it — and every row it
  // addresses — exactly where the last content-carrying save left them.
  const seed = await seededSqlite("retained-generation");
  const generation = baseGeneration(seed.root);
  const before = (await loadRawState(seed.root))!;

  for (let cycle = 0; cycle < 2; cycle++) {
    const live: Seeded = { ...seed, state: (await loadRawState(seed.root))! };
    const packets: StateSavePacket[] = [];
    const saved = await saveStateSource(live.root, live.state, pullSource(live), { apply: capturing(packets) });
    expect(packets[0]!.global, `cycle ${cycle}`).toBeUndefined();
    expect(baseGeneration(seed.root), `cycle ${cycle}`).toBe(generation);
    expect(saved).toStrictEqual((await loadRawState(seed.root))!);
  }
  const afterElisions = (await loadRawState(seed.root))!;
  expect({ ...afterElisions, stateRevision: before.stateRevision })
    .toStrictEqual(before);

  // …and a save that really carries content still moves the generation and is
  // readable through it.
  const live = (await loadRawState(seed.root))!;
  const changed = { ...MANIFEST, files: [file("one.txt", 1), file("three.txt", 3)] };
  const advanced = await applyStateSavePacket(seed.root, {
    expectedStream: STREAM, expectedNonce: NONCE, sourceGlobalSeq: SEQ + 1,
    global: { manifest: changed, manifestMeta: seed.meta }, repos: [],
  });
  expect(advanced.status).toBe("accepted");
  expect(baseGeneration(seed.root)).toBe(generation + 1);
  const reloaded = (await loadRawState(seed.root))!;
  expect(reloaded.lastSyncedManifest.files.map((entry) => entry.path)).toEqual(["one.txt", "three.txt"]);
  expect(reloaded.stateRevision).toBe(live.stateRevision! + 1);
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

test("an unfiltered action forbids every elision, repo transitions included", async () => {
  const seed = await seededSqlite("ignored-only");
  const packets: StateSavePacket[] = [];
  // The filtered action list is empty; the UNFILTERED one is not, and only the
  // unfiltered one reaches the receipt.
  const source = pullSource(seed, { elisionReceipt: receiptFor(seed, { noActions: false })! });
  await saveStateSource(seed.root, seed.state, source, { apply: capturing(packets) });
  expect(packets[0]!.global).toBeDefined();
  expect(packets[0]!.global!.manifest.files).toHaveLength(MANIFEST.files.length);
  // §3.3: repo transitions ride the global proof, never their own. The record
  // composes to itself here, and it is STILL sent — so a content-carrying save
  // never attaches an expectation and never spends retry budget on drift.
  expect(packets[0]!.repos.map((repo) => repo.relPath)).toEqual(["repo"]);
  expect(packets[0]!.elisionExpectation).toBeUndefined();
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

test("encSha-ONLY durable drift under zero actions refuses elision and heals", async () => {
  // The r1 counterexample, isolated: plaintext sha256, size, mode and mtime all
  // match the meta's manifest — ONLY the ciphertext address differs. A predicate
  // that stopped binding `encSha` would elide here and leave the drift durable,
  // which no other fixture in this suite would notice.
  const truth = MANIFEST.files.map((entry) => ({ ...entry, encSha: hex(64, 200 + entry.size) }));
  const drifted = truth.map((entry, index) => index === 1 ? { ...entry, encSha: hex(64, 999) } : entry);
  const seed = await seededSqlite("enc-drift", { ...MANIFEST, files: drifted });
  const trueMeta = {
    ...META_FIELDS,
    manifestHash: canonicalManifestHashStreaming(manifestFromMeta({ ...MANIFEST, files: truth }, META_FIELDS)),
  };
  const durableBefore = (await loadRawState(seed.root))!;
  expect(durableBefore.lastSyncedManifest.files[1]!.encSha).toBe(hex(64, 999));
  expect(durableBefore.lastSyncedManifest.files.map((entry) => entry.sha256))
    .toEqual(truth.map((entry) => entry.sha256));

  const packets: StateSavePacket[] = [];
  const source: StateSource = {
    ...pullSource(seed, { globalManifest: { ...MANIFEST, files: truth } }),
    manifestMeta: trueMeta,
    elisionReceipt: receiptFor(seed, { manifestMeta: trueMeta })!,
  };
  const saved = await saveStateSource(seed.root, seed.state, source, { apply: capturing(packets) });
  expect(packets[0]!.global).toBeDefined();
  expect(packets[0]!.elisionExpectation).toBeUndefined();
  // Healed, byte for byte, and the durable store agrees.
  expect(saved.lastSyncedManifest.files).toEqual(truth);
  expect(saved).toStrictEqual((await loadRawState(seed.root))!);
});

test("the hash operand is the meta reconstruction, not the local git projection", async () => {
  // The persisted manifest's gitRepos is the LOCAL apply projection: a repo with
  // a pending section legitimately reads back differently from meta-wire truth.
  // Hashing the raw persisted manifest would make the predicate permanently
  // false on any workspace with pending git; hashing the reconstruction elides.
  const seed = await seededSqlite("meta-operand", MANIFEST, { ...META_FIELDS, gitRepos: { repo: SECTION } });
  const durable = (await loadRawState(seed.root))!;
  expect(seed.meta.gitRepos).toEqual({ repo: SECTION });
  expect(durable.lastSyncedManifest.gitRepos ?? {}).toEqual({});
  // The two operands genuinely differ — without that, this fixture proves nothing.
  expect(canonicalManifestHashStreaming(durable.lastSyncedManifest))
    .not.toBe(canonicalManifestHashStreaming(manifestFromMeta(durable.lastSyncedManifest, seed.meta)));

  const packets: StateSavePacket[] = [];
  const saved = await saveStateSource(seed.root, durable, pullSource({ ...seed, state: durable }), { apply: capturing(packets) });
  expect(packets[0]!.global).toBeUndefined();
  expect(packets[0]!.elisionExpectation).toBeDefined();
  expect(saved).toStrictEqual((await loadRawState(seed.root))!);
});
