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
  // The test-kit exists so tests can construct a branded CAS token without a
  // real lock; no production module may reach it — by direct import, re-export,
  // or dynamic import() — or the brand's provenance guarantee would leak. The
  // scan covers every production root and every reach shape: it flags either the
  // seam identifier or its module specifier appearing in a non-test file.
  const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
  const patterns = [
    "src/**/*.ts", "src/**/*.tsx",
    "apps/**/*.ts", "apps/**/*.tsx",
    "scripts/**/*.ts", "scripts/**/*.tsx",
    "rig/**/*.ts", "rig/**/*.tsx",
  ];
  const skipDir = (p: string): boolean =>
    p.includes("node_modules") || /(?:^|\/)(?:build|dist|\.svelte-kit)(?:\/|$)/.test(p);
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for await (const file of fs.glob(pattern, { cwd: repoRoot, exclude: skipDir })) seen.add(file);
  }
  const files = [...seen].filter((file) =>
    !file.endsWith(".test.ts") && !file.endsWith(".test.tsx")
    && !file.endsWith(".typecheck.ts")
    && !file.endsWith("owner-token-testkit.ts"));
  const offenders: string[] = [];
  for (const file of files) {
    const source = await fs.readFile(path.join(repoRoot, file), "utf8");
    if (source.includes("casOwnerTokenForTest") || source.includes("owner-token-testkit")) {
      offenders.push(file);
    }
  }
  expect(offenders, "production code must not name, import, or re-export the test-only CAS token seam").toEqual([]);
});
