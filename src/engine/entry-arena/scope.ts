/**
 * Bounded owner scope (design 163 § "Early U0"). Its registry is strong and
 * enumerable and OWNS every owner handle until an exact terminal action, so
 * teardown can release a candidate even when the capability object was lost.
 * It never relies on WeakMap enumeration, `FinalizationRegistry`, or GC timing.
 *
 * This module claims the owner-minting capability once, at initialization, and
 * its own construction key never leaves the file — so `withGenerationOwnerScope`
 * really is the only owner construction path.
 */
import type { FileEntry } from "../types.js";
import type { EntryArena } from "./arena.js";
import { resolvePublishedGeneration } from "./generation.js";
import { takeOwnerCapability, type AbortOutcome, type GenerationOwnerLease, type OwnerHandle } from "./owner.js";
import type { GenerationMutationToken, PublishedGenerationToken } from "./tokens.js";

const mintOwner = takeOwnerCapability();

const SCOPE_KEY = Symbol("rbox.entry-arena.scope-construction");

export interface CandidateSeed {
  /** The published TOKEN is the seed capability, and it takes its OWN
   *  one-per-slot retains. A released — or hand-constructed — generation's
   *  token does not resolve, so only live generations can seed. */
  seedFrom?: PublishedGenerationToken;
  entries?: Iterable<Readonly<FileEntry>>;
}

export class GenerationOwnerScope {
  private readonly handles = new Map<number, OwnerHandle>();
  private closed = false;

  constructor(
    readonly arena: EntryArena,
    key: symbol,
  ) {
    if (key !== SCOPE_KEY) throw new Error("a generation owner scope is created only by withGenerationOwnerScope");
  }

  /** Only the workspace writer holding the workspace mutex may call this. */
  createOwner(seed: CandidateSeed = {}): { owner: GenerationOwnerLease; token: GenerationMutationToken } {
    if (this.closed) throw new Error("generation owner scope is closed");
    const entries = seed.entries ?? (seed.seedFrom ? resolvePublishedGeneration(seed.seedFrom).entries : []);
    const handle = mintOwner(this.arena, (ownerId) => this.handles.delete(ownerId));
    // Registered BEFORE seeding: a throwing iterator then leaves partial retains
    // that this registry can still find and release.
    this.handles.set(handle.ownerId, handle);
    try {
      handle.seed(entries);
    } catch (error) {
      handle.discardUnseeded();
      throw error;
    }
    return { owner: handle.owner, token: handle.token };
  }

  get liveOwnerIds(): number[] {
    return [...this.handles.keys()];
  }

  /** No-capability drain for owner loss. */
  async abortOwner(ownerId: number): Promise<AbortOutcome> {
    const handle = this.handles.get(ownerId);
    if (!handle) return "already-terminal";
    return handle.abort("scope.abortOwner");
  }

  /** Does not return before every owner reaches terminal with zero pending. */
  async abortAll(): Promise<void> {
    this.closed = true;
    while (this.handles.size > 0) {
      await Promise.all([...this.handles.values()].map((handle) => handle.abort("scope.abortAll")));
    }
  }
}

export async function withGenerationOwnerScope<T>(
  arena: EntryArena,
  body: (scope: GenerationOwnerScope) => Promise<T> | T,
): Promise<T> {
  const scope = new GenerationOwnerScope(arena, SCOPE_KEY);
  try {
    return await body(scope);
  } finally {
    await scope.abortAll();
  }
}
