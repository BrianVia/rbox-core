import fs from "node:fs/promises";
import path from "node:path";
import { DirCache, HashCache } from "../engine/index.js";
import { git } from "../engine/git/shared.js";
import { fsyncDirectory } from "../engine/fsutil.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import { loadConfigIfPresent, saveConfig, syncStreamId, type WorkspaceConfig } from "./config.js";
import { acknowledgeCacheGeneration } from "./adopt-cache.js";
import { abortAdoption, continueAdoption, refreshAdoptionContinuation } from "./adopt-lifecycle.js";
import {
  adoptDir,
  adoptStashDir,
  adoptUnplacedDir,
  findAdoptRoot,
  isTerminalAdoptPhase,
  loadAdoptJournal,
  type AdoptJournal,
} from "./adopt-journal.js";
import { emitJson } from "./json.js";
import { confirmDestructive } from "./prompt.js";
import { acquireWorkspaceSyncMutexForAdopt, releaseWorkspaceSyncMutex } from "./sync-mutex.js";
import { sync } from "./sync.js";

export interface AdoptStatusReport {
  root: string;
  journalId: string;
  phase: string;
  resumePhase?: string;
  pauseReasons: string[];
  retained: string[];
  displaced: string[];
  unplaced: string[];
  collisions: Array<{ path: string; live: string; retained: string; reason: string }>;
  skippedSpecial: Array<{ path: string; retained: string; kind: string }>;
  fastForwarded: string[];
  parked: Array<{ repo: string; ref?: string; reason: string }>;
  retainedGit: Array<{ repo: string; refs: string[]; detachedHead?: string; location: string }>;
  finishSync: AdoptJournal["finishSync"];
}

async function retainedRepoLocation(journal: AdoptJournal, rel: string): Promise<string> {
  const candidates = [
    rel === "." ? adoptStashDir(journal.workspace.root) : path.join(adoptStashDir(journal.workspace.root), ...rel.split("/")),
    rel === "." ? adoptUnplacedDir(journal.workspace.root) : path.join(adoptUnplacedDir(journal.workspace.root), ...rel.split("/")),
  ];
  for (const candidate of candidates) {
    if (await fs.lstat(candidate).then((stat) => stat.isDirectory(), () => false)) return candidate;
  }
  return candidates[0]!;
}

export async function adoptionStatus(root: string): Promise<AdoptStatusReport> {
  const journal = await loadAdoptJournal(root);
  if (!journal) throw new Error(`no adoption journal found at ${root}`);
  const retainedGit: AdoptStatusReport["retainedGit"] = [];
  for (const source of journal.sourceRepos) {
    const location = await retainedRepoLocation(journal, source.path);
    const refs = (await git(location, ["for-each-ref", "--format=%(refname)"]).catch(() => "")).split("\n").filter(Boolean).sort();
    const head = await git(location, ["rev-parse", "HEAD"]).catch(() => "");
    const symbolic = await git(location, ["symbolic-ref", "-q", "HEAD"]).catch(() => "");
    retainedGit.push({ repo: source.path, refs, location, ...(head && !symbolic ? { detachedHead: head } : {}) });
  }
  return {
    root,
    journalId: journal.journalId,
    phase: journal.phase,
    ...(journal.resumePhase ? { resumePhase: journal.resumePhase } : {}),
    pauseReasons: [...journal.pauseReasons],
    retained: journal.retainMoves.filter((move) => move.state === "complete").map((move) => move.destination),
    displaced: journal.overlayMoves.filter((move) => move.displaced).map((move) => path.join(adoptDir(root), "displaced", move.displaced!)),
    unplaced: journal.overlayMoves.filter((move) => move.unplaced).map((move) => path.join(adoptDir(root), "unplaced", move.unplaced!)),
    collisions: journal.overlayMoves.filter((move) => move.disposition === "unplaced").map((move) => ({
      path: move.path,
      live: path.join(root, ...move.destination.split("/")),
      retained: path.join(adoptUnplacedDir(root), ...move.unplaced!.split("/")),
      reason: move.reason ?? "type collision",
    })),
    skippedSpecial: journal.overlayMoves.filter((move) => move.disposition === "special").map((move) => ({
      path: move.path,
      retained: path.join(adoptUnplacedDir(root), ...move.unplaced!.split("/")),
      kind: move.sourceBefore.kind,
    })),
    fastForwarded: journal.gitRepos.flatMap((repo) => repo.branches.filter((branch) => ["cas-complete", "index-complete"].includes(branch.state)).map((branch) => `${repo.path}:${branch.ref}`)),
    parked: journal.gitRepos.flatMap((repo) => [
      ...(repo.state === "parked" || repo.state === "paused" ? [{ repo: repo.path, reason: repo.reason ?? repo.state }] : []),
      ...repo.branches.filter((branch) => branch.state === "parked" || branch.state === "paused").map((branch) => ({ repo: repo.path, ref: branch.ref, reason: branch.reason ?? branch.state })),
    ]),
    retainedGit,
    finishSync: { ...journal.finishSync },
  };
}

async function ensureJournalConfig(journal: AdoptJournal): Promise<void> {
  const current = await loadConfigIfPresent(journal.workspace.root);
  if (current) {
    if (syncStreamId(current) !== journal.workspace.stream) throw new Error("workspace config does not match adoption journal");
    return;
  }
  const cfg: WorkspaceConfig = {
    schema: "e2ee/v1",
    remoteWorkspaceId: journal.workspace.workspaceId,
    projectId: journal.workspace.projectId,
    deviceId: journal.workspace.deviceId,
    rootPath: journal.workspace.root,
    remoteUrl: journal.workspace.remoteUrl,
    token: "",
    syncGit: journal.workspace.syncGit,
    respectGitignore: journal.workspace.respectGitignore,
    ...(journal.workspace.name ? { name: journal.workspace.name } : {}),
  };
  await saveConfig(journal.workspace.root, cfg);
}

