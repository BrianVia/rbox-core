/**
 * The two generation shapes of the U0 seam (design 163 § "Early U0").
 *
 * A CANDIDATE is mutable but unpublished; it holds exactly one arena retain per
 * referenced slot and is reachable only through its owner control block. A
 * PUBLISHED generation is immutable: the candidate's retains are transferred to
 * it without a second retain, and its entry array is frozen.
 */
import { compareManifestPaths } from "../manifest.js";
import type { FileEntry } from "../types.js";
import { EntryLeaseError } from "./errors.js";
import type { ArenaSlot, EntryArena } from "./arena.js";
import {
  makeVersionToken,
  type EntryLease,
  type EntryVersionToken,
  type GenerationId,
  type OwnedEntryRef,
  type PublishedGenerationToken,
} from "./tokens.js";

export interface PathState {
  slot: ArenaSlot;
  pathEpoch: number;
}

function sortedPaths(byPath: Map<string, PathState>): string[] {
  return [...byPath.keys()].sort(compareManifestPaths);
}

export class CandidateGeneration {
  readonly generationId: GenerationId;
  private readonly byPath = new Map<string, PathState>();
  private drained = false;

  constructor(
    private readonly arena: EntryArena,
    generationId: GenerationId,
  ) {
    this.generationId = generationId;
  }

  /** Seeding takes its OWN one-per-slot retains; it never borrows the source
   *  generation's retains. The path is read from the arena's own frozen copy,
   *  and the provisional retain is released in `finally` unless the candidate
   *  took ownership of it — a source that throws mid-iteration leaks nothing. */
  seed(entries: Iterable<Readonly<FileEntry>>): void {
    for (const entry of entries) {
      const slot = this.arena.internExact(entry);
      let handedOff = false;
      try {
        const path = slot.entry.path;
        const previous = this.byPath.get(path);
        this.byPath.set(path, { slot, pathEpoch: previous ? previous.pathEpoch + 1 : 0 });
        handedOff = true;
        if (previous) this.arena.release(previous.slot);
      } finally {
        if (!handedOff) this.arena.release(slot);
      }
    }
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }

  state(path: string): PathState | undefined {
    return this.byPath.get(path);
  }

  versionOf(path: string): EntryVersionToken | undefined {
    const state = this.byPath.get(path);
    if (!state) return undefined;
    return makeVersionToken(this.generationId, path, state.pathEpoch, state.slot.id);
  }

  ref(path: string): OwnedEntryRef | undefined {
    const state = this.byPath.get(path);
    if (!state) return undefined;
    return Object.freeze({
      version: makeVersionToken(this.generationId, path, state.pathEpoch, state.slot.id),
      entry: state.slot.entry,
    });
  }

  /** Atomically swap the path reference to an already-retained next slot, bump
   *  `pathEpoch` (the ABA guard), and only then release the old retain. */
  replace(path: string, nextSlot: ArenaSlot): OwnedEntryRef {
    const previous = this.byPath.get(path);
    if (!previous) throw new EntryLeaseError(`candidate has no path ${path}`);
    this.byPath.set(path, { slot: nextSlot, pathEpoch: previous.pathEpoch + 1 });
    this.arena.release(previous.slot);
    return this.ref(path)!;
  }

  snapshot(): Array<{ path: string; state: PathState }> {
    return sortedPaths(this.byPath).map((path) => ({ path, state: this.byPath.get(path)! }));
  }

  /** Release every candidate retain exactly once. Idempotent by construction:
   *  the map is emptied in the same step. */
  releaseAll(): void {
    if (this.drained) return;
    this.drained = true;
    for (const state of this.byPath.values()) this.arena.release(state.slot);
    this.byPath.clear();
  }

  /** Hand the retains to a published generation without a second retain. */
  transfer(): Array<{ path: string; state: PathState }> {
    if (this.drained) throw new EntryLeaseError("candidate generation already released");
    this.drained = true;
    const transferred = this.snapshot();
    this.byPath.clear();
    return transferred;
  }
}

export class PublishedGeneration {
  readonly token: PublishedGenerationToken;
  readonly generationId: GenerationId;
  /** Frozen: published arrays are never sorted, spliced, or pushed in place.
   *  Null once released — a released generation exposes nothing. */
  private frozenEntries: readonly Readonly<FileEntry>[] | null;
  private readonly byPath = new Map<string, PathState>();
  private released = false;

  /** Inert on its own: a generation becomes seedable only when the publisher
   *  registers its token, which happens nowhere but `publishGeneration`. */
  constructor(
    private readonly arena: EntryArena,
    generationId: GenerationId,
    transferred: Array<{ path: string; state: PathState }>,
  ) {
    this.generationId = generationId;
    this.token = Object.freeze({ kind: "published" as const, generationId });
    for (const { path, state } of transferred) this.byPath.set(path, state);
    this.frozenEntries = Object.freeze(transferred.map(({ state }) => state.slot.entry));
  }

  get entries(): readonly Readonly<FileEntry>[] {
    return this.requireLive();
  }

  get isReleased(): boolean {
    return this.released;
  }

  get(path: string): Readonly<FileEntry> | undefined {
    this.requireLive();
    return this.byPath.get(path)?.slot.entry;
  }

  versionOf(path: string): EntryVersionToken | undefined {
    this.requireLive();
    const state = this.byPath.get(path);
    if (!state) return undefined;
    return makeVersionToken(this.generationId, path, state.pathEpoch, state.slot.id);
  }

  /** An explicit extra retain that outlives replacements and awaits. Release it
   *  in `finally`. */
  lease(path: string): EntryLease {
    this.requireLive();
    const state = this.byPath.get(path);
    if (!state) throw new EntryLeaseError(`generation ${this.generationId} has no path ${path}`);
    this.arena.retain(state.slot);
    const arena = this.arena;
    let live = true;
    return {
      version: makeVersionToken(this.generationId, path, state.pathEpoch, state.slot.id),
      entry: state.slot.entry,
      release(): void {
        if (!live) throw new EntryLeaseError(`lease on ${path} released twice`);
        live = false;
        arena.release(state.slot);
      },
    };
  }

  /** Drop this generation's one-per-slot retains. Outstanding reader leases keep
   *  their own retains and stay valid. */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.frozenEntries = null;
    for (const state of this.byPath.values()) this.arena.release(state.slot);
    this.byPath.clear();
  }

  private requireLive(): readonly Readonly<FileEntry>[] {
    if (!this.frozenEntries) throw new EntryLeaseError(`published generation ${this.generationId} is released`);
    return this.frozenEntries;
  }
}
