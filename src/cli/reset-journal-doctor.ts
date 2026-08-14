import fs from "node:fs/promises";
import path from "node:path";
import { acquireLock } from "../engine/lockfile.js";
import { withRepositoryRecoveryFence, type RepositoryProtocolFenceRequest } from "../cli/sync-git/protocol-locks.js";
import { loadConfig, stateLockPath, statePath, syncStreamId } from "./config.js";
import { assertStateReadable } from "./state-plane/authority-marker.js";
import { classifyStateFormat } from "./state-plane/authority-marker.js";
import { boundedHash, RESET_STREAM_BYTE_LIMIT } from "./reset-io.js";
import {
  decodeResetJournal,
  inspectResetJournalEnvelopeStreams,
  resetJournalFileSource,
} from "./reset-journal-codec.js";
import { inspectResetJournalSafety } from "./reset-halt-inspection.js";
import { resetJournalPath } from "./reset-journal.js";
import {
  quarantineResetUnderFence,
  readResetQuarantineBundle,
  resetQuarantineArtifactPath,
  resetQuarantineRoot,
  resumeResetQuarantineUnderFence,
  restoreResetQuarantineUnderFence,
} from "./reset-quarantine.js";
import { withWorkspaceSyncMutex } from "./sync-mutex.js";

export interface ResetJournalDoctorOptions {
  quarantine?: boolean;
  restore?: string;
}

async function withJournalOnlyFence<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return withResetJournalDoctorFence(root, [], fn);
}

export async function withResetJournalDoctorFence<T>(root: string, requests: readonly RepositoryProtocolFenceRequest[], fn: () => Promise<T>): Promise<T> {
  const sqliteState = path.join(root, ".rbox", "state", "state.db");
  const preFormat = await classifyStateFormat(statePath(root));
  const isSqlite = preFormat === "authority-marker";
  const fencePath = isSqlite ? sqliteState : stateLockPath(root);
  const lockPath = isSqlite ? `${sqliteState}.lock` : stateLockPath(root);
  return withWorkspaceSyncMutex(root, async () => withRepositoryRecoveryFence(requests, fencePath, async () => {
    const acquired = await acquireLock(lockPath);
    if (acquired.status !== "acquired") throw new Error("reset-journal doctor could not acquire the state recovery fence");
    try {
      const heldFormat = await classifyStateFormat(statePath(root));
      if (heldFormat !== preFormat) {
        throw new Error("reset-journal doctor state format changed while acquiring the recovery fence");
      }
      // Everything inside this fence hashes, quarantines, or republishes the
      // live state. A newer state plane is refused here rather than at each read.
      if (!isSqlite) await assertStateReadable(statePath(root));
      return await fn();
    }
    finally {
      const released = await acquired.lock.release();
      if (!released.released) throw new Error("reset-journal doctor lost the state recovery fence");
    }
  }));
}

function requestsFromJournal(value: unknown): RepositoryProtocolFenceRequest[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const journal = value as { old?: { z?: unknown[] } };
  if (!Array.isArray(journal.old?.z)) return [];
  const byCommon = new Map<string, Set<string>>();
  for (const raw of journal.old.z) {
    const entry = raw as { repositoryIdentity?: { commonDirReal?: unknown }; activeRef?: unknown; recoveryRef?: unknown };
    const commonDir = entry.repositoryIdentity?.commonDirReal;
    if (typeof commonDir !== "string") continue;
    const refs = byCommon.get(commonDir) ?? new Set<string>();
    if (typeof entry.activeRef === "string") refs.add(entry.activeRef);
    if (typeof entry.recoveryRef === "string") refs.add(entry.recoveryRef);
    byCommon.set(commonDir, refs);
  }
  return [...byCommon].map(([commonDir, refs]) => ({ commonDir, reflogRefs: [...refs], origins: true }));
}

function bundlePath(root: string, value: string): string {
  const candidate = path.isAbsolute(value) ? path.resolve(value) : path.join(resetQuarantineRoot(root), value);
  if (path.dirname(candidate) !== resetQuarantineRoot(root)) throw new Error("restore bundle must name one entry under .rbox/state/quarantine");
  return candidate;
}

async function journalFromBundle(root: string, bundle: string): Promise<{ old: { stream: string; z?: unknown[] }; next: { stream: string }; [key: string]: unknown } | undefined> {
  const manifest = await readResetQuarantineBundle(root, bundle);
  const journal = manifest?.artifacts.find((artifact) => artifact.kind === "journal");
  if (!manifest || !journal) return undefined;
  try {
    const decoded = await decodeResetJournal(await resetJournalFileSource(resetQuarantineArtifactPath(bundle, journal)));
    if (!decoded.ok) {
      const envelope = await inspectResetJournalEnvelopeStreams(
        await resetJournalFileSource(resetQuarantineArtifactPath(bundle, journal)),
      );
      return envelope
        ? { old: { stream: envelope.oldStream }, next: { stream: envelope.nextStream } }
        : undefined;
    }
    return decoded.journal as unknown as { old: { stream: string; z?: unknown[] }; next: { stream: string }; [key: string]: unknown };
  } catch {
    return undefined;
  }
}

async function restoreBundle(root: string, value: string): Promise<void> {
  const bundle = bundlePath(root, value);
  const preJournal = await journalFromBundle(root, bundle);
  await withResetJournalDoctorFence(root, requestsFromJournal(preJournal), async () => {
    const manifest = await readResetQuarantineBundle(root, bundle);
    if (!manifest) throw new Error("reset quarantine bundle is uncommitted or corrupt");
    const journal = await journalFromBundle(root, bundle);
    const cfgStream = syncStreamId(await loadConfig(root));
    const eligible = journal !== undefined && (cfgStream === journal.old.stream || cfgStream === journal.next.stream);
    const restored = await restoreResetQuarantineUnderFence(root, bundle, { configEligible: eligible });
    console.log(restored === "already-restored" ? "reset journal was already restored" : "reset journal restored; recovery will resume on the next daemon cycle");
  });
}

