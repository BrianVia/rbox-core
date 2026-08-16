/**
 * Design 267 §3.0 — which pull lanes may mint an elision receipt, proved through
 * the real `pull()` pipeline rather than a hand-built input.
 *
 * The observable is durable and cheap: an elided save writes no global section,
 * so the store's BASE generation does not advance. A full packet always advances
 * it. That single number distinguishes the two outcomes without reaching inside
 * the composer.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalManifestHashStreaming, LocalBlobStore, type FileEntry, type Manifest } from "../../engine/index.js";
import { manifestFromMeta, type GlobalManifestMeta, type SyncState } from "../sync-state-model.js";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "../workspace-config.js";
import { authorityMarkerBytes } from "../state-plane/authority-marker.js";
import { sqliteResetPaths, statePath } from "../state-plane/paths.js";
import { applyStateSavePacket, loadRawState } from "../state-plane/adapters/whole-state-compat.js";
import { createStateStore, openStateStore } from "../state-plane/store/open.js";
import { openReadSnapshot } from "../state-plane/store/read-snapshot.js";
import type { SyncRemote } from "../remote.js";
import { pull } from "./pull.js";

const AUTHORITY = "a".repeat(32);
const LINEAGE = "b".repeat(32);
const NONCE = "c".repeat(32);
const SEQ = 7;
const GENERATED_AT = "2026-08-16T00:00:00.000Z";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const META: GlobalManifestMeta = {
  encManifestSha: "1".repeat(64),
  manifestHash: "0".repeat(64),
  accountEpoch: 1,
  keyEpoch: 1,
  chain: [],
  chainBytes: 0,
  snapshotBytes: 4096,
  gitRepos: {},
};

const entry = (name: string, seed: number): FileEntry => ({
  path: name, sha256: seed.toString(16).padStart(64, "0"), size: seed,
  mode: 0o644, mtimeMs: seed, type: "file",
} as FileEntry);

function baseGeneration(root: string): number {
  const store = openStateStore(sqliteResetPaths.active(root), { readonly: true });
  try {
    return openReadSnapshot(store).token.baseGeneration;
  } finally {
    store.close();
  }
}

interface Workspace { root: string; cfg: WorkspaceConfig; remoteManifest: Manifest; meta: GlobalManifestMeta }

/**
 * An empty workspace whose durable base is an EMPTY manifest at `SEQ`, with a
 * meta that truthfully describes it. A pull of that same head therefore
 * reconciles to zero actions — the shape M1 exists for.
 */
async function workspace(prefix: string): Promise<Workspace> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `rbox-267-prov-${prefix}-`));
  roots.push(root);
  await fsp.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  const cfg: WorkspaceConfig = {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_267",
    projectId: "root",
    deviceId: "dev",
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
  };
  await saveConfig(root, cfg);
  const stream = syncStreamId(cfg);
  createStateStore(sqliteResetPaths.active(root), {
    authorityId: AUTHORITY, lineageId: LINEAGE, stream,
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  }).close();
  await fsp.writeFile(statePath(root), authorityMarkerBytes(AUTHORITY));

  const manifest = { generatedAt: GENERATED_AT, files: [] };
  const seeded = await applyStateSavePacket(root, {
    expectedStream: stream, expectedNonce: NONCE, sourceGlobalSeq: SEQ,
    global: { manifest, manifestMeta: META }, repos: [],
  });
  if (seeded.status !== "accepted") throw new Error(`seed refused (${seeded.status})`);
  // Hash the state as it READS BACK, then re-persist, so the §3.2.3 self-check
  // has a truthful operand and the incoming meta deep-equals the stored one.
  const meta = {
    ...META,
    manifestHash: canonicalManifestHashStreaming(manifestFromMeta(seeded.state.lastSyncedManifest, META)),
  };
  const settled = await applyStateSavePacket(root, {
    expectedStream: stream, expectedNonce: NONCE, sourceGlobalSeq: SEQ,
    global: { manifest, manifestMeta: meta }, repos: [],
  });
  if (settled.status !== "accepted") throw new Error(`meta seed refused (${settled.status})`);
  const durable = (await loadRawState(root))! as SyncState;
  return { root, cfg, remoteManifest: { ...durable.lastSyncedManifest }, meta: durable.manifestMeta! };
}

/** The head the workspace already holds: a pull of it moves nothing. */
function remoteAt(ws: Workspace, manifest: Manifest = ws.remoteManifest): SyncRemote {
  return {
    latest: async () => ({ sequence: SEQ, manifest, manifestMeta: ws.meta }),
    missingBlobs: async () => [],
    putBlobFile: async () => {},
    commit: async () => ({ sequence: SEQ + 1 }),
    blobStore: () => new LocalBlobStore(path.join(ws.root, ".rbox", "blobs")),
  };
}

test("a standalone pull of an unchanged head elides — no BASE generation is built", async () => {
  const ws = await workspace("standalone");
  const before = baseGeneration(ws.root);
  const actions = await pull(ws.root, ws.cfg, { remote: remoteAt(ws), onGitLog: () => {} });
  expect(actions).toEqual([]);
  expect(baseGeneration(ws.root)).toBe(before);
  // The save still ran: the CAS advanced the revision.
  expect((await loadRawState(ws.root))!.stateRevision).toBe(2 + 1);
});

test("a recovery pull of the very same head composes the full packet", async () => {
  // push.ts's 409/pull-first and pullAndLoadAccepted arms take this lane. It
  // observes a slice of a push's retry loop, not a whole cycle, so §3.0 makes it
  // structurally receipt-less — same workspace, same head, different outcome.
  const ws = await workspace("recovery");
  const before = baseGeneration(ws.root);
  const actions = await pull(ws.root, ws.cfg, { remote: remoteAt(ws), onGitLog: () => {} }, undefined, "recovery");
  expect(actions).toEqual([]);
  expect(baseGeneration(ws.root)).toBe(before + 1);
});

test("a remote change on an IGNORED path still composes the full packet", async () => {
  // `actions` is empty here — the matcher drops the entry, nothing touches disk —
  // but the UNFILTERED list is not, and the base must still adopt the entry. This
  // is the distinction `noActions` carries; reading the filtered list would elide
  // and silently strand the remote change out of the local base forever.
  const ws = await workspace("ignored-path");
  const before = baseGeneration(ws.root);
  const withIgnored: Manifest = { ...ws.remoteManifest, files: [entry("node_modules/dep.txt", 3)] };
  const actions = await pull(ws.root, ws.cfg, { remote: remoteAt(ws, withIgnored), onGitLog: () => {} });
  expect(actions).toEqual([]);
  expect(fs.existsSync(path.join(ws.root, "node_modules/dep.txt"))).toBeFalse();
  expect(baseGeneration(ws.root)).toBe(before + 1);
  expect((await loadRawState(ws.root))!.lastSyncedManifest.files.map((file) => file.path))
    .toEqual(["node_modules/dep.txt"]);
});

test("the kill switch turns the standalone lane back into a full save", async () => {
  const ws = await workspace("kill-switch");
  const before = baseGeneration(ws.root);
  process.env.RBOX_SAVE_NOOP_ELIDE = "0";
  try {
    await pull(ws.root, ws.cfg, { remote: remoteAt(ws), onGitLog: () => {} });
  } finally {
    delete process.env.RBOX_SAVE_NOOP_ELIDE;
  }
  expect(baseGeneration(ws.root)).toBe(before + 1);
});
