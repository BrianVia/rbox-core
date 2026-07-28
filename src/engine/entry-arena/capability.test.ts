import { expect, test } from "bun:test";
import * as barrel from "./index.js";
import { EntryArena } from "./arena.js";
import { authenticateOwner, createOwnerControl, discardUnseeded, seedCandidate } from "./owner.js";
import { GenerationOwnerScope, withGenerationOwnerScope } from "./scope.js";

test("REGRESSION (finding 6): the barrel exports no capability-minting surface", () => {
  const names = Object.keys(barrel);
  for (const forbidden of [
    "createOwnerControl",
    "authenticateOwner",
    "seedCandidate",
    "discardUnseeded",
    "abortControl",
    "controlOfOwner",
    "replaceOnOwnerQueue",
    "requireOwnerLive",
    "settleOwnerDrain",
    "CandidateGeneration",
    "OWNER_CONSTRUCTION_KEY",
    "SCOPE_CONSTRUCTION_KEY",
  ]) {
    expect(names).not.toContain(forbidden);
  }
  expect(names).toContain("withGenerationOwnerScope");
});

test("REGRESSION (finding 6): a deep import cannot mint an owner outside a scope", () => {
  const arena = new EntryArena();
  const forgedKey = Symbol("forged") as never;
  expect(() => createOwnerControl(forgedKey, arena, () => {})).toThrow(/module-private/);
  expect(() => authenticateOwner(forgedKey, { ownerId: 1 })).toThrow(/module-private/);
  expect(() => seedCandidate(forgedKey, {} as never, [])).toThrow(/module-private/);
  expect(() => discardUnseeded(forgedKey, {} as never)).toThrow(/module-private/);
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
});

test("REGRESSION (finding 6): a scope cannot be constructed without withGenerationOwnerScope", async () => {
  const arena = new EntryArena();
  expect(() => new GenerationOwnerScope(arena, Symbol("forged") as never)).toThrow(/module-private/);
  await withGenerationOwnerScope(arena, (scope) => {
    expect(scope).toBeInstanceOf(GenerationOwnerScope);
  });
});
