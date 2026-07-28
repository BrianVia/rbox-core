/**
 * Immutable DTOs of the U0 replacement seam (design 163 § "Early U0"). Every
 * value here is frozen and structurally comparable; none of them is authority.
 * Authority lives in the runtime capability (`scope.ts`) — a brand alone is not
 * authority.
 */
import type { FileEntry } from "../types.js";

export type SlotId = number;
export type GenerationId = number;
export type WorkerResultId = number;

/** `{generationId,path,pathEpoch,slotId}` — the exact version a mutation targets. */
export interface EntryVersionToken {
  readonly generationId: GenerationId;
  readonly path: string;
  readonly pathEpoch: number;
  readonly slotId: SlotId;
}

/** Single-use mutation token. A new token invalidates every earlier token for
 *  that owner; validity is object identity against `OwnerControl.currentToken`. */
export interface GenerationMutationToken {
  readonly kind: "mutation";
  readonly ownerId: number;
  readonly sequence: number;
}

/** Returned by `publishGeneration`. Can only seed a new candidate owner; it is
 *  never accepted by `replaceInternedEntry`. */
export interface PublishedGenerationToken {
  readonly kind: "published";
  readonly generationId: GenerationId;
}

/** The version plus the immutable entry. NOT an extra retain: valid for mutation
 *  only while its owner/candidate/token remain live. Code that keeps an entry
 *  across an await or a replacement must acquire an {@link EntryLease}. */
export interface OwnedEntryRef {
  readonly version: EntryVersionToken;
  readonly entry: Readonly<FileEntry>;
}

/** An explicit retain on one arena slot. Must be released in `finally`. */
export interface EntryLease {
  readonly version: EntryVersionToken;
  readonly entry: Readonly<FileEntry>;
  release(): void;
}

export type ReplacementDisposition = "unchanged" | "replaced";

/** What a worker's apply callback sees. Deliberately WITHOUT a token: workers
 *  never hold mutation authority, not even transitively through a result. */
export interface WorkerReplacementResult {
  readonly entry: OwnedEntryRef;
  readonly disposition: ReplacementDisposition;
}

export type WorkerLifecycleState =
  | "registered"
  | "running"
  | "result-returned"
  | "applying"
  | "discarding"
  | "resources-released"
  | "done";

export type OwnerTerminalState = "live" | "aborting" | "published" | "discarded";

export type WorkerIntakeState = "open" | "closed";

export function makeVersionToken(
  generationId: GenerationId,
  path: string,
  pathEpoch: number,
  slotId: SlotId,
): EntryVersionToken {
  return Object.freeze({ generationId, path, pathEpoch, slotId });
}

export function sameVersion(a: EntryVersionToken, b: EntryVersionToken): boolean {
  return a.generationId === b.generationId && a.path === b.path && a.pathEpoch === b.pathEpoch && a.slotId === b.slotId;
}

/** The owner capability's public face. A brand alone is not authority: the
 *  coordinator authenticates this object against an isolate-private registry. */
export interface GenerationOwnerLease {
  readonly ownerId: number;
}

export type AbortOutcome = "aborted" | "already-terminal";

export interface ReplaceInternedEntryArgs {
  owner: GenerationOwnerLease;
  token: GenerationMutationToken;
  path: string;
  expected: EntryVersionToken;
  next: Readonly<FileEntry>;
}

export interface ReplaceInternedEntryResult {
  token: GenerationMutationToken;
  entry: OwnedEntryRef;
  disposition: ReplacementDisposition;
}

/** The immutable DTO handed to a crypto worker — never the owner, never a token. */
export interface WorkerEntryRequest {
  readonly path: string;
  readonly expected: EntryVersionToken;
  readonly entry: Readonly<FileEntry>;
}
