import fs from "node:fs/promises";
import path from "node:path";
import { SETTLED_ABSENCE_PREFIX, readSettledAbsence, settleBaseAbsentArtifact, readBasePresentArtifact } from "./sync-git/base-artifacts.js";
import { artifactBinding, readStateLineageV1, repositoryIdentityForContext, repositoryIdentityHash } from "./sync-git/repo-lineage.js";
import { checkoutJournalDir, recoverJournal } from "./sync-git/journal.js";
import { repoCtxFromDisk } from "./sync-git/git-state.js";
import { scanBaseArtifacts } from "./sync-git/base-artifact-scan.js";
import { withRepositoryRecoveryFence } from "./sync-git/protocol-locks.js";
import { runLockedPRepairAttempt, resumeLockedAcceptedPRepair, refreshLockedAcceptedPRepair } from "./sync-git/p-repair-transaction.js";
import { ENCRYPT_ADDRESS_CACHE_REL } from "../engine/encrypt-address-cache.js";
import { acquireLock, captureCommonDirIdentity, type OwnedLock } from "../engine/lockfile.js";
import { errCode } from "../engine/fsutil.js";
import { gitRaw } from "../engine/git-spawn.js";
import {
  acquireWorkspaceSyncMutex,
  assertSyncMutex,
  releaseWorkspaceSyncMutex,
  workspaceSyncMutexDegraded,
  type WorkspaceSyncMutex,
} from "./sync-mutex.js";
import {
  beginSelectedReset,
  inspectResetFenceInventory,
  settleStandingReset,
  settleStandingResetUnderHeldFence,
  type ResetJournalAuthorization,
  type ResetZEntry,
} from "./reset-journal.js";
import { compareResetZEntries } from "./reset-z.js";
import { boundedJsonRead } from "./reset-io.js";
import { createPRepairStatePort } from "./sync-git/p-repair-state.js";
import { settleExactPresentArtifact } from "./sync-git/p-settlement.js";
import {
  RebindConsentRequiredError, consumeResetConsent, inspectResetConsent,
  type ResetConsentInspection, type ResetConsentWitness,
} from "./reset-consent.js";
import { RBOX_DIR, loadConfig, syncStreamId } from "./workspace-config.js";
import {
  type SyncState,
} from "./sync-state-model.js";
import {
  normalizeStateCounter, repoRecordsForState,
} from "./sync-state-records.js";
import {
  applyStateSavePacket,
  assertResetIncarnationMarkerNormalized,
  loadRawState,
  selectedStateForResetConsent,
  stateLockBusyDetail,
  stateLockPath,
  statePath,
} from "./sync-state-store.js";

interface ResetRepositoryDescriptor {
  relPath: string;
  repoDir: string;
  ctx: NonNullable<Awaited<ReturnType<typeof repoCtxFromDisk>>>;
  identity: Awaited<ReturnType<typeof repositoryIdentityForContext>>;
  branchRefs: string[];
}

/** Read-only repository inventory used to choose the complete fence. A later
 * state-lineage recheck under that fence rejects any raced state before the
 * first preparation mutation. */
async function inspectResetRepositories(root: string, state: SyncState): Promise<ResetRepositoryDescriptor[]> {
  const repos: ResetRepositoryDescriptor[] = [];
  for (const [relPath, record] of Object.entries(repoRecordsForState(state)).sort(([a], [b]) => a < b ? -1 : 1)) {
    const repoDir = relPath === "." ? root : path.join(root, ...relPath.split("/"));
    const ctx = await repoCtxFromDisk(repoDir);
    const branchRefs = Object.keys(record.base?.refs ?? {}).filter((ref) => ref.startsWith("refs/heads/")).sort();
    if (!ctx) {
      if (branchRefs.length || Object.keys(record.branchBaseOrigins ?? {}).length) throw new Error(`reset refused: repository identity unavailable for ${relPath}`);
      continue;
    }
    const worktreeId = await fs.realpath(ctx.repoDir).catch(() => path.resolve(ctx.repoDir));
    const identity = await repositoryIdentityForContext(relPath, ctx, worktreeId);
    repos.push({ relPath, repoDir, ctx, identity, branchRefs });
  }
  return repos;
}

