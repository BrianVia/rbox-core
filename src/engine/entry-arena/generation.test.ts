import { expect, test } from "bun:test";
import type { FileEntry } from "../types.js";
import { EntryArena } from "./arena.js";
import { withCipherDescriptor } from "./cipher-descriptor.js";
import { EntryLeaseError, GenerationOwnerCapabilityError, GenerationReplacementConflict } from "./errors.js";
import {
  candidateRef,
  discardGeneration,
  inspectOwner,
  publishGeneration,
  replaceInternedEntry,
  workerRequest,
  type GenerationOwnerLease,
} from "./owner.js";
import { withGenerationOwnerScope } from "./owner.js";
import { makeVersionToken, type GenerationMutationToken, type PublishedGenerationToken } from "./tokens.js";

function entry(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return { path, sha256: `sha-${path}`, size: 3, mode: 0o644, mtimeMs: 1000, type: "file", ...overrides };
}

const SEED = [entry("a.txt"), entry("b.txt")];

async function conflictOf(action: Promise<unknown>): Promise<GenerationReplacementConflict> {
  try {
    await action;
  } catch (error) {
    if (error instanceof GenerationReplacementConflict) return error;
    throw error;
  }
  throw new Error("expected GenerationReplacementConflict");
}

test("seeding takes its own retains and publish transfers them without a second retain", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    expect(arena.stats()).toMatchObject({ liveSlots: 2, retains: 2 });
    const published = await publishGeneration(owner, token);
    expect(arena.stats()).toMatchObject({ liveSlots: 2, retains: 2 });
    expect(published.entries.map((e) => e.path)).toEqual(["a.txt", "b.txt"]);
    published.release();
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  });
});

test("a candidate seeded from a published TOKEN shares identity but not retains", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const first = scope.createOwner({ entries: SEED });
    const published = await publishGeneration(first.owner, first.token);
    const second = scope.createOwner({ seedFrom: published.token });
    expect(arena.stats()).toMatchObject({ liveSlots: 2, retains: 4 });
    expect(Object.is(candidateRef(second.owner, "a.txt")!.entry, published.get("a.txt"))).toBe(true);
    await discardGeneration(second.owner, second.token);
    expect(arena.stats()).toMatchObject({ liveSlots: 2, retains: 2 });
    published.release();
    expect(arena.stats().liveSlots).toBe(0);
  });
});

test("a released published generation exposes nothing and can never reseed a candidate", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const published = await publishGeneration(owner, token);
    const staleToken = published.token;
    published.release();
    expect(published.isReleased).toBe(true);
    expect(() => published.entries).toThrow(EntryLeaseError);
    expect(() => published.get("a.txt")).toThrow(EntryLeaseError);
    expect(() => published.lease("a.txt")).toThrow(EntryLeaseError);
    expect(() => scope.createOwner({ seedFrom: staleToken })).toThrow(EntryLeaseError);
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  });
});

test("a forged published token cannot seed a candidate", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, (scope) => {
    const forged = Object.freeze({ kind: "published", generationId: 1 }) as PublishedGenerationToken;
    expect(() => scope.createOwner({ seedFrom: forged })).toThrow(EntryLeaseError);
  });
});

test("published entries and arrays are frozen", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const published = await publishGeneration(owner, token);
    expect(Object.isFrozen(published.entries)).toBe(true);
    expect(() => (published.entries as FileEntry[]).push(entry("c.txt"))).toThrow();
    expect(() => {
      (published.entries[0] as FileEntry).size = 9;
    }).toThrow();
    published.release();
  });
});

test("exact-value replacement is unchanged, keeps the token and changes no retains", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const before = candidateRef(owner, "a.txt")!;
    const result = await replaceInternedEntry({ owner, token, path: "a.txt", expected: before.version, next: entry("a.txt") });
    expect(result.disposition).toBe("unchanged");
    expect(result.token).toBe(token);
    expect(Object.is(result.entry.entry, before.entry)).toBe(true);
    expect(arena.stats()).toMatchObject({ liveSlots: 2, retains: 2 });
    await discardGeneration(owner, token);
  });
});

