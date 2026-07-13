import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  PACK_DIR_ENTRY_BYTES,
  PACK_FOOTER_BYTES,
  PACK_HEADER_BYTES,
  PACK_MAX_BODY_BYTES,
  PACK_MAX_MEMBER_BYTES,
  PACK_MAX_MEMBERS,
  encodePackDirectory,
  encodePackFooter,
  encodePackHeader,
  packOverheadBytes,
  parsePack,
  type PackDirEntry,
} from "./blob-pack.js";

const shaBytes = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const shaHex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function buildPack(lengths: number[]): { bytes: Uint8Array; entries: PackDirEntry[] } {
  let payloadBytes = 0;
  const entries = lengths.map((length, i) => {
    const member = new Uint8Array(length).fill(i & 0xff);
    const entry = { sha256: shaHex(member), offset: PACK_HEADER_BYTES + payloadBytes, length };
    payloadBytes += length;
    return entry;
  });
  // Make same-content members unique without coupling structural tests to hashing.
  for (let i = 0; i < entries.length; i++) entries[i]!.sha256 = i.toString(16).padStart(64, "0");
  const directory = encodePackDirectory(entries);
  const footer = encodePackFooter({
    count: entries.length,
    directoryOffset: PACK_HEADER_BYTES + payloadBytes,
    directoryBytes: directory.byteLength,
    directorySha256: shaBytes(directory),
  });
  const bytes = new Uint8Array(PACK_HEADER_BYTES + payloadBytes + directory.byteLength + footer.byteLength);
  bytes.set(encodePackHeader());
  let payloadOffset = PACK_HEADER_BYTES;
  for (let i = 0; i < lengths.length; i++) {
    bytes.fill(i & 0xff, payloadOffset, payloadOffset + lengths[i]!);
    payloadOffset += lengths[i]!;
  }
  bytes.set(directory, payloadOffset);
  bytes.set(footer, payloadOffset + directory.byteLength);
  return { bytes, entries };
}

function mutate(bytes: Uint8Array, edit: (copy: Uint8Array, dv: DataView, footerOffset: number) => void): Uint8Array {
  const copy = bytes.slice();
  edit(copy, new DataView(copy.buffer), copy.byteLength - PACK_FOOTER_BYTES);
  return copy;
}

