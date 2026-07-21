import fs from "node:fs/promises";
import path from "node:path";
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
import { getGitArtifact, git, type RepoCtx } from "../../engine/git/shared.js";
import { graphEnv } from "../../engine/git/reachability.js";
import { validateCanonicalGitConfig } from "../../engine/git/config-sync.js";
import { gitFingerprint, gitFingerprintRun } from "./fingerprint.js";
import { sectionOpState } from "./shared.js";
import { indexArtifact } from "./follow.js";
import type { FingerprintHitProbeResult } from "./divergence-cache.js";

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

async function semanticIndex(
  ctx: RepoCtx,
  section: GitSection,
  store: BlobStore,
  kek: Buffer,
  label: string,
): Promise<string | null> {
  const artifact = indexArtifact(section, { strict: true });
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
    const [pendingIndex, candidateIndex] = await Promise.all([
      semanticIndex(input.ctx, input.pending, input.store, input.kek, "pending"),
      semanticIndex(input.ctx, input.candidate, input.store, input.kek, "candidate"),
    ]);
    return pendingIndex === candidateIndex;
  } catch {
    return false;
  }
}