const sameResetLineage = (state: Pick<SyncState, "stream" | "stateNonce" | "stateRevision"> | undefined, expected: Pick<SyncState, "stream" | "stateNonce" | "stateRevision"> | undefined): boolean => state?.stream === expected?.stream && state?.stateNonce === expected?.stateNonce && normalizeStateCounter(state?.stateRevision) === normalizeStateCounter(expected?.stateRevision);

async function prepareResetArtifactsUnderFence<T>(
  root: string,
  state: SyncState,
  descriptors: readonly ResetRepositoryDescriptor[],
  heldStateLock: OwnedLock,
  finish: (state: SyncState, z: ResetZEntry[]) => Promise<T>,
): Promise<T> {
  if (!state.stream || !state.stateNonce) throw new Error("reset refused: state lacks a fenced lineage");
  const stateStream = state.stream;
  const stateNonce = state.stateNonce;
  const repos = await Promise.all(descriptors.map(async ({ relPath, repoDir, ctx, identity }) => {
    const lineage = await readStateLineageV1(root, stateStream, stateNonce, identity);
    const binding = artifactBinding(lineage);
    return { relPath, repoDir, ctx, identity, binding };
  }));
  {
    let currentState = state;
    const knownLineagesByCommonDir = new Map<string, Set<string>>();
    for (const repo of repos) {
      const known = knownLineagesByCommonDir.get(repo.identity.commonDirReal) ?? new Set<string>();
      known.add(repo.binding.lineageHash);
      knownLineagesByCommonDir.set(repo.identity.commonDirReal, known);
    }

    const assertScanValid = async (repo: typeof repos[number]): Promise<Awaited<ReturnType<typeof scanBaseArtifacts>>> => {
      const scan = await scanBaseArtifacts(repo.repoDir, repo.binding);
      if (scan.invalidNamespace.length || scan.orphanKeep.length || scan.absent.some((item) => item.status === "invalid")
        || scan.present.some((item) => item.status === "invalid")
        || scan.foreign.some((item) => item.status === "invalid" || !knownLineagesByCommonDir.get(repo.identity.commonDirReal)?.has(item.lineageHash))) {
        throw new Error(`reset refused: malformed A/P/K artifacts for ${repo.relPath}`);
      }
      const settled = await readSettledAbsence(repo.repoDir, repo.binding);
      if (settled.status === "invalid") throw new Error(`reset refused: malformed Z for ${repo.relPath}: ${settled.detail}`);
      return scan;
    };

    // A published checkout intent owns its branch mutations. Refuse every such
    // journal before settling any P or compacting any A in any repository.
    for (const { relPath } of repos) {
      const checkoutPath = path.join(checkoutJournalDir(root, relPath), "journal.json");
      const checkoutStat = await fs.lstat(checkoutPath).catch((error) => errCode(error) === "ENOENT" ? undefined : Promise.reject(error));
      if (checkoutStat) {
        if (!checkoutStat.isFile() || checkoutStat.isSymbolicLink() || checkoutStat.size > 512 * 1024) {
          throw new Error(`reset refused: unsafe or oversized checkout journal for ${relPath}`);
        }
        try {
          const raw = await boundedJsonRead<{ phase?: unknown }>(checkoutPath, 512 * 1024);
          if (raw?.phase === "published") throw new Error(`reset refused: published checkout journal for ${relPath}`);
        } catch (error) {
          if (String(error).includes("published checkout journal")) throw error;
          throw new Error(`reset refused: unreadable or corrupt checkout journal for ${relPath}`);
        }
      }
    }

    for (const { relPath, identity } of repos) {
      const journalBinding = {
        stream: state.stream, stateNonce: state.stateNonce!,
        gitDirReal: identity.gitDirReal, commonDirReal: identity.commonDirReal, worktreeId: identity.worktreeId,
        commonDirIdentity: await captureCommonDirIdentity(identity.commonDirReal),
      };
      const checkout = await recoverJournal(root, relPath, journalBinding);
      if (checkout.status === "keep") throw new Error(`reset refused: published checkout journal for ${relPath}`);
      if (checkout.status === "defer") throw new Error(`reset refused: ${checkout.reason} for ${relPath}`);
    }

    // First classify every repository before mutating any protocol artifact, so
    // a malformed peer cannot be hidden by successful work in an earlier repo.
    for (const repo of repos) await assertScanValid(repo);

    // A valid P is never a reset veto. Settle its exact episode, or preserve and
    // quarantine every moved observation through P-repair, then start again from
    // freshly loaded state and artifacts. The cap makes this bound unreachable
    // without repeated external races; exhaustion is a safe-direction refusal.
    let passes = 0;
    for (const repo of repos) {
      for (;;) {
        if (++passes > 1_024) throw new Error("reset refused: P settlement did not stabilize");
        const scan = await assertScanValid(repo);
        const item = scan.present.find((candidate) => candidate.status === "valid");
        if (!item || item.status !== "valid") break;
        const p = item.artifact;
        const exact = await settleExactPresentArtifact({
          root, stream: state.stream, state: currentState, relPath: repo.relPath,
          ctx: repo.ctx, binding: repo.binding, p, stateSaveOptions: { heldLock: heldStateLock },
        });
        if (exact.status === "hold") {
          throw new Error(`reset refused: unpreservable P for ${repo.relPath}${exact.code ? ` (${exact.code})` : ""}: ${exact.reason}`);
        }
        if (exact.status === "settled") {
          currentState = exact.state;
          continue;
        }
        if (exact.status === "absent") continue;

        const record = repoRecordsForState(currentState)[repo.relPath];
        if (!record) throw new Error(`reset refused: RepoRecord disappeared while repairing P for ${repo.relPath}`);
        const port = createPRepairStatePort({
          root, stream: state.stream, relPath: repo.relPath, repoKind: repo.ctx.kind,
          effectiveRefScope: record.base?.refScope ?? "all", p, stateSaveOptions: { heldLock: heldStateLock },
        });
        const validateArtifacts = async (): Promise<boolean> => {
          const freshP = await readBasePresentArtifact(repo.repoDir, repo.binding, p.payload.ref);
          if (freshP.status !== "valid" || freshP.artifact.targetOid !== p.targetOid) return false;
          const freshScan = await scanBaseArtifacts(repo.repoDir, repo.binding);
          if (freshScan.invalidNamespace.length || freshScan.orphanKeep.length
            || freshScan.absent.some((candidate) => candidate.status !== "valid")
            || freshScan.present.some((candidate) => candidate.status !== "valid")
            || freshScan.foreign.some((candidate) => candidate.status !== "valid"
              || candidate.branchRef === p.payload.ref)) return false;
          if (freshScan.absent.some((candidate) => candidate.status === "valid" && candidate.artifact.payload.ref === p.payload.ref)) return false;
          const z = await readSettledAbsence(repo.repoDir, repo.binding);
          return z.status !== "invalid" && !(z.status === "valid"
            && [...z.ledger.entries.values()].some((payload) => payload.ref === p.payload.ref));
        };
        const accepted = record.partial?.pRepaired?.[p.payload.ref];
        const mismatches = {
          live: exact.reason === "live",
          reflog: exact.reason === "reflog",
          baseShape: exact.reason === "base-shape",
        };
        let repaired;
        if (accepted) {
          const resumed = await resumeLockedAcceptedPRepair({ repoDir: repo.repoDir, receipt: accepted, validateArtifacts });
          repaired = resumed.status === "refresh-receipt"
            ? await refreshLockedAcceptedPRepair({
                repoDir: repo.repoDir, p, state: port, repairAt: new Date().toISOString(),
                acceptedReceipt: accepted, mismatches, validateArtifacts,
              })
            : resumed.status === "restart"
              ? { status: "restart" as const }
              : { status: "hold" as const, reason: resumed.reason };
        } else {
          repaired = await runLockedPRepairAttempt({
            repoDir: repo.repoDir, p, state: port, repairAt: new Date().toISOString(), mismatches, validateArtifacts,
          });
        }
        if (repaired.status === "hold") throw new Error(`reset refused: unpreservable P for ${repo.relPath}: ${repaired.reason}`);
        if (repaired.status === "retry") continue;
        // P-repair CAS contract: no accepted projection, so materialize after commit.
        const reloaded = await loadRawState(root);
        if (!reloaded || reloaded.stream !== state.stream || reloaded.stateNonce !== state.stateNonce) throw new Error("reset refused: state lineage changed while repairing P");
        currentState = reloaded;
      }
    }

    // Normative post-P rescan: reset never relies on the pre-repair artifact
    // view, and no valid/malformed standing P may slip into the lineage cutover.
    const rescans = new Map<string, Awaited<ReturnType<typeof scanBaseArtifacts>>>();
    for (const repo of repos) {
      const scan = await assertScanValid(repo);
      if (scan.present.some((item) => item.status === "valid")) {
        throw new Error(`reset refused: present-transition artifact survived repair for ${repo.relPath}`);
      }
      rescans.set(repo.relPath, scan);
    }

    // A is authoritative over serialized BASE, including an old writer's stale
    // positive member. Compact by exact A/Z CAS; never reject merely because the
    // materialized state view still says present.
    for (const repo of repos) {
      for (const item of rescans.get(repo.relPath)?.absent ?? []) {
        if (item.status === "valid") await settleBaseAbsentArtifact(repo.repoDir, repo.binding, item.artifact.payload.ref);
      }
    }

    const entries: ResetZEntry[] = [];
    for (const { relPath, repoDir, identity, binding } of repos) {
      const settled = await readSettledAbsence(repoDir, binding);
      if (settled.status === "invalid") throw new Error(`reset refused: malformed Z for ${relPath}: ${settled.detail}`);
      if (settled.status === "valid") entries.push({
        lineageHash: binding.lineageHash,
        repositoryIdentityHash: binding.repositoryIdentityHash,
        repositoryIdentity: identity,
        activeRef: settled.ledger.ref,
        targetOid: settled.ledger.targetOid,
        recoveryRef: `refs/rbox-recovery/base-absent/v1/${binding.lineageHash}/${settled.ledger.targetOid}`,
      });
    }
    for (const [commonDir, knownLineages] of knownLineagesByCommonDir) {
      const refs = (await gitRaw(commonDir, ["for-each-ref", "--format=%(refname)", SETTLED_ABSENCE_PREFIX])).split("\n").filter(Boolean);
      for (const ref of refs) {
        const match = new RegExp(`^${SETTLED_ABSENCE_PREFIX}/([0-9a-f]{64})$`).exec(ref);
        if (!match || !knownLineages.has(match[1]!)) throw new Error(`reset refused: foreign or malformed active Z ${ref}`);
      }
    }
    const journalRoot = path.join(root, RBOX_DIR, "state", "git-journal");
    const remaining = await fs.readdir(journalRoot).catch((error) => errCode(error) === "ENOENT" ? [] : Promise.reject(error));
    if (remaining.length > 0) throw new Error(`reset refused: unbound or unreadable checkout journal entries remain at ${journalRoot}`);
    // Complete-fence preflight contract: recheck cheap Q lineage after P work.
    const finalLineage = await selectedStateForResetConsent(root);
    if (!finalLineage) throw new Error("reset refused: selected state disappeared during artifact preflight");
    if (!sameResetLineage(finalLineage, currentState)) throw new Error("reset refused: state lineage changed during artifact preflight");
    return finish(currentState, entries.sort(compareResetZEntries));
  }
}