describe("rbox-pack-v1 codec", () => {
  test("matches the pinned single-member golden encoding", () => {
    const entry = { sha256: "0".repeat(64), offset: 16, length: 1 };
    const directory = encodePackDirectory([entry]);
    expect(Buffer.from(encodePackHeader()).toString("hex")).toBe("52424f58504b30310000001000000000");
    expect(Buffer.from(directory).toString("hex")).toBe(`${"00".repeat(32)}00000000000000100000000000000001`);
    expect(Buffer.from(shaBytes(directory)).toString("hex")).toBe("1873d3b1b8a8ac7be479aac96e54baccd2bbb14896b7a26a3b48c517f084bc65");
    const footer = encodePackFooter({ count: 1, directoryOffset: 17, directoryBytes: 48, directorySha256: shaBytes(directory) });
    expect(Buffer.from(footer.subarray(0, 40)).toString("hex")).toBe(
      "52424f58454e44310000000100000030000000010000000000000000000000110000000000000030",
    );
  });

  test("round-trips canonical entries and exposes the directory hash claim", () => {
    const pack = buildPack([1, 17, PACK_MAX_MEMBER_BYTES]);
    const parsed = parsePack(pack.bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toEqual(pack.entries);
    expect(parsed.directorySha256).toEqual(shaBytes(parsed.directory));
    expect(packOverheadBytes(pack.entries.length)).toBe(PACK_HEADER_BYTES + 3 * PACK_DIR_ENTRY_BYTES + PACK_FOOTER_BYTES);
  });

  test("rejects empty and truncated bodies", () => {
    expect(parsePack(new Uint8Array()).error).toBe("truncated");
    expect(parsePack(new Uint8Array(PACK_HEADER_BYTES + PACK_FOOTER_BYTES - 1)).error).toBe("truncated");
  });

  test("rejects header/footer magic, header size, version, flags, reserved, and entry size", () => {
    const { bytes } = buildPack([1]);
    expect(parsePack(mutate(bytes, (b) => (b[0] ^= 1))).error).toBe("bad_magic");
    expect(parsePack(mutate(bytes, (b, _dv, footer) => (b[footer] ^= 1))).error).toBe("bad_magic");
    expect(parsePack(mutate(bytes, (_b, dv) => dv.setUint32(8, 15, false))).error).toBe("bad_header_bytes");
    expect(parsePack(mutate(bytes, (_b, dv) => dv.setUint32(12, 1, false))).error).toBe("bad_flags");
    expect(parsePack(mutate(bytes, (_b, dv, footer) => dv.setUint32(footer + 8, 2, false))).error).toBe("bad_version");
    expect(parsePack(mutate(bytes, (_b, dv, footer) => dv.setUint32(footer + 12, 47, false))).error).toBe("bad_entry_bytes");
    expect(parsePack(mutate(bytes, (_b, dv, footer) => dv.setUint32(footer + 20, 1, false))).error).toBe("bad_reserved");
  });

  test("enforces count bounds including valid count 1 and 2048", () => {
    const one = buildPack([1]);
    expect(parsePack(one.bytes).ok).toBe(true);
    expect(parsePack(mutate(one.bytes, (_b, dv, footer) => dv.setUint32(footer + 16, 0, false))).error).toBe("bad_count");
    expect(parsePack(mutate(one.bytes, (_b, dv, footer) => dv.setUint32(footer + 16, PACK_MAX_MEMBERS + 1, false))).error).toBe(
      "bad_count",
    );
    expect(parsePack(buildPack(new Array(PACK_MAX_MEMBERS).fill(1)).bytes).ok).toBe(true);
  });

  test("rejects unsafe u64 values in footer and directory", () => {
    const { bytes } = buildPack([1]);
    expect(parsePack(mutate(bytes, (_b, dv, footer) => dv.setBigUint64(footer + 24, BigInt(Number.MAX_SAFE_INTEGER) + 1n, false))).error).toBe(
      "integer_overflow",
    );
    const directoryOffset = PACK_HEADER_BYTES + 1;
    expect(parsePack(mutate(bytes, (_b, dv) => dv.setBigUint64(directoryOffset + 32, BigInt(Number.MAX_SAFE_INTEGER) + 1n, false))).error).toBe(
      "integer_overflow",
    );
  });

  test("rejects duplicate shas, descending offsets, gaps, and overlaps", () => {
    const { bytes } = buildPack([2, 2]);
    const directoryOffset = PACK_HEADER_BYTES + 4;
    expect(
      parsePack(
        mutate(bytes, (b) => b.copyWithin(directoryOffset + PACK_DIR_ENTRY_BYTES, directoryOffset, directoryOffset + 32)),
      ).error,
    ).toBe("duplicate_sha");
    expect(
      parsePack(mutate(bytes, (_b, dv) => dv.setBigUint64(directoryOffset + PACK_DIR_ENTRY_BYTES + 32, BigInt(PACK_HEADER_BYTES - 1), false))).error,
    ).toBe("bad_order");
    expect(parsePack(mutate(bytes, (_b, dv) => dv.setBigUint64(directoryOffset + PACK_DIR_ENTRY_BYTES + 32, 19n, false))).error).toBe(
      "not_contiguous",
    );
    expect(parsePack(mutate(bytes, (_b, dv) => dv.setBigUint64(directoryOffset + PACK_DIR_ENTRY_BYTES + 32, 17n, false))).error).toBe(
      "not_contiguous",
    );
  });

  test("rejects zero and oversized members", () => {
    const { bytes } = buildPack([1]);
    const directoryOffset = PACK_HEADER_BYTES + 1;
    expect(parsePack(mutate(bytes, (_b, dv) => dv.setBigUint64(directoryOffset + 40, 0n, false))).error).toBe("bad_length");
    expect(parsePack(mutate(bytes, (_b, dv) => dv.setBigUint64(directoryOffset + 40, BigInt(PACK_MAX_MEMBER_BYTES + 1), false))).error).toBe(
      "bad_length",
    );
  });

  test("rejects directory size and bounds mismatches", () => {
    const { bytes } = buildPack([1]);
    expect(parsePack(mutate(bytes, (_b, dv, footer) => dv.setBigUint64(footer + 32, 47n, false))).error).toBe("bad_directory_size");
    expect(parsePack(mutate(bytes, (_b, dv, footer) => dv.setBigUint64(footer + 24, BigInt(PACK_HEADER_BYTES), false))).error).toBe(
      "bad_directory_bounds",
    );
  });

  test("returns a mismatched claimed directory hash for caller rejection", () => {
    const { bytes } = buildPack([1]);
    const parsed = parsePack(mutate(bytes, (b, _dv, footer) => (b[footer + 40] ^= 1)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.directorySha256).not.toEqual(shaBytes(parsed.directory));
  });

  test("parses exact 8 MiB and 8 MiB+1 structural bodies; the caller owns the cap", () => {
    const count = 32;
    const payloadAtCap = PACK_MAX_BODY_BYTES - packOverheadBytes(count);
    const lengths = new Array(count).fill(Math.floor(payloadAtCap / count)) as number[];
    lengths[0]! += payloadAtCap - lengths.reduce((sum, n) => sum + n, 0);
    const exact = buildPack(lengths).bytes;
    expect(exact.byteLength).toBe(PACK_MAX_BODY_BYTES);
    expect(parsePack(exact).ok).toBe(true);
    lengths[0]! += 1;
    const over = buildPack(lengths).bytes;
    expect(over.byteLength).toBe(PACK_MAX_BODY_BYTES + 1);
    expect(parsePack(over).ok).toBe(true);
  });
});
