import fs from "node:fs/promises";
import path from "node:path";
import { hashBytes } from "../hash.js";
import { isSafeRelPath } from "../manifest-validate.js";
import type { GitRepoKind, RepoCtx } from "./shared.js";

const HEX32 = /^[0-9a-f]{32}$/;
const DECIMAL_U64 = /^(?:0|[1-9][0-9]*)$/;
const U64_MAX = (1n << 64n) - 1n;

export interface RepoIdentityV1 {
  relPath: string;
  kind: GitRepoKind;
  worktreeId: string;
  gitDirReal: string;
  commonDirReal: string;
  dev: string;
  ino: string;
  birthtime: string;
}

export interface StateLineageV1 {
  workspaceRootReal: string;
  stream: string;
  stateNonce: string;
  repositoryIdentity: RepoIdentityV1;
}

export interface ArtifactBinding {
  lineageHash: string;
  repositoryIdentityHash: string;
}

function asciiField(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

function binaryField(bytes: Uint8Array): Buffer {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  return Buffer.concat([length, bytes]);
}

function validU64Decimal(value: string): boolean {
  if (!DECIMAL_U64.test(value)) return false;
  try { return BigInt(value) <= U64_MAX; } catch { return false; }
}

function requireAbsolute(label: string, value: string): void {
  if (!value || !path.isAbsolute(value) || value.includes("\0")) throw new Error(`invalid ${label}`);
}

export function validateRepoIdentityV1(value: RepoIdentityV1): void {
  if (!(value.relPath === "." || isSafeRelPath(value.relPath))) throw new Error("invalid repository record key");
  if (value.kind !== "dir" && value.kind !== "pointer") throw new Error("invalid repository kind");
  requireAbsolute("worktreeId", value.worktreeId);
  requireAbsolute("gitDirReal", value.gitDirReal);
  requireAbsolute("commonDirReal", value.commonDirReal);
  for (const field of [value.dev, value.ino, value.birthtime]) {
    if (!validU64Decimal(field)) throw new Error("invalid repository stat identity");
  }
}

export function encodeRepoIdentityV1(value: RepoIdentityV1): Uint8Array {
  validateRepoIdentityV1(value);
  return Buffer.concat([
    Buffer.from("rbox-repo-identity-v1\0", "ascii"),
    ...[
      value.relPath, value.kind, value.worktreeId, value.gitDirReal, value.commonDirReal,
      value.dev, value.ino, value.birthtime,
    ].map(asciiField),
  ]);
}

export function repositoryIdentityHash(value: RepoIdentityV1): string {
  return hashBytes(encodeRepoIdentityV1(value));
}

export async function readRepoIdentityV1(
  relPath: string,
  kind: GitRepoKind,
  binding: Pick<RepoIdentityV1, "worktreeId" | "gitDirReal" | "commonDirReal">,
): Promise<RepoIdentityV1> {
  const [worktreeId, gitDirReal, commonDirReal] = await Promise.all([
    fs.realpath(binding.worktreeId), fs.realpath(binding.gitDirReal), fs.realpath(binding.commonDirReal),
  ]);
  const stat = await fs.stat(commonDirReal, { bigint: true });
  const value: RepoIdentityV1 = {
    relPath, kind, worktreeId, gitDirReal, commonDirReal,
    dev: stat.dev.toString(), ino: stat.ino.toString(),
    birthtime: stat.birthtimeNs > 0n ? stat.birthtimeNs.toString() : "0",
  };
  validateRepoIdentityV1(value);
  return value;
}

export function encodeStateLineageV1(value: StateLineageV1): Uint8Array {
  requireAbsolute("workspaceRootReal", value.workspaceRootReal);
  if (!value.stream || value.stream.includes("\0")) throw new Error("invalid state stream");
  if (!HEX32.test(value.stateNonce)) throw new Error("invalid state nonce");
  const repoBytes = encodeRepoIdentityV1(value.repositoryIdentity);
  return Buffer.concat([
    Buffer.from("rbox-lineage-v1\0", "ascii"),
    asciiField(value.workspaceRootReal), asciiField(value.stream), asciiField(value.stateNonce), binaryField(repoBytes),
  ]);
}

export function lineageHash(value: StateLineageV1): string {
  return hashBytes(encodeStateLineageV1(value));
}

export async function readStateLineageV1(
  workspaceRoot: string,
  stream: string,
  stateNonce: string,
  repositoryIdentity: RepoIdentityV1,
): Promise<StateLineageV1> {
  const value = { workspaceRootReal: await fs.realpath(workspaceRoot), stream, stateNonce, repositoryIdentity };
  encodeStateLineageV1(value);
  return value;
}

export function artifactBinding(value: StateLineageV1): ArtifactBinding {
  return { lineageHash: lineageHash(value), repositoryIdentityHash: repositoryIdentityHash(value.repositoryIdentity) };
}

export function bindingForContext(lineage: StateLineageV1): ArtifactBinding { return artifactBinding(lineage); }

export async function repositoryIdentityForContext(relPath: string, ctx: RepoCtx, worktreeId: string): Promise<RepoIdentityV1> {
  return readRepoIdentityV1(relPath, ctx.kind, { worktreeId, gitDirReal: ctx.gitDir, commonDirReal: ctx.commonDir });
}
