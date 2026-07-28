import { expect, test } from "bun:test";
import type { FileEntry } from "../types.js";
import { EntryArena } from "./arena.js";
import { withCipherDescriptor } from "./cipher-descriptor.js";
import { GenerationReplacementConflict } from "./errors.js";
import {
  abortGeneration,
  candidateRef,
  currentMutationToken,
  inspectOwner,
  publishGeneration,
  registerWorker,
  replaceInternedEntry,
  workerRequest,
} from "./owner.js";
import { GenerationOwnerScope, withGenerationOwnerScope } from "./scope.js";

function entry(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return { path, sha256: `sha-${path}`, size: 3, mode: 0o644, mtimeMs: 1000, type: "file", ...overrides };
}

const SEED = [entry("a.txt"), entry("b.txt")];

const settled = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test("abort with zero pending results finalizes in the same queue step", async () => {
  const arena = new EntryArena();
  const scope = new GenerationOwnerScope(arena);
  const { owner } = scope.createOwner({ entries: SEED });
  expect(await abortGeneration(owner)).toBe("aborted");
  expect(inspectOwner(owner)).toMatchObject({ terminalState: "discarded", workerIntake: "closed", tokenSequence: null });
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  expect(scope.liveOwnerIds).toEqual([]);
  await scope.abortAll();
});

test("abort with an in-flight worker waits for the return callback, then discards it", async () => {
  const arena = new EntryArena();
  const scope = new GenerationOwnerScope(arena);
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
  await scope.abortAll();
});

test("a repeat abort is already-terminal and never double-releases", async () => {
  const arena = new EntryArena();
  const scope = new GenerationOwnerScope(arena);
  const { owner } = scope.createOwner({ entries: SEED });
  const registration = await registerWorker(owner);
  const first = abortGeneration(owner);
  const concurrent = abortGeneration(owner);
  await registration.fail();
  expect(await first).toBe("aborted");
  expect(await concurrent).toBe("already-terminal");
  expect(await abortGeneration(owner)).toBe("already-terminal");
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  await scope.abortAll();
});

test("abort after publish is already-terminal and leaves the published generation intact", async () => {
  const arena = new EntryArena();
  const scope = new GenerationOwnerScope(arena);
  const { owner, token } = scope.createOwner({ entries: SEED });
  const published = await publishGeneration(owner, token);
  expect(await abortGeneration(owner)).toBe("already-terminal");
  expect(published.entries.map((e) => e.path)).toEqual(["a.txt", "b.txt"]);
  expect(arena.stats()).toMatchObject({ liveSlots: 2, retains: 2 });
  published.release();
  await scope.abortAll();
});

test("a returned-but-queued result blocks publication and lands in the published generation", async () => {
  const arena = new EntryArena();
  const scope = new GenerationOwnerScope(arena);
  const { owner, token } = scope.createOwner({ entries: SEED });
  const request = workerRequest(owner, "a.txt");
  const registration = await registerWorker(owner);

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
  await scope.abortAll();
});

test("intake closes before publication drains, so late registration conflicts", async () => {
  const arena = new EntryArena();
  const scope = new GenerationOwnerScope(arena);
  const { owner, token } = scope.createOwner({ entries: SEED });
  const registration = await registerWorker(owner);
  const publish = publishGeneration(owner, token);
  await settled();
  await expect(registerWorker(owner)).rejects.toThrow(GenerationReplacementConflict);
  await registration.fail();
  const generation = await publish;
  generation.release();
  await scope.abortAll();
  expect(arena.stats().liveSlots).toBe(0);
});

test("an apply that throws still releases resources and decrements pendingResults", async () => {
  const arena = new EntryArena();
  const scope = new GenerationOwnerScope(arena);
  const { owner, token } = scope.createOwner({ entries: SEED });
  const registration = await registerWorker(owner);
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
  await scope.abortAll();
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
  const scope = new GenerationOwnerScope(arena);
  const { owner, token } = scope.createOwner({ entries: SEED });
  const registration = await registerWorker(owner);
  const ref = candidateRef(owner, "a.txt")!;
  const advanced = await replaceInternedEntry({ owner, token, path: "a.txt", expected: ref.version, next: entry("a.txt", { size: 4 }) });
  expect(currentMutationToken(owner)).toBe(advanced.token);
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
  await scope.abortAll();
});

test("scope teardown drains a lost capability without WeakMap enumeration", async () => {
  const arena = new EntryArena();
  const scope = new GenerationOwnerScope(arena);
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
  const scope = new GenerationOwnerScope(arena);
  const { owner } = scope.createOwner({ entries: SEED });
  const [ownerId] = scope.liveOwnerIds;
  expect(await scope.abortOwner(ownerId!)).toBe("aborted");
  expect(inspectOwner(owner).terminalState).toBe("discarded");
  expect(await scope.abortOwner(ownerId!)).toBe("already-terminal");
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  await scope.abortAll();
});
