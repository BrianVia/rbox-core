import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  gitIdentity,
  gitIdentityKey,
  gitPreflight,
  indexIdentityV2,
  isGitBusy,
  validateGitSection,
  type BlobStore,
  type GitSection,
  type JournalRecoveryResult,
} from "../../engine/index.js";
import { canonicalString } from "../../engine/e2ee/index.js";
import { getGitArtifact, git, headBranchOf, type RepoCtx } from "../../engine/git/shared.js";
import { graphEnv } from "../../engine/git/reachability.js";
import { validateCanonicalGitConfig } from "../../engine/git/config-sync.js";
import { gitFingerprint, gitFingerprintRun } from "./fingerprint.js";
import { gitIncomingKey, sectionOpState } from "./shared.js";
import { indexArtifact } from "./follow.js";
import type { FingerprintHitProbeResult } from "./divergence-cache.js";
import { composeRepoBase, type BranchBaseOrigin } from "./base-composer.js";

export const gitPendingSupersedeEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.RBOX_GIT_PENDING_SUPERSEDE !== "0";

/**
 * Dry-run the exact publisher-ACK composer used after commit admission. The
 * source sequence is a documented sentinel: zero is valid publisher provenance
 * and cannot affect the composed BASE bytes being compared here. Object member
 * order is deliberately ignored by isDeepStrictEqual.
 */
export function pendingSupersessionAckConverges(input: {
  previousBase?: GitSection;
  previousOrigins?: Record<string, BranchBaseOrigin>;
  candidate: GitSection;
  binding: { lineageHash: string; repositoryIdentityHash: string; repoKind: "dir" | "pointer" };
}): boolean {
  const DRY_RUN_SOURCE_SEQ = 0;
  const composed = composeRepoBase(
    { base: input.previousBase, branchBaseOrigins: input.previousOrigins },
    { base: input.candidate },
    {
      kind: "publisher-ack",
      lineageHash: input.binding.lineageHash,
      repositoryIdentityHash: input.binding.repositoryIdentityHash,
      incomingKey: gitIncomingKey(input.candidate),
      sourceSeq: DRY_RUN_SOURCE_SEQ,
      advertisedRefs: input.candidate.refs,
    },
    {
      repoKind: input.binding.repoKind,
      effectiveRefScope: input.candidate.refScope,
      checkoutComplete: true,
      branches: {},
      safeRefs: {},
    },
  );
  return composed.disposition === "terminal" && isDeepStrictEqual(composed.base, input.candidate);
}

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
  | { status: "maybe"; fastLookup: FingerprintHitProbeResult }
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
    return {
      status: "maybe",
      fastLookup: {
        status: "hit",
        fingerprint: after,
        probe: {
          busy: false,
          preflightOk: true,
          preflightStructural: false,
          preflightKind: preflight.kind,
          identityKey: gitIdentityKey(identity),
        },
        ...(preflight.kind ? { kind: preflight.kind } : {}),
      },
    };
  } catch {
    return { status: "carry", reason: "pending supersession probe failed" };
  }
}

function exactCanonicalConfig(a: GitSection["config"], b: GitSection["config"]): boolean {
  if (a === undefined || b === undefined) return a === b;
  const av = validateCanonicalGitConfig(a);
  const bv = validateCanonicalGitConfig(b);
  return av.ok && bv.ok && canonicalString(av.config) === canonicalString(bv.config);
}

async function pendingIndexIsCleanAndPlain(
  ctx: RepoCtx,
  section: GitSection,
  store: BlobStore,
  kek: Buffer,
): Promise<boolean> {
  const artifact = indexArtifact(section, { strict: true });
  if (!artifact) return false;
  const tmpDir = await fs.mkdtemp(path.join(ctx.gitDir, ".rbox-supersession-index-"));
  try {
    const indexPath = path.join(tmpDir, "index");
    await getGitArtifact(store, kek, artifact, indexPath, tmpDir);
    if (!(await fs.lstat(indexPath)).isFile()) return false;

    const headBranch = headBranchOf(section.head);
    const pendingHeadOid = headBranch ? section.refs[headBranch] : section.head.trim();
    if (!pendingHeadOid) return false;
    const peeledPendingHead = await git(ctx.repoDir, ["rev-parse", "--verify", `${pendingHeadOid}^{commit}`], { env: graphEnv });
    const indexEnv = { ...graphEnv, GIT_INDEX_FILE: path.resolve(indexPath) };
    await git(ctx.repoDir, ["diff-index", "--cached", "--quiet", peeledPendingHead, "--"], { env: indexEnv });

    const plainIndexPath = path.join(tmpDir, "plain-index");
    await git(ctx.repoDir, [
      "-c", "core.sparseCheckout=false",
      "-c", "core.sparseCheckoutCone=false",
      "-c", "index.sparse=false",
      "read-tree", peeledPendingHead,
    ], {
      env: { ...graphEnv, GIT_INDEX_FILE: path.resolve(plainIndexPath) },
    });
    const [pendingProjection, plainProjection] = await Promise.all([
      indexIdentityV2(ctx.repoDir, indexPath),
      indexIdentityV2(ctx.repoDir, plainIndexPath),
    ]);
    return pendingProjection !== undefined && pendingProjection === plainProjection;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function equalOrFastForward(repoDir: string, pendingOid: string, candidateOid: string): Promise<boolean> {
  const [pendingCommit, candidateCommit] = await Promise.all([
    git(repoDir, ["rev-parse", "--verify", `${pendingOid}^{commit}`], { env: graphEnv }),
    git(repoDir, ["rev-parse", "--verify", `${candidateOid}^{commit}`], { env: graphEnv }),
  ]);
  if (pendingCommit === candidateCommit) return true;
  try {
    await git(repoDir, ["merge-base", "--is-ancestor", pendingCommit, candidateCommit], { env: graphEnv });
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
    if (canonicalString(sectionOpState(input.pending)) !== canonicalString(sectionOpState(input.candidate))) return false;

    const refProofs = await Promise.all(Object.entries(input.pending.refs).map(async ([ref, pendingOid]) => {
      const candidateOid = input.candidate.refs[ref];
      if (candidateOid === undefined) return false;
      if (ref.startsWith("refs/heads/")) {
        return equalOrFastForward(input.ctx.repoDir, pendingOid, candidateOid);
      } else if (ref.startsWith("refs/tags/") || ref === "refs/stash") {
        return candidateOid === pendingOid;
      } else {
        return false;
      }
    }));
    if (refProofs.some((proven) => !proven)) return false;
    if ((input.pending.refs["refs/stash"] ?? null) !== (input.candidate.refs["refs/stash"] ?? null)) return false;
    const pendingIndex = indexArtifact(input.pending, { strict: true });
    const candidateIndex = indexArtifact(input.candidate, { strict: true });
    if (!pendingIndex || !candidateIndex) return pendingIndex === undefined && candidateIndex === undefined;
    return await pendingIndexIsCleanAndPlain(input.ctx, input.pending, input.store, input.kek);
  } catch {
    return false;
  }
}
