import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../../engine/lockfile.js";
import { resetJournalPath } from "../reset-journal.js";
import {
  acquireWorkspaceSyncMutex,
  assertHealthyOwnedSyncMutex,
  releaseWorkspaceSyncMutex,
  workspaceSyncMutexDegraded,
  type WorkspaceSyncMutex,
} from "../sync-mutex.js";
import { saveStateUnsafeLegacyOrTest } from "../sync-state-store.js";
import { AUTHORITY_MARKER_MAGIC, authorityMarkerBytes, classifyStateFormat } from "./authority-marker.js";
import { withGenesisAdmissionLocks, withStatePlaneLocks, type StatePlaneLockStage } from "./locks.js";
import { sqliteResetPaths, stateLockPath, statePath } from "./paths.js";
import { createStateStore } from "./store/open.js";

async function workspace(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  await saveStateUnsafeLegacyOrTest(root, {
    stream: "stream", lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] },
  });
  return root;
}

test("the bundle is acquired in design 222 §3.1's order", async () => {
  const root = await workspace("rbox-locks-order-");
  const stages: StatePlaneLockStage[] = [];
  const outcome = await withStatePlaneLocks(root, async (locks) => {
    expect(locks.underRepositoryFence).toBeTrue();
    expect(locks.stateLock.path).toBe(stateLockPath(root));
    expect(await locks.stateLock.isOwner()).toBeTrue();
    // The bundle's declared invariant (design 222 §3.1): healthy, live-owned.
    expect(workspaceSyncMutexDegraded(locks.mutex)).toBeFalse();
    return true;
  }, { onStage: (stage) => void stages.push(stage) });

  expect(outcome).toEqual({ held: true, value: true });
  expect(stages).toEqual(["mutex", "inventory", "fence", "state-lock", "fenced-recheck", "reset-recovery", "body"]);
});

test("both locks are released after the body returns", async () => {
  const root = await workspace("rbox-locks-release-");
  await withStatePlaneLocks(root, async () => undefined);
  const reacquired = await acquireLock(stateLockPath(root));
  expect(reacquired.status).toBe("acquired");
  if (reacquired.status === "acquired") await reacquired.lock.release();
  // A second full acquisition proves the mutex was released too.
  expect(await withStatePlaneLocks(root, async () => "again")).toEqual({ held: true, value: "again" });
});

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
    expect(stages).toEqual(["mutex", "inventory", "fence", "state-lock", "fenced-recheck", "reset-recovery", "body"]);
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

  const degraded = { root, incarnation: "degraded", released: false, degraded: { reason: "test" } } satisfies WorkspaceSyncMutex;
  await expect(withGenesisAdmissionLocks(root, degraded, async () => void (bodies += 1)))
    .rejects.toThrow(/non-degraded/);

  const lost = await acquireWorkspaceSyncMutex(root, "cli");
  if (!lost.lock) throw new Error("test requires a real mutex");
  await fs.rm(lost.lock.path);
  await expect(withGenesisAdmissionLocks(root, lost, async () => void (bodies += 1)))
    .rejects.toThrow(/ownership was lost/);
  expect(bodies).toBe(0);
  const stateLock = await acquireLock(stateLockPath(root));
  expect(stateLock.status).toBe("acquired");
  if (stateLock.status === "acquired") await stateLock.lock.release();
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
  expect(body).not.toMatch(/loadRawState|loadState|selectStateAuthority|admitGenesisAuthority|whole-state-compat/);
});

/** Rewrite the workspace binding, which is one of the inventory's inputs. */
async function rebind(root: string, id: string): Promise<void> {
  await fs.writeFile(
    path.join(root, ".rbox", "workspace.json"),
    JSON.stringify({ remoteUrl: "https://example.invalid", remoteWorkspaceId: id, projectId: "p" }),
  );
}

test("a workspace changing under the fence restarts, then refuses when it keeps changing", async () => {
  const root = await workspace("rbox-locks-restart-");
  await rebind(root, "w0");
  let mutations = 0;
  await expect(withStatePlaneLocks(root, async () => "never", {
    attempts: 2,
    // Mutate the inventory between the pre-fence read and the fenced recheck on
    // every attempt: the acquisition must restart, then refuse.
    onStage: async (stage) => {
      if (stage !== "fence") return;
      mutations += 1;
      await rebind(root, `w${mutations}`);
    },
  })).rejects.toThrow(/kept changing under the fence/);
  expect(mutations).toBe(2);
});

test("a stable workspace reaches the body on the first pass", async () => {
  const root = await workspace("rbox-locks-stable-");
  await rebind(root, "w0");
  let bodies = 0;
  await withStatePlaneLocks(root, async () => void (bodies += 1));
  expect(bodies).toBe(1);
});

test("a held state lock refuses the bundle rather than proceeding without it", async () => {
  const root = await workspace("rbox-locks-busy-");
  const blocker = await acquireLock(stateLockPath(root));
  expect(blocker.status).toBe("acquired");
  try {
    await expect(withStatePlaneLocks(root, async () => "never")).rejects.toThrow(/state lock is unavailable/);
  } finally {
    if (blocker.status === "acquired") await blocker.lock.release();
  }
});

/**
 * Wave 5B replaces this test's former assertion.
 *
 * It used to pin the debt: post-`Q` the inventory read raised
 * `StateFormatTooNewError`, so NO lock bundle was obtainable on a workspace rbox
 * had just migrated — which left `rbox migrate` unable to report success on its
 * own work and the two post-`Q` halts unreachable by the retry that exists for
 * them. The inventory now goes through the selecting whole-state seam, so being
 * migrated is not itself a refusal.
 *
 * A marker with NO database behind it is a different thing entirely, and it is
 * what this fixture actually constructs: 163's contradictory-authority row, whose
 * verdict is a hard corruption error with zero repair. The assertion is that the
 * failure is THAT one and not "your rbox is too old" — a healthy current binary
 * must never be told to upgrade itself.
 */