test("a changed field replaces the slot, bumps pathEpoch and returns a new token", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const before = candidateRef(owner, "a.txt")!;
    const next = withCipherDescriptor(before.entry, { encSha: "enc-a" });
    const result = await replaceInternedEntry({ owner, token, path: "a.txt", expected: before.version, next });
    expect(result.disposition).toBe("replaced");
    expect(result.token).not.toBe(token);
    expect(result.entry.version.pathEpoch).toBe(before.version.pathEpoch + 1);
    expect(result.entry.version.slotId).toBeGreaterThan(before.version.slotId);
    expect(result.entry.entry.encSha).toBe("enc-a");
    expect(before.entry.encSha).toBeUndefined();
    expect(arena.stats()).toMatchObject({ liveSlots: 2, retains: 2 });
    await discardGeneration(owner, result.token);
    expect(arena.stats().liveSlots).toBe(0);
  });
});

test("a new token invalidates every earlier token for that owner", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const before = candidateRef(owner, "a.txt")!;
    const first = await replaceInternedEntry({
      owner,
      token,
      path: "a.txt",
      expected: before.version,
      next: withCipherDescriptor(before.entry, { encSha: "enc-a" }),
    });
    const stale = await conflictOf(
      replaceInternedEntry({
        owner,
        token,
        path: "b.txt",
        expected: candidateRef(owner, "b.txt")!.version,
        next: entry("b.txt", { size: 4 }),
      }),
    );
    expect(stale.reason).toBe("stale-token");
    expect(arena.stats()).toMatchObject({ liveSlots: 2, retains: 2 });
    await discardGeneration(owner, first.token);
  });
});

test("a recycled slot cannot pass a stale pathEpoch (ABA)", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const original = candidateRef(owner, "a.txt")!;
    const forward = await replaceInternedEntry({
      owner,
      token,
      path: "a.txt",
      expected: original.version,
      next: entry("a.txt", { size: 4 }),
    });
    const back = await replaceInternedEntry({
      owner,
      token: forward.token,
      path: "a.txt",
      expected: forward.entry.version,
      next: entry("a.txt"),
    });
    // Same VALUE as the original, but a fresh slot and a higher epoch.
    expect(back.entry.entry).toEqual(original.entry);
    expect(back.entry.version.slotId).not.toBe(original.version.slotId);
    expect(back.entry.version.pathEpoch).toBe(original.version.pathEpoch + 2);
    const conflict = await conflictOf(
      replaceInternedEntry({ owner, token: back.token, path: "a.txt", expected: original.version, next: entry("a.txt", { size: 5 }) }),
    );
    expect(conflict.reason).toBe("stale-version");
    expect(arena.stats()).toMatchObject({ liveSlots: 2, retains: 2 });
    await discardGeneration(owner, back.token);
  });
});

test("unknown path, mismatched next.path and stale generation each conflict without retain change", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const ref = candidateRef(owner, "a.txt")!;
    const unknown = await conflictOf(
      replaceInternedEntry({
        owner,
        token,
        path: "missing.txt",
        expected: makeVersionToken(ref.version.generationId, "missing.txt", 0, ref.version.slotId),
        next: entry("missing.txt"),
      }),
    );
    expect(unknown.reason).toBe("unknown-path");
    const mismatch = await conflictOf(
      replaceInternedEntry({ owner, token, path: "a.txt", expected: ref.version, next: entry("b.txt") }),
    );
    expect(mismatch.reason).toBe("path-mismatch");
    const otherGeneration = await conflictOf(
      replaceInternedEntry({
        owner,
        token,
        path: "a.txt",
        expected: makeVersionToken(ref.version.generationId + 99, "a.txt", ref.version.pathEpoch, ref.version.slotId),
        next: entry("a.txt", { size: 4 }),
      }),
    );
    expect(otherGeneration.reason).toBe("stale-version");
    expect(arena.stats()).toMatchObject({ liveSlots: 2, retains: 2 });
    await discardGeneration(owner, token);
  });
});

