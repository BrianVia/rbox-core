import { expect, test } from "bun:test";
import type { FileEntry } from "../types.js";
import { EntryArena } from "./arena.js";
import { withCipherDescriptor } from "./cipher-descriptor.js";
import { GenerationReplacementConflict, OwnerReentrancyError, WorkerLifecycleError } from "./errors.js";
import {
  abortGeneration,
  candidateRef,
  inspectOwner,
  publishGeneration,
  registerWorker,
  replaceInternedEntry,
  workerRequest,
} from "./owner.js";
import type { WorkerApplyContext } from "./workers.js";
import { withGenerationOwnerScope } from "./owner.js";

function entry(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return { path, sha256: "sha-" + path, size: 3, mode: 0o644, mtimeMs: 1000, type: "file", ...overrides };
}

const SEED = [entry("a.txt"), entry("b.txt")];

const settled = async (): Promise<void> => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};

test("REGRESSION (finding 2): a saved worker apply context is revoked when the callback returns", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const request = workerRequest(owner, "a.txt");
    const registration = await registerWorker(owner);
    await registration.markRunning();
    let escaped: WorkerApplyContext | undefined;
    await registration.returnResult((context) => {
      escaped = context;
    });
    expect(escaped).toBeDefined();
    expect(() =>
      escaped!.replace(request.path, request.expected, withCipherDescriptor(request.entry, { encSha: "enc-a" })),
    ).toThrow(WorkerLifecycleError);
    // Nothing moved: the token the caller holds is still current and publishes.
    expect(candidateRef(owner, "a.txt")!.entry.encSha).toBeUndefined();
    const published = await publishGeneration(owner, token);
    expect(published.get("a.txt")!.encSha).toBeUndefined();
    published.release();
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  });
});

test("REGRESSION (finding 3): settlement is single-use and pendingResults never underflows", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner } = scope.createOwner({ entries: SEED });
    const registration = await registerWorker(owner);
    expect(await registration.fail()).toBe("discarded");
    expect(inspectOwner(owner).pendingResults).toBe(0);
    await expect(registration.fail()).rejects.toThrow(WorkerLifecycleError);
    await expect(registration.returnResult(() => {})).rejects.toThrow(WorkerLifecycleError);
    await expect(registration.markRunning()).rejects.toThrow(WorkerLifecycleError);
    expect(inspectOwner(owner).pendingResults).toBe(0);
    expect(await abortGeneration(owner)).toBe("aborted");
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  });
});

test("REGRESSION (finding 3): a result cannot be returned before the worker runs", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner } = scope.createOwner({ entries: SEED });
    const registration = await registerWorker(owner);
    await expect(registration.returnResult(() => {})).rejects.toThrow(WorkerLifecycleError);
    expect(registration.state).toBe("registered");
    expect(inspectOwner(owner).pendingResults).toBe(1);
    await registration.markRunning();
    expect(await registration.returnResult(() => {})).toBe("applied");
    expect(inspectOwner(owner).pendingResults).toBe(0);
    expect(await abortGeneration(owner)).toBe("aborted");
  });
});

test("REGRESSION (finding 4): a throwing resource release still reaches done and settles the abort", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner } = scope.createOwner({ entries: SEED });
    const registration = await registerWorker(owner);
    await registration.markRunning();
    const abort = abortGeneration(owner);
    await settled();
    await expect(
      registration.returnResult(
        () => {},
        () => {
          throw new Error("temp file unlink failed");
        },
      ),
    ).rejects.toThrow("temp file unlink failed");
    expect(registration.state).toBe("done");
    expect(await abort).toBe("aborted");
    expect(inspectOwner(owner)).toMatchObject({ terminalState: "discarded", pendingResults: 0 });
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  });
});

test("REGRESSION (r2 finding 2): an ASYNC release callback awaiting its own abort is refused, not deadlocked", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner } = scope.createOwner({ entries: SEED });
    const registration = await registerWorker(owner);
    await registration.markRunning();
    await expect(
      registration.fail(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await abortGeneration(owner);
      }),
    ).rejects.toThrow(OwnerReentrancyError);
    expect(registration.state).toBe("done");
    expect(inspectOwner(owner).pendingResults).toBe(0);
    expect(await abortGeneration(owner)).toBe("aborted");
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  });
});

test("REGRESSION (r2 finding 2): scope.abortOwner and scope.abortAll are guarded too", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner } = scope.createOwner({ entries: SEED });
    const [ownerId] = scope.liveOwnerIds;
    const byId = await registerWorker(owner);
    await byId.markRunning();
    await expect(
      byId.fail(async () => {
        await Promise.resolve();
        await scope.abortOwner(ownerId!);
      }),
    ).rejects.toThrow(OwnerReentrancyError);

    const byAll = await registerWorker(owner);
    await byAll.markRunning();
    await expect(
      byAll.fail(async () => {
        await Promise.resolve();
        await scope.abortAll();
      }),
    ).rejects.toThrow(OwnerReentrancyError);
    expect(inspectOwner(owner).pendingResults).toBe(0);
  });
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
});

test("REGRESSION (r3 finding 2): NO owner may be driven terminal from a release callback", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const first = scope.createOwner({ entries: SEED });
    const second = scope.createOwner({ entries: [entry("c.txt")] });
    const registration = await registerWorker(first.owner);
    await registration.markRunning();
    await expect(
      registration.fail(async () => {
        await Promise.resolve();
        await abortGeneration(second.owner);
      }),
    ).rejects.toThrow(OwnerReentrancyError);
    expect(inspectOwner(second.owner).terminalState).toBe("live");
    expect(registration.state).toBe("done");
    expect(inspectOwner(first.owner).pendingResults).toBe(0);
  });
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
});