/** Discard the local sync baseline (used when a root is REBOUND to a different
 *  workspace — the old baseline describes the old stream). Files on disk are
 *  untouched; the next pull writes without deleting and the next push publishes
 *  the full tree. Every per-binding sidecar goes with it (design 45):
 *  the activity record AND the design-46 `shell.line` prompt sidecar both describe
 *  the OLD binding's halt/trail and must not render under the new one.
 *  Missing files = already reset. */
export interface ResetSyncStateHooks {
  /** Test-only barrier seam under the complete fence, before consent
   * consumption or any reset preparation mutation. */
  afterFencedRecheck?: () => void | Promise<void>;
}

export async function resetSyncState(
  root: string,
  nextStream: string,
  heldMutex?: WorkspaceSyncMutex,
  resetConsent?: ResetConsentWitness,
  hooks: ResetSyncStateHooks = {},
): Promise<void> {
  if (!nextStream) throw new Error("reset refused: next stream is empty");

  // Validate the invocation-local capability before selecting or opening state.
  // Exact Q is WAL-mode: even its ordinary read connection is a SQLite mutation.
  // A missing witness therefore uses only the Adapter's file-level presence
  // predicate, while a supplied witness is shape/freshness/replay/root/
  // destination validated before the selected state is materialized.
  const initialConfig = await loadConfig(root).catch(() => undefined);
  let consentInspection: Readonly<ResetConsentInspection> | undefined;
  if (resetConsent) {
    consentInspection = inspectResetConsent(resetConsent);
    if (consentInspection.root !== path.resolve(root) || consentInspection.nextStream !== nextStream) {
      throw new RebindConsentRequiredError(root);
    }
    const consentState = await selectedStateForResetConsent(root);
    const consentOldStream = consentState?.stream ?? (initialConfig ? syncStreamId(initialConfig) : undefined);
    if (consentOldStream === undefined
      || consentInspection.observedOldStream !== consentOldStream
      || consentInspection.observedOldNonce !== consentState?.stateNonce
      || consentInspection.mintedAtRevision !== normalizeStateCounter(consentState?.stateRevision)) {
      throw new RebindConsentRequiredError(root);
    }
  } else if (initialConfig !== undefined || await selectedStateForResetConsent(root) !== undefined) {
    throw new RebindConsentRequiredError(root);
  }
  const initialState = consentInspection ? await loadRawState(root) : undefined;
  const initialOldStream = initialState?.stream ?? (initialConfig ? syncStreamId(initialConfig) : undefined);
  if (consentInspection && (initialOldStream === undefined
    || consentInspection.observedOldStream !== initialOldStream
    || consentInspection.observedOldNonce !== initialState?.stateNonce
    || consentInspection.mintedAtRevision !== normalizeStateCounter(initialState?.stateRevision))) {
    throw new RebindConsentRequiredError(root);
  }

  let owned = heldMutex;
  let releaseOwned = false;
  if (!owned) {
    owned = await acquireWorkspaceSyncMutex(root, "cli");
    releaseOwned = true;
  }
  assertSyncMutex(owned, root);
  try {
    if (workspaceSyncMutexDegraded(owned)) throw new Error("sync state reset requires a non-degraded workspace fence");

    const initialRecoveryStream = initialConfig ? syncStreamId(initialConfig) : initialOldStream;
    const standing = await inspectResetFenceInventory(root, initialRecoveryStream);
    if (standing.settlement === "required") {
      await settleStandingReset(root, owned, initialRecoveryStream);
      // Recovery-settlement contract: recurse to observe its post-mutation state.
      return resetSyncState(root, nextStream, owned, resetConsent, hooks);
    }

    const observedState = initialState;
    const descriptors = observedState ? await inspectResetRepositories(root, observedState) : [];
    const requests = [...descriptors.map((repo) => ({
      commonDir: repo.identity.commonDirReal,
      reflogRefs: repo.branchRefs,
      origins: true,
    })), ...standing.requests];
    let recoveryCallerStream: string | undefined;

    await withRepositoryRecoveryFence(requests, path.resolve(statePath(root)), async () => {
      const acquired = await acquireLock(stateLockPath(root));
      if (acquired.status !== "acquired") throw new Error(`sync state reset lock unavailable (${stateLockBusyDetail(acquired)})`);
      try {
        if (await settleStandingResetUnderHeldFence(
          root, initialRecoveryStream, standing.observation, acquired.lock,
        ) !== "none") {
          throw new Error("standing reset appeared after reset entry inspection");
        }
        // Requests were necessarily discovered before acquiring their common-dir
        // locks. Re-resolve every checkout under those locks and refuse if a
        // replacement now points at an unlocked repository incarnation.
        for (const descriptor of descriptors) {
          const currentCtx = await repoCtxFromDisk(descriptor.repoDir);
          if (!currentCtx) throw new Error(`reset refused: repository identity changed for ${descriptor.relPath}`);
          const worktreeId = await fs.realpath(currentCtx.repoDir).catch(() => path.resolve(currentCtx.repoDir));
          const currentIdentity = await repositoryIdentityForContext(descriptor.relPath, currentCtx, worktreeId);
          if (repositoryIdentityHash(currentIdentity) !== repositoryIdentityHash(descriptor.identity)) {
            throw new Error(`reset refused: repository identity changed for ${descriptor.relPath}`);
          }
        }
        let prior = observedState;
        const freshConfig = await loadConfig(root).catch(() => undefined);
        // Complete-fence consent contract: under-lock Q recheck is lineage-only.
        const fencedLineage = await selectedStateForResetConsent(root);
        const fencedOldStream = fencedLineage?.stream ?? (freshConfig ? syncStreamId(freshConfig) : undefined);
        if (consentInspection) {
          if (!fencedLineage && !freshConfig) throw new Error("reset refused: confirmed old lineage disappeared before the fence");
          if (fencedOldStream !== consentInspection.observedOldStream
            || fencedLineage?.stateNonce !== consentInspection.observedOldNonce
            || normalizeStateCounter(fencedLineage?.stateRevision) !== consentInspection.mintedAtRevision) {
            throw new Error("reset refused: state lineage changed after confirmation");
          }
        } else if (fencedLineage || freshConfig) {
          throw new RebindConsentRequiredError(root);
        }

        await hooks.afterFencedRecheck?.();
        // Journal-publication barrier contract: recheck cheap Q lineage after the seam.
        const barrierLineage = await selectedStateForResetConsent(root);
        const barrierConfig = await loadConfig(root).catch(() => undefined);
        if ((barrierLineage?.stream ?? (barrierConfig ? syncStreamId(barrierConfig) : undefined)) !== fencedOldStream
          || !sameResetLineage(barrierLineage, fencedLineage)) {
          throw new Error("reset refused: state lineage changed before journal publication");
        }

        if (prior) await assertResetIncarnationMarkerNormalized(root, prior);

        let authorization: ResetJournalAuthorization | undefined;
        if (consentInspection && resetConsent) {
          const consumed = consumeResetConsent(resetConsent, {
            root,
            observedOldStream: consentInspection.observedOldStream,
            observedOldNonce: consentInspection.observedOldNonce,
            nextStream,
          });
          authorization = {
            version: 2,
            authorizedNextStream: nextStream,
            consentKind: consumed.consentKind,
            mintedAtRevision: consumed.mintedAtRevision,
          };
        }

        if (!prior) {
          return;
        }
        if (!authorization) throw new RebindConsentRequiredError(root);

        // Legacy-lineage migration is itself behind the fenced witness recheck
        // and reuses the already-held physical state lock.
        if (prior.stateNonce === undefined) {
          const legacyStream = prior.stream ?? fencedOldStream;
          if (!legacyStream) throw new Error("sync state reset requires the legacy binding stream");
          const migrated = await applyStateSavePacket(root, {
            expectedStream: legacyStream,
            expectedNonce: "legacy",
            sourceGlobalSeq: normalizeStateCounter(prior.lastSyncedSequence),
            repos: [],
          }, { heldLock: acquired.lock });
          if (migrated.status !== "accepted") {
            const detail = migrated.status === "rejected" ? migrated.reason
              : migrated.status === "busy" ? migrated.detail : migrated.status;
            throw new Error(`sync state legacy reset migration failed (${detail})`);
          }
          prior = migrated.state;
        }
        if (!prior.stream || !prior.stateNonce || !Number.isSafeInteger(prior.stateRevision)) {
          throw new Error("sync state reset requires a fenced state lineage");
        }
        recoveryCallerStream = prior.stream;
        await prepareResetArtifactsUnderFence(root, prior, descriptors, acquired.lock, async (preparedState, z) => {
          const begun = await beginSelectedReset(
            root,
            nextStream,
            { stream: preparedState.stream!, stateNonce: preparedState.stateNonce! },
            z,
            authorization!,
            acquired.lock,
          );
          recoveryCallerStream = begun.recoveryStream;
        });
      } finally {
        await acquired.lock.release();
      }
    });

    await settleStandingReset(root, owned, recoveryCallerStream);

    for (const p of [
      path.join(root, ENCRYPT_ADDRESS_CACHE_REL),
      path.join(root, RBOX_DIR, "state", "activity.json"),
      path.join(root, RBOX_DIR, "state", "shell.line"),
      path.join(root, RBOX_DIR, "state", "shell.deferrals"),
      path.join(root, RBOX_DIR, "state", "path-warnings.json"),
      path.join(root, RBOX_DIR, "state", "git-republish.json"),
    ]) {
      try {
        await fs.rm(p, { recursive: true });
      } catch (error) {
        if (errCode(error) !== "ENOENT") throw error;
      }
    }
  } finally {
    if (releaseOwned) await releaseWorkspaceSyncMutex(owned);
  }
}
