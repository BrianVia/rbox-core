import { expect, test } from "bun:test";
import type { FileEntry } from "../types.js";
import { EntryArena, defaultFingerprint, sameEntryExact } from "./arena.js";
import { withCipherDescriptor } from "./cipher-descriptor.js";
import { EntryShapeError } from "./errors.js";

function entry(overrides: Partial<FileEntry> = {}): FileEntry {
  return { path: "a.txt", sha256: "aa", size: 3, mode: 0o644, mtimeMs: 1000, type: "file", ...overrides };
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
  expect((extended.entry as Record<string, unknown>).futureField).toBe(1);
  arena.release(plain);
  arena.release(extended);
});

test("composite extension values are refused at intern time", () => {
  const arena = new EntryArena();
  for (const value of [{ nested: 1 }, [1, 2], () => 1, Symbol("x"), null]) {
    expect(() => arena.internExact({ ...entry(), extension: value } as unknown as FileEntry)).toThrow(EntryShapeError);
  }
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

test("defaultFingerprint is stable across key order", () => {
  const a: Record<string, unknown> = { path: "a", sha256: "x", size: 1, mode: 0, mtimeMs: 0, type: "file" };
  const b: Record<string, unknown> = { type: "file", mtimeMs: 0, mode: 0, size: 1, sha256: "x", path: "a" };
  expect(defaultFingerprint(a as unknown as FileEntry)).toBe(defaultFingerprint(b as unknown as FileEntry));
});

test("withCipherDescriptor is pure and preserves extension members", () => {
  const source = Object.freeze({ ...entry(), futureField: "keep" }) as Readonly<FileEntry>;
  const next = withCipherDescriptor(source, { encSha: "ee", comp: "zstd", payloadSha: "pp", cipherSize: 20 });
  expect(next).not.toBe(source);
  expect(source.encSha).toBeUndefined();
  expect(next).toMatchObject({ encSha: "ee", comp: "zstd", payloadSha: "pp", cipherSize: 20 });
  expect((next as Record<string, unknown>).futureField).toBe("keep");
});

test("withCipherDescriptor drops comp, payloadSha and cipherSize together", () => {
  const compressed = withCipherDescriptor(entry(), { encSha: "ee", comp: "zstd", payloadSha: "pp", cipherSize: 20 });
  const plain = withCipherDescriptor(compressed, { encSha: "ff" });
  expect(plain.encSha).toBe("ff");
  expect("comp" in plain).toBe(false);
  expect("payloadSha" in plain).toBe(false);
  expect("cipherSize" in plain).toBe(false);
});
