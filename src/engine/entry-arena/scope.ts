/**
 * Bounded owner scope (design 163 § "Early U0"). Its registry is strong and
 * enumerable and OWNS every control block until an exact terminal action, so
 * teardown can release a candidate even when the capability object was lost.
 * It never relies on WeakMap enumeration, `FinalizationRegistry`, or GC timing.
 */
import type { FileEntry } from "../types.js";
import type { EntryArena } from "./arena.js";
import type { PublishedGeneration } from "./generation.js";
import { abortControl, createOwnerControl, type GenerationOwnerLease, type OwnerControl } from "./owner.js";
import type { GenerationMutationToken } from "./tokens.js";

export interface CandidateSeed {
  /** Seeds from the live published generation. Takes its OWN one-per-slot
   *  retains; it never borrows the source generation's retains. */
  seedFrom?: PublishedGeneration;
  entries?: Iterable<Readonly<FileEntry>>;
}

export class GenerationOwnerScope {
  private readonly controls = new Map<number, OwnerControl>();
  private closed = false;

  constructor(readonly arena: EntryArena) {}

  /** Only the workspace writer holding the workspace mutex may call this. */
  createOwner(seed: CandidateSeed = {}): { owner: GenerationOwnerLease; token: GenerationMutationToken } {
    if (this.closed) throw new Error("generation owner scope is closed");
    const entries = seed.entries ?? seed.seedFrom?.entries ?? [];
    const { owner, token, control } = createOwnerControl(this.arena, (ownerId) => this.controls.delete(ownerId), entries);
    this.controls.set(control.ownerId, control);
    return { owner, token };
  }

  get liveOwnerIds(): number[] {
    return [...this.controls.keys()];
  }

  /** No-capability drain for owner loss. */
  async abortOwner(ownerId: number): Promise<"aborted" | "already-terminal"> {
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
  const scope = new GenerationOwnerScope(arena);
  try {
    return await body(scope);
  } finally {
    await scope.abortAll();
  }
}
