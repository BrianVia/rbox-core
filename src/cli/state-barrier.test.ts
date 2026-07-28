import { expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../engine/git/lockfile.js";
import {
  AUTHORITY_MARKER_BYTES,
  AUTHORITY_MARKER_MAGIC,
  classifyStateFormat,
  isAuthorityMarkerBytes,
  rethrowIfStateBarrier,
  StateFormatTooNewError,
  StateWriteRefusedError,
} from "./state-barrier.js";
import {
  buildReserveHeader,
  ensureStateReserve,
  inspectStateReserve,
  parseReserveHeader,
  RESERVE_FILL_BYTES,
  RESERVE_HEADER_BYTES,
  RESERVE_MAGIC,
  RESERVE_MAX_VERSION_BYTES,
  RESERVE_TOTAL_BYTES,
  stateReservePath,
  streamDigest,
} from "./state-reserve.js";
import {
  lastWriterWitnessPath,
  parseLastWriterWitness,
  recordLastWriterWitness,
  verifyLastWriterWitness,
} from "./state-witness.js";
import {
  applyStateSavePacket,
  loadRawState,
  loadState,
  saveState,
  saveStateUnsafeLegacyOrTest,
  stateLockPath,
  statePath,
} from "./sync-state-store.js";

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

test("a successful save records a witness that verifies against the published bytes", async () => {
  const root = await workspace("rbox-barrier-witness-");
  await saveStateUnsafeLegacyOrTest(root, legacyState());
  const verdict = await verifyLastWriterWitness(root, statePath(root), "0.0.1");
  expect(verdict.status).toBe("ok");
  const witness = await fs.readFile(lastWriterWitnessPath(root), "utf8");
  const parsed = parseLastWriterWitness(witness);
  expect(parsed?.version).toBe(1);
  expect(parsed?.stateSizeBytes).toBe(Buffer.byteLength(await fs.readFile(statePath(root), "utf8")));
  expect(parsed?.stateBodySha256).toBe(
    crypto.createHash("sha256").update(await fs.readFile(statePath(root))).digest("hex"),
  );
});

test("the witness fails closed on a changed body and on identity drift", async () => {
  const root = await workspace("rbox-barrier-witness-drift-");
  await saveStateUnsafeLegacyOrTest(root, legacyState());
  const published = await fs.readFile(statePath(root));

  await fs.writeFile(statePath(root), `${published.toString("utf8")} `);
  expect(await verifyLastWriterWitness(root, statePath(root), "0.0.1")).toEqual({
    status: "barrier-witness-missing", detail: "body-mismatch",
  });

  // Identical bytes republished by something that did not maintain the witness.
  await fs.rm(statePath(root));
  await fs.writeFile(statePath(root), published);
  expect(await verifyLastWriterWitness(root, statePath(root), "0.0.1")).toEqual({
    status: "barrier-witness-missing", detail: "barrier-witness-identity-drift",
  });
});

test("the witness refuses a writer below the downgrade floor", async () => {
  const root = await workspace("rbox-barrier-witness-floor-");
  await saveStateUnsafeLegacyOrTest(root, legacyState());
  expect(await verifyLastWriterWitness(root, statePath(root), "99.0.0")).toEqual({
    status: "barrier-witness-missing", detail: "writer-version-below-floor",
  });
});

test("a foreign or extended witness schema is not a witness", () => {
  const base = {
    version: 1, writerVersion: "1.11.0", writtenAtMs: 1, stateBodySha256: "0".repeat(64),
    stateSizeBytes: 2, stateMtimeMs: 3, stateDev: 4, stateIno: 5,
  };
  expect(parseLastWriterWitness(JSON.stringify(base))).toBeDefined();
  expect(parseLastWriterWitness(JSON.stringify({ ...base, extra: 1 }))).toBeUndefined();
  expect(parseLastWriterWitness(JSON.stringify({ ...base, version: 2 }))).toBeUndefined();
  expect(parseLastWriterWitness(JSON.stringify({ ...base, stateBodySha256: "ZZ" }))).toBeUndefined();
  expect(parseLastWriterWitness("not json")).toBeUndefined();
});

test("the reserve header arithmetic closes at exactly 1 MiB", () => {
  expect(RESERVE_MAGIC.length).toBe(21);
  expect(RESERVE_HEADER_BYTES + RESERVE_FILL_BYTES).toBe(RESERVE_TOTAL_BYTES);
  expect(RESERVE_FILL_BYTES).toBe(1_048_448);
  expect(RESERVE_TOTAL_BYTES).toBe(1_048_576);
  expect(RESERVE_MAX_VERSION_BYTES).toBe(40);

  const digest = streamDigest("stream");
  const header = buildReserveHeader("1.11.0-rc.3+2026072701", digest);
  expect(header.byteLength).toBe(RESERVE_HEADER_BYTES);
  expect(parseReserveHeader(header)).toEqual({ creatingVersion: "1.11.0-rc.3+2026072701", streamSha256: digest });
  expect(() => buildReserveHeader("v".repeat(41), digest)).toThrow();
  expect(parseReserveHeader(Buffer.concat([header.subarray(0, 127), Buffer.from([0x41])]))).toBeUndefined();
});

test("the reserve is created once at exactly 1 MiB and then adopted", async () => {
  const root = await workspace("rbox-reserve-");
  const created = await ensureStateReserve(root, "stream");
  expect(created.status).toBe("created");
  const stat = await fs.stat(stateReservePath(root));
  expect(stat.size).toBe(RESERVE_TOTAL_BYTES);
  const bytes = await fs.readFile(stateReservePath(root));
  expect(parseReserveHeader(bytes.subarray(0, RESERVE_HEADER_BYTES))?.streamSha256).toBe(streamDigest("stream"));
  expect(bytes.subarray(RESERVE_HEADER_BYTES).every((byte) => byte === 0)).toBe(true);
  expect((await ensureStateReserve(root, "stream")).status).toBe("adopted");
});

test("a foreign reserve is never adopted, truncated, or deleted", async () => {
  const cases: Array<[string, Buffer | "dir", string]> = [
    ["wrong-size", Buffer.alloc(64), "wrong-size"],
    ["header-malformed", Buffer.concat([Buffer.from("NOT-A-RESERVE\n"), Buffer.alloc(RESERVE_TOTAL_BYTES - 14)]), "header-malformed"],
    ["foreign-workspace", Buffer.concat([buildReserveHeader("1.11.0", streamDigest("someone-else")), Buffer.alloc(RESERVE_FILL_BYTES)]), "foreign-workspace"],
    ["not-a-regular-file", "dir", "not-a-regular-file"],
  ];
  for (const [name, content, detail] of cases) {
    const root = await workspace(`rbox-reserve-foreign-${name}-`);
    const file = stateReservePath(root);
    if (content === "dir") await fs.mkdir(file, { recursive: true });
    else await fs.writeFile(file, content);
    const before = content === "dir" ? undefined : await fs.readFile(file);
    expect(await ensureStateReserve(root, "stream")).toEqual({ status: "reserve-foreign", detail: detail as never });
    expect(await inspectStateReserve(root, "stream")).toEqual({ status: "reserve-foreign", detail: detail as never });
    const after = content === "dir" ? undefined : await fs.readFile(file);
    expect(after).toEqual(before);
    if (content === "dir") expect((await fs.lstat(file)).isDirectory()).toBe(true);
  }
});

test("a symlink at the reserve path is foreign and its target is left alone", async () => {
  const root = await workspace("rbox-reserve-symlink-");
  const target = path.join(root, "victim.bin");
  await fs.writeFile(target, Buffer.concat([buildReserveHeader("1.11.0", streamDigest("stream")), Buffer.alloc(RESERVE_FILL_BYTES)]));
  const before = await fs.readFile(target);
  await fs.symlink(target, stateReservePath(root));

  // The header behind the link is valid and names this very workspace: only the
  // no-follow lookup keeps it from being adopted, claimed, and later deleted.
  expect(await ensureStateReserve(root, "stream")).toEqual({ status: "reserve-foreign", detail: "not-a-regular-file" });
  expect((await fs.lstat(stateReservePath(root))).isSymbolicLink()).toBe(true);
  expect(await fs.readFile(target)).toEqual(before);
});

test("a header whose version field is not a semver is malformed, not adopted", async () => {
  const digest = streamDigest("stream");
  const forged = Buffer.alloc(RESERVE_HEADER_BYTES);
  forged.write(`${RESERVE_MAGIC} !!!!!!!! ${digest}\n`, 0, "latin1");
  expect(parseReserveHeader(forged)).toBeUndefined();

  const root = await workspace("rbox-reserve-badsemver-");
  await fs.writeFile(stateReservePath(root), Buffer.concat([forged, Buffer.alloc(RESERVE_FILL_BYTES)]));
  expect(await ensureStateReserve(root, "stream")).toEqual({ status: "reserve-foreign", detail: "header-malformed" });
});

test("the witness is not recorded when the published bytes are no longer the live bytes", async () => {
  const root = await workspace("rbox-witness-displaced-");
  await saveStateUnsafeLegacyOrTest(root, legacyState());
  await fs.rm(lastWriterWitnessPath(root));
  // Something republished between the state write and the witness observation.
  expect(await recordLastWriterWitness(root, statePath(root), "{\"different\":true}")).toBeUndefined();
  await expect(fs.lstat(lastWriterWitnessPath(root))).rejects.toThrow();
});

test("a broad catch cannot demote the fail-closed barrier refusals", () => {
  expect(() => rethrowIfStateBarrier(new StateFormatTooNewError("/x"))).toThrow(StateFormatTooNewError);
  expect(() => rethrowIfStateBarrier(new StateWriteRefusedError("state-lock-unavailable", "/x"))).toThrow(StateWriteRefusedError);
  expect(() => rethrowIfStateBarrier(new Error("ordinary"))).not.toThrow();
});

test("a state save leaves a reserve behind for a future upgrade", async () => {
  const root = await workspace("rbox-reserve-after-save-");
  const result = await applyStateSavePacket(root, {
    expectedStream: "stream", expectedNonce: "legacy", sourceGlobalSeq: 0, repos: [],
  });
  expect(result.status).toBe("accepted");
  expect((await fs.stat(stateReservePath(root))).size).toBe(RESERVE_TOTAL_BYTES);
});
