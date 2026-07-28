import { expect, test } from "bun:test";
import type { FileEntry } from "../types.js";
import { EntryArena } from "./arena.js";
import { withCipherDescriptor } from "./cipher-descriptor.js";
import { GenerationReplacementConflict, WorkerLifecycleError } from "./errors.js";
import {
  abortGeneration,
  candidateRef,
  inspectOwner,
  publishGeneration,
  replaceInternedEntry,
  workerRequest,
} from "./owner.js";
import { registerWorker, type WorkerApplyContext } from "./workers.js";
import { withGenerationOwnerScope } from "./scope.js";

function entry(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return { path, sha256: `sha-${path}`, size: 3, mode: 0o644, mtimeMs: 1000, type: "file", ...overrides };
}

const SEED = [entry("a.txt"), entry("b.txt")];

const settled = async (): Promise<void> => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};

test("abort with zero pending results finalizes in the same queue step", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner } = scope.createOwner({ entries: SEED });
    expect(await abortGeneration(owner)).toBe("aborted");
    expect(inspectOwner(owner)).toMatchObject({ terminalState: "discarded", workerIntake: "closed", tokenSequence: null });
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
    expect(scope.liveOwnerIds).toEqual([]);
  });
});

test("abort with an in-flight worker waits for the return callback, then discards it", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner } = scope.createOwner({ entries: SEED });
    let cancelled = 0;
    const registration = await registerWorker(owner, { cancel: () => cancelled++ });
    await registration.markRunning();
    expect(registration.state).toBe("running");

    let aborted = false;
    const abort = abortGeneration(owner).then((outcome) => {
      aborted = true;
      return outcome;
    });
    await settled();
    expect(aborted).toBe(false);
    expect(cancelled).toBe(1);
    expect(inspectOwner(owner)).toMatchObject({ terminalState: "aborting", pendingResults: 1 });
    expect(arena.stats().retains).toBe(2);

    let applied = false;
    let released = false;
    const outcome = await registration.returnResult(
      () => {
        applied = true;
      },
      () => {
        released = true;
      },
    );
    expect(outcome).toBe("discarded");
    expect(applied).toBe(false);
    expect(released).toBe(true);
    expect(registration.state).toBe("done");
    expect(await abort).toBe("aborted");
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  });
});

test("a repeat abort is already-terminal and never double-releases", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner } = scope.createOwner({ entries: SEED });
    const registration = await registerWorker(owner);
    const first = abortGeneration(owner);
    const concurrent = abortGeneration(owner);
    await registration.fail();
    expect(await first).toBe("aborted");
    expect(await concurrent).toBe("already-terminal");
    expect(await abortGeneration(owner)).toBe("already-terminal");
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  });
});

test("abort after publish is already-terminal and leaves the published generation intact", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const published = await publishGeneration(owner, token);
    expect(await abortGeneration(owner)).toBe("already-terminal");
    expect(published.entries.map((e) => e.path)).toEqual(["a.txt", "b.txt"]);
    expect(arena.stats()).toMatchObject({ liveSlots: 2, retains: 2 });
    published.release();
  });
});

test("REGRESSION (finding 1): every publish/abort interleaving has exactly one winner", async () => {
  // The abort's pre-queue terminal check cannot see a publication that is
  // already queued ahead of it, so the invariant is enforced ON the queue:
  // abort never rewrites a published generation, and the two never both win.
  const outcomes = new Set<string>();
  for (let delay = 0; delay <= 12; delay++) {
    const arena = new EntryArena();
    await withGenerationOwnerScope(arena, async (scope) => {
      const { owner, token } = scope.createOwner({ entries: SEED });
      const registration = await registerWorker(owner);
      const publish = publishGeneration(owner, token);
      const settle = registration.fail();
      for (let i = 0; i < delay; i++) await Promise.resolve();
      const abort = abortGeneration(owner);
      await settle;

      const result = await publish.then(
        (generation) => ({ generation, error: undefined }),
        (error: unknown) => ({ generation: undefined, error }),
      );
      const abortOutcome = await abort;
      if (result.generation) {
        outcomes.add("published");
        expect(abortOutcome).toBe("already-terminal");
        expect(inspectOwner(owner).terminalState).toBe("published");
        expect(result.generation.entries.map((e) => e.path)).toEqual(["a.txt", "b.txt"]);
        expect(arena.stats()).toMatchObject({ liveSlots: 2, retains: 2 });
        result.generation.release();
      } else {
        outcomes.add("aborted");
        expect(result.error).toBeInstanceOf(GenerationReplacementConflict);
        expect(abortOutcome).toBe("aborted");
        expect(inspectOwner(owner).terminalState).toBe("discarded");
      }
      expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
    });
  }
  // The window is real: both winners occur across the interleavings.
  expect([...outcomes].sort()).toEqual(["aborted", "published"]);
});

