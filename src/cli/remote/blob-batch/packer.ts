import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PACK_HEADER_BYTES,
  PACK_MAX_BODY_BYTES,
  PACK_MAX_MEMBER_BYTES,
  PACK_MAX_MEMBERS,
  encodePackDirectory,
  encodePackFooter,
  encodePackHeader,
  packOverheadBytes,
  type PackDirEntry,
} from "../../../engine/blob-pack.js";

export interface PackBuildMember {
  sha: string;
  size: number;
  srcPath: string;
  uploadsDir?: string;
}

export interface BuiltPack {
  path: string;
  packSha256: string;
  entries: PackDirEntry[];
  totalBytes: number;
}

async function writeAll(
  file: fsp.FileHandle,
  bytes: Uint8Array,
  position: number,
  hash: ReturnType<typeof createHash>,
): Promise<number> {
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await file.write(bytes, written, bytes.byteLength - written, position + written);
    if (result.bytesWritten < 1) throw new Error("blob-pack: temp file write made no progress");
    written += result.bytesWritten;
  }
  hash.update(bytes);
  return position + written;
}

/** Build an rbox-pack-v1 body without retaining member payloads in heap. */
export async function buildPack(members: PackBuildMember[]): Promise<BuiltPack> {
  if (members.length < 1 || members.length > PACK_MAX_MEMBERS) throw new Error("blob-pack: bad member count");
  let payloadBytes = 0;
  for (const member of members) {
    if (!Number.isInteger(member.size) || member.size < 1 || member.size > PACK_MAX_MEMBER_BYTES) {
      throw new Error("blob-pack: bad member size");
    }
    payloadBytes += member.size;
  }
  const totalBytes = payloadBytes + packOverheadBytes(members.length);
  if (totalBytes > PACK_MAX_BODY_BYTES) throw new Error("blob-pack: body exceeds hard cap");

  const dir = members[0]!.uploadsDir ?? os.tmpdir();
  await fsp.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `pack-${randomBytes(12).toString("hex")}.tmp`);
  const file = await fsp.open(tempPath, "wx", 0o600);
  const hash = createHash("sha256");
  const entries: PackDirEntry[] = [];
  let position = 0;
  try {
    position = await writeAll(file, encodePackHeader(), position, hash);
    for (const member of members) {
      const offset = position;
      let actual = 0;
      for await (const chunk of fs.createReadStream(member.srcPath)) {
        const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
        actual += bytes.byteLength;
        if (actual > member.size) throw new Error("blob-pack: member grew while packing");
        position = await writeAll(file, bytes, position, hash);
      }
      if (actual !== member.size) throw new Error("blob-pack: member size changed while packing");
      entries.push({ sha256: member.sha, offset, length: actual });
    }

    if (position !== PACK_HEADER_BYTES + payloadBytes) throw new Error("blob-pack: payload size mismatch");
    const directory = encodePackDirectory(entries);
    const directorySha256 = createHash("sha256").update(directory).digest();
    const directoryOffset = position;
    position = await writeAll(file, directory, position, hash);
    const footer = encodePackFooter({
      count: entries.length,
      directoryOffset,
      directoryBytes: directory.byteLength,
      directorySha256,
    });
    position = await writeAll(file, footer, position, hash);
    if (position !== totalBytes) throw new Error("blob-pack: encoded size mismatch");
    await file.sync();
    await file.close();
    return { path: tempPath, packSha256: hash.digest("hex"), entries, totalBytes };
  } catch (error) {
    await file.close().catch(() => {});
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
