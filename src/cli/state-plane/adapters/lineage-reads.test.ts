/** Design 277: the boundary fence's O(1) identity read, on both backends. */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { authorityMarkerBytes } from "../authority-marker.js";
import { sqliteResetPaths, statePath } from "../paths.js";
import { createStateStore } from "../store/open.js";
import { loadRawStateIdentity } from "./lineage-reads.js";
import { saveStateUnsafeLegacyOrTest } from "./legacy-json-store.js";

const STREAM = "https://api.test::ws_277::root";
const AUTHORITY = "a".repeat(32);
const LINEAGE = "b".repeat(32);
const NONCE = "c".repeat(32);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function sqliteWorkspace(prefix: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `rbox-277-${prefix}-`));
  roots.push(root);
  await fsp.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  createStateStore(sqliteResetPaths.active(root), {
    authorityId: AUTHORITY, lineageId: LINEAGE, stream: STREAM,
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  }).close();
  await fsp.writeFile(statePath(root), authorityMarkerBytes(AUTHORITY));
  return root;
}

async function legacyWorkspace(prefix: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `rbox-277-${prefix}-`));
  roots.push(root);
  await saveStateUnsafeLegacyOrTest(root, {
    stream: STREAM, stateNonce: NONCE, stateRevision: 0,
    lastSyncedSequence: 3, lastSyncedManifest: { generatedAt: "", files: [] },
  });
  return root;
}

test("the boundary identity read reports stream and nonce for both backends", async () => {
  const sqlite = await sqliteWorkspace("identity");
  expect(await loadRawStateIdentity(sqlite)).toEqual({ stream: STREAM, stateNonce: NONCE });
  const legacy = await legacyWorkspace("identity-legacy");
  expect(await loadRawStateIdentity(legacy)).toMatchObject({ stream: STREAM, stateNonce: NONCE });
  const absent = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-277-identity-absent-"));
  roots.push(absent);
  expect(await loadRawStateIdentity(absent)).toBeUndefined();
});
