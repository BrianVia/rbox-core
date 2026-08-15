import { expect, test } from "bun:test";
import type { JsonValue } from "../../json.js";
import type { FileEntry } from "../types.js";
import { EntryArena, MAX_EXTENSION_DEPTH, canonicalEntryKey, defaultFingerprint, sameEntryExact } from "./arena.js";
import { withCipherDescriptor } from "./cipher-descriptor.js";
import { EntryStructureError } from "./errors.js";

function entry(overrides: Partial<FileEntry> = {}): FileEntry {
  return { path: "a.txt", sha256: "aa", size: 3, mode: 0o644, mtimeMs: 1000, type: "file", ...overrides };
}

interface FutureFileEntry extends FileEntry { futureField: string | number; }
interface ExtrasFileEntry<T> extends FileEntry { extras: T; }
interface CyclicFixture { self?: CyclicFixture; }

/** An entry carrying an extension member the wire may add later. `ExtrasFileEntry`
 * extends `FileEntry`, so fixtures reach the arena as the type they really are. */
function entryWithExtras<T>(extras: T): ExtrasFileEntry<T> {
  return { ...entry(), extras };
}

test("internExact returns one shared frozen object for identical field sets", () => {
  const arena = new EntryArena();
  const first = arena.internExact(entry());
  const second = arena.internExact(entry());
  expect(second).toBe(first);
  expect(Object.is(second.entry, first.entry)).toBe(true);
  expect(Object.isFrozen(first.entry)).toBe(true);
  expect(arena.stats()).toMatchObject({ liveSlots: 1, retains: 2 });
  arena.release(first);
  arena.release(second);
  expect(arena.stats().liveSlots).toBe(0);
});

test("interning copies the caller's object so a later caller mutation cannot alias a slot", () => {
  const arena = new EntryArena();
  const source = entry();
  const slot = arena.internExact(source);
  expect(slot.entry).not.toBe(source);
  source.size = 99;
  expect(slot.entry.size).toBe(3);
  arena.release(slot);
});

test("published entries reject in-place mutation", () => {
  const arena = new EntryArena();
  const slot = arena.internExact(entry());
  expect(() => {
    (slot.entry as FileEntry).size = 7;
  }).toThrow();
  arena.release(slot);
});

test("every field participates in interning identity", () => {
  const arena = new EntryArena();
  const base = arena.internExact(entry());
  const variants: Array<Partial<FileEntry>> = [
    { path: "b.txt" },
    { sha256: "bb" },
    { size: 4 },
    { mode: 0o755 },
    { mtimeMs: 1001 },
    { type: "symlink" },
    { symlinkTarget: "x" },
    { encSha: "cc" },
    { comp: "zstd" },
    { payloadSha: "dd" },
    { cipherSize: 12 },
  ];
  for (const variant of variants) {
    const slot = arena.internExact(entry(variant));
    expect(slot).not.toBe(base);
    arena.release(slot);
  }
  arena.release(base);
  expect(arena.stats().liveSlots).toBe(0);
});

test("optional-field PRESENCE distinguishes even when the value is undefined", () => {
  const arena = new EntryArena();
  const absent = arena.internExact(entry());
  const presentUndefined = arena.internExact({ ...entry(), payloadSha: undefined });
  expect(presentUndefined).not.toBe(absent);
  expect(sameEntryExact(absent.entry, presentUndefined.entry)).toBe(false);
  arena.release(absent);
  arena.release(presentUndefined);
});

test("extension members participate in exact interning", () => {
  const arena = new EntryArena();
  const plain = arena.internExact(entry());
  const extended = arena.internExact({ ...entry(), futureField: 1 } as FileEntry);
  expect(extended).not.toBe(plain);
  expect((extended.entry as FutureFileEntry).futureField).toBe(1);
  arena.release(plain);
  arena.release(extended);
});