test("REGRESSION (r3 finding 2): concurrent mutual cross-owner aborts throw instead of deadlocking", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const a = scope.createOwner({ entries: SEED });
    const b = scope.createOwner({ entries: [entry("c.txt")] });
    const workerA = await registerWorker(a.owner);
    const workerB = await registerWorker(b.owner);
    await workerA.markRunning();
    await workerB.markRunning();

    // Codex's repro: A's release aborts B while B's release aborts A.
    const settleA = workerA
      .fail(async () => {
        await Promise.resolve();
        await abortGeneration(b.owner);
      })
      .catch((error: unknown) => error);
    const settleB = workerB
      .fail(async () => {
        await Promise.resolve();
        await abortGeneration(a.owner);
      })
      .catch((error: unknown) => error);
    expect(await settleA).toBeInstanceOf(OwnerReentrancyError);
    expect(await settleB).toBeInstanceOf(OwnerReentrancyError);
    expect(inspectOwner(a.owner).pendingResults).toBe(0);
    expect(inspectOwner(b.owner).pendingResults).toBe(0);
    expect(await abortGeneration(a.owner)).toBe("aborted");
    expect(await abortGeneration(b.owner)).toBe("aborted");
  });
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
});

test("REGRESSION (r2 finding 1): the worker apply result carries no token", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const request = workerRequest(owner, "a.txt");
    const registration = await registerWorker(owner);
    await registration.markRunning();
    let seen: { disposition: string; entry: Readonly<FileEntry> } | undefined;
    await registration.returnResult((context) => {
      seen = context.replace(request.path, request.expected, withCipherDescriptor(request.entry, { encSha: "enc-a" }));
    });
    expect(Object.keys(seen!).sort()).toEqual(["disposition", "entry"]);
    expect("token" in seen!).toBe(false);
    // The coordinator's token advanced, so the caller's stale token is refused.
    await expect(publishGeneration(owner, token)).rejects.toThrow(GenerationReplacementConflict);
    expect(await abortGeneration(owner)).toBe("aborted");
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  });
});

test("an apply that throws still releases resources and decrements pendingResults", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const registration = await registerWorker(owner);
    await registration.markRunning();
    let released = false;
    await expect(
      registration.returnResult(
        () => {
          throw new Error("encryption failed");
        },
        () => {
          released = true;
        },
      ),
    ).rejects.toThrow("encryption failed");
    expect(released).toBe(true);
    expect(registration.state).toBe("done");
    expect(inspectOwner(owner).pendingResults).toBe(0);
    const generation = await publishGeneration(owner, token);
    generation.release();
  });
  expect(arena.stats().liveSlots).toBe(0);
});

test("out-of-order worker results with a stale expected version conflict inside the callback", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const stale = workerRequest(owner, "a.txt");
    const first = await replaceInternedEntry({
      owner,
      token,
      path: "a.txt",
      expected: stale.expected,
      next: entry("a.txt", { size: 4 }),
    });
    expect(first.disposition).toBe("replaced");
    const registration = await registerWorker(owner);
    await registration.markRunning();
    await expect(
      registration.returnResult((context) => {
        context.replace(stale.path, stale.expected, withCipherDescriptor(stale.entry, { encSha: "enc-a" }));
      }),
    ).rejects.toThrow(GenerationReplacementConflict);
    expect(inspectOwner(owner).pendingResults).toBe(0);
    expect(arena.stats()).toMatchObject({ liveSlots: 2, retains: 2 });
    await abortGeneration(owner);
  });
  expect(arena.stats().liveSlots).toBe(0);
});

test("REGRESSION (r4): a nested scope inside a release callback is refused before it allocates", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner } = scope.createOwner({ entries: SEED });
    const registration = await registerWorker(owner);
    await registration.markRunning();
    let nestedReached = false;
    await expect(
      registration.fail(async () => {
        await Promise.resolve();
        await withGenerationOwnerScope(arena, (nested) => {
          nestedReached = true;
          nested.createOwner({ entries: [entry("nested.txt")] });
        });
      }),
    ).rejects.toThrow(OwnerReentrancyError);
    // Nothing was allocated, so there is nothing that teardown could not reclaim.
    expect(nestedReached).toBe(false);
    expect(arena.stats()).toMatchObject({ liveSlots: 2, retains: 2 });
    expect(registration.state).toBe("done");
    expect(inspectOwner(owner).pendingResults).toBe(0);
  });
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
});

test("REGRESSION (r4): createOwner on the outer scope is refused inside a release callback", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner } = scope.createOwner({ entries: SEED });
    const registration = await registerWorker(owner);
    await registration.markRunning();
    const ownersBefore = scope.liveOwnerIds.length;
    await expect(
      registration.fail(async () => {
        await Promise.resolve();
        scope.createOwner({ entries: [entry("nested.txt")] });
      }),
    ).rejects.toThrow(OwnerReentrancyError);
    expect(scope.liveOwnerIds).toHaveLength(ownersBefore);
    expect(arena.stats()).toMatchObject({ liveSlots: 2, retains: 2 });
    expect(inspectOwner(owner).pendingResults).toBe(0);
  });
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
});