test("a post-Q workspace with no database behind its marker is corruption, not a too-new format", async () => {
  const root = await workspace("rbox-locks-post-q-");
  await fs.writeFile(statePath(root), `${AUTHORITY_MARKER_MAGIC}\n${"a".repeat(32)}\n`);
  expect(await classifyStateFormat(statePath(root))).toBe("authority-marker");
  const raised = await withStatePlaneLocks(root, async () => "never").catch((error) => error);
  if (!(raised instanceof Error)) throw new Error("expected state authority corruption");
  expect(raised.name).toBe("StateAuthorityCorruptError");
  expect(raised.message).not.toMatch(/newer version of rbox/);
});

test("a state.json the parse budget refuses is a typed refusal, not an escaping RangeError", async () => {
  // The measured shape on a 16 GiB host: an 81 MB `state.json` needs 4.215 GiB
  // of parse headroom against a 4 GiB floor budget. The inventory read is the
  // FIRST thing that hits it — earlier than M0's own `memory-admission` halt —
  // and it used to escape uncaught through the fence. The budget is injected
  // here through the sanctioned override rather than by writing 81 MB of state.
  const root = await workspace("rbox-locks-memory-");
  const previous = process.env.RBOX_RESET_PARSE_BUDGET_BYTES;
  process.env.RBOX_RESET_PARSE_BUDGET_BYTES = "1";
  let bodies = 0;
  try {
    const outcome = await withStatePlaneLocks(root, async () => void (bodies += 1));
    expect(outcome.held).toBeFalse();
    if (outcome.held) throw new Error("the bundle was held on a refused parse budget");
    expect(outcome.refusal.code).toBe("memory-admission");
    // 163 §6.3: the refusal prints what was measured.
    expect(outcome.refusal.detail).toMatch(/bytes of parse headroom/);
    expect(outcome.refusal.detail).toMatch(/RBOX_RESET_PARSE_BUDGET_BYTES/);
  } finally {
    if (previous === undefined) delete process.env.RBOX_RESET_PARSE_BUDGET_BYTES;
    else process.env.RBOX_RESET_PARSE_BUDGET_BYTES = previous;
  }
  expect(bodies).toBe(0);
  // Nothing was admitted, so the workspace is left acquirable — a refusal, not a
  // halt: the very next attempt on a machine with headroom must succeed.
  expect(await withStatePlaneLocks(root, async () => "after")).toEqual({ held: true, value: "after" });
});

// 222 §7.9. The bundle is the proof object every mutator trusts without
// re-verifying — `control-publication.ts` takes it and does `void locks` — so
// its unforgeability rests entirely on the unexported runtime brand. No
// production cast may forge it, and only locks.ts may name or mint the brand.
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
  const brandFiles = new TextDecoder().decode(brand.stdout).trim().split("\n").filter(Boolean);
  expect(brandFiles).toEqual(["src/cli/state-plane/locks.ts"]);
});

test("a standing reset journal is recovered to completion before the body runs", async () => {
  const root = await workspace("rbox-locks-standing-reset-");
  await fs.writeFile(resetJournalPath(root), "{ not a journal");
  // Fail-closed: an undecodable standing transaction refuses; it is never
  // stepped over so the body can start on a half-completed reset.
  await expect(withStatePlaneLocks(root, async () => "never")).rejects.toThrow();
});

test("paired JSON no-reset inventory reaches the body without settlement", async () => {
  const root = await workspace("rbox-locks-json-inventory-");
  let bodies = 0;
  expect(await withStatePlaneLocks(root, async () => void (bodies += 1))).toEqual({ held: true, value: undefined });
  expect(bodies).toBe(1);
});

test("paired exact-Q S0 inventory reaches the body without writable reset open", async () => {
  const root = await workspace("rbox-locks-q-inventory-");
  const authorityId = "a".repeat(32);
  createStateStore(sqliteResetPaths.active(root), {
    authorityId, lineageId: "b".repeat(32), stream: "stream", createdBy: "test",
    stateNonce: "c".repeat(32), stateRevision: 0,
  }).close();
  await fs.writeFile(statePath(root), authorityMarkerBytes(authorityId));
  let bodies = 0;
  expect(await withStatePlaneLocks(root, async () => void (bodies += 1))).toEqual({ held: true, value: undefined });
  expect(bodies).toBe(1);
  expect(await fs.readdir(path.dirname(sqliteResetPaths.active(root)))).toContain("state.db");
});

test("reset-fence observation drift restarts and refuses before the body", async () => {
  const root = await workspace("rbox-locks-reset-drift-");
  let bodies = 0;
  await expect(withStatePlaneLocks(root, async () => void (bodies += 1), {
    attempts: 1,
    onStage: async (stage) => {
      if (stage === "fence") await fs.writeFile(resetJournalPath(root), "{ malformed");
    },
  })).rejects.toThrow();
  expect(bodies).toBe(0);
});

test("a format-neutral halt row never reaches the borrowed body", async () => {
  const root = await workspace("rbox-locks-reset-halt-row-");
  await fs.writeFile(resetJournalPath(root), "{ malformed");
  let bodies = 0;
  await expect(withStatePlaneLocks(root, async () => void (bodies += 1))).rejects.toThrow();
  expect(bodies).toBe(0);
});