test("REGRESSION (r2 finding 7): structurally equal extras intern together regardless of key order", () => {
  const arena = new EntryArena();
  const first = arena.internExact(entryWithExtras({ b: [1, { z: 1, y: 2 }], a: "x" }));
  const second = arena.internExact(entryWithExtras({ a: "x", b: [1, { y: 2, z: 1 }] }));
  expect(second).toBe(first);
  expect(Object.is(second.entry, first.entry)).toBe(true);
  arena.release(first);
  arena.release(second);
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
});

test("REGRESSION (r2 finding 7): absent, null, {} and [] extras are four distinct values", () => {
  const arena = new EntryArena();
  const slots = [
    arena.internExact(entry()),
    arena.internExact(entryWithExtras(null)),
    arena.internExact(entryWithExtras(undefined)),
    arena.internExact(entryWithExtras({})),
    arena.internExact(entryWithExtras([])),
  ];
  expect(new Set(slots.map((slot) => slot.id)).size).toBe(5);
  expect(arena.stats().liveSlots).toBe(5);
  for (const slot of slots) arena.release(slot);
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
});

test("REGRESSION (r2 finding 7): the arena deep-copies and deep-freezes extras", () => {
  const arena = new EntryArena();
  const extras = { nested: { list: [1, 2] } };
  const slot = arena.internExact(entryWithExtras(extras));
  const interned = (slot.entry as ExtrasFileEntry<{ nested: { list: number[] } }>).extras;
  expect(interned).not.toBe(extras);
  extras.nested.list.push(3);
  extras.nested = { list: [9] };
  expect(interned.nested.list).toEqual([1, 2]);
  expect(Object.isFrozen(interned)).toBe(true);
  expect(Object.isFrozen(interned.nested)).toBe(true);
  expect(Object.isFrozen(interned.nested.list)).toBe(true);
  expect(() => interned.nested.list.push(4)).toThrow();
  arena.release(slot);
});

test("values JSON cannot produce, and unbounded nesting, are refused", () => {
  const arena = new EntryArena();
  for (const value of [() => 1, Symbol("x"), 1n]) {
    expect(() => arena.internExact(entryWithExtras(value))).toThrow(EntryStructureError);
  }
  let deep: JsonValue = 1;
  for (let i = 0; i <= MAX_EXTENSION_DEPTH + 1; i++) deep = { deep };
  expect(() => arena.internExact(entryWithExtras(deep))).toThrow(EntryStructureError);
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
});

test("fingerprint collisions fall back to a full field comparison", () => {
  const arena = new EntryArena({ fingerprint: () => "same" });
  const a = arena.internExact(entry({ path: "a.txt" }));
  const b = arena.internExact(entry({ path: "b.txt" }));
  const aAgain = arena.internExact(entry({ path: "a.txt" }));
  expect(b).not.toBe(a);
  expect(aAgain).toBe(a);
  expect(arena.stats().collisionBuckets).toBe(1);
  arena.release(a);
  arena.release(aAgain);
  expect(arena.stats().collisionBuckets).toBe(0);
  expect(arena.stats().liveSlots).toBe(1);
  arena.release(b);
  expect(arena.stats().liveSlots).toBe(0);
});

test("a collision bucket never owns an extra retain", () => {
  const arena = new EntryArena({ fingerprint: () => "same" });
  const a = arena.internExact(entry({ path: "a.txt" }));
  const b = arena.internExact(entry({ path: "b.txt" }));
  expect(arena.retainsOf(a)).toBe(1);
  expect(arena.retainsOf(b)).toBe(1);
  arena.release(a);
  expect(arena.hasSlot(a.id)).toBe(false);
  arena.release(b);
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0, collisionBuckets: 0 });
});

test("slot ids are monotonic and never reused", () => {
  const arena = new EntryArena();
  const first = arena.internExact(entry());
  const firstId = first.id;
  arena.release(first);
  const recycled = arena.internExact(entry());
  expect(recycled.id).toBeGreaterThan(firstId);
  arena.release(recycled);
});

