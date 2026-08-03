import { expect, spyOn, test } from "bun:test";
import { rmSync, symlinkSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../../engine/git/lockfile.js";
import {
  AUTHORITY_MARKER_BYTES,
  AUTHORITY_MARKER_MAGIC,
  classifyStateFormat,
  isAuthorityMarkerBytes,
  readAuthorityMarkerId,
  rethrowIfStateBarrier,
} from "./authority-marker.js";
import {
  StateAuthorityCorruptError,
  StateFormatTooNewError,
  StateWriteRefusedError,
} from "./errors.js";
import {
  applyLegacyJsonSavePacket,
  loadLegacyJsonState,
  loadRawLegacyJsonState,
} from "./adapters/legacy-json-store.js";
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

test("the marker's authority id is read only from the exact bytes", async () => {
  const root = await workspace("rbox-barrier-id-");
  expect(await readAuthorityMarkerId(statePath(root)), "absent").toBeUndefined();
  await fs.writeFile(statePath(root), AUTHORITY_MARKER);
  expect(await readAuthorityMarkerId(statePath(root))).toBe("a".repeat(32));
  for (const impostor of [
    `${AUTHORITY_MARKER_MAGIC}\n${"A".repeat(32)}\n`, // uppercase hex
    AUTHORITY_MARKER.replace(/\n$/, "x"),
    AUTHORITY_MARKER.slice(0, -1),
    '{"stream":"s"}',
  ]) {
    await fs.writeFile(statePath(root), impostor);
    expect(await readAuthorityMarkerId(statePath(root)), impostor.slice(0, 24)).toBeUndefined();
  }
  await fs.rm(statePath(root));
  await fs.symlink(path.join(root, "elsewhere"), statePath(root));
  expect(await readAuthorityMarkerId(statePath(root)), "symlink").toBeUndefined();
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

test("a symlink at the state path is refused without its target ever being read", async () => {
  const root = await workspace("rbox-barrier-symlink-");
  const target = path.join(root, "elsewhere.json");
  await fs.writeFile(target, JSON.stringify(legacyState()));
  await fs.symlink(target, statePath(root));
  // Were the target followed, these bytes would classify as a readable legacy
  // document and the barrier would hand a foreign file to the state parser.
  expect(await classifyStateFormat(statePath(root))).toBe("foreign");
});

test("a symlink loop above the state path stays an unexpected error, not a classification", async () => {
  const root = await workspace("rbox-barrier-loop-");
  const loop = path.join(root, "loop");
  await fs.symlink(loop, loop);
  // ELOOP from resolving an ancestor is not the final-component symlink the
  // barrier classifies; the old path stat propagated it and so must this.
  const failure = await classifyStateFormat(path.join(loop, "state.json")).catch((error: unknown) => error);
  expect((failure as NodeJS.ErrnoException).code).toBe("ELOOP");
});

test("a symlink swapped in at the path is refused rather than read as the document", async () => {
  const root = await workspace("rbox-barrier-swap-");
  const target = path.join(root, "elsewhere.json");
  await fs.writeFile(target, JSON.stringify(legacyState("attacker")));
  await fs.writeFile(statePath(root), "not json at all");
  const realOpen = fs.open;
  // Stand in for the window between a pathname stat and a separate open: the
  // path is a regular file when the classification starts and a symlink by the
  // time the descriptor is taken.
  const open = spyOn(fs, "open").mockImplementation(((...args: Parameters<typeof fs.open>) => {
    rmSync(statePath(root));
    symlinkSync(target, statePath(root));
    return realOpen(...args);
  }) as typeof fs.open);
  try {
    expect(await classifyStateFormat(statePath(root))).toBe("foreign");
  } finally {
    open.mockRestore();
  }
  expect((await fs.lstat(statePath(root))).isSymbolicLink(), "the swap fixture never armed").toBe(true);
});

test("every legacy-JSON state read refuses the authority marker with a typed error", async () => {
  const root = await workspace("rbox-barrier-read-");
  await fs.writeFile(statePath(root), AUTHORITY_MARKER);
  await expect(loadRawLegacyJsonState(root)).rejects.toBeInstanceOf(StateFormatTooNewError);
  await expect(loadLegacyJsonState(root, "stream")).rejects.toBeInstanceOf(StateFormatTooNewError);
});

/** From U3 the whole-state seam is authority-aware (design 222 §1.2 A-2): it
 * selects the SQLite backend on `Q` instead of refusing. The barrier's promise
 * survives as the corruption refusal below — a marker naming a database that is
 * not there is contradictory durable state, and rbox repairs nothing. */
test("the whole-state seam selects on the marker and refuses a marker with no database", async () => {
  const root = await workspace("rbox-barrier-select-");
  await fs.writeFile(statePath(root), AUTHORITY_MARKER);
  await expect(loadRawState(root)).rejects.toBeInstanceOf(StateAuthorityCorruptError);
  await expect(loadState(root, "stream")).rejects.toBeInstanceOf(StateAuthorityCorruptError);
  expect(await fs.readFile(statePath(root), "utf8")).toBe(AUTHORITY_MARKER);
  expect(await fs.readdir(path.join(root, ".rbox", "state"))).toEqual([]);
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

test("the transactional CAS writer never publishes JSON over the marker", async () => {
  const root = await workspace("rbox-barrier-cas-");
  await fs.writeFile(statePath(root), AUTHORITY_MARKER);
  // The legacy JSON CAS still refuses outright; the selecting seam routes to
  // SQLite and refuses there. Neither writes.
  await expect(applyLegacyJsonSavePacket(root, {
    expectedStream: "stream", expectedNonce: "legacy", sourceGlobalSeq: 0, repos: [],
  })).rejects.toBeInstanceOf(StateFormatTooNewError);
  await expect(applyStateSavePacket(root, {
    expectedStream: "stream", expectedNonce: "legacy", sourceGlobalSeq: 0, repos: [],
  })).rejects.toBeInstanceOf(StateAuthorityCorruptError);
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
