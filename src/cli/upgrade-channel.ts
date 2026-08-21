import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";
import { jsonObject, jsonText, type JsonValue } from "../json.js";
import type { Manifest } from "./release-verify.js";
import { semverGt } from "./semver.js";

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

export interface ResolvedUpgradeChannel {
  /** Channel whose manifest we adopted. */
  channel: UpgradeChannel;
  /** Verified manifest of the adopted channel. */
  manifest: Manifest;
  /** Persisted next was superseded by a newer stable. */
  supersedesNext: boolean;
  /** Stable could not be fetched or verified, so persisted next was kept. */
  stableUnavailable: boolean;
  /** Version on next when a newer stable superseded it. */
  supersededNextVersion?: string;
}

interface ResolveUpgradeChannelArgs {
  remoteUrl: string;
  requested: UpgradeChannel | undefined;
  persisted: UpgradeChannel;
  fetchBytes: (url: string) => Promise<Uint8Array>;
  verifyManifest: (manifest: Uint8Array, sig: Uint8Array) => Manifest;
}

async function fetchManifest(
  base: string,
  fetchBytes: ResolveUpgradeChannelArgs["fetchBytes"],
  verifyManifest: ResolveUpgradeChannelArgs["verifyManifest"],
): Promise<Manifest> {
  const [manifest, signature] = await Promise.all([
    fetchBytes(`${base}/version`),
    fetchBytes(`${base}/version.sig`),
  ]);
  return verifyManifest(manifest, signature);
}

export async function resolveUpgradeChannel(args: ResolveUpgradeChannelArgs): Promise<ResolvedUpgradeChannel> {
  const selected = args.requested ?? args.persisted;
  if (args.requested !== undefined || selected === "latest") {
    const manifest = await fetchManifest(
      upgradeManifestBase(args.remoteUrl, selected),
      args.fetchBytes,
      args.verifyManifest,
    );
    return { channel: selected, manifest, supersedesNext: false, stableUnavailable: false };
  }

  const [next, stable] = await Promise.allSettled([
    fetchManifest(upgradeManifestBase(args.remoteUrl, "next"), args.fetchBytes, args.verifyManifest),
    fetchManifest(upgradeManifestBase(args.remoteUrl, "latest"), args.fetchBytes, args.verifyManifest),
  ]);
  if (next.status === "rejected") throw next.reason;
  if (stable.status === "rejected") {
    return { channel: "next", manifest: next.value, supersedesNext: false, stableUnavailable: true };
  }
  if (semverGt(stable.value.version, next.value.version)) {
    return {
      channel: "latest",
      manifest: stable.value,
      supersedesNext: true,
      stableUnavailable: false,
      supersededNextVersion: next.value.version,
    };
  }
  return { channel: "next", manifest: next.value, supersedesNext: false, stableUnavailable: false };
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
    let value: JsonValue;
    try {
      value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    } catch (error) {
      throw new Error("upgrade channel setting is malformed", { cause: error });
    }
    if (!jsonObject(value)
      || Object.keys(value).sort().join(",") !== "channel,schema"
      || value.schema !== 1) {
      throw new Error("upgrade channel setting is malformed");
    }
    const channel = parseUpgradeChannel(jsonText(value.channel) ? value.channel : undefined);
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
