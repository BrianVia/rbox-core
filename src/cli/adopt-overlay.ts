import fs from "node:fs/promises";
import path from "node:path";
import {
  createAdoptDirectory,
  removeEmptyAdoptDirectory,
  secureMoveNoReplace,
} from "./adopt-fs.js";
import {
  adoptDisplacedDir,
  adoptStashDir,
  adoptUnplacedDir,
  identitiesEqual,
  readAdoptIdentity,
  type AdoptIdentity,
  type AdoptJournal,
  type AdoptOverlayMove,
} from "./adopt-journal.js";

function relAbs(root: string, rel: string): string {
  return rel === "." ? root : path.join(root, ...rel.split("/"));
}

async function maybeIdentity(abs: string, withContent: boolean): Promise<AdoptIdentity | undefined> {
  try { return await readAdoptIdentity(abs, withContent); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function underGitAdmin(rel: string, repoPaths: readonly string[]): boolean {
  return repoPaths.some((repo) => {
    const dotGit = repo === "." ? ".git" : `${repo}/.git`;
    return rel === dotGit || rel.startsWith(`${dotGit}/`);
  });
}

async function classifyOrRunMove(
  journal: AdoptJournal,
  move: AdoptOverlayMove,
  persist: () => Promise<void>,
): Promise<void> {
  const root = journal.workspace.root;
  const stash = adoptStashDir(root);
  const displaced = adoptDisplacedDir(root);
  const unplaced = adoptUnplacedDir(root);
  const sourceLive = () => maybeIdentity(relAbs(stash, move.source), move.sourceBefore.kind === "file");
  const destLive = () => maybeIdentity(relAbs(root, move.destination), move.sourceBefore.kind === "file");

  try {
    if (move.disposition === "landed") {
      const [source, dest] = await Promise.all([sourceLive(), destLive()]);
      if (!source && identitiesEqual(move.sourceBefore, dest)) {
        move.sourceAfter = dest; move.state = "complete"; await persist(); return;
      }
      if (!identitiesEqual(move.sourceBefore, source) || dest) throw new Error("overlay landed-state identity mismatch");
      const result = await secureMoveNoReplace({ sourceRoot: stash, sourceRel: move.source, destinationRoot: root, destinationRel: move.destination, expectedSource: move.sourceBefore, createDestinationParents: true });
      move.sourceAfter = result.destinationAfter; move.state = "complete"; await persist(); return;
    }

    if (move.disposition === "displaced") {
      const displacedRel = move.displaced!;
      if (move.state === "intent") {
        const [source, baseline, retainedA] = await Promise.all([
          sourceLive(),
          maybeIdentity(relAbs(root, move.destination), move.baselineBefore?.kind === "file"),
          maybeIdentity(relAbs(displaced, displacedRel), move.baselineBefore?.kind === "file"),
        ]);
        if (!identitiesEqual(move.sourceBefore, source)) throw new Error("overlay source identity mismatch before displacement");
        if (!baseline && identitiesEqual(move.baselineBefore, retainedA)) {
          move.baselineAfter = retainedA; move.state = "baseline-displaced"; await persist();
        } else {
          if (!identitiesEqual(move.baselineBefore, baseline) || retainedA) throw new Error("baseline displacement identity mismatch");
          const result = await secureMoveNoReplace({ sourceRoot: root, sourceRel: move.destination, destinationRoot: displaced, destinationRel: displacedRel, expectedSource: move.baselineBefore!, createDestinationParents: true });
          move.baselineAfter = result.destinationAfter; move.state = "baseline-displaced"; await persist();
        }
      }
      const [source, dest] = await Promise.all([sourceLive(), destLive()]);
      if (!source && identitiesEqual(move.sourceBefore, dest)) {
        move.sourceAfter = dest; move.state = "complete"; await persist(); return;
      }
      if (!identitiesEqual(move.sourceBefore, source) || dest) throw new Error("overlay post-displacement identity mismatch");
      const result = await secureMoveNoReplace({ sourceRoot: stash, sourceRel: move.source, destinationRoot: root, destinationRel: move.destination, expectedSource: move.sourceBefore, createDestinationParents: true });
      move.sourceAfter = result.destinationAfter; move.state = "complete"; await persist(); return;
    }

    const retainedRel = move.unplaced!;
    const destinationRoot = unplaced;
    const [source, retained] = await Promise.all([
      sourceLive(),
      maybeIdentity(relAbs(destinationRoot, retainedRel), move.sourceBefore.kind === "file"),
    ]);
    if (!source && identitiesEqual(move.sourceBefore, retained)) {
      move.sourceAfter = retained; move.state = "complete"; await persist(); return;
    }
    if (!identitiesEqual(move.sourceBefore, source) || retained) throw new Error("unplaced identity mismatch");
    const result = await secureMoveNoReplace({ sourceRoot: stash, sourceRel: move.source, destinationRoot, destinationRel: retainedRel, expectedSource: move.sourceBefore, createDestinationParents: true });
    move.sourceAfter = result.destinationAfter; move.state = "complete"; await persist();
  } catch (error) {
    move.state = "paused";
    move.reason = error instanceof Error ? error.message : String(error);
    journal.resumePhase = "overlay";
    journal.phase = "paused";
    journal.pauseReasons.push(`${move.path}: ${move.reason}`);
    await persist();
  }
}

async function addAndRun(
  journal: AdoptJournal,
  move: AdoptOverlayMove,
  persist: () => Promise<void>,
): Promise<void> {
  journal.overlayMoves.push(move);
  await persist();
  await classifyOrRunMove(journal, move, persist);
}

/** Ignore-independent, leafwise B-over-A overlay with retained collisions. */
export async function runFileOverlay(journal: AdoptJournal, persist: () => Promise<void>): Promise<void> {
  const root = journal.workspace.root;
  const stash = adoptStashDir(root);
  const repoPaths = journal.sourceRepos.map((repo) => repo.path);

  for (const move of journal.overlayMoves) {
    if (move.state !== "complete" && move.state !== "aborted") await classifyOrRunMove(journal, move, persist);
    if (journal.phase === "paused") return;
  }
  const known = new Set(journal.overlayMoves.map((move) => move.path));

  const walk = async (relativeDirectory: string): Promise<void> => {
    const sourceDir = relAbs(stash, relativeDirectory || ".");
    const names = await fs.readdir(sourceDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    names.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
    for (const dirent of names) {
      const rel = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
      if (underGitAdmin(rel, repoPaths) || known.has(rel)) continue;
      const sourceAbs = relAbs(stash, rel);
      const source = await readAdoptIdentity(sourceAbs, dirent.isFile());
      const destinationAbs = relAbs(root, rel);
      const destination = await maybeIdentity(destinationAbs, true);

      if (source.kind === "directory") {
        if (!destination) {
          const identity = await createAdoptDirectory(root, rel);
          journal.createdDirectories.push({ path: rel, identity });
          await persist();
          await walk(rel);
          continue;
        }
        if (destination.kind === "directory") {
          await walk(rel);
          continue;
        }
        await addAndRun(journal, {
          path: rel, source: rel, destination: rel, disposition: "unplaced", unplaced: rel,
          sourceBefore: source, baselineBefore: destination, state: "intent", reason: "type collision",
        }, persist);
        if (journal.phase === "paused") return;
        continue;
      }

      if (["fifo", "socket", "device", "other"].includes(source.kind)) {
        await addAndRun(journal, {
          path: rel, source: rel, destination: rel, disposition: "special", unplaced: rel,
          sourceBefore: source, baselineBefore: destination, state: "intent", reason: `special ${source.kind} retained`,
        }, persist);
      } else if (!destination) {
        await addAndRun(journal, {
          path: rel, source: rel, destination: rel, disposition: "landed", sourceBefore: source, state: "intent",
        }, persist);
      } else if (source.kind === destination.kind) {
        await addAndRun(journal, {
          path: rel, source: rel, destination: rel, disposition: "displaced", displaced: rel,
          sourceBefore: source, baselineBefore: destination, state: "intent",
        }, persist);
      } else {
        await addAndRun(journal, {
          path: rel, source: rel, destination: rel, disposition: "unplaced", unplaced: rel,
          sourceBefore: source, baselineBefore: destination, state: "intent", reason: "type collision",
        }, persist);
      }
      if (journal.phase === "paused") return;
    }
  };
  await walk("");
}

export async function abortFileOverlay(journal: AdoptJournal, persist: () => Promise<void>): Promise<void> {
  const root = journal.workspace.root;
  const stash = adoptStashDir(root);
  const displaced = adoptDisplacedDir(root);
  for (const move of [...journal.overlayMoves].reverse()) {
    if (move.state !== "complete") continue;
    try {
      if (move.disposition === "landed" || move.disposition === "displaced") {
        const live = await readAdoptIdentity(relAbs(root, move.destination), move.sourceBefore.kind === "file");
        if (!identitiesEqual(move.sourceAfter ?? move.sourceBefore, live)) throw new Error("live adopted value changed");
        await secureMoveNoReplace({ sourceRoot: root, sourceRel: move.destination, destinationRoot: stash, destinationRel: move.source, expectedSource: live, createDestinationParents: true });
      }
      if (move.disposition === "displaced") {
        const retainedA = await readAdoptIdentity(relAbs(displaced, move.displaced!), move.baselineBefore?.kind === "file");
        if (!identitiesEqual(move.baselineAfter ?? move.baselineBefore, retainedA)) throw new Error("displaced baseline changed");
        await secureMoveNoReplace({ sourceRoot: displaced, sourceRel: move.displaced!, destinationRoot: root, destinationRel: move.destination, expectedSource: retainedA, createDestinationParents: true });
      }
      move.state = "aborted";
      await persist();
    } catch (error) {
      move.state = "paused"; move.reason = error instanceof Error ? error.message : String(error);
      journal.phase = "paused"; journal.resumePhase = "aborting"; journal.pauseReasons.push(`${move.path}: ${move.reason}`); await persist(); return;
    }
  }
  for (const created of [...journal.createdDirectories].reverse()) {
    await removeEmptyAdoptDirectory(root, created.path, created.identity).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    });
  }
}
