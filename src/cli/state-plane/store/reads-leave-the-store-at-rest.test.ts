/**
 * Every state-plane read leaves the workspace byte-identical (163 v13).
 *
 * A read-only load used to leave `-wal`/`-shm` beside the active database: the
 * reader's cached statements outlived `close()`, so SQLite zombie-closed the
 * connection and never unlinked the sidecars. The next observer read that
 * signature as `W1` — a WAL crash — which is a real corruption row that must
 * keep meaning what it means. The defect was that a read CREATED the signature.
 *
 * The consumers below are the ones that decide whether a workspace is healthy:
 * `inspectResetJournal` is what `rbox status` renders and what the daemon's
 * `resetOperationBoundary` gates scan/pull/push on, so a fabricated `W1` both
 * mislabels a healthy workspace and silently stops sync. The load-then-inspect
 * order every case asserts is the daemon's own recovery boundary, which loads
 * the state and then requires the very next inspection to be terminal.
 *
 * Every case drives a REAL migration and asserts the whole `.rbox` tree is
 * byte-identical across the read. Sidecar reaping is timing-sensitive, so each
 * case runs `ROUNDS` times rather than once.
 */
import { expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectResetJournal } from "../../reset-journal.js";
import type { StateSavePacket } from "../../sync-state-model.js";
import { saveStateUnsafeLegacyOrTest } from "../../sync-state-store.js";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "../../workspace-config.js";
import { materializeManifestFromStore } from "../adapters/read-only.js";
import { applyStateSavePacket, loadRawState, loadState, replaceResetLineageStream } from "../adapters/whole-state-compat.js";
import { StateWriteRefusedError } from "../errors.js";
import { withStatePlaneLocks, type EntryProof, type HeldStatePlaneLocks } from "../locks.js";
import { runMigration } from "../migration/authority.js";
import { sqliteResetPaths } from "../paths.js";
import { stableDbHash } from "../reset/artifacts.js";
import { openStateStore, stateStoreDatabase } from "./open.js";
import { openReadSnapshot } from "./read-snapshot.js";

process.env.RBOX_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-at-rest-home-"));

const ROUNDS = 8;
const NONCE = "c".repeat(32);

const configOf = (root: string): WorkspaceConfig => ({
  schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev",
  rootPath: root, remoteUrl: "https://example.invalid", token: "",
});

/** A migrated workspace, machine-produced: the real M0→M7 loop over real legacy
 * records, never a hand-planted database. */
async function migratedWorkspace(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-at-rest-"));
  const config = configOf(root);
  await saveConfig(root, config);
  await fsp.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(config), lastSyncedSequence: 0, stateNonce: NONCE, stateRevision: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
  });
  const outcome = await withStatePlaneLocks(root, (locks: HeldStatePlaneLocks) =>
    runMigration(root, { entry: "foreground-migrate", locks } as EntryProof));
  if (!outcome.held || outcome.value.kind !== "migrated") {
    throw new Error(`fixture did not migrate: ${JSON.stringify(outcome)}`);
  }
  return root;
}

/** Every byte under `.rbox`, sidecars included. */
function treeDigest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else out[`${prefix}${entry.name}`] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    }
  };
  walk(path.join(root, ".rbox"), "");
  return out;
}

const stream = (root: string): string => syncStreamId(configOf(root));

/** One consumer, `ROUNDS` times: the tree must be byte-identical across the read
 * and the workspace must still classify healthy afterwards. */
async function readsLeaveTheWorkspaceUntouched(read: (root: string) => Promise<unknown>): Promise<void> {
  for (let round = 0; round < ROUNDS; round++) {
    const root = await migratedWorkspace();
    const before = treeDigest(root);
    await read(root);
    expect(treeDigest(root)).toEqual(before);
    expect((await inspectResetJournal(root, stream(root))).status).toBe("none");
  }
}

test("loadState — what rbox status, sync, and the daemon gate all read", async () => {
  await readsLeaveTheWorkspaceUntouched((root) => loadState(root, stream(root)));
});

test("loadRawState — what rbox doctor's state check reads", async () => {
  await readsLeaveTheWorkspaceUntouched((root) => loadRawState(root));
});

test("materializeManifest — the wire snapshot projection", async () => {
  await readsLeaveTheWorkspaceUntouched(async (root) => {
    const store = openStateStore(sqliteResetPaths.active(root), { readonly: true });
    try {
      const token = openReadSnapshot(store).token;
      materializeManifestFromStore(store, { purpose: "wire-snapshot", plane: "base", projectionToken: token });
    } finally {
      store.close();
    }
  });
});