async function resume(root: string, journal: AdoptJournal): Promise<AdoptJournal> {
  if (isTerminalAdoptPhase(journal.phase)) throw new Error(`adoption is already ${journal.phase}`);
  const mutex = await acquireWorkspaceSyncMutexForAdopt(root, "resume", journal.journalId);
  try {
    await refreshAdoptionContinuation(journal, mutex);
    if (journal.phase === "aborting") return abortAdoption(journal, mutex);
    // Only unprepared PARKED branches may be freshly classified on resume.
    for (const repo of journal.gitRepos) {
      if (repo.state !== "parked") continue;
      repo.branches = repo.branches.filter((branch) => branch.state !== "parked");
      repo.state = "pending";
      repo.reason = undefined;
    }
    await ensureJournalConfig(journal);
    const { cfg, deps } = await buildAuthedRemote(root);
    deps.syncMutex = mutex;
    return continueAdoption(journal, mutex, {
      establishBaseline: async () => { await sync(root, cfg, deps); },
      finishSync: async (current) => {
        deps.cache = new HashCache();
        deps.dircache = new DirCache();
        deps.forceFullScan = true;
        await sync(root, cfg, deps);
        if (current.cache.generationAfter !== undefined) {
          await acknowledgeCacheGeneration(root, current.cache.generationAfter, `foreground-${current.journalId}`);
        }
      },
    });
  } finally {
    await releaseWorkspaceSyncMutex(mutex);
  }
}

async function abort(root: string, journal: AdoptJournal): Promise<AdoptJournal> {
  if (isTerminalAdoptPhase(journal.phase)) throw new Error(`adoption is already ${journal.phase}`);
  const mutex = await acquireWorkspaceSyncMutexForAdopt(root, "abort", journal.journalId);
  try { return await abortAdoption(journal, mutex); }
  finally { await releaseWorkspaceSyncMutex(mutex); }
}

async function clean(root: string, journal: AdoptJournal, yes: boolean): Promise<void> {
  if (!isTerminalAdoptPhase(journal.phase)) throw new Error("adoption retention can be cleaned only after complete or aborted");
  const report = await adoptionStatus(root);
  const locations = [...report.retained, ...report.displaced, ...report.unplaced, ...report.retainedGit.map((repo) => repo.location)];
  process.stderr.write(`adoption clean will remove ${locations.length} retained location(s) under ${adoptDir(root)}\n`);
  const confirmed = await confirmDestructive({
    message: "Permanently remove retained adoption recovery data?",
    yes,
    default: false,
    headless: "deny",
  });
  if (!confirmed) throw new Error("adoption clean requires explicit confirmation (--yes)");
  const mutex = await acquireWorkspaceSyncMutexForAdopt(root, "clean", journal.journalId);
  try {
    await fs.rm(adoptDir(root), { recursive: true, force: true });
    await fsyncDirectory(path.join(root, ".rbox"));
  }
  finally { await releaseWorkspaceSyncMutex(mutex); }
}

export async function adoptCmd(
  subcommand: string | undefined,
  start: string,
  options: { json?: boolean; yes?: boolean } = {},
): Promise<void> {
  if (!subcommand || !["status", "resume", "abort", "clean"].includes(subcommand)) {
    throw new Error("usage: rbox adopt <status|resume|abort|clean> [path] [--json] [--yes]");
  }
  const root = await findAdoptRoot(start);
  if (!root) throw new Error("no .rbox/adopt/journal.json found from this path");
  const journal = await loadAdoptJournal(root);
  if (!journal) throw new Error("adoption journal disappeared");
  if (subcommand === "status") {
    const report = await adoptionStatus(root);
    if (options.json) emitJson(report);
    else {
      console.log(`adoption ${report.phase}${report.resumePhase ? ` (resume: ${report.resumePhase})` : ""}`);
      for (const reason of report.pauseReasons) console.log(`  paused: ${reason}`);
      for (const branch of report.fastForwarded) console.log(`  fast-forwarded: ${branch}`);
      for (const parked of report.parked) console.log(`  parked: ${parked.repo}${parked.ref ? `:${parked.ref}` : ""} — ${parked.reason}`);
      for (const location of report.displaced) console.log(`  displaced: ${location}`);
      for (const location of report.unplaced) console.log(`  unplaced: ${location}`);
      for (const collision of report.collisions) console.log(`  collision: ${collision.path} — A live at ${collision.live}; B retained at ${collision.retained}`);
      for (const special of report.skippedSpecial) console.log(`  skipped ${special.kind}: ${special.path} — retained at ${special.retained}`);
      for (const repo of report.retainedGit) console.log(`  retained Git: ${repo.repo} at ${repo.location} (${repo.refs.length} refs${repo.detachedHead ? ", detached HEAD" : ""})`);
    }
    return;
  }
  if (subcommand === "resume") {
    const result = await resume(root, journal);
    console.log(`adoption ${result.phase}`);
    return;
  }
  if (subcommand === "abort") {
    const result = await abort(root, journal);
    console.log(`adoption ${result.phase}`);
    return;
  }
  await clean(root, journal, options.yes === true);
  console.log("adoption retention cleaned");
}
