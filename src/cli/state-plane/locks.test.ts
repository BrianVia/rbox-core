import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../../engine/lockfile.js";
import {
  acquireWorkspaceSyncMutex,
  assertHealthyOwnedSyncMutex,
  releaseWorkspaceSyncMutex,
  type WorkspaceSyncMutex,
} from "../sync-mutex.js";
import { saveStateUnsafeLegacyOrTest } from "../sync-state-store.js";
import { withGenesisAdmissionLocks, type StatePlaneLockStage } from "./locks.js";
import { stateLockPath } from "./paths.js";

async function workspace(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  await saveStateUnsafeLegacyOrTest(root, {
    stream: "stream",
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
  });
  return root;
}

async function rebind(root: string, id: string): Promise<void> {
  await fs.writeFile(
    path.join(root, ".rbox", "workspace.json"),
    JSON.stringify({
      remoteUrl: "https://example.invalid",
      remoteWorkspaceId: id,
      projectId: "p",
    }),
  );
}

test("genesis admission borrows the live mutex and releases only its remaining fences", async () => {
  const root = await workspace("rbox-locks-borrowed-");
  const mutex = await acquireWorkspaceSyncMutex(root, "cli");
  const stages: StatePlaneLockStage[] = [];
  try {
    expect(await withGenesisAdmissionLocks(root, mutex, async (locks) => {
      expect(locks.mutex).toBe(mutex);
      expect(await locks.stateLock.isOwner()).toBeTrue();
      return "inside";
    }, { onStage: (stage) => void stages.push(stage) })).toBe("inside");
    expect(stages).toEqual([
      "mutex", "inventory", "fence", "state-lock",
      "fenced-recheck", "reset-recovery", "body",
    ]);
    await expect(assertHealthyOwnedSyncMutex(mutex, root)).resolves.toBeUndefined();

    const stateLock = await acquireLock(stateLockPath(root));
    expect(stateLock.status).toBe("acquired");
    if (stateLock.status === "acquired") await stateLock.lock.release();

    await expect(withGenesisAdmissionLocks(root, mutex, async () => {
      throw new Error("body failed");
    })).rejects.toThrow("body failed");
    await expect(assertHealthyOwnedSyncMutex(mutex, root)).resolves.toBeUndefined();
  } finally {
    await releaseWorkspaceSyncMutex(mutex);
  }
});

test("borrowed admission rejects invalid mutex handles before its body", async () => {
  const root = await workspace("rbox-locks-borrowed-invalid-");
  const other = await workspace("rbox-locks-borrowed-other-");
  let bodies = 0;
  const wrongRoot = await acquireWorkspaceSyncMutex(other, "cli");
  try {
    await expect(withGenesisAdmissionLocks(root, wrongRoot, async () => void (bodies += 1)))
      .rejects.toThrow(/different root/);
  } finally {
    await releaseWorkspaceSyncMutex(wrongRoot);
  }

  const released = await acquireWorkspaceSyncMutex(root, "cli");
  await releaseWorkspaceSyncMutex(released);
  await expect(withGenesisAdmissionLocks(root, released, async () => void (bodies += 1)))
    .rejects.toThrow(/already been released/);

  const degraded = {
    root,
    incarnation: "degraded",
    released: false,
    degraded: { reason: "test" },
  } satisfies WorkspaceSyncMutex;
  await expect(withGenesisAdmissionLocks(root, degraded, async () => void (bodies += 1)))
    .rejects.toThrow(/non-degraded/);

  const lost = await acquireWorkspaceSyncMutex(root, "cli");
  if (!lost.lock) throw new Error("test requires a real mutex");
  await fs.rm(lost.lock.path);
  await expect(withGenesisAdmissionLocks(root, lost, async () => void (bodies += 1)))
    .rejects.toThrow(/ownership was lost/);
  expect(bodies).toBe(0);
});

test("borrowed admission bounds reset-inventory restarts without releasing the mutex", async () => {
  const root = await workspace("rbox-locks-borrowed-restart-");
  await rebind(root, "w0");
  const mutex = await acquireWorkspaceSyncMutex(root, "cli");
  let mutations = 0;
  try {
    await expect(withGenesisAdmissionLocks(root, mutex, async () => "never", {
      attempts: 2,
      onStage: async (stage) => {
        if (stage !== "fence") return;
        mutations += 1;
        await rebind(root, `w${mutations}`);
      },
    })).rejects.toThrow(/kept changing under the fence/);
    expect(mutations).toBe(2);
    await expect(assertHealthyOwnedSyncMutex(mutex, root)).resolves.toBeUndefined();
  } finally {
    await releaseWorkspaceSyncMutex(mutex);
  }
});

test("the genesis reset-only inventory has no whole-state selector reach", async () => {
  const source = await fs.readFile(new URL("./locks.ts", import.meta.url), "utf8");
  const body = /async function inspectResetInventory[\s\S]*?\n}/.exec(source)?.[0];
  expect(body).toBeDefined();
  expect(body).not.toMatch(
    /loadRawState|loadState|selectStateAuthority|admitGenesisAuthority|whole-state-compat/,
  );
});

test("only locks.ts can mint a branded lock bundle in production code", () => {
  const casts = Bun.spawnSync([
    "git", "grep", "-lIE", "\\bas\\b[^;]*HeldStatePlaneLocks", "--", "src", ":!*.test.ts",
  ], { cwd: path.resolve(import.meta.dir, "../../..") });
  expect(casts.exitCode, "git grep failed to run").toBeLessThanOrEqual(1);
  expect(new TextDecoder().decode(casts.stdout).trim()).toBe("");

  const brand = Bun.spawnSync([
    "git", "grep", "-lF", "heldStatePlaneLocks", "--", "src", ":!*.test.ts",
  ], { cwd: path.resolve(import.meta.dir, "../../..") });
  expect(brand.exitCode, "git grep failed to run").toBeLessThanOrEqual(1);
  const brandFiles = new TextDecoder().decode(brand.stdout)
    .trim()
    .split("\n")
    .filter(Boolean);
  expect(brandFiles).toEqual(["src/cli/state-plane/locks.ts"]);
});