test("explicit migration — the terminal-sqlite active-store proof", async () => {
  await readsLeaveTheWorkspaceUntouched((root) =>
    withStatePlaneLocks(root, (locks: HeldStatePlaneLocks) =>
      runMigration(root, { entry: "foreground-migrate", locks } as EntryProof)));
});

/** A write is not a read, but it shares the obligation: the store it commits to
 * must be back at rest before the next observer classifies it. */
test("applyStateSavePacket leaves the committed store at rest", async () => {
  for (let round = 0; round < ROUNDS; round++) {
    const root = await migratedWorkspace();
    const result = await applyStateSavePacket(root, {
      expectedStream: stream(root),
      expectedNonce: NONCE,
      sourceGlobalSeq: 5,
      global: { manifest: { generatedAt: "2026-07-29T00:00:00.000Z", files: [] } },
      repos: [],
    } as StateSavePacket);
    expect(result.status).toBe("accepted");
    expect(fs.existsSync(`${sqliteResetPaths.active(root)}-wal`)).toBe(false);
    expect(fs.existsSync(`${sqliteResetPaths.active(root)}-shm`)).toBe(false);
    expect((await inspectResetJournal(root, stream(root))).status).toBe("none");
  }
});

test("reset-lineage replacement closes its writer at exact S0", async () => {
  const root = await migratedWorkspace();
  const active = sqliteResetPaths.active(root);
  const archiveHash = (await stableDbHash(active)).sha256;
  const archive = sqliteResetPaths.archive(root, "d".repeat(32), archiveHash);
  await fsp.mkdir(path.dirname(archive), { recursive: true });
  await fsp.copyFile(active, archive);
  const authorized = await loadState(root, stream(root));
  const writer = openStateStore(active);
  stateStoreDatabase(writer).run("UPDATE state_lineage SET stream='old-stream'");
  writer.close();
  const rejected = (await loadRawState(root))!;
  const applied = await replaceResetLineageStream(root, authorized, rejected, {
    expectedStream: stream(root), expectedNonce: NONCE, sourceGlobalSeq: 5,
    global: { manifest: { generatedAt: "2026-08-15T00:00:00.000Z", files: [] } }, repos: [],
  }, authorized, authorized);
  expect(applied.stream).toBe(stream(root));
  expect(fs.existsSync(`${active}-wal`)).toBe(false);
  expect(fs.existsSync(`${active}-shm`)).toBe(false);
  expect((await inspectResetJournal(root, stream(root))).status).toBe("none");
});

test("unsupported Q save opens no store and leaves the complete workspace at rest", async () => {
  const root = await migratedWorkspace();
  const before = treeDigest(root);
  const active = path.resolve(sqliteResetPaths.active(root));
  const originalOpen = fs.openSync;
  let storeOpens = 0;
  const open = spyOn(fs, "openSync").mockImplementation(((file, ...args) => {
    if (path.resolve(String(file)) === active) storeOpens += 1;
    return originalOpen(file, ...args);
  }) as typeof fs.openSync);
  try {
    const result = await applyStateSavePacket(root, {
      expectedStream: stream(root),
      expectedNonce: NONCE,
      sourceGlobalSeq: 5,
      global: { manifest: { generatedAt: "2026-08-15T00:00:00.000Z", files: [] } },
      repos: [],
    }, {
      lock: {
        identity: {
          current: async () => { throw new Error("identity unavailable"); },
          probe: async () => ({ status: "unknown" }),
        },
      },
    });
    expect(result.status).toBe("unsupported");
    if (result.status === "unsupported") expect(result.error).toBeInstanceOf(StateWriteRefusedError);
    expect(storeOpens).toBe(0);
    expect(treeDigest(root)).toEqual(before);
    expect((await inspectResetJournal(root, stream(root))).status).toBe("none");
  } finally {
    open.mockRestore();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/**
 * Negative control. The byte-identity assertion above is only worth its runtime
 * if it can fail, so this drives the exact residue the defect left — a sidecar
 * beside the active database — and proves both halves of the assertion notice.
 */
test("negative control: the at-rest assertion detects a planted sidecar", async () => {
  const root = await migratedWorkspace();
  const before = treeDigest(root);
  await fsp.writeFile(`${sqliteResetPaths.active(root)}-wal`, "");
  expect(treeDigest(root)).not.toEqual(before);
  // Design 276 F2.1: the fabricated signature is now its own typed row rather
  // than a halt. It is still emphatically not `none` — the control's whole job.
  expect((await inspectResetJournal(root, stream(root))).status).toBe("w1");
});