test("a returned-but-queued result blocks publication and lands in the published generation", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const request = workerRequest(owner, "a.txt");
    const registration = await registerWorker(owner);
    await registration.markRunning();

    let publishedSeen = false;
    const publish = publishGeneration(owner, token).then((generation) => {
      publishedSeen = true;
      return generation;
    });
    await settled();
    expect(publishedSeen).toBe(false);
    expect(inspectOwner(owner)).toMatchObject({ workerIntake: "closed", pendingResults: 1 });

    const outcome = await registration.returnResult((context) => {
      const result = context.replace(request.path, request.expected, withCipherDescriptor(request.entry, { encSha: "enc-a" }));
      expect(result.disposition).toBe("replaced");
    });
    expect(outcome).toBe("applied");
    const generation = await publish;
    expect(generation.get("a.txt")!.encSha).toBe("enc-a");
    expect(arena.stats()).toMatchObject({ liveSlots: 2, retains: 2 });
    generation.release();
  });
});

test("REGRESSION (finding 5): an advance from outside the drain fails the publication", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const registration = await registerWorker(owner);
    await registration.markRunning();
    const publish = publishGeneration(owner, token);
    await settled();
    // Not a drain callback: a direct holder of the current token mutating the
    // candidate after publication was decided.
    const outside = await replaceInternedEntry({
      owner,
      token,
      path: "b.txt",
      expected: candidateRef(owner, "b.txt")!.version,
      next: entry("b.txt", { size: 4 }),
    });
    expect(outside.disposition).toBe("replaced");
    await registration.fail();
    await expect(publish).rejects.toThrow(GenerationReplacementConflict);
    expect(inspectOwner(owner).terminalState).toBe("live");
    expect(await abortGeneration(owner)).toBe("aborted");
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  });
});

test("intake closes before publication drains, so late registration conflicts", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const registration = await registerWorker(owner);
    const publish = publishGeneration(owner, token);
    await settled();
    await expect(registerWorker(owner)).rejects.toThrow(GenerationReplacementConflict);
    await registration.fail();
    const generation = await publish;
    generation.release();
  });
  expect(arena.stats().liveSlots).toBe(0);
});

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

test("REGRESSION (finding 4): a release callback that re-enters its own owner is refused, not deadlocked", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner } = scope.createOwner({ entries: SEED });
    const registration = await registerWorker(owner);
    await registration.markRunning();
    await expect(
      registration.fail(() => {
        void abortGeneration(owner);
      }),
    ).rejects.toThrow(WorkerLifecycleError);
    expect(registration.state).toBe("done");
    expect(inspectOwner(owner).pendingResults).toBe(0);
    expect(await abortGeneration(owner)).toBe("aborted");
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  });
});

test("REGRESSION (finding 7): a throwing cancellation hook cancels the rest and still settles", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner } = scope.createOwner({ entries: SEED });
    let secondCancelled = false;
    const first = await registerWorker(owner, {
      cancel: () => {
        throw new Error("cancel hook exploded");
      },
    });
    const second = await registerWorker(owner, {
      cancel: () => {
        secondCancelled = true;
      },
    });
    const abort = abortGeneration(owner);
    await settled();
    expect(secondCancelled).toBe(true);
    expect(inspectOwner(owner).abortHookErrors).toHaveLength(1);
    await first.fail();
    await second.fail();
    expect(await abort).toBe("aborted");
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

test("cancellation after token advancement discards the late result", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const registration = await registerWorker(owner);
    await registration.markRunning();
    const ref = candidateRef(owner, "a.txt")!;
    const advanced = await replaceInternedEntry({ owner, token, path: "a.txt", expected: ref.version, next: entry("a.txt", { size: 4 }) });
    expect(advanced.disposition).toBe("replaced");
    const abort = abortGeneration(owner);
    await settled();
    let applied = false;
    expect(
      await registration.returnResult(() => {
        applied = true;
      }),
    ).toBe("discarded");
    expect(applied).toBe(false);
    expect(await abort).toBe("aborted");
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  });
});

test("scope teardown drains a lost capability without WeakMap enumeration", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    let registration: Awaited<ReturnType<typeof registerWorker>>;
    {
      const { owner } = scope.createOwner({ entries: SEED });
      registration = await registerWorker(owner);
    }
    expect(scope.liveOwnerIds.length).toBe(1);
    let torndown = false;
    const teardown = scope.abortAll().then(() => {
      torndown = true;
    });
    await settled();
    expect(torndown).toBe(false);
    await registration.fail();
    await teardown;
    expect(scope.liveOwnerIds).toEqual([]);
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  });
});

test("withGenerationOwnerScope aborts every owner when the body throws", async () => {
  const arena = new EntryArena();
  await expect(
    withGenerationOwnerScope(arena, (scope) => {
      scope.createOwner({ entries: SEED });
      scope.createOwner({ entries: [entry("c.txt")] });
      throw new Error("upload failed");
    }),
  ).rejects.toThrow("upload failed");
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
});

test("abortOwner performs the same no-capability drain by owner id", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner } = scope.createOwner({ entries: SEED });
    const [ownerId] = scope.liveOwnerIds;
    expect(await scope.abortOwner(ownerId!)).toBe("aborted");
    expect(inspectOwner(owner).terminalState).toBe("discarded");
    expect(await scope.abortOwner(ownerId!)).toBe("already-terminal");
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  });
});
