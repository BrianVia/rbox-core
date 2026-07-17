import fs from "node:fs/promises";
import path from "node:path";
import { acquireLock } from "../engine/git/lockfile.js";
import { withRepositoryRecoveryFence, type RepositoryProtocolFenceRequest } from "../engine/git/protocol-locks.js";
import { loadConfig, stateLockPath, syncStreamId } from "./config.js";
import { boundedHash, boundedRead } from "./reset-io.js";
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

const MAX_JOURNAL_BYTES = 512 * 1024;

export interface ResetJournalDoctorOptions {
  quarantine?: boolean;
  restore?: string;
}

async function withJournalOnlyFence<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return withResetJournalDoctorFence(root, [], fn);
}

export async function withResetJournalDoctorFence<T>(root: string, requests: readonly RepositoryProtocolFenceRequest[], fn: () => Promise<T>): Promise<T> {
  return withWorkspaceSyncMutex(root, async () => withRepositoryRecoveryFence(requests, stateLockPath(root), async () => {
    const acquired = await acquireLock(stateLockPath(root));
    if (acquired.status !== "acquired") throw new Error("reset-journal doctor could not acquire the state recovery fence");
    try { return await fn(); }
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
  const bytes = await boundedRead(resetQuarantineArtifactPath(bundle, journal), MAX_JOURNAL_BYTES);
  if (!bytes) return undefined;
  try {
    const value = JSON.parse(bytes.toString("utf8")) as { old?: { stream?: unknown }; next?: { stream?: unknown } };
    return typeof value.old?.stream === "string" && typeof value.next?.stream === "string"
      ? value as { old: { stream: string; z?: unknown[] }; next: { stream: string }; [key: string]: unknown } : undefined;
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
    const envelope = await boundedRead(resetJournalPath(root), MAX_JOURNAL_BYTES);
    if (!envelope) throw new Error("reset journal disappeared before quarantine");
    let version: unknown;
    try { version = (JSON.parse(envelope.toString("utf8")) as { v?: unknown }).v; } catch { version = undefined; }
    const typed = inspection as typeof inspection & {
      journal?: { v?: number; phase?: string; id?: string; old?: { stateNonce?: string; stateSha256?: string; z?: unknown[] }; next?: { stateSha256?: string } };
      observation?: {
        active?: string; marker?: string; recoveryRefs?: unknown; activeRefGroups?: unknown;
        activeHash?: string; artifactPaths?: { candidate?: string; archive?: string };
      };
    };
    if (version === 2 && typed.journal?.v === 2) {
      if (!typed.journal || !typed.observation || !["prepared", "ready"].includes(typed.journal.phase ?? "") || typed.observation.active !== "old") {
        throw new Error("reset journal has progressed past quarantine eligibility; complete forward recovery instead");
      }
      const artifacts: Array<{ kind: "journal" | "candidate" | "archive"; absolutePath: string; cleanup: "remove-exact" | "preserve" }> = [
        { kind: "journal", absolutePath: resetJournalPath(root), cleanup: "remove-exact" },
      ];
      if (typed.observation.artifactPaths?.candidate && await boundedHash(typed.observation.artifactPaths.candidate)) {
        artifacts.push({ kind: "candidate", absolutePath: typed.observation.artifactPaths.candidate, cleanup: "remove-exact" });
      }
      if (typed.observation.artifactPaths?.archive && await boundedHash(typed.observation.artifactPaths.archive)) {
        artifacts.push({ kind: "archive", absolutePath: typed.observation.artifactPaths.archive, cleanup: "preserve" });
      }
      const recoveryRefs = typed.observation.recoveryRefs;
      const activeRefGroups = typed.observation.activeRefGroups;
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
        scope: "transaction", phase: typed.journal.phase!, activeStateSha256: typed.observation.activeHash,
        recoveredStateSha256: typed.journal.next?.stateSha256,
        markerPrecondition: String(typed.observation.marker),
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
