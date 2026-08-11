import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fsyncDirectory } from "../engine/fsutil.js";
import {
  assertHealthyOwnedSyncMutex,
  beginAdoptBaselineContinuation,
  bindAdoptBaselineContinuation,
  endAdoptBaselineContinuation,
  retireAdoptBaselineContinuation,
  workspaceSyncMutexDegraded,
  type WorkspaceSyncMutex,
} from "./sync-mutex.js";
import { invalidateAdoptionCaches } from "./adopt-cache.js";
import { secureMoveNoReplace } from "./adopt-fs.js";
import { abortGitAdoption, bindRetainedRepoIncarnations, runGitAdoption, type AdoptGitDeps } from "./adopt-git.js";
import { inventoryAdoptionSource, type AdoptInventory } from "./adopt-inventory.js";
import {
  ADOPT_VERSION,
  adoptDir,
  adoptDisplacedDir,
  adoptStashDir,
  adoptUnplacedDir,
  identitiesEqual,
  loadAdoptJournal,
  newJournalId,
  readAdoptIdentity,
  saveAdoptJournal,
  type AdoptJournal,
  type AdoptPhase,
  type AdoptRetainMove,
  type JournalPinnedFolderPolicy,
} from "./adopt-journal.js";
import type { ResolvedFolderPolicy } from "./folder-config.js";
import { abortFileOverlay, runFileOverlay } from "./adopt-overlay.js";

export interface StartAdoptionInput {
  root: string;
  rootReal: string;
  stream: string;
  workspaceId: string;
  projectId: string;
  remoteUrl: string;
  deviceId: string;
  syncGit: boolean;
  respectGitignore: boolean;
  name?: string;
}

export interface AdoptionHooks {
  establishBaseline(journal: AdoptJournal, mutex: WorkspaceSyncMutex): Promise<void>;
  finishSync(journal: AdoptJournal, mutex: WorkspaceSyncMutex): Promise<void>;
  gitDeps?: AdoptGitDeps;
}

export async function pinAdoptionFolderPolicy(
  journal: AdoptJournal,
  generation: string,
  policy: ResolvedFolderPolicy,
  mutex: WorkspaceSyncMutex,
): Promise<JournalPinnedFolderPolicy> {
  await assertHealthyOwnedSyncMutex(mutex, journal.workspace.root);
  const pinned: JournalPinnedFolderPolicy = {
    generation,
    syncGit: policy.syncGit,
    git: { incremental: policy.git.incremental },
    respectGitignore: policy.respectGitignore,
    noDrift: policy.noDrift,
    trash: { days: policy.trash.days, maxBytes: policy.trash.maxBytes },
  };
  journal.pinnedFolderPolicy = pinned;
  await saveAdoptJournal(journal.workspace.root, journal);
  return pinned;
}

async function makeControlDirectories(root: string): Promise<void> {
  const rbox = path.join(root, ".rbox");
  const rboxStat = await fs.lstat(rbox).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (!rboxStat) await fs.mkdir(rbox, { mode: 0o700 });
  else if (!rboxStat.isDirectory() || rboxStat.isSymbolicLink()) throw new Error(`unsafe adoption control path: ${rbox}`);
  const dir = adoptDir(root);
  const existing = await fs.lstat(dir).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existing) throw new Error("an adoption record already exists; run `rbox adopt status|resume|abort`");
  await fs.mkdir(dir, { mode: 0o700 });
  await fsyncDirectory(rbox);
}

async function headroomCheck(root: string, inventory: AdoptInventory): Promise<void> {
  const stat = await fs.statfs(root, { bigint: true });
  const free = stat.bavail * stat.bsize;
  // B already consumes its retained bytes. Reserving a second B-sized envelope is
  // the only honest local bound available before the encrypted A manifest is read.
  if (free < inventory.retainedBytes) {
    throw new Error(`insufficient adoption headroom: need at least ${inventory.retainedBytes} free bytes, have ${free}`);
  }
}

function topIdentity(inventory: AdoptInventory, rel: string) {
  const identity = inventory.entries.find((entry) => entry.path === rel)?.identity;
  if (!identity) throw new Error(`missing top-level inventory identity: ${rel}`);
  return identity;
}

