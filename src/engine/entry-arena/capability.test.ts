import { expect, test } from "bun:test";
import * as barrel from "./index.js";
import { EntryArena } from "./arena.js";
import { PublishedGeneration, resolvePublishedGeneration, takePublicationCapability } from "./generation.js";
import { takeOwnerCapability } from "./owner.js";
import { GenerationOwnerScope, withGenerationOwnerScope } from "./scope.js";
import type { FileEntry } from "../types.js";

function entry(path: string): FileEntry {
  return { path, sha256: `sha-${path}`, size: 3, mode: 0o644, mtimeMs: 1000, type: "file" };
}

test("REGRESSION (r2 finding 4): the barrel exports no capability-minting surface", () => {
  const names = Object.keys(barrel);
  for (const forbidden of [
    "takeOwnerCapability",
    "takePublicationCapability",
    "resolvePublishedGeneration",
    "createRegistration",
    "CandidateGeneration",
    "OWNER_CONSTRUCTION_KEY",
    "SCOPE_CONSTRUCTION_KEY",
  ]) {
    expect(names).not.toContain(forbidden);
  }
  expect(names).toContain("withGenerationOwnerScope");
});

test("REGRESSION (r2 finding 4): a deep import cannot claim the owner capability", () => {
  // The scope module claimed it when it initialized; there is no second one.
  expect(() => takeOwnerCapability()).toThrow(/already claimed/);
  expect(() => takeOwnerCapability()).toThrow(/already claimed/);
});

test("REGRESSION (r2 finding 4): a scope cannot be constructed without withGenerationOwnerScope", async () => {
  const arena = new EntryArena();
  expect(() => new GenerationOwnerScope(arena, Symbol("forged"))).toThrow(/only by withGenerationOwnerScope/);
  await withGenerationOwnerScope(arena, (scope) => {
    expect(scope).toBeInstanceOf(GenerationOwnerScope);
  });
});

test("REGRESSION (r2 finding 6): a hand-constructed PublishedGeneration mints no seedable token", async () => {
  const arena = new EntryArena();
  // The publication capability was claimed by the owner module at init.
  expect(() => takePublicationCapability()).toThrow(/already claimed/);

  const slot = arena.internExact(entry("a.txt"));
  expect(
    () => new PublishedGeneration(Symbol("forged"), arena, 1, [{ path: "a.txt", state: { slot, pathEpoch: 0 } }]),
  ).toThrow(/only by publishGeneration/);

  // Even a shape-compatible impostor token resolves to nothing.
  const impostor = Object.freeze({ kind: "published" as const, generationId: 1 });
  expect(() => resolvePublishedGeneration(impostor)).toThrow(/not live/);
  await withGenerationOwnerScope(arena, (scope) => {
    expect(() => scope.createOwner({ seedFrom: impostor })).toThrow(/not live/);
  });

  arena.release(slot);
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
});
