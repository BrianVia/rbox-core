/** Incoming-artifact staging and index projection: fetch/decrypt/import the
 * incoming pack chain and index into scratch space, project an index to its
 * semantic v2 identity, and derive the base-side projection. Moved verbatim out
 * of follow.ts. */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { probeReceiverEquivalence, receiverEquivalentCollisionNames, receiverEquivalentPath, type GitSection } from "../../engine/index.js";
import { indexIdentityV2 } from "./index-identity.js";
import { pruneStaleScratchRefs } from "./pins.js";
import { listRefs } from "./refs.js";
import { addTimedMs } from "./chain-timings.js";
import { clearIndexResolveUndo, getGitArtifact, importGitPackChain } from "./git-state.js";
import { git, gitWithIndexFile } from "../../engine/git-spawn.js";
import type { FollowOptions, StagedIncoming, StageIncomingOptions } from "./follow-types.js";

const receiverEquivalenceByWorkspace = new Map<string, ReturnType<typeof probeReceiverEquivalence>>();

export async function candidateIndexCollision(workspaceRoot: string, repoDir: string, indexPath: string): Promise<string | undefined> {
  let pending = receiverEquivalenceByWorkspace.get(workspaceRoot);
  if (!pending) {
    pending = probeReceiverEquivalence(workspaceRoot);
    receiverEquivalenceByWorkspace.set(workspaceRoot, pending);
  }
  const equivalence = await pending;
  if (!equivalence.caseAliases && !equivalence.unicodeAliases) return undefined;
  const raw = await gitWithIndexFile(repoDir, indexPath, ["ls-files", "-z", "--stage"]);
  const names = new Set(raw.split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error("candidate index ls-files record lacks pathname");
    return record.slice(tab + 1);
  }));
  const collisions = receiverEquivalentCollisionNames(names, (name) => receiverEquivalentPath(name, equivalence));
  return collisions.size > 0 ? [...collisions].sort().join(", ") : undefined;
}

export function indexArtifact(section: GitSection | undefined, options: { strict?: boolean } = {}) {
  if (!section) return undefined;
  const fields = [section.indexSha, section.indexEncSha, section.indexCipherSize] as const;
  if (fields.every((field) => field === undefined)) return undefined;
  if (!section.indexSha || !section.indexEncSha || section.indexCipherSize === undefined) {
    if (options.strict) throw new Error("incomplete index lane");
    return undefined;
  }
  return {
    sha: section.indexSha,
    encSha: section.indexEncSha,
    cipherSize: section.indexCipherSize,
    ...(section.indexComp ? { comp: section.indexComp } : {}),
    ...(section.indexPayloadSha ? { payloadSha: section.indexPayloadSha } : {}),
  };
}

export async function normalizedIndexProjection(repoDir: string, source: string, dest: string): Promise<string | undefined> {
  await fs.copyFile(source, dest);
  try {
    await clearIndexResolveUndo(repoDir, dest);
  } catch {
    return undefined;
  }
  return indexIdentityV2(repoDir, dest);
}

export async function stageIncoming(opts: StageIncomingOptions): Promise<StagedIncoming> {
  const { ctx, incoming, store, kek } = opts;
  await fs.mkdir(path.join(ctx.repoDir, ".rbox"), { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(ctx.repoDir, ".rbox", "git-follow-"));
  const incomingNs = `refs/rbox-incoming/${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const cleanupRefs = async () => {
    for (const ref of await listRefs(ctx.repoDir, incomingNs).catch(() => [])) await git(ctx.repoDir, ["update-ref", "-d", ref]).catch(() => {});
  };
  const cleanup = async () => {
    await cleanupRefs();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    let candidateIndex: string | undefined;
    let incomingIndexProjection: string | undefined;
    const artifact = indexArtifact(incoming);
    if (artifact) {
      const raw = path.join(tmpDir, "incoming-index.raw");
      candidateIndex = path.join(tmpDir, "incoming-index");
      await addTimedMs(opts.chainTimings, "indexOpStateMs", async () => {
        await getGitArtifact(store, kek, artifact, raw, tmpDir);
        incomingIndexProjection = await normalizedIndexProjection(ctx.repoDir, raw, candidateIndex!);
      });
    }
    const opState: Array<{ rel: string; tmp: string }> = [];
    const opBytes: Record<string, Uint8Array> = {};
    for (const [rel, artifactRef] of Object.entries(incoming.opState ?? {})) {
      const tmp = path.join(tmpDir, "op", rel);
      await addTimedMs(opts.chainTimings, "indexOpStateMs", async () => {
        await getGitArtifact(store, kek, artifactRef, tmp, tmpDir);
        opState.push({ rel, tmp });
        opBytes[rel] = await fs.readFile(tmp);
      });
    }
    await pruneStaleScratchRefs(ctx.repoDir, "refs/rbox-incoming");
    await importGitPackChain(ctx.repoDir, incoming, store, kek, tmpDir, incomingNs, opts.chainTimings);
    return { tmpDir, incomingNs, candidateIndex, incomingIndexProjection, opState, opBytes, cleanupRefs, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function deriveBaseIndexProjection(
  opts: Pick<FollowOptions, "ctx" | "base" | "store" | "kek" | "record">,
  tmpDir: string,
  ignoreCache = false,
): Promise<string | undefined> {
  if (!indexArtifact(opts.base)) return undefined;
  if (!ignoreCache && opts.record?.idxProj) return opts.record.idxProj;
  const artifact = indexArtifact(opts.base);
  if (!artifact) return undefined;
  const raw = path.join(opts.ctx.gitDir, `.rbox-base-index-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  try {
    await getGitArtifact(opts.store, opts.kek, artifact, raw, tmpDir);
    await clearIndexResolveUndo(opts.ctx.repoDir, raw);
    // `return await`, not `return`: the finally's rm would otherwise race the
    // projection's own read of `raw` (observed as a flaky false-indeterminate).
    return await indexIdentityV2(opts.ctx.repoDir, raw);
  } finally {
    await fs.rm(raw, { force: true });
  }
}

export function expectedHead(section: GitSection): string {
  return section.head.endsWith("\n") ? section.head : `${section.head}\n`;
}
