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
async function publish(prefix: string, committed: Manifest): Promise<{ saved: SyncState; meta: GlobalManifestMeta }> {
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
  return { saved, meta };
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

  expect(attestSavedBase(saved, committed, meta, NEXT_SEQ)).toBe("attested");
  expect(baseHashIsAttested(saved, meta)).toBe(true);
});

test("a manifest with no git layer attests, and its reconstruction omits gitRepos exactly as the hash expects", async () => {
  const committed: Manifest = { generatedAt: "2026-08-24T00:00:00.000Z", files: FILES };
  const { saved, meta } = await publish("attest-nogit", committed);

  expect(reconstructedHash(saved)).toBe(meta.manifestHash);
  expect(attestSavedBase(saved, committed, meta, NEXT_SEQ)).toBe("attested");
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

  expect(attestSavedBase(saved, committed, meta, NEXT_SEQ)).toBe("shape");
  expect(baseHashIsAttested(saved, meta)).toBe(false);
});

test("a present-but-empty gitRepos is REFUSED: the canonical hash carries a member the reconstruction omits", async () => {
  const committed: Manifest = { generatedAt: "2026-08-24T00:00:00.000Z", files: FILES, gitRepos: {} };
  const { saved, meta } = await publish("attest-empty-git", committed);

  expect(reconstructedHash(saved)).not.toBe(meta.manifestHash);

  expect(attestSavedBase(saved, committed, meta, NEXT_SEQ)).toBe("gitrepos-presence");
  expect(baseHashIsAttested(saved, meta)).toBe(false);
});

test("a meta the accepted save did not persist is REFUSED", async () => {
  const committed: Manifest = { generatedAt: "2026-08-24T00:00:00.000Z", files: FILES };
  const { saved, meta } = await publish("attest-other-meta", committed);

  // A save whose recompute dropped the global leaves an older meta standing;
  // the identity check is what notices.
  const otherMeta: GlobalManifestMeta = { ...meta, encManifestSha: "9".repeat(64) };
  expect(attestSavedBase(saved, committed, otherMeta, NEXT_SEQ)).toBe("meta-mismatch");
  expect(baseHashIsAttested(saved, otherMeta)).toBe(false);
  expect(baseHashIsAttested(saved, meta)).toBe(false);
});

test("a sequence the accepted save did not reach is REFUSED", async () => {
  const committed: Manifest = { generatedAt: "2026-08-24T00:00:00.000Z", files: FILES };
  const { saved, meta } = await publish("attest-other-seq", committed);

  expect(attestSavedBase(saved, committed, meta, NEXT_SEQ + 1)).toBe("sequence");
  expect(baseHashIsAttested(saved, meta)).toBe(false);
});

test("a projection that rebuilds the manifest wrapper and the meta object but keeps the files array remains attested", async () => {
  const committed: Manifest = { generatedAt: "2026-08-24T00:00:00.000Z", files: FILES };
  const { saved, meta } = await publish("attest-projected", committed);
  expect(attestSavedBase(saved, committed, meta, NEXT_SEQ)).toBe("attested");

  // What an elided save's projection actually does on the fleet: new state, new
  // manifest wrapper, new meta object, SAME files array (design 277/313b).
  const projected = {
    ...saved,
    stateRevision: saved.stateRevision! + 1,
    lastSyncedManifest: { ...saved.lastSyncedManifest },
    manifestMeta: { ...saved.manifestMeta! },
  };
  expect(projected.lastSyncedManifest).not.toBe(saved.lastSyncedManifest);
  expect(projected.manifestMeta).not.toBe(saved.manifestMeta);
  expect(projected.lastSyncedManifest.files).toBe(saved.lastSyncedManifest.files);
  expect(baseHashIsAttested(projected, meta)).toBe(true);
});

test("the same files array with different meta gitRepos misses despite equal hashes", async () => {
  const committed: Manifest = { generatedAt: "2026-08-24T00:00:00.000Z", files: FILES };
  const { saved, meta } = await publish("attest-meta-identity", committed);
  expect(attestSavedBase(saved, committed, meta, NEXT_SEQ)).toBe("attested");

  const differentMeta: GlobalManifestMeta = { ...meta, gitRepos: { repo: SECTION } };
  const projected = { ...saved, manifestMeta: differentMeta };
  expect(projected.lastSyncedManifest.files).toBe(saved.lastSyncedManifest.files);
  expect(differentMeta.encManifestSha).toBe(meta.encManifestSha);
  expect(differentMeta.manifestHash).toBe(meta.manifestHash);
  expect(baseHashIsAttested(projected, differentMeta)).toBe(false);
  // A header input changed under the same array misses too.
  expect(baseHashIsAttested({ ...saved, lastSyncedManifest: { ...saved.lastSyncedManifest, generatedAt: "2026-08-25T00:00:00.000Z" } }, meta)).toBe(false);
});

test("a rebuilt files array with equal content misses", async () => {
  const committed: Manifest = { generatedAt: "2026-08-24T00:00:00.000Z", files: FILES };
  const { saved, meta } = await publish("attest-manifest-identity", committed);
  expect(attestSavedBase(saved, committed, meta, NEXT_SEQ)).toBe("attested");

  const rebuiltManifest = { ...saved.lastSyncedManifest, files: structuredClone(saved.lastSyncedManifest.files) };
  const projected = { ...saved, lastSyncedManifest: rebuiltManifest };
  expect(rebuiltManifest.files).toEqual(saved.lastSyncedManifest.files);
  expect(rebuiltManifest.files).not.toBe(saved.lastSyncedManifest.files);
  expect(baseHashIsAttested(projected, meta)).toBe(false);
});

test("every remaining attestation guard reports its refusal reason", async () => {
  const committed: Manifest = { generatedAt: "2026-08-24T00:00:00.000Z", files: FILES, manifestSchema: 2 };
  const { saved, meta } = await publish("attest-reasons", committed);
  const { manifestMeta: _manifestMeta, ...withoutMeta } = saved;

  expect(attestSavedBase(withoutMeta, committed, meta, NEXT_SEQ)).toBe("no-meta");
  expect(attestSavedBase({
    ...saved,
    lastSyncedManifest: { ...saved.lastSyncedManifest, generatedAt: "different" },
  }, committed, meta, NEXT_SEQ)).toBe("generatedAt");
  expect(attestSavedBase({
    ...saved,
    lastSyncedManifest: { ...saved.lastSyncedManifest, manifestSchema: 3 },
  }, committed, meta, NEXT_SEQ)).toBe("schema");
  expect(attestSavedBase({
    ...saved,
    lastSyncedManifest: { ...saved.lastSyncedManifest, files: saved.lastSyncedManifest.files.slice(1) },
  }, committed, meta, NEXT_SEQ)).toBe("count");
});