test("the canonical key and its fingerprint are stable across key order", () => {
  const a: FileEntry = { path: "a", sha256: "x", size: 1, mode: 0, mtimeMs: 0, type: "file" };
  const b: FileEntry = { type: "file", mtimeMs: 0, mode: 0, size: 1, sha256: "x", path: "a" };
  const keyA = canonicalEntryKey(a);
  expect(keyA).toBe(canonicalEntryKey(b));
  expect(defaultFingerprint(keyA)).toBe(defaultFingerprint(canonicalEntryKey(b)));
});

test("withCipherDescriptor is pure and preserves extension members", () => {
  const source = Object.freeze({ ...entry(), futureField: "keep" }) as Readonly<FileEntry>;
  const next = withCipherDescriptor(source, { encSha: "ee", comp: "zstd", payloadSha: "pp", cipherSize: 20 });
  expect(next).not.toBe(source);
  expect(source.encSha).toBeUndefined();
  expect(next).toMatchObject({ encSha: "ee", comp: "zstd", payloadSha: "pp", cipherSize: 20 });
  expect((next as FutureFileEntry).futureField).toBe("keep");
});

test("withCipherDescriptor drops comp, payloadSha and cipherSize together", () => {
  const compressed = withCipherDescriptor(entry(), { encSha: "ee", comp: "zstd", payloadSha: "pp", cipherSize: 20 });
  const plain = withCipherDescriptor(compressed, { encSha: "ff" });
  expect(plain.encSha).toBe("ff");
  expect("comp" in plain).toBe(false);
  expect("payloadSha" in plain).toBe(false);
  expect("cipherSize" in plain).toBe(false);
});

test("REGRESSION (r3 finding 3): an own '__proto__' member survives interning", () => {
  const arena = new EntryArena();
  const source: FileEntry = { ...entry() };
  Object.defineProperty(source, "__proto__", { value: { a: 1 }, enumerable: true, writable: true, configurable: true });
  const slot = arena.internExact(source);
  expect(Object.keys(slot.entry)).toContain("__proto__");
  expect(Object.getPrototypeOf(slot.entry)).toBeNull();
  expect(sameEntryExact(slot.entry, source)).toBe(true);
  // It is a real member, so it distinguishes just like any other extension.
  const without = arena.internExact(entry());
  expect(without).not.toBe(slot);
  arena.release(slot);
  arena.release(without);
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
});

test("REGRESSION (r3 finding 3): a changing accessor cannot diverge the key from the stored entry", () => {
  const arena = new EntryArena();
  let reads = 0;
  const shifty: FileEntry = {
    ...entry(),
    get size(): number {
      return ++reads === 1 ? 1 : 999;
    },
  };
  const slot = arena.internExact(shifty);
  expect(slot.entry.size).toBe(1);
  // The slot really is keyed under what it stores: an equal plain entry shares it.
  const plain = arena.internExact(entry({ size: 1 }));
  expect(plain).toBe(slot);
  expect(canonicalEntryKey(slot.entry)).toBe(canonicalEntryKey(entry({ size: 1 })));
  arena.release(slot);
  arena.release(plain);
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
});

test("REGRESSION (r3 finding 3): cyclic extras hit the depth bound, never a stack overflow", () => {
  const arena = new EntryArena();
  const cyclic: CyclicFixture = {};
  cyclic.self = cyclic;
  expect(() => arena.internExact(entryWithExtras(cyclic))).toThrow(EntryStructureError);

  // Shallow-then-cyclic accessor: the single read wins, so the arena stores the
  // shallow value and the later cyclic one is never reachable.
  let reads = 0;
  const shallowThenCyclic: ExtrasFileEntry<unknown> = {
    ...entry(),
    get extras(): unknown {
      return reads++ === 0 ? { ok: 1 } : cyclic;
    },
  };
  const slot = arena.internExact(shallowThenCyclic);
  expect((slot.entry as ExtrasFileEntry<unknown>).extras).toEqual({ ok: 1 });
  expect(canonicalEntryKey(slot.entry)).toBe(canonicalEntryKey(entryWithExtras({ ok: 1 })));
  arena.release(slot);
  expect(arena.stats()).toMatchObject({ liveSlots: 0, retains: 0 });
});
