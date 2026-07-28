import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../../../engine/git/lockfile.js";
import { casOwnerTokenFromLock } from "./owner-token.js";

test("the CAS owner token agrees with the async lease across acquire and release", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-owner-token-"));
  const lockPath = path.join(dir, "state.json.lock");
  const acquired = await acquireLock(lockPath);
  expect(acquired.status).toBe("acquired");
  if (acquired.status !== "acquired") return;

  const token = casOwnerTokenFromLock(acquired.lock);
  expect(token.isOwner()).toBe(true);
  expect(await acquired.lock.isOwner()).toBe(true);

  await acquired.lock.release();
  expect(token.isOwner()).toBe(false);
  expect(await acquired.lock.isOwner()).toBe(false);
});

test("the CAS owner token sees a stolen marker as ownership lost, synchronously", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-owner-token-steal-"));
  const lockPath = path.join(dir, "state.json.lock");
  const acquired = await acquireLock(lockPath);
  if (acquired.status !== "acquired") throw new Error(`lock not acquired: ${acquired.status}`);

  const token = casOwnerTokenFromLock(acquired.lock);
  expect(token.isOwner()).toBe(true);

  // A foreign writer overwrites the marker bytes: the synchronous observation
  // must report the lease lost, exactly as the async check does.
  await fs.writeFile(lockPath, "not the rbox marker\n");
  expect(token.isOwner()).toBe(false);
  expect(await acquired.lock.isOwner()).toBe(false);

  await acquired.lock.release().catch(() => undefined);
});

test("the test-only mint seam is unreachable from production code", async () => {
  // owner-token-testkit.ts exists so tests can construct a branded CAS token
  // without a real lock; no production module may import it, or the brand's
  // provenance guarantee would leak.
  const srcRoot = path.resolve(import.meta.dir, "..", "..", "..");
  const files = (await Array.fromAsync(fs.glob("**/*.ts", { cwd: srcRoot })))
    .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".typecheck.ts")
      && !file.endsWith("owner-token-testkit.ts"));
  const offenders: string[] = [];
  for (const file of files) {
    const source = await fs.readFile(path.join(srcRoot, file), "utf8");
    if (/(?:from|import)\s*["'][^"']*owner-token-testkit/.test(source)) offenders.push(file);
  }
  expect(offenders, "production code must not import the test-only CAS token seam").toEqual([]);
});
