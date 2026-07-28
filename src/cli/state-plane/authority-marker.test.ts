import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../../engine/git/lockfile.js";
import {
  AUTHORITY_MARKER_BYTES,
  AUTHORITY_MARKER_MAGIC,
  classifyStateFormat,
  isAuthorityMarkerBytes,
  rethrowIfStateBarrier,
} from "./authority-marker.js";
import {
  StateFormatTooNewError,
  StateWriteRefusedError,
} from "./errors.js";
import {
  applyStateSavePacket,
  loadRawState,
  loadState,
  saveState,
  saveStateUnsafeLegacyOrTest,
  stateLockPath,
  statePath,
} from "../sync-state-store.js";

const AUTHORITY_MARKER = `${AUTHORITY_MARKER_MAGIC}\n${"a".repeat(32)}\n`;

async function workspace(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  return root;
}

const legacyState = (stream = "stream") => ({
  stream,
  lastSyncedSequence: 0,
  lastSyncedManifest: { generatedAt: "", files: [] },
});

test("the authority marker is exactly 58 bytes and recognized only in its exact form", () => {
  expect(Buffer.byteLength(AUTHORITY_MARKER)).toBe(AUTHORITY_MARKER_BYTES);
  expect(isAuthorityMarkerBytes(Buffer.from(AUTHORITY_MARKER))).toBe(true);
  expect(isAuthorityMarkerBytes(Buffer.from(AUTHORITY_MARKER.replace(/\n$/, "")))).toBe(false);
  expect(isAuthorityMarkerBytes(Buffer.from(`${AUTHORITY_MARKER_MAGIC}\n${"A".repeat(32)}\n`))).toBe(false);
  expect(isAuthorityMarkerBytes(Buffer.from(`${AUTHORITY_MARKER}x`))).toBe(false);
});

test("state formats are classified without parsing", async () => {
  const root = await workspace("rbox-barrier-classify-");
  expect(await classifyStateFormat(statePath(root))).toBe("absent");
  await fs.writeFile(statePath(root), AUTHORITY_MARKER);
  expect(await classifyStateFormat(statePath(root))).toBe("authority-marker");
  await fs.writeFile(statePath(root), "  \n{\"stream\":\"s\"}");
  expect(await classifyStateFormat(statePath(root))).toBe("json");
  await fs.writeFile(statePath(root), "not json at all");
  expect(await classifyStateFormat(statePath(root))).toBe("foreign");
  await fs.rm(statePath(root));
  await fs.symlink(path.join(root, "elsewhere"), statePath(root));
  expect(await classifyStateFormat(statePath(root))).toBe("foreign");
});

test("every state read refuses the authority marker with a typed error", async () => {
  const root = await workspace("rbox-barrier-read-");
  await fs.writeFile(statePath(root), AUTHORITY_MARKER);
  await expect(loadRawState(root)).rejects.toBeInstanceOf(StateFormatTooNewError);
  await expect(loadState(root, "stream")).rejects.toBeInstanceOf(StateFormatTooNewError);
});

test("the write-side barrier leaves the authority marker byte-identical", async () => {
  const root = await workspace("rbox-barrier-write-");
  await fs.writeFile(statePath(root), AUTHORITY_MARKER);
  await expect(saveStateUnsafeLegacyOrTest(root, legacyState())).rejects.toBeInstanceOf(StateFormatTooNewError);
  await expect(saveState(root, legacyState())).rejects.toBeInstanceOf(StateFormatTooNewError);
  expect(await fs.readFile(statePath(root), "utf8")).toBe(AUTHORITY_MARKER);
  // No temp is left behind: the publication was aborted, not attempted.
  expect((await fs.readdir(path.join(root, ".rbox"))).filter((name) => name.startsWith(".rbox-tmp-"))).toEqual([]);
});

test("the transactional CAS writer also refuses to publish over the marker", async () => {
  const root = await workspace("rbox-barrier-cas-");
  await fs.writeFile(statePath(root), AUTHORITY_MARKER);
  await expect(applyStateSavePacket(root, {
    expectedStream: "stream", expectedNonce: "legacy", sourceGlobalSeq: 0, repos: [],
  })).rejects.toBeInstanceOf(StateFormatTooNewError);
  expect(await fs.readFile(statePath(root), "utf8")).toBe(AUTHORITY_MARKER);
});

test("the whole-state writer refuses rather than publishing while another holder has the lock", async () => {
  const root = await workspace("rbox-barrier-locked-");
  await saveStateUnsafeLegacyOrTest(root, legacyState());
  const before = await fs.readFile(statePath(root), "utf8");
  const acquired = await acquireLock(stateLockPath(root));
  expect(acquired.status).toBe("acquired");
  if (acquired.status !== "acquired") return;
  try {
    const refusal = await saveStateUnsafeLegacyOrTest(root, legacyState("other")).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(StateWriteRefusedError);
    expect((refusal as StateWriteRefusedError).reason).toBe("state-lock-unavailable");
    expect(await fs.readFile(statePath(root), "utf8")).toBe(before);
  } finally {
    await acquired.lock.release();
  }
});

test("a broad catch cannot demote the fail-closed barrier refusals", () => {
  expect(() => rethrowIfStateBarrier(new StateFormatTooNewError("/x"))).toThrow(StateFormatTooNewError);
  expect(() => rethrowIfStateBarrier(new StateWriteRefusedError("state-lock-unavailable", "/x"))).toThrow(StateWriteRefusedError);
  expect(() => rethrowIfStateBarrier(new Error("ordinary"))).not.toThrow();
});
