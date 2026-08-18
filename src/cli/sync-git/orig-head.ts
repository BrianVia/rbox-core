/** Never: waiver eligibility/classification, journal/checkout commit, or state persistence. */
import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory } from "../../engine/fsutil.js";
import { hashBytes } from "../../engine/hash.js";
import { readRegularFileNoFollow, type RepoCtx } from "./git-state.js";
import { git } from "../../engine/git-spawn.js";
import { listRefs } from "./refs.js";

export interface OrigHeadBreadcrumbMismatch {
  rel: "ORIG_HEAD";
  live: string | null;
}

export interface OrigHeadPreservation {
  expectedOldBytes: Buffer | null;
  recoveryLocation: string;
  recoveryRef?: string;
  recoveryOid?: string;
  transactionLine?: string;
  discriminator?: string;
  malformedRawBytes?: true;
}

const ORIG_HEAD_FORENSIC_CAP = 64 * 1024;
const ORIG_HEAD_ERROR_MESSAGE_CAP = 512;
const ORIG_HEAD_REPO_DISPLAY_CAP = 512;

function boundedSingleLine(value: string, cap: number): string {
  const clean = value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim() || "unknown";
  const scalars = [...clean];
  return scalars.length <= cap ? clean : `${scalars.slice(0, cap - 1).join("")}…`;
}

function boundedOrigHeadForensics(bytes: Buffer): Buffer {
  if (bytes.length <= ORIG_HEAD_FORENSIC_CAP) return bytes;
  const marker = Buffer.from(`\n[rbox: ORIG_HEAD truncated from ${bytes.length} bytes at ${ORIG_HEAD_FORENSIC_CAP}-byte cap]\n`);
  return Buffer.concat([bytes.subarray(0, ORIG_HEAD_FORENSIC_CAP - marker.length), marker]);
}

/** One forensic log record: controls cannot forge lines, and hostile error text
 * cannot grow the daemon log without bound. */
export function boundedOrigHeadPreservationError(error: unknown): string {
  return boundedSingleLine(String((error as Error)?.message ?? error) || "unknown error", ORIG_HEAD_ERROR_MESSAGE_CAP);
}

export function origHeadPreservationFailureLine(relPath: string, error: unknown): string {
  const repo = boundedSingleLine(relPath, ORIG_HEAD_REPO_DISPLAY_CAP);
  return `git-sync: ORIG_HEAD preservation failed for ${repo}: ${boundedOrigHeadPreservationError(error)}`;
}

async function quarantineOrigHeadBytes(workspaceRoot: string, relPath: string, bytes: Buffer): Promise<string> {
  const repoDir = path.join(workspaceRoot, ".rbox", "git-quarantine", hashBytes(Buffer.from(relPath)).slice(0, 16));
  const createdDirectories = await ensureDirectoryChain(repoDir, "recovery directory");
  const dest = path.join(repoDir, `orig-head-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.bytes`);
  let handle: fs.FileHandle | undefined;
  let created = false;
  try {
    handle = await fs.open(dest, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    created = true;
    await handle.writeFile(boundedOrigHeadForensics(bytes));
    await handle.sync();
  } catch (error) {
    if (created) await fs.rm(dest, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  // The file entry always requires its parent's fsync. Newly created directory
  // entries then publish bottom-up through the first pre-existing ancestor.
  await fsyncDirectory(repoDir);
  await fsyncCreatedDirectoryAncestors(repoDir, createdDirectories);
  return dest;
}

export async function origHeadWorktreeDiscriminator(ctx: RepoCtx): Promise<string> {
  const [gitDirReal, commonDirReal] = await Promise.all([fs.realpath(ctx.gitDir), fs.realpath(ctx.commonDir)]);
  return gitDirReal === commonDirReal ? "primary" : `wt-${hashBytes(Buffer.from(gitDirReal)).slice(0, 12)}`;
}

export async function preserveOrigHead(
  opts: { workspaceRoot: string; relPath: string; ctx: RepoCtx },
  mismatch: OrigHeadBreadcrumbMismatch,
): Promise<OrigHeadPreservation> {
  const live = await readRegularFileNoFollow(path.join(opts.ctx.gitDir, "ORIG_HEAD"));
  const bytes = live?.bytes ?? null;
  if ((bytes === null ? null : hashBytes(bytes)) !== mismatch.live) throw new Error("ORIG_HEAD changed before preservation");
  if (bytes === null) return { expectedOldBytes: null, recoveryLocation: "no prior ORIG_HEAD value" };

  const oid = bytes.toString("utf8").trim();
  if (/^[0-9a-f]{40}$/.test(oid) && await git(opts.ctx.repoDir, ["cat-file", "-e", oid]).then(() => true, () => false)) {
    const discriminator = await origHeadWorktreeDiscriminator(opts.ctx);
    const recoveryRef = `refs/rbox-recovery/orig-head/${discriminator}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    return {
      expectedOldBytes: bytes,
      recoveryLocation: recoveryRef,
      recoveryRef,
      recoveryOid: oid,
      transactionLine: `create ${recoveryRef} ${oid}`,
      discriminator,
    };
  }

  const recoveryLocation = await quarantineOrigHeadBytes(opts.workspaceRoot, opts.relPath, bytes);
  return { expectedOldBytes: bytes, recoveryLocation, malformedRawBytes: true };
}

export async function pruneOrigHeadRecoveryRefs(repoDir: string, discriminator: string, currentRef: string): Promise<void> {
  const prefix = `refs/rbox-recovery/orig-head/${discriminator}`;
  const entries = (await listRefs(repoDir, prefix)).flatMap((ref) => {
    const match = /\/(\d+)-([0-9a-f]+)$/.exec(ref);
    return match ? [{ ref, timestamp: Number(match[1]) }] : [];
  }).sort((a, b) => a.timestamp - b.timestamp || a.ref.localeCompare(b.ref));
  let remove = Math.max(0, entries.length - 8);
  for (const entry of entries) {
    if (remove === 0) break;
    if (entry.ref === currentRef) continue;
    await git(repoDir, ["update-ref", "-d", entry.ref]);
    remove--;
  }
}
