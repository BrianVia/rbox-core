import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createStateStore } from "../store/open.js";
import { prepareEmptyResetDbSeed, quiesceActiveDbForReset } from "./lifecycle.js";
import {
  observeDbArtifact,
  RESET_SCHEMA_V1_EMPTY_SEED_BYTES,
  sqliteResetPaths,
} from "./artifacts.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; authorityId: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-u2-lifecycle-"));
  roots.push(root);
  const authorityId = crypto.randomBytes(16).toString("hex");
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  await fs.writeFile(sqliteResetPaths.authorityMarker(root), `RBOX-SQLITE-AUTHORITY-v1\n${authorityId}\n`);
  const store = createStateStore(sqliteResetPaths.active(root), {
    stream: "old",
    authorityId,
    lineageId: "1".repeat(32),
    stateNonce: "1".repeat(32),
    stateRevision: 7,
    createdBy: "test",
  });
  store.close();
  return { root, authorityId };
}

test("quiesce establishes an S0 active DB without changing lineage", async () => {
  const { root } = await fixture();
  expect(await quiesceActiveDbForReset(root)).toMatchObject({
    stream: "old",
    stateNonce: "1".repeat(32),
    stateRevision: 7,
  });
  expect(await observeDbArtifact(sqliteResetPaths.active(root))).toMatchObject({
    main: "regular",
    sidecars: "S0",
  });
});

test("private next DB seed is bounded, exact, and leaves no canonical candidate", async () => {
  const { root, authorityId } = await fixture();
  const next = {
    stream: "next",
    stateNonce: "2".repeat(32),
    stateRevision: 8,
  };
  const seed = await prepareEmptyResetDbSeed(root, next, authorityId);
  expect(seed.bytes.byteLength).toBe(RESET_SCHEMA_V1_EMPTY_SEED_BYTES);
  expect(seed.bytes.byteLength).toBeLessThanOrEqual(256 * 1024);
  expect(crypto.createHash("sha256").update(seed.bytes).digest("hex")).toBe(seed.sha256);
  expect(await fs.readdir(path.join(root, ".rbox", "state", "reset-candidates"))).toEqual([]);
});
