/**
 * Shared ground for the design 267 suites: a workspace already holding a
 * coherent base on either backend, a pull-shaped `StateSource` over it, and the
 * observations the fixtures make — the recorded packets and the durable BASE
 * generation, which is what proves no O(N) stage was built, promoted or fsynced.
 *
 * The split is by question, not by size: `save-elision.test.ts` asks what the
 * proof admits and refuses; `save-elision-races.test.ts` asks what happens when
 * another writer lands between the proof and the lock.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalManifestHashStreaming, type FileEntry, type GitSection } from "../../../engine/index.js";
import { manifestFromMeta, type FileOnlyManifest, type GlobalManifestMeta, type StateSavePacket, type SyncState } from "../../sync-state-model.js";
import { elisionReceipt, type ElisionReceipt } from "../../sync-state-elision.js";
import type { StateSource } from "../../sync-state.js";
import { authorityMarkerBytes } from "../authority-marker.js";
import { sqliteResetPaths, statePath } from "../paths.js";
import { createStateStore, openStateStore } from "../store/open.js";
import { openReadSnapshot } from "../store/read-snapshot.js";
import { applyStateSavePacket, loadRawState } from "./whole-state-compat.js";

export const STREAM = "https://api.test::ws_267::root";
export const AUTHORITY = "a".repeat(32);
export const LINEAGE = "b".repeat(32);
export const NONCE = "c".repeat(32);
export const SEQ = 5;

const roots: string[] = [];

/** Every suite that uses these fixtures calls this from its own afterEach. */
export function cleanupElisionFixtures(): void {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  delete process.env.RBOX_SAVE_NOOP_ELIDE;
}

export const file = (name: string, seed: number): FileEntry => ({
  path: name, sha256: seed.toString(16).padStart(64, "0"), size: seed,
  mode: 0o644, mtimeMs: seed, type: "file",
} as FileEntry);

export const hex = (length: number, seed: number): string => seed.toString(16).padStart(length, "0");

export const SECTION: GitSection = {
  bundleSha: hex(64, 11), bundleEncSha: hex(64, 12), bundleCipherSize: 21,
  head: hex(40, 13), refs: {}, config: {}, refScope: "all",
  generatedAt: "2026-08-16T00:00:00.000Z",
};

export const MANIFEST: FileOnlyManifest = {
  generatedAt: "2026-08-16T00:00:00.000Z",
  files: [file("one.txt", 1), file("two.txt", 2)],
};

export const META_FIELDS: GlobalManifestMeta = {
  encManifestSha: "1".repeat(64),
  manifestHash: "0".repeat(64),
  accountEpoch: 1,
  keyEpoch: 1,
  chain: [],
  chainBytes: 0,
  snapshotBytes: 4096,
  gitRepos: {},
};

export async function tempRoot(prefix: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `rbox-267-${prefix}-`));
  roots.push(root);
  await fsp.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  return root;
}

export function baseGeneration(root: string): number {
  const store = openStateStore(sqliteResetPaths.active(root), { readonly: true });
  try {
    return openReadSnapshot(store).token.baseGeneration;
  } finally {
    store.close();
  }
}

export interface Seeded { root: string; state: SyncState; meta: GlobalManifestMeta }

/**
 * A workspace that has already adopted `MANIFEST` at `SEQ` with one repo record,
 * whose persisted meta describes exactly the persisted manifest. The meta hash is
 * computed from the state as it READS BACK, so the §3.2.3 self-check has a
 * truthful operand rather than one this test asserted into existence.
 */
export async function seededSqlite(
  prefix: string,
  manifest: FileOnlyManifest = MANIFEST,
  metaFields: GlobalManifestMeta = META_FIELDS,
): Promise<Seeded> {
  const root = await tempRoot(prefix);
  createStateStore(sqliteResetPaths.active(root), {
    authorityId: AUTHORITY, lineageId: LINEAGE, stream: STREAM,
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  }).close();
  await fsp.writeFile(statePath(root), authorityMarkerBytes(AUTHORITY));
  const first = await applyStateSavePacket(root, {
    expectedStream: STREAM, expectedNonce: NONCE, sourceGlobalSeq: SEQ,
    global: { manifest, manifestMeta: metaFields },
    repos: [{ relPath: "repo", expectedRepoGen: 0, newRecord: { sourceSeq: SEQ } }],
  });
  if (first.status !== "accepted") throw new Error(`seed save was refused (${first.status})`);
  // A caller that already knows the hash it wants persisted (a drift fixture,
  // whose meta must describe the TRUTH rather than the bytes being seeded)
  // supplies it; otherwise the meta is made to describe what actually landed.
  const meta = metaFields.manifestHash === META_FIELDS.manifestHash
    ? {
        ...metaFields,
        manifestHash: canonicalManifestHashStreaming(manifestFromMeta(first.state.lastSyncedManifest, metaFields)),
      }
    : metaFields;
  const second = await applyStateSavePacket(root, {
    expectedStream: STREAM, expectedNonce: NONCE, sourceGlobalSeq: SEQ,
    global: { manifest, manifestMeta: meta }, repos: [],
  });
  if (second.status !== "accepted") throw new Error("seed meta save was refused");
  return { root, state: second.state, meta };
}

/** The same seeded shape on the legacy-JSON arm, written directly. */
export async function seededLegacy(prefix: string): Promise<Seeded> {
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

export function pullSource(seed: Seeded, overrides: Partial<StateSource> = {}): StateSource {
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

export const receiptFor = (seed: Seeded, evidence: Partial<ElisionReceipt> = {}): ElisionReceipt | undefined =>
  elisionReceipt(seed.state, { noActions: true, storedBaseIsRemote: true, manifestMeta: seed.meta, ...evidence });

/** The real adapter, with every packet it is handed recorded. */
export function capturing(packets: StateSavePacket[], interleave?: () => Promise<void>): typeof applyStateSavePacket {
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
