import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";

export type UpgradeChannel = "latest" | "next";

const MAX_BYTES = 256;

export function parseUpgradeChannel(value: string | undefined): UpgradeChannel | undefined {
  if (value === undefined) return undefined;
  if (value === "latest" || value === "next") return value;
  throw new Error(`unknown upgrade channel ${JSON.stringify(value)} — expected latest or next`);
}

export const upgradeChannelPath = (executable: string): string => `${executable}.channel.json`;

export function upgradeManifestBase(remoteUrl: string, channel: UpgradeChannel): string {
  const base = remoteUrl.replace(/\/+$/, "");
  return channel === "latest" ? base : `${base}/next`;
}

function sameFile(
  a: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint },
  b: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint },
): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

export async function readUpgradeChannel(executable: string): Promise<UpgradeChannel> {
  const file = upgradeChannelPath(executable);
  let before: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    before = await fsp.lstat(file, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "latest";
    throw new Error("upgrade channel setting is unreadable", { cause: error });
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_BYTES)) {
    throw new Error("upgrade channel setting is malformed");
  }
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw new Error("upgrade channel setting is unreadable", { cause: error });
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error("upgrade channel setting changed while opening");
    const size = Number(opened.size);
    const bytes = Buffer.alloc(size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await fsp.lstat(file, { bigint: true });
    if (bytesRead !== size || !sameFile(opened, afterHandle) || !sameFile(afterHandle, afterPath)) {
      throw new Error("upgrade channel setting changed while reading");
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    } catch (error) {
      throw new Error("upgrade channel setting is malformed", { cause: error });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "channel,schema"
      || (value as { schema?: unknown }).schema !== 1) {
      throw new Error("upgrade channel setting is malformed");
    }
    const channel = parseUpgradeChannel((value as { channel?: unknown }).channel as string | undefined);
    if (channel === undefined) throw new Error("upgrade channel setting is malformed");
    return channel;
  } finally {
    await handle.close();
  }
}

export async function writeUpgradeChannel(executable: string, channel: UpgradeChannel): Promise<void> {
  const file = upgradeChannelPath(executable);
  await writeFileAtomic(file, `${JSON.stringify({ schema: 1, channel })}\n`, {
    mode: 0o644,
    exactMode: true,
  });
  await fsyncDirectory(path.dirname(file));
}
