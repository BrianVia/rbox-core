/**
 * Workspace-scoped, explicitly leased interning arena for `FileEntry` values
 * (design 163 § "Early U0"). There is no immortal process-global map: every
 * live slot carries at least one retain, and the last release removes both the
 * slot and its fingerprint-bucket link in the same synchronous operation.
 *
 * Interning equality is EXACT — every field, every optional-field presence, and
 * every preserved extension member, compared by CANONICAL VALUE. Extension
 * members are authoritative arbitrary JSON (design 163 § extras_cjson), so
 * absent / `null` / `{}` / `[]` are four distinct values and key order is not
 * significant.
 *
 * The caller's entry is SNAPSHOT EXACTLY ONCE into null-prototype, frozen,
 * data-property objects. Canonicalization, the depth bound, equality, and the
 * stored entry all read that one snapshot, so an accessor cannot make a slot's
 * key disagree with the entry stored under it, and an own `__proto__` member
 * survives the copy like any other key.
 *
 * `sameContent` (diff.ts) remains a different comparison and still ignores
 * `mtimeMs`.
 */
import type { FileEntry } from "../types.js";
import { EntryShapeError } from "./errors.js";
import type { SlotId } from "./tokens.js";

export interface ArenaSlot {
  readonly id: SlotId;
  readonly entry: Readonly<FileEntry>;
  readonly fingerprint: string;
}

interface SlotRecord {
  readonly id: SlotId;
  readonly entry: Readonly<FileEntry>;
  readonly fingerprint: string;
  readonly canonical: string;
  retains: number;
}

export interface ArenaStats {
  /** Slots currently present (every one of them has ≥1 retain). */
  liveSlots: number;
  /** Sum of all retains held across all slots. */
  retains: number;
  /** Fingerprint buckets holding more than one slot. */
  collisionBuckets: number;
  /** Estimated retained metadata bytes — advisory, for the U4 cap. */
  estimatedBytes: number;
}

export interface EntryArenaOptions {
  /** Fingerprint of an entry's canonical form. Overridden only by tests, to
   *  force collision buckets and exercise the full-value fallback comparison. */
  fingerprint?: (canonical: string) => string;
}

/** Nesting bound for extension members. Manifest extras are decoded JSON, which
 *  is acyclic and shallow in practice; the bound turns a pathological or cyclic
 *  input into a loud `EntryShapeError` instead of a stack overflow. */
export const MAX_EXTENSION_DEPTH = 32;

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  // Assignment would route an own `__proto__` key through the prototype setter
  // and silently drop a valid decoded-JSON member.
  Object.defineProperty(target, key, { value, enumerable: true, writable: false, configurable: false });
}

/** Reads each source value EXACTLY once and returns a frozen, null-prototype
 *  deep copy. Every later step reads this result, never the caller's object. */
function snapshotValue(value: unknown, path: string, depth: number): unknown {
  if (depth > MAX_EXTENSION_DEPTH) throw new EntryShapeError(path, `nested deeper than ${MAX_EXTENSION_DEPTH}`);
  if (value === null) return null;
  const kind = typeof value;
  if (kind !== "object") {
    if (kind === "string" || kind === "number" || kind === "boolean" || kind === "undefined") return value;
    throw new EntryShapeError(path, `${kind} is not representable in a manifest`);
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item, index) => snapshotValue(item, `${path}[${index}]`, depth + 1)));
  }
  const source = value as Record<string, unknown>;
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source)) defineOwn(copy, key, snapshotValue(source[key], `${path}.${key}`, depth + 1));
  return Object.freeze(copy);
}

function canonicalOf(value: unknown): string {
  if (value === undefined) return "u";
  if (value === null) return "z";
  switch (typeof value) {
    case "string":
      return `s${JSON.stringify(value)}`;
    case "number":
      return `n${Object.is(value, -0) ? "-0" : String(value)}`;
    case "boolean":
      return value ? "b1" : "b0";
    default:
      break;
  }
  if (Array.isArray(value)) return `a[${value.map(canonicalOf).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `o{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalOf(record[key])}`)
    .join(",")}}`;
}

