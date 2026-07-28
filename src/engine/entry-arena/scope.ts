/**
 * Bounded owner scope (design 163 § "Early U0"). Its registry is strong and
 * enumerable and OWNS every control block until an exact terminal action, so
 * teardown can release a candidate even when the capability object was lost.
 * It never relies on WeakMap enumeration, `FinalizationRegistry`, or GC timing.
 *
 * `withGenerationOwnerScope` is the only construction path: the constructor
 * demands a module-private key that `index.ts` does not re-export.
 */
import type { FileEntry } from "../types.js";
import type { EntryArena } from "./arena.js";
import { resolvePublishedGeneration } from "./generation.js";
import {
  OWNER_CONSTRUCTION_KEY,
  SCOPE_CONSTRUCTION_KEY,
  requireConstructionKey,
  type ScopeConstructionKey,
} from "./internal.js";
import {
  abortControl,
  createOwnerControl,
  discardUnseeded,
  seedCandidate,
  type AbortOutcome,
  type GenerationOwnerLease,
  type OwnerControl,
} from "./owner.js";
import type { GenerationMutationToken, PublishedGenerationToken } from "./tokens.js";

export interface CandidateSeed {
  /** The published TOKEN is the seed capability, and it takes its OWN
   *  one-per-slot retains. A released generation's token no longer resolves, so
   *  historical generations can never reseed a candidate. */
  seedFrom?: PublishedGenerationToken;
  entries?: Iterable<Readonly<FileEntry>>;
}

export class GenerationOwnerScope {
  private readonly controls = new Map<number, OwnerControl>();
  private closed = false;

  constructor(
    readonly arena: EntryArena,
    key: ScopeConstructionKey,
  ) {
    requireConstructionKey(key, SCOPE_CONSTRUCTION_KEY, "GenerationOwnerScope");
  }

  /** Only the workspace writer holding the workspace mutex may call this. */
  createOwner(seed: CandidateSeed = {}): { owner: GenerationOwnerLease; token: GenerationMutationToken } {
    if (this.closed) throw new Error("generation owner scope is closed");
    const entries = seed.entries ?? (seed.seedFrom ? resolvePublishedGeneration(seed.seedFrom).entries : []);
    const { owner, token, control } = createOwnerControl(OWNER_CONSTRUCTION_KEY, this.arena, (ownerId) =>
      this.controls.delete(ownerId),
    );
    // Registered BEFORE seeding: a throwing iterator then leaves partial retains
    // that this registry can still find and release.
    this.controls.set(control.ownerId, control);
    try {
      seedCandidate(OWNER_CONSTRUCTION_KEY, control, entries);
    } catch (error) {
      discardUnseeded(OWNER_CONSTRUCTION_KEY, control);
      throw error;
    }
    return { owner, token };
  }

  get liveOwnerIds(): number[] {
    return [...this.controls.keys()];
  }

  /** No-capability drain for owner loss. */
  async abortOwner(ownerId: number): Promise<AbortOutcome> {
    const control = this.controls.get(ownerId);
    if (!control) return "already-terminal";
    return abortControl(control);
  }

  /** Does not return before every control reaches terminal with zero pending. */
  async abortAll(): Promise<void> {
    this.closed = true;
    while (this.controls.size > 0) {
      await Promise.all([...this.controls.values()].map((control) => abortControl(control)));
    }
  }
}

export async function withGenerationOwnerScope<T>(
  arena: EntryArena,
  body: (scope: GenerationOwnerScope) => Promise<T> | T,
): Promise<T> {
  const scope = new GenerationOwnerScope(arena, SCOPE_CONSTRUCTION_KEY);
  try {
    return await body(scope);
  } finally {
    await scope.abortAll();
  }
}