test("a published token is never accepted by replaceInternedEntry", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const ref = candidateRef(owner, "a.txt")!;
    const published = await publishGeneration(owner, token);
    const conflict = await conflictOf(
      replaceInternedEntry({
        owner,
        token: published.token as unknown as GenerationMutationToken,
        path: "a.txt",
        expected: ref.version,
        next: entry("a.txt", { size: 4 }),
      }),
    );
    expect(conflict.reason).toBe("not-live");
    published.release();
  });
  expect(arena.stats().liveSlots).toBe(0);
});

test("publish rejects after the generation is terminal", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    await discardGeneration(owner, token);
    expect(inspectOwner(owner).terminalState).toBe("discarded");
    expect((await conflictOf(publishGeneration(owner, token))).reason).toBe("not-live");
    expect(arena.stats().liveSlots).toBe(0);
  });
});

test("an unauthenticated capability object is rejected", async () => {
  const arena = new EntryArena();
  const forged = Object.freeze({ ownerId: 1 }) as GenerationOwnerLease;
  expect(() => inspectOwner(forged)).toThrow(GenerationOwnerCapabilityError);
  await withGenerationOwnerScope(arena, (scope) => {
    scope.createOwner({ entries: SEED });
    expect(() => candidateRef(forged, "a.txt")).toThrow(GenerationOwnerCapabilityError);
  });
});

test("reader leases on a published generation outlive its release", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const published = await publishGeneration(owner, token);
    const lease = published.lease("a.txt");
    published.release();
    expect(arena.stats()).toMatchObject({ liveSlots: 1, retains: 1 });
    expect(lease.entry.path).toBe("a.txt");
    lease.release();
    expect(() => lease.release()).toThrow(EntryLeaseError);
    expect(arena.stats().liveSlots).toBe(0);
  });
});

test("the worker DTO carries path, expected version and entry — never a token", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    const { owner, token } = scope.createOwner({ entries: SEED });
    const request = workerRequest(owner, "a.txt");
    expect(Object.keys(request).sort()).toEqual(["entry", "expected", "path"]);
    expect(Object.isFrozen(request)).toBe(true);
    await discardGeneration(owner, token);
  });
});

test("REGRESSION (r2 finding 5): seeding never re-reads the caller's entry after interning", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, async (scope) => {
    // The arena consumes the source exactly while producing its own frozen copy;
    // any read after that would throw and strand the provisional retain.
    let reads = 0;
    const hostile = {
      sha256: "sha-a.txt",
      size: 3,
      mode: 0o644,
      mtimeMs: 1000,
      type: "file" as const,
      get path(): string {
        if (++reads > 2) throw new Error("path accessor exploded");
        return "a.txt";
      },
    };
    const { owner, token } = scope.createOwner({ entries: [hostile as FileEntry] });
    expect(candidateRef(owner, "a.txt")!.entry.path).toBe("a.txt");
    expect(arena.stats()).toMatchObject({ liveSlots: 1, retains: 1 });
    await discardGeneration(owner, token);
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  });
});

test("REGRESSION (r2 finding 5): a mid-iteration intern failure leaves no provisional retain", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, (scope) => {
    const hostile = {
      sha256: "sha-b.txt",
      size: 3,
      mode: 0o644,
      mtimeMs: 1000,
      type: "file" as const,
      get path(): string {
        throw new Error("path accessor exploded");
      },
    };
    expect(() => scope.createOwner({ entries: [entry("a.txt"), hostile as FileEntry] })).toThrow("path accessor exploded");
    expect(scope.liveOwnerIds).toEqual([]);
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  });
});

test("REGRESSION (finding 8): a seed iterator that throws leaks no retains", async () => {
  const arena = new EntryArena();
  await withGenerationOwnerScope(arena, (scope) => {
    function* halfSeed(): Generator<FileEntry> {
      yield entry("a.txt");
      throw new Error("scan aborted");
    }
    expect(() => scope.createOwner({ entries: halfSeed() })).toThrow("scan aborted");
    expect(scope.liveOwnerIds).toEqual([]);
    expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
  });
});