export interface InternedSnapshot {
  /** The arena's own immutable entry — this exact object is what gets stored. */
  entry: Readonly<FileEntry>;
  /** Order-independent total serialization of that same object. */
  canonical: string;
}

export function snapshotEntry(entry: Readonly<FileEntry>): InternedSnapshot {
  const snapshot = snapshotValue(entry, "", 0) as Readonly<FileEntry>;
  return { entry: snapshot, canonical: canonicalOf(snapshot) };
}

export function canonicalEntryKey(entry: Readonly<FileEntry>): string {
  return snapshotEntry(entry).canonical;
}

export function sameEntryExact(a: Readonly<FileEntry>, b: Readonly<FileEntry>): boolean {
  return canonicalEntryKey(a) === canonicalEntryKey(b);
}

export function defaultFingerprint(canonical: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export class EntryArena {
  private readonly slots = new Map<SlotId, SlotRecord>();
  private readonly buckets = new Map<string, SlotRecord[]>();
  private readonly fingerprintOf: (canonical: string) => string;
  /** Monotonic and never reused for the arena's lifetime — the ABA guard. */
  private nextSlotId = 1;
  private nextGenerationId = 1;

  constructor(options: EntryArenaOptions = {}) {
    this.fingerprintOf = options.fingerprint ?? defaultFingerprint;
  }

  allocateGenerationId(): number {
    return this.nextGenerationId++;
  }

  /**
   * Intern by exact canonical value AND take one retain on the result. The
   * retain is the caller's provisional lease: hand it to a generation or
   * release it in `finally`. There is deliberately no way to observe a
   * zero-retain slot.
   */
  internExact(entry: Readonly<FileEntry>): ArenaSlot {
    const { entry: snapshot, canonical } = snapshotEntry(entry);
    const fingerprint = this.fingerprintOf(canonical);
    const bucket = this.buckets.get(fingerprint);
    if (bucket) {
      for (const candidate of bucket) {
        if (candidate.canonical === canonical) {
          candidate.retains++;
          return candidate;
        }
      }
    }
    const record: SlotRecord = { id: this.nextSlotId++, entry: snapshot, fingerprint, canonical, retains: 1 };
    this.slots.set(record.id, record);
    if (bucket) bucket.push(record);
    else this.buckets.set(fingerprint, [record]);
    return record;
  }

  retain(slot: ArenaSlot): void {
    this.requireLive(slot).retains++;
  }

  release(slot: ArenaSlot): void {
    const record = this.requireLive(slot);
    record.retains--;
    if (record.retains > 0) return;
    this.slots.delete(record.id);
    const bucket = this.buckets.get(record.fingerprint);
    if (!bucket) return;
    const index = bucket.indexOf(record);
    if (index >= 0) bucket.splice(index, 1);
    if (bucket.length === 0) this.buckets.delete(record.fingerprint);
  }

  retainsOf(slot: ArenaSlot): number {
    return this.slots.get(slot.id)?.retains ?? 0;
  }

  hasSlot(slotId: SlotId): boolean {
    return this.slots.has(slotId);
  }

  stats(): ArenaStats {
    let retains = 0;
    let estimatedBytes = 0;
    for (const record of this.slots.values()) {
      retains += record.retains;
      estimatedBytes += 64 + record.canonical.length * 2;
    }
    let collisionBuckets = 0;
    for (const bucket of this.buckets.values()) if (bucket.length > 1) collisionBuckets++;
    return { liveSlots: this.slots.size, retains, collisionBuckets, estimatedBytes };
  }

  private requireLive(slot: ArenaSlot): SlotRecord {
    const record = this.slots.get(slot.id);
    if (!record || record !== slot) throw new Error(`arena slot ${slot.id} is not live`);
    return record;
  }
}
