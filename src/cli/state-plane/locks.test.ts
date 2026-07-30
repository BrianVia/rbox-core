import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../../engine/git/lockfile.js";
import { resetJournalPath } from "../reset-journal.js";
import { workspaceSyncMutexDegraded } from "../sync-mutex.js";
import { saveStateUnsafeLegacyOrTest } from "../sync-state-store.js";
import { AUTHORITY_MARKER_MAGIC, classifyStateFormat } from "./authority-marker.js";
import { withStatePlaneLocks, type StatePlaneLockStage } from "./locks.js";
import { sqliteResetPaths, stateLockPath, statePath } from "./paths.js";

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

test("a post-Q workspace refuses the bundle rather than fencing an inventory it cannot see", async () => {
  const root = await workspace("rbox-locks-post-q-");
  await fs.writeFile(statePath(root), `${AUTHORITY_MARKER_MAGIC}\n${"a".repeat(32)}\n`);
  expect(await classifyStateFormat(statePath(root))).toBe("authority-marker");
  await expect(withStatePlaneLocks(root, async () => "never")).rejects.toThrow(/newer version of rbox/);
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
// its unforgeability rests entirely on the brand. A cast anywhere else in
// production reaches an admitted migration with no lock held.
test("only locks.ts casts its way to a bundle in production code", () => {
  // Deliberately loose: `as unknown as HeldStatePlaneLocks` is only the obvious
  // spelling. A qualified reference (`as unknown as Mod.HeldStatePlaneLocks`)
  // is the same forgery and slipped past a tighter pattern when probed.
  const sweep = Bun.spawnSync([
    "git", "grep", "-lIE", "\\bas\\b[^;]*HeldStatePlaneLocks", "--", "src", ":!*.test.ts",
  ], { cwd: path.resolve(import.meta.dir, "../../..") });
  expect(sweep.exitCode, "git grep failed to run").toBeLessThanOrEqual(1);
  const files = new TextDecoder().decode(sweep.stdout).trim().split("\n").filter(Boolean);
  expect(files).toEqual(["src/cli/state-plane/locks.ts"]);
});

test("a standing reset journal is recovered to completion before the body runs", async () => {
  const root = await workspace("rbox-locks-standing-reset-");
  await fs.writeFile(resetJournalPath(root), "{ not a journal");
  // Fail-closed: an undecodable standing transaction refuses; it is never
  // stepped over so the body can start on a half-completed reset.
  await expect(withStatePlaneLocks(root, async () => "never")).rejects.toThrow();
});
