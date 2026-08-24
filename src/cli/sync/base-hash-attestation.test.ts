/**
 * Issue #816 — what the attested base hash may and may not claim.
 *
 * The attestation lets push skip an O(N) canonical re-hash of its delta base, so
 * a false attestation publishes a delta against a base no reader can reproduce.
 * Every case here therefore checks BOTH halves: whether `attestSavedBase`
 * records the proof, and whether that proof is actually true of the state the
 * REAL SQLite store read back. The refusals matter most — each one is a shape
 * whose reconstruction demonstrably does not hash to the persisted value.
 */
import { afterEach, expect, test } from "bun:test";
import { canonicalManifestHashStreaming, type Manifest } from "../../engine/index.js";
import { manifestFromMeta, type GlobalManifestMeta, type SyncState } from "../sync-state-model.js";
import { saveStateSource } from "../sync-state.js";
import { loadRawState } from "../state-plane/adapters/whole-state-compat.js";
import { attestSavedBase, baseHashIsAttested } from "./base-hash-attestation.js";
import {
  cleanupElisionFixtures, file, META_FIELDS, SECTION, SEQ, seededSqlite, STREAM,
} from "../state-plane/adapters/save-elision.test-helper.js";

afterEach(cleanupElisionFixtures);

const NEXT_SEQ = SEQ + 1;

const metaFor = (committed: Manifest): GlobalManifestMeta => ({
  ...META_FIELDS,
  encManifestSha: "2".repeat(64),
  // The encoder's `resultHash`: the canonical hash of the manifest being committed.
  manifestHash: canonicalManifestHashStreaming(committed),
  gitRepos: committed.gitRepos ?? {},
});

/** One real publication: seed a store, commit `committed` through the shipped
 *  save path, and hand back the accepted state exactly as push sees it. */
async function publish(prefix: string, committed: Manifest): Promise<{ saved: SyncState; meta: GlobalManifestMeta; root: string }> {
  const seed = await seededSqlite(prefix);
  const meta = metaFor(committed);
  const saved = await saveStateSource(seed.root, seed.state, {
    expectedStream: STREAM,
    sourceGlobalSeq: NEXT_SEQ,
    globalManifest: committed,
    manifestMeta: meta,
    baseIsUnscopedRemote: true,
    observedRepos: [],
    values: {},
  });
  return { saved, meta, root: seed.root };
}

/** What the next push would reconstruct as its delta base, and its true hash. */
const reconstructedHash = (state: SyncState): string =>
  canonicalManifestHashStreaming(manifestFromMeta(state.lastSyncedManifest, state.manifestMeta!));

const FILES = [file("a.txt", 1), file("b.txt", 2), file("c.txt", 3)];

test("a published manifest's persisted reconstruction really does hash to the meta the encoder stamped", async () => {
  const committed: Manifest = {
    generatedAt: "2026-08-24T00:00:00.000Z",
    files: FILES,
    manifestSchema: 2,
    gitRepos: { repo: SECTION },
  };
  const { saved, meta } = await publish("attest-true", committed);

  // The claim, checked against what the store ACTUALLY read back — not asserted
  // into existence. This is the whole predicate the skip rests on.
  expect(reconstructedHash(saved)).toBe(meta.manifestHash);

  attestSavedBase(saved, committed, meta, NEXT_SEQ);
  expect(baseHashIsAttested(saved, meta)).toBe(true);
});

test("a manifest with no git layer attests, and its reconstruction omits gitRepos exactly as the hash expects", async () => {
  const committed: Manifest = { generatedAt: "2026-08-24T00:00:00.000Z", files: FILES };
  const { saved, meta } = await publish("attest-nogit", committed);

  expect(reconstructedHash(saved)).toBe(meta.manifestHash);
  attestSavedBase(saved, committed, meta, NEXT_SEQ);
  expect(baseHashIsAttested(saved, meta)).toBe(true);
});

test("an unknown top-level member is REFUSED: it survives persistence but manifestFromMeta cannot rebuild it", async () => {
  // `Manifest` is a type, not a runtime shape, and validateManifest admits
  // unknown members — so the encoder hashes one the reconstruction will drop.
  const committed: Manifest & { extension: string } = {
    generatedAt: "2026-08-24T00:00:00.000Z",
    files: FILES,
    extension: "v1",
  };
  const { saved, meta } = await publish("attest-extension", committed);

  // The refusal is NECESSARY, not defensive bookkeeping: the reconstruction is a
  // different manifest and hashes differently.
  expect(reconstructedHash(saved)).not.toBe(meta.manifestHash);

  attestSavedBase(saved, committed, meta, NEXT_SEQ);
  expect(baseHashIsAttested(saved, meta)).toBe(false);
});

test("a present-but-empty gitRepos is REFUSED: the canonical hash carries a member the reconstruction omits", async () => {
  const committed: Manifest = { generatedAt: "2026-08-24T00:00:00.000Z", files: FILES, gitRepos: {} };
  const { saved, meta } = await publish("attest-empty-git", committed);

  expect(reconstructedHash(saved)).not.toBe(meta.manifestHash);

  attestSavedBase(saved, committed, meta, NEXT_SEQ);
  expect(baseHashIsAttested(saved, meta)).toBe(false);
});

test("a meta the accepted save did not persist is REFUSED", async () => {
  const committed: Manifest = { generatedAt: "2026-08-24T00:00:00.000Z", files: FILES };
  const { saved, meta } = await publish("attest-other-meta", committed);

  // A save whose recompute dropped the global leaves an older meta standing;
  // the identity check is what notices.
  const otherMeta: GlobalManifestMeta = { ...meta, encManifestSha: "9".repeat(64) };
  attestSavedBase(saved, committed, otherMeta, NEXT_SEQ);
  expect(baseHashIsAttested(saved, otherMeta)).toBe(false);
  expect(baseHashIsAttested(saved, meta)).toBe(false);
});

test("a sequence the accepted save did not reach is REFUSED", async () => {
  const committed: Manifest = { generatedAt: "2026-08-24T00:00:00.000Z", files: FILES };
  const { saved, meta } = await publish("attest-other-seq", committed);

  attestSavedBase(saved, committed, meta, NEXT_SEQ + 1);
  expect(baseHashIsAttested(saved, meta)).toBe(false);
});

test("the attestation binds to the retained state OBJECT, so any state the store hands back afresh misses", async () => {
  const committed: Manifest = { generatedAt: "2026-08-24T00:00:00.000Z", files: FILES };
  const { saved, meta, root } = await publish("attest-identity", committed);
  attestSavedBase(saved, committed, meta, NEXT_SEQ);
  expect(baseHashIsAttested(saved, meta)).toBe(true);

  // A load that has to materialize again — which is what every invalidation the
  // design-277 memo enforces (another writer's CAS, a reset, a new process,
  // RBOX_STATE_LOAD_CACHE=0) ultimately produces — carries no attestation.
  const reloaded = (await loadRawState(root))!;
  expect(reloaded).not.toBe(saved);
  expect(baseHashIsAttested(reloaded, meta)).toBe(false);
});
