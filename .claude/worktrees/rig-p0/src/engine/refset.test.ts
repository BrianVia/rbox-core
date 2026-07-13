import { describe, expect, test } from "bun:test";
import { parseRefset, refsetByteLength, serializeRefset, REFSET_HEADER, REFSET_MAGIC, REFSET_REC, type Ref } from "./refset.js";

const sha = (b: string) => b.repeat(64).slice(0, 64);
const A = sha("a"); // "aaaa…"
const B = sha("b");
const C = sha("c");

describe("refset codec (§24.1)", () => {
  test("round-trips a unique set, returned in canonical (sorted) order", () => {
    const refs: Ref[] = [
      { encSha: C, size: 3 },
      { encSha: A, size: 1 },
      { encSha: B, size: 2 },
    ];
    const bytes = serializeRefset(refs);
    expect(bytes.length).toBe(refsetByteLength(3));
    expect(refsetByteLength(3)).toBe(REFSET_HEADER + REFSET_REC * 3);
    const parsed = parseRefset(bytes);
    expect(parsed).toEqual([
      { encSha: A, size: 1 },
      { encSha: B, size: 2 },
      { encSha: C, size: 3 },
    ]);
  });

  test("parses a subarray VIEW (nonzero byteOffset) into a larger buffer", () => {
    // Locks the `new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)` contract — a
    // naive `new DataView(bytes.buffer)` would read from offset 0 and corrupt every field.
    const bytes = serializeRefset([{ encSha: A, size: 1 }, { encSha: B, size: 2 }]);
    const big = new Uint8Array(bytes.length + 11);
    big.set(bytes, 7);
    const view = big.subarray(7, 7 + bytes.length); // byteOffset = 7
    expect(view.byteOffset).toBe(7);
    expect(parseRefset(view)).toEqual([{ encSha: A, size: 1 }, { encSha: B, size: 2 }]);
  });

  test("deterministic: input order does not change the bytes (dedupable blob)", () => {
    const x = serializeRefset([
      { encSha: B, size: 9 },
      { encSha: A, size: 7 },
    ]);
    const y = serializeRefset([
      { encSha: A, size: 7 },
      { encSha: B, size: 9 },
    ]);
    expect(Buffer.from(x).equals(Buffer.from(y))).toBe(true);
  });

  test("magic + u32be count header is exactly as locked", () => {
    const bytes = serializeRefset([{ encSha: A, size: 1 }]);
    expect(new TextDecoder().decode(bytes.slice(0, 14))).toBe(REFSET_MAGIC);
    const dv = new DataView(bytes.buffer);
    expect(dv.getUint32(14, false)).toBe(1);
  });

  test("empty set encodes to a bare header and parses to []", () => {
    const bytes = serializeRefset([]);
    expect(bytes.length).toBe(REFSET_HEADER);
    expect(parseRefset(bytes)).toEqual([]);
  });

  test("round-trips a large (>2^32) size via u64be", () => {
    const big = 5_000_000_000; // > u32 max, still a safe int
    expect(parseRefset(serializeRefset([{ encSha: A, size: big }]))).toEqual([{ encSha: A, size: big }]);
  });

  test("serialize rejects duplicate sha + malformed inputs", () => {
    expect(() => serializeRefset([{ encSha: A, size: 1 }, { encSha: A, size: 1 }])).toThrow(/duplicate/);
    expect(() => serializeRefset([{ encSha: "xyz", size: 1 }])).toThrow(/malformed/);
    expect(() => serializeRefset([{ encSha: A, size: -1 }])).toThrow(/bad size/);
  });

  describe("parse fails CLOSED on malleable / corrupt bytes", () => {
    const good = serializeRefset([{ encSha: A, size: 1 }, { encSha: B, size: 2 }]);

    test("bad magic", () => {
      const b = good.slice();
      b[0] = 0x00;
      expect(() => parseRefset(b)).toThrow(/magic/);
    });
    test("trailing bytes (length != 18 + 40·count)", () => {
      const b = new Uint8Array(good.length + 1);
      b.set(good);
      expect(() => parseRefset(b)).toThrow(/length mismatch/);
    });
    test("truncated record", () => {
      expect(() => parseRefset(good.slice(0, good.length - 1))).toThrow(/length mismatch/);
    });
    test("count larger than the bytes provide (no over-allocation)", () => {
      const b = good.slice();
      new DataView(b.buffer).setUint32(14, 1000, false);
      expect(() => parseRefset(b)).toThrow(/length mismatch/);
    });
    test("unsorted / duplicate sha order", () => {
      // hand-build two records out of ascending order: B then A
      const bytes = new Uint8Array(refsetByteLength(2));
      bytes.set(new TextEncoder().encode(REFSET_MAGIC), 0);
      const dv = new DataView(bytes.buffer);
      dv.setUint32(14, 2, false);
      const hex = (h: string, off: number) => { for (let i = 0; i < 32; i++) bytes[off + i] = parseInt(h.substr(i * 2, 2), 16); };
      hex(B, REFSET_HEADER);
      hex(A, REFSET_HEADER + REFSET_REC);
      expect(() => parseRefset(bytes)).toThrow(/ascending|duplicate/);
    });
    test("size exceeding the safe-integer range", () => {
      const b = serializeRefset([{ encSha: A, size: 1 }]);
      new DataView(b.buffer).setBigUint64(REFSET_HEADER + 32, BigInt(Number.MAX_SAFE_INTEGER) + 1n, false);
      expect(() => parseRefset(b)).toThrow(/safe integer/);
    });
  });
});
