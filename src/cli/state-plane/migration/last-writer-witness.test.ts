import { expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  lastWriterWitnessPath,
  parseLastWriterWitness,
  recordLastWriterWitness,
  verifyLastWriterWitness,
} from "./last-writer-witness.js";
import {
  saveStateUnsafeLegacyOrTest,
  statePath,
} from "../../sync-state-store.js";

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

test("the witness is not recorded when the published bytes are no longer the live bytes", async () => {
  const root = await workspace("rbox-witness-displaced-");
  await saveStateUnsafeLegacyOrTest(root, legacyState());
  await fs.rm(lastWriterWitnessPath(root));
  // Something republished between the state write and the witness observation.
  expect(await recordLastWriterWitness(root, statePath(root), "{\"different\":true}")).toBeUndefined();
  await expect(fs.lstat(lastWriterWitnessPath(root))).rejects.toThrow();
});
