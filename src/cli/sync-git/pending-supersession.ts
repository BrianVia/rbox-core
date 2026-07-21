import fs from "node:fs/promises";
import path from "node:path";
import {
  gitIdentity,
  gitPreflight,
  indexIdentityV2,
  isGitBusy,
  validateGitSection,
  type BlobStore,
  type GitSection,
  type JournalRecoveryResult,
} from "../../engine/index.js";
import { getGitArtifact, git, type RepoCtx } from "../../engine/git/shared.js";
import { validateCanonicalGitConfig } from "../../engine/git/config-sync.js";
import { gitFingerprint, gitFingerprintRun } from "./fingerprint.js";
import { sectionOpState } from "./shared.js";

export const gitPendingSupersedeEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.RBOX_GIT_PENDING_SUPERSEDE !== "0";

export function journalAllowsPendingSupersession(status: JournalRecoveryResult["status"]): boolean {
  switch (status) {
    case "none":
    case "rolled-back":
    case "keep": // recoverAndLandFollowJournal has already landed the intended record.
    case "binding-mismatch":
      return true;
    case "defer":
    case "human-intervened":
    case "fresh-quarantined":
      return false;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export type PendingPreProbeResult =
  | { status: "maybe" }
  | { status: "carry"; reason: string; busy?: true };

/** Cheap stable admission probe only. It never grants publication authority. */
export async function pendingSupersessionPreProbe(
  root: string,
  relPath: string,
  pending: GitSection,
): Promise<PendingPreProbeResult> {
  try {
    const before = await gitFingerprint(gitFingerprintRun("per-decision"), root, relPath);
    const ctx = before.diskCtx;
    if (!ctx) return { status: "carry", reason: "pending supersession repository is unreadable" };
    if (await isGitBusy(ctx.repoDir, ctx)) return { status: "carry", reason: "git busy (pending supersession probe)", busy: true };
    const preflight = await gitPreflight(ctx.repoDir, ctx);
    if (!preflight.ok) return { status: "carry", reason: preflight.reason ?? "pending supersession preflight failed" };
    const identity = await gitIdentity(ctx.repoDir);
    if (!identity || identity.refScope !== pending.refScope || identity.head !== pending.head) {
      return { status: "carry", reason: "local repository cannot supersede pending semantic lanes" };
    }
    for (const [ref, oid] of Object.entries(pending.refs)) {
      const live = identity.refs[ref];
      if (live === undefined) return { status: "carry", reason: `local repository lacks pending ref ${ref}` };
      if ((ref.startsWith("refs/tags/") || ref === "refs/stash") && live !== oid) {
        return { status: "carry", reason: `local repository mismatches exact pending ref ${ref}` };
      }
    }
    const after = await gitFingerprint(gitFingerprintRun("per-decision"), root, relPath);
    if (before.hash !== after.hash) return { status: "carry", reason: "pending supersession probe was unstable" };
    return { status: "maybe" };
  } catch {
    return { status: "carry", reason: "pending supersession probe failed" };
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function exactCanonicalConfig(a: GitSection["config"], b: GitSection["config"]): boolean {
  if (a === undefined || b === undefined) return a === b;
  const av = validateCanonicalGitConfig(a);
  const bv = validateCanonicalGitConfig(b);
  return av.ok && bv.ok && canonical(av.config) === canonical(bv.config);
}

function indexArtifact(section: GitSection) {
  const fields = [section.indexSha, section.indexEncSha, section.indexCipherSize] as const;
  if (fields.every((field) => field === undefined)) return undefined;
  if (section.indexSha === undefined || section.indexEncSha === undefined || section.indexCipherSize === undefined) {
    throw new Error("incomplete index lane");
  }
  return {
    sha: section.indexSha,
    encSha: section.indexEncSha,
    cipherSize: section.indexCipherSize,
    ...(section.indexComp ? { comp: section.indexComp } : {}),
    ...(section.indexPayloadSha ? { payloadSha: section.indexPayloadSha } : {}),
  };
}

async function semanticIndex(
  ctx: RepoCtx,
  section: GitSection,
  store: BlobStore,
  kek: Buffer,
  label: string,
): Promise<string | null> {
  const artifact = indexArtifact(section);
  if (!artifact) return null;
  const tmpDir = await fs.mkdtemp(path.join(ctx.gitDir, `.rbox-supersession-${label}-`));
  try {
    const indexPath = path.join(tmpDir, "index");
    await getGitArtifact(store, kek, artifact, indexPath, tmpDir);
    const projection = await indexIdentityV2(ctx.repoDir, indexPath);
    if (projection === undefined) throw new Error("semantic index proof failed");
    return projection;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

const literalGraphEnv: NodeJS.ProcessEnv = {
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
};

async function equalOrFastForward(repoDir: string, pendingOid: string, candidateOid: string): Promise<boolean> {
  const [pendingCommit, candidateCommit] = await Promise.all([
    git(repoDir, ["rev-parse", "--verify", `${pendingOid}^{commit}`], { env: literalGraphEnv }),
    git(repoDir, ["rev-parse", "--verify", `${candidateOid}^{commit}`], { env: literalGraphEnv }),
  ]);
  if (pendingCommit === candidateCommit) return true;
  try {
    await git(repoDir, ["merge-base", "--is-ancestor", pendingCommit, candidateCommit], { env: literalGraphEnv });
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

/** Candidate-bound, fail-closed proof over the exact final normalized section. */
export async function provePendingSupersession(input: {
  ctx: RepoCtx;
  pending: GitSection;
  candidate: GitSection;
  store: BlobStore;
  kek: Buffer;
}): Promise<boolean> {
  try {
    if (!validateGitSection(input.pending).ok || !validateGitSection(input.candidate).ok) return false;
    if (await fs.lstat(path.join(input.ctx.commonDir, "shallow")).then(() => true, () => false)) return false;
    if (input.pending.head !== input.candidate.head || input.pending.refScope !== input.candidate.refScope) return false;
    if (!exactCanonicalConfig(input.pending.config, input.candidate.config)) return false;
    if (canonical(sectionOpState(input.pending)) !== canonical(sectionOpState(input.candidate))) return false;

    for (const [ref, pendingOid] of Object.entries(input.pending.refs)) {
      const candidateOid = input.candidate.refs[ref];
      if (candidateOid === undefined) return false;
      if (ref.startsWith("refs/heads/")) {
        if (!(await equalOrFastForward(input.ctx.repoDir, pendingOid, candidateOid))) return false;
      } else if (ref.startsWith("refs/tags/") || ref === "refs/stash") {
        if (candidateOid !== pendingOid) return false;
      } else {
        return false;
      }
    }
    if ((input.pending.refs["refs/stash"] ?? null) !== (input.candidate.refs["refs/stash"] ?? null)) return false;
    const [pendingIndex, candidateIndex] = await Promise.all([
      semanticIndex(input.ctx, input.pending, input.store, input.kek, "pending"),
      semanticIndex(input.ctx, input.candidate, input.store, input.kek, "candidate"),
    ]);
    return pendingIndex === candidateIndex;
  } catch {
    return false;
  }
}