async function resumePendingBundles(root: string): Promise<number> {
  const names = await fs.readdir(resetQuarantineRoot(root), { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  let resumed = 0;
  for (const entry of names) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const bundle = path.join(resetQuarantineRoot(root), entry.name);
    const bundledJournal = await journalFromBundle(root, bundle);
    await withResetJournalDoctorFence(root, requestsFromJournal(bundledJournal), async () => {
      await resumeResetQuarantineUnderFence(root, bundle);
    });
    resumed++;
  }
  return resumed;
}

async function quarantineStandingJournal(root: string): Promise<void> {
  const resumed = await resumePendingBundles(root);
  const before = await inspectResetJournalSafety(root, syncStreamId(await loadConfig(root)));
  if (before.status === "none") {
    if (resumed > 0) {
      console.log(`reset quarantine cleanup resumed for ${resumed} bundle${resumed === 1 ? "" : "s"}`);
      return;
    }
    throw new Error("no reset journal is standing");
  }
  const preRequests = requestsFromJournal(before.journal);
  await withResetJournalDoctorFence(root, preRequests, async () => {
    const inspection = await inspectResetJournalSafety(root, syncStreamId(await loadConfig(root)));
    if (inspection.status === "none") throw new Error("reset journal disappeared before quarantine");
    if (before.journalIdentityHash && inspection.journalIdentityHash !== before.journalIdentityHash) throw new Error("reset journal changed before quarantine; retry the command");
    if (!await boundedHash(resetJournalPath(root), RESET_STREAM_BYTE_LIMIT)) throw new Error("reset journal disappeared before quarantine");
    const journal = inspection.journal;
    const observation = inspection.observation;
    const version = journal?.v;
    if (journal?.v === 2) {
      if (!observation || !["prepared", "ready"].includes(journal.phase) || observation.active !== "old") {
        throw new Error("reset journal has progressed past quarantine eligibility; complete forward recovery instead");
      }
      const artifacts: Array<{ kind: "journal" | "candidate" | "archive"; absolutePath: string; cleanup: "remove-exact" | "preserve" }> = [
        { kind: "journal", absolutePath: resetJournalPath(root), cleanup: "remove-exact" },
      ];
      if (await boundedHash(observation.artifactPaths.candidate)) {
        artifacts.push({ kind: "candidate", absolutePath: observation.artifactPaths.candidate, cleanup: "remove-exact" });
      }
      if (await boundedHash(observation.artifactPaths.archive)) {
        artifacts.push({ kind: "archive", absolutePath: observation.artifactPaths.archive, cleanup: "preserve" });
      }
      const recoveryRefs = observation.recoveryRefs;
      const activeRefGroups = observation.activeRefGroups;
      const isRestorablePrefix = (value: unknown): value is { kind: "prefix"; count: number; total: number } => {
        if (!value || typeof value !== "object") return false;
        const disposition = value as { kind?: unknown; count?: unknown; total?: unknown };
        return disposition.kind === "prefix" && Number.isSafeInteger(disposition.count)
          && Number.isSafeInteger(disposition.total) && Number(disposition.count) >= 0
          && Number(disposition.count) <= Number(disposition.total);
      };
      if (!isRestorablePrefix(recoveryRefs) || !isRestorablePrefix(activeRefGroups)) {
        throw new Error("reset ref preconditions could not be safely observed; retry the command");
      }
      const bundle = await quarantineResetUnderFence(root, {
        scope: "transaction", phase: journal.phase, activeStateSha256: observation.activeHash,
        recoveredStateSha256: journal.next.stateSha256,
        markerPrecondition: String(observation.marker),
        refPreconditions: JSON.stringify({ recovery: recoveryRefs, active: activeRefGroups }),
        artifacts,
      });
      console.log(`reset transaction quarantined at ${bundle}; deterministic recovery refs and the canonical lineage archive were preserved`);
      return;
    }
    const bundle = await quarantineResetUnderFence(root, {
      scope: "journal-only",
      phase: version === 1 ? "legacy-v1" : "malformed",
      activeStateSha256: await boundedHash(path.join(root, ".rbox", "state.json")).catch(() => undefined),
      markerPrecondition: "unknown",
      refPreconditions: "unknown",
      artifacts: [{ kind: "journal", absolutePath: resetJournalPath(root), cleanup: "remove-exact" }],
    });
    console.log(`reset journal quarantined at ${bundle}; candidate/archive artifacts were left untouched`);
  });
}

/** Rescue dispatcher. It intentionally runs before collectDoctorContext and
 * therefore before workspaceShape/loadState. */
export async function resetJournalDoctorCmd(root: string, opts: ResetJournalDoctorOptions = {}): Promise<void> {
  if (opts.quarantine && opts.restore) throw new Error("choose either --quarantine or --restore");
  if (opts.restore) return restoreBundle(root, opts.restore);
  if (opts.quarantine) return quarantineStandingJournal(root);
  const cfg = await loadConfig(root);
  const inspection = await inspectResetJournalSafety(root, syncStreamId(cfg));
  if (inspection.status === "none") {
    console.log("reset journal: none");
    return;
  }
  if (inspection.status === "recoverable") {
    console.log("reset journal: recoverable; the daemon will complete forward recovery");
    return;
  }
  console.log(`reset journal: sync halted (${inspection.reason})`);
  console.log("Files on disk are untouched. To preserve the standing record, run `rbox doctor reset-journal --quarantine`.");
}