async function revalidateInventorySubtree(root: string, inventory: AdoptInventory, top: string): Promise<void> {
  const entries = inventory.entries.filter((entry) => entry.path === top || entry.path.startsWith(`${top}/`));
  // Validate children first and the namespace root last so a child replacement
  // cannot hide behind the directory identity originally observed in phase 0.
  entries.sort((a, b) => b.path.split("/").length - a.path.split("/").length || a.path.localeCompare(b.path));
  for (const entry of entries) {
    const live = await readAdoptIdentity(path.join(root, ...entry.path.split("/")), entry.identity.kind === "file");
    if (!identitiesEqual(entry.identity, live)) throw new Error(`adoption source changed after inventory: ${entry.path}`);
  }
}

async function maybeIdentity(abs: string, content: boolean) {
  try { return await readAdoptIdentity(abs, content); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function assertJournalWorkspaceBinding(journal: AdoptJournal): Promise<void> {
  const liveReal = await fs.realpath(journal.workspace.root);
  if (liveReal !== journal.workspace.rootReal || !journal.workspace.stream || !journal.workspace.workspaceId) {
    throw new Error("adoption journal workspace/stream binding mismatch");
  }
}

async function classifyRetainMove(journal: AdoptJournal, move: AdoptRetainMove): Promise<void> {
  const root = journal.workspace.root;
  const source = await maybeIdentity(path.join(root, ...move.path.split("/")), move.before.kind === "file");
  const destination = await maybeIdentity(path.join(adoptStashDir(root), ...move.path.split("/")), move.before.kind === "file");
  if (!source && identitiesEqual(move.before, destination)) {
    move.after = destination;
    move.state = "complete";
    await saveAdoptJournal(root, journal);
    return;
  }
  if (!identitiesEqual(move.before, source) || destination) throw new Error(`retain move identity mismatch: ${move.path}`);
  const result = await secureMoveNoReplace({
    sourceRoot: root,
    sourceRel: move.path,
    destinationRoot: adoptStashDir(root),
    destinationRel: move.path,
    expectedSource: move.before,
    createDestinationParents: true,
  });
  move.after = result.destinationAfter;
  move.state = "complete";
  await saveAdoptJournal(root, journal);
}

async function retainSource(journal: AdoptJournal, inventory?: AdoptInventory): Promise<void> {
  const root = journal.workspace.root;
  for (const move of journal.retainMoves) {
    if (move.state === "complete") continue;
    try { await classifyRetainMove(journal, move); }
    catch (error) {
      journal.phase = "paused"; journal.resumePhase = "retaining";
      journal.pauseReasons.push(error instanceof Error ? error.message : String(error));
      await saveAdoptJournal(root, journal);
      return;
    }
  }
  if (inventory) {
    for (const rel of inventory.topLevel) {
      await revalidateInventorySubtree(root, inventory, rel);
      const move: AdoptRetainMove = {
        path: rel,
        source: path.join(root, ...rel.split("/")),
        destination: path.join(adoptStashDir(root), ...rel.split("/")),
        before: topIdentity(inventory, rel),
        state: "intent",
      };
      journal.retainMoves.push(move);
      await saveAdoptJournal(root, journal);
      await classifyRetainMove(journal, move);
    }
  }
  await bindRetainedRepoIncarnations(journal);
  journal.phase = "baseline";
  await saveAdoptJournal(root, journal);
}

/** Phase 0+1. The caller inventories while holding this exact healthy mutex. */
export async function startAdoption(
  input: StartAdoptionInput,
  inventory: AdoptInventory,
  mutex: WorkspaceSyncMutex,
): Promise<AdoptJournal> {
  if (workspaceSyncMutexDegraded(mutex)) throw new Error("adoption requires a non-degraded workspace mutex");
  await assertHealthyOwnedSyncMutex(mutex, input.root);
  if (await loadAdoptJournal(input.root)) throw new Error("an adoption record already exists; run `rbox adopt status|resume|abort`");
  await headroomCheck(input.root, inventory);
  await makeControlDirectories(input.root);
  const journal: AdoptJournal = {
    version: ADOPT_VERSION,
    journalId: newJournalId(),
    createdAt: new Date().toISOString(),
    workspace: {
      root: path.resolve(input.root), rootReal: input.rootReal, stream: input.stream,
      workspaceId: input.workspaceId, projectId: input.projectId, remoteUrl: input.remoteUrl,
      deviceId: input.deviceId, syncGit: input.syncGit, respectGitignore: input.respectGitignore,
      ...(input.name ? { name: input.name } : {}),
    },
    phase: "retaining",
    pauseReasons: [],
    inventory: inventory.entries,
    sourceRepos: inventory.sourceRepos,
    retainedBytes: inventory.retainedBytes.toString(),
    retainMoves: [],
    baseline: {
      started: false, complete: false, continuationNonce: crypto.randomBytes(16).toString("hex"),
      consumed: false, mutexIncarnation: mutex.incarnation,
    },
    gitRepos: [], overlayMoves: [], createdDirectories: [],
    cache: { invalidated: false },
    finishSync: { attempted: false, complete: false },
  };
  await saveAdoptJournal(input.root, journal);
  for (const dir of [adoptStashDir(input.root), adoptDisplacedDir(input.root), adoptUnplacedDir(input.root)]) {
    await fs.mkdir(dir, { mode: 0o700 });
    await fsyncDirectory(adoptDir(input.root));
  }
  await retainSource(journal, inventory);
  if (!journal.baseline.complete) {
    bindAdoptBaselineContinuation(mutex, {
      journalId: journal.journalId, root: journal.workspace.root, stream: journal.workspace.stream,
      nonce: journal.baseline.continuationNonce, mutexIncarnation: journal.baseline.mutexIncarnation,
    });
  }
  return journal;
}

export async function refreshAdoptionContinuation(journal: AdoptJournal, mutex: WorkspaceSyncMutex): Promise<void> {
  await assertHealthyOwnedSyncMutex(mutex, journal.workspace.root);
  await assertJournalWorkspaceBinding(journal);
  journal.baseline.continuationNonce = crypto.randomBytes(16).toString("hex");
  journal.baseline.consumed = false;
  journal.baseline.mutexIncarnation = mutex.incarnation;
  if (journal.phase === "paused" && journal.resumePhase) {
    journal.phase = journal.resumePhase;
    journal.resumePhase = undefined;
  }
  journal.pauseReasons = [];
  await saveAdoptJournal(journal.workspace.root, journal);
  if (!journal.baseline.complete) {
    bindAdoptBaselineContinuation(mutex, {
      journalId: journal.journalId, root: journal.workspace.root, stream: journal.workspace.stream,
      nonce: journal.baseline.continuationNonce, mutexIncarnation: journal.baseline.mutexIncarnation,
    });
  }
}

function assertContinuation(journal: AdoptJournal, mutex: WorkspaceSyncMutex): void {
  if (journal.baseline.mutexIncarnation !== mutex.incarnation || mutex.released) throw new Error("adoption continuation mutex incarnation mismatch");
  if (!/^[0-9a-f]{32}$/.test(journal.baseline.continuationNonce)) throw new Error("invalid adoption continuation nonce");
}

/** Resume the closed state machine through local completion, then ordinary sync. */
export async function continueAdoption(journal: AdoptJournal, mutex: WorkspaceSyncMutex, hooks: AdoptionHooks): Promise<AdoptJournal> {
  const root = journal.workspace.root;
  await assertHealthyOwnedSyncMutex(mutex, root);
  await assertJournalWorkspaceBinding(journal);
  assertContinuation(journal, mutex);
  const persist = () => saveAdoptJournal(root, journal);

  if ((journal.phase as AdoptPhase) === "paused") return journal;
  if (journal.phase === "retaining") await retainSource(journal);
  if (journal.phase === "paused") return journal;

  if (journal.phase === "baseline") {
    if (!journal.baseline.consumed) {
      assertContinuation(journal, mutex);
      journal.baseline.started = true;
      journal.baseline.consumed = true;
      await persist();
    } else if (!journal.baseline.complete) {
      // A top-level replay in one process is forbidden. Crash recovery must first
      // mint a fresh nonce with refreshAdoptionContinuation().
      throw new Error("adoption baseline continuation was already consumed; run `rbox adopt resume`");
    }
    if (!journal.baseline.complete) {
      const nonce = journal.baseline.continuationNonce;
      beginAdoptBaselineContinuation(mutex, {
        journalId: journal.journalId,
        root,
        stream: journal.workspace.stream,
        nonce,
        mutexIncarnation: journal.baseline.mutexIncarnation,
      });
      let established = false;
      try {
        await hooks.establishBaseline(journal, mutex);
        established = true;
      } finally {
        endAdoptBaselineContinuation(mutex, nonce);
      }
      if (established) retireAdoptBaselineContinuation(mutex, nonce);
    }
    journal.baseline.complete = true;
    journal.phase = "git";
    await persist();
  }

  if (journal.phase === "git") {
    await runGitAdoption(journal, persist, hooks.gitDeps);
    if (journal.gitRepos.some((repo) => repo.state === "paused")) {
      journal.phase = "paused"; journal.resumePhase = "git";
      journal.pauseReasons.push(...journal.gitRepos.filter((repo) => repo.state === "paused").map((repo) => `${repo.path}: ${repo.reason ?? "Git operation paused"}`));
      await persist();
      return journal;
    }
    journal.phase = "overlay";
    await persist();
  }

  if (journal.phase === "overlay") {
    await runFileOverlay(journal, persist);
    if ((journal.phase as AdoptPhase) === "paused") return journal;
    journal.phase = "invalidating";
    await persist();
  }

  if (journal.phase === "invalidating") {
    const generation = await invalidateAdoptionCaches(root, "adopt-complete");
    journal.cache = { invalidated: true, generationBefore: generation.before, generationAfter: generation.after };
    await persist();
    journal.phase = "complete";
    await persist();
  }

  if (journal.phase === "complete" && !journal.finishSync.attempted) {
    journal.finishSync.attempted = true;
    await persist();
    try {
      await hooks.finishSync(journal, mutex);
      journal.finishSync.complete = true;
    } catch (error) {
      journal.finishSync.error = error instanceof Error ? error.message : String(error);
    }
    await persist();
  }
  return journal;
}

async function restorePreBaseline(journal: AdoptJournal): Promise<void> {
  const root = journal.workspace.root;
  for (const move of [...journal.retainMoves].reverse()) {
    if (move.state !== "complete") continue;
    const retained = await readAdoptIdentity(move.destination, move.before.kind === "file");
    if (!identitiesEqual(move.after ?? move.before, retained)) throw new Error(`retained source changed: ${move.path}`);
    await secureMoveNoReplace({ sourceRoot: adoptStashDir(root), sourceRel: move.path, destinationRoot: root, destinationRel: move.path, expectedSource: retained, createDestinationParents: true });
  }
}

export async function abortAdoption(journal: AdoptJournal, mutex: WorkspaceSyncMutex): Promise<AdoptJournal> {
  const root = journal.workspace.root;
  await assertHealthyOwnedSyncMutex(mutex, root);
  journal.phase = "aborting";
  journal.resumePhase = undefined;
  journal.pauseReasons = [];
  const persist = () => saveAdoptJournal(root, journal);
  await persist();
  try {
    if (!journal.baseline.started) await restorePreBaseline(journal);
    else {
      await abortFileOverlay(journal, persist);
      if ((journal.phase as AdoptPhase) === "paused") return journal;
      await abortGitAdoption(journal, persist);
      if (journal.gitRepos.some((repo) => repo.state === "paused")) {
        journal.phase = "paused"; journal.resumePhase = "aborting"; await persist(); return journal;
      }
    }
    const generation = await invalidateAdoptionCaches(root, "adopt-abort");
    journal.cache = { invalidated: true, generationBefore: generation.before, generationAfter: generation.after };
    await persist();
    journal.phase = "aborted";
    await persist();
  } catch (error) {
    journal.phase = "paused"; journal.resumePhase = "aborting";
    journal.pauseReasons.push(error instanceof Error ? error.message : String(error));
    await persist();
  }
  return journal;
}
