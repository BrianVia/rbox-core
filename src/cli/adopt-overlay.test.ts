import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { secureMoveNoReplace } from "./adopt-fs.js";
import { inventoryAdoptionSource } from "./adopt-inventory.js";
import {
  ADOPT_PERSIST_BATCH,
  ADOPT_VERSION,
  adoptDisplacedDir,
  adoptStashDir,
  adoptUnplacedDir,
  createBatchedPersist,
  identitiesEqual,
  readAdoptIdentity,
  type AdoptJournal,
} from "./adopt-journal.js";
import { abortFileOverlay, runFileOverlay } from "./adopt-overlay.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ root: string; stash: string; journal: AdoptJournal; persist: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-adopt-overlay-"));
  roots.push(root);
  const stash = adoptStashDir(root);
  await Promise.all([
    fs.mkdir(stash, { recursive: true }),
    fs.mkdir(adoptDisplacedDir(root), { recursive: true }),
    fs.mkdir(adoptUnplacedDir(root), { recursive: true }),
  ]);
  const journal: AdoptJournal = {
    version: ADOPT_VERSION,
    journalId: "1".repeat(32),
    createdAt: new Date(0).toISOString(),
    workspace: { root, rootReal: await fs.realpath(root), stream: "stream", workspaceId: "ws", projectId: "root", remoteUrl: "https://example.invalid", deviceId: "dev", syncGit: false, respectGitignore: false },
    phase: "overlay", pauseReasons: [], inventory: [], sourceRepos: [], retainedBytes: "0", retainMoves: [],
    baseline: { started: true, complete: true, continuationNonce: "2".repeat(32), consumed: true, mutexIncarnation: "lock" },
    gitRepos: [], overlayMoves: [], createdDirectories: [], cache: { invalidated: false }, finishSync: { attempted: false, complete: false },
  };
  return { root, stash, journal, persist: async () => {} };
}

describe("design 166 file overlay", () => {
  test("A-only survival, same-type collision displacement, and abort are byte-exact", async () => {
    const { root, stash, journal, persist } = await fixture();
    await fs.mkdir(path.join(root, "repo"));
    await fs.mkdir(path.join(stash, "repo"));
    await fs.writeFile(path.join(root, "repo", "a-only.txt"), "A only\n");
    await fs.writeFile(path.join(root, "repo", "same.txt"), "A value\n");
    await fs.writeFile(path.join(stash, "repo", "same.txt"), "B value\n");

    await runFileOverlay(journal, persist);
    expect(await fs.readFile(path.join(root, "repo", "a-only.txt"), "utf8")).toBe("A only\n");
    expect(await fs.readFile(path.join(root, "repo", "same.txt"), "utf8")).toBe("B value\n");
    expect(await fs.readFile(path.join(adoptDisplacedDir(root), "repo", "same.txt"), "utf8")).toBe("A value\n");
    expect(journal.overlayMoves[0]?.disposition).toBe("displaced");

    await abortFileOverlay(journal, persist);
    expect(await fs.readFile(path.join(root, "repo", "same.txt"), "utf8")).toBe("A value\n");
    expect(await fs.readFile(path.join(stash, "repo", "same.txt"), "utf8")).toBe("B value\n");
    expect(await fs.readFile(path.join(root, "repo", "a-only.txt"), "utf8")).toBe("A only\n");
  });

  test("same-type symlink collision lands B and retains A without following either", async () => {
    const { root, stash, journal, persist } = await fixture();
    await fs.symlink("a-target", path.join(root, "link"));
    await fs.symlink("b-target", path.join(stash, "link"));
    await runFileOverlay(journal, persist);
    expect(await fs.readlink(path.join(root, "link"))).toBe("b-target");
    expect(await fs.readlink(path.join(adoptDisplacedDir(root), "link"))).toBe("a-target");
    expect(journal.overlayMoves[0]?.sourceBefore.linkText).toBe("b-target");
  });

  test("file-directory and directory-file/symlink type flips retain complete B subtrees", async () => {
    const { root, stash, journal, persist } = await fixture();
    await fs.writeFile(path.join(root, "a-file"), "A");
    await fs.mkdir(path.join(stash, "a-file"));
    await fs.writeFile(path.join(stash, "a-file", "child"), "B subtree");
    await fs.mkdir(path.join(root, "a-dir"));
    await fs.writeFile(path.join(root, "a-dir", "kept"), "A subtree");
    await fs.writeFile(path.join(stash, "a-dir"), "B file");
    await fs.mkdir(path.join(root, "a-dir-link"));
    await fs.symlink("target", path.join(stash, "a-dir-link"));

    await runFileOverlay(journal, persist);
    expect(await fs.readFile(path.join(root, "a-file"), "utf8")).toBe("A");
    expect(await fs.readFile(path.join(adoptUnplacedDir(root), "a-file", "child"), "utf8")).toBe("B subtree");
    expect(await fs.readFile(path.join(root, "a-dir", "kept"), "utf8")).toBe("A subtree");
    expect(await fs.readFile(path.join(adoptUnplacedDir(root), "a-dir"), "utf8")).toBe("B file");
    expect(await fs.readlink(path.join(adoptUnplacedDir(root), "a-dir-link"))).toBe("target");
    expect(journal.overlayMoves.filter((move) => move.disposition === "unplaced")).toHaveLength(3);
  });

  test("overlay is ignore-independent and final rule files use the same collision policy", async () => {
    const { root, stash, journal, persist } = await fixture();
    await fs.writeFile(path.join(root, ".rboxignore"), "secret.txt\n");
    await fs.writeFile(path.join(stash, ".rboxignore"), "other.txt\n");
    await fs.writeFile(path.join(stash, ".gitignore"), "ignored.txt\n");
    await fs.writeFile(path.join(stash, "secret.txt"), "secret B\n");
    await fs.writeFile(path.join(stash, "ignored.txt"), "ignored B\n");
    await runFileOverlay(journal, persist);
    expect(await fs.readFile(path.join(root, "secret.txt"), "utf8")).toBe("secret B\n");
    expect(await fs.readFile(path.join(root, "ignored.txt"), "utf8")).toBe("ignored B\n");
    expect(await fs.readFile(path.join(root, ".rboxignore"), "utf8")).toBe("other.txt\n");
    expect(await fs.readFile(path.join(adoptDisplacedDir(root), ".rboxignore"), "utf8")).toBe("secret.txt\n");
  });

  test("hardlink topology survives B landing and A displacement/live split", async () => {
    const { root, stash, journal, persist } = await fixture();
    await fs.writeFile(path.join(root, "a-collide"), "A links");
    await fs.link(path.join(root, "a-collide"), path.join(root, "a-only"));
    await fs.writeFile(path.join(stash, "a-collide"), "B links");
    await fs.link(path.join(stash, "a-collide"), path.join(stash, "b-only"));
    await runFileOverlay(journal, persist);
    const [aDisplaced, aOnly, bLive, bOnly] = await Promise.all([
      fs.lstat(path.join(adoptDisplacedDir(root), "a-collide"), { bigint: true }),
      fs.lstat(path.join(root, "a-only"), { bigint: true }),
      fs.lstat(path.join(root, "a-collide"), { bigint: true }),
      fs.lstat(path.join(root, "b-only"), { bigint: true }),
    ]);
    expect(aDisplaced.ino).toBe(aOnly.ino);
    expect(bLive.ino).toBe(bOnly.ino);
  });

  test("FIFO is never opened or materialized live and is reported as retained special state", async () => {
    if (process.platform === "win32") return;
    const { root, stash, journal, persist } = await fixture();
    const proc = Bun.spawnSync(["mkfifo", path.join(stash, "pipe")]);
    expect(proc.exitCode).toBe(0);
    await runFileOverlay(journal, persist);
    expect((await fs.lstat(path.join(adoptUnplacedDir(root), "pipe"))).isFIFO()).toBe(true);
    expect(await fs.lstat(path.join(root, "pipe")).then(() => true, () => false)).toBe(false);
    expect(journal.overlayMoves[0]?.disposition).toBe("special");
  });

  test("full-content hash rejects a large-file stat-token alias", async () => {
    const { stash } = await fixture();
    const file = path.join(stash, "large.bin");
    await fs.writeFile(file, Buffer.alloc(2 * 1024 * 1024, 0x41));
    const before = await readAdoptIdentity(file, true);
    const aliased = { ...before, sha256: "f".repeat(64) };
    expect(identitiesEqual(before, aliased)).toBe(false);
  });

  test("no-clobber writer race preserves both source and unexpected destination", async () => {
    const { root, stash } = await fixture();
    await fs.writeFile(path.join(stash, "race"), "B");
    const expected = await readAdoptIdentity(path.join(stash, "race"), true);
    await fs.writeFile(path.join(root, "race"), "writer");
    await expect(secureMoveNoReplace({ sourceRoot: stash, sourceRel: "race", destinationRoot: root, destinationRel: "race", expectedSource: expected })).rejects.toThrow("destination appeared");
    expect(await fs.readFile(path.join(root, "race"), "utf8")).toBe("writer");
    expect(await fs.readFile(path.join(stash, "race"), "utf8")).toBe("B");
  });

  test("symlinked destination parent is never traversed", async () => {
    const { root, stash } = await fixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-adopt-outside-"));
    roots.push(outside);
    await fs.mkdir(path.join(stash, "escape"));
    await fs.writeFile(path.join(stash, "escape", "value"), "B");
    await fs.symlink(outside, path.join(root, "escape"));
    const expected = await readAdoptIdentity(path.join(stash, "escape", "value"), true);
    await expect(secureMoveNoReplace({ sourceRoot: stash, sourceRel: "escape/value", destinationRoot: root, destinationRel: "escape/value", expectedSource: expected })).rejects.toThrow();
    expect(await fs.readdir(outside)).toEqual([]);
  });

  test("validated parent exchanged for a symlink before rename pauses without escape", async () => {
    const { root, stash } = await fixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-adopt-race-outside-"));
    roots.push(outside);
    await fs.mkdir(path.join(stash, "source"));
    await fs.mkdir(path.join(root, "destination"));
    await fs.writeFile(path.join(stash, "source", "value"), "B");
    const expected = await readAdoptIdentity(path.join(stash, "source", "value"), true);
    await expect(secureMoveNoReplace({
      sourceRoot: stash, sourceRel: "source/value", destinationRoot: root, destinationRel: "destination/value", expectedSource: expected,
      beforeRename: async () => {
        await fs.rename(path.join(root, "destination"), path.join(root, "parked-parent"));
        await fs.symlink(outside, path.join(root, "destination"));
      },
    })).rejects.toThrow("parent identity changed");
    expect(await fs.readFile(path.join(stash, "source", "value"), "utf8")).toBe("B");
    expect(await fs.readdir(outside)).toEqual([]);
  });

  test("mode-000 source directory is refused by phase-0 inventory before movement", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-adopt-mode-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "closed"), { mode: 0 });
    try {
      await expect(inventoryAdoptionSource(root)).rejects.toThrow(path.join(root, "closed"));
      expect(await fs.lstat(path.join(root, "closed")).then(() => true, () => false)).toBe(true);
    } finally {
      await fs.chmod(path.join(root, "closed"), 0o700);
    }
  });

  test("rename-visible-before-journal-advance is closed-classified as complete", async () => {
    const { root, stash, journal, persist } = await fixture();
    await fs.writeFile(path.join(stash, "crash.txt"), "B");
    const before = await readAdoptIdentity(path.join(stash, "crash.txt"), true);
    journal.overlayMoves.push({ path: "crash.txt", source: "crash.txt", destination: "crash.txt", disposition: "landed", sourceBefore: before, state: "intent" });
    await secureMoveNoReplace({ sourceRoot: stash, sourceRel: "crash.txt", destinationRoot: root, destinationRel: "crash.txt", expectedSource: before });
    await runFileOverlay(journal, persist);
    expect(journal.overlayMoves[0]?.state).toBe("complete");
    expect(await fs.readFile(path.join(root, "crash.txt"), "utf8")).toBe("B");
  });
});

describe("issue 501 journal persist batching", () => {
  test("K+1 events cost exactly one batch write plus a trailing flush", async () => {
    let writes = 0;
    let clock = 0;
    const batched = createBatchedPersist(async () => { writes += 1; }, { batch: 3, maxDelayMs: 10_000, now: () => clock });
    for (let event = 0; event < 4; event += 1) await batched.persist();
    expect(writes).toBe(1);
    await batched.flush();
    expect(writes).toBe(2);
    await batched.flush();
    expect(writes).toBe(2);
  });

  test("a slow trickle still persists on the max-delay bound", async () => {
    let writes = 0;
    let clock = 0;
    const batched = createBatchedPersist(async () => { writes += 1; }, { batch: 1000, maxDelayMs: 2000, now: () => clock });
    await batched.persist();
    expect(writes).toBe(0);
    clock = 2000;
    await batched.persist();
    expect(writes).toBe(1);
  });

  test("overlay write amplification scales with events/K, not events", async () => {
    const { root, stash, journal } = await fixture();
    const count = ADOPT_PERSIST_BATCH + 1;
    await Promise.all(Array.from({ length: count }, (_unused, index) => fs.writeFile(path.join(stash, `f${index}`), `B${index}`)));
    let writes = 0;
    await runFileOverlay(journal, async () => { writes += 1; });
    expect(journal.overlayMoves).toHaveLength(count);
    expect(journal.overlayMoves.every((move) => move.state === "complete")).toBe(true);
    expect(await fs.readFile(path.join(root, `f${count - 1}`), "utf8")).toBe(`B${count - 1}`);
    // Eager persistence wrote >= 2 * count times; batching stays within a small
    // multiple of count / ADOPT_PERSIST_BATCH.
    expect(writes).toBeLessThanOrEqual(12);
  });

  test("a crash mid-batch replays journaled intents without loss or duplication", async () => {
    const { root, stash, journal, persist } = await fixture();
    await fs.writeFile(path.join(stash, "landed"), "B landed");
    await fs.writeFile(path.join(stash, "displaced"), "B displaced");
    await fs.writeFile(path.join(root, "displaced"), "A displaced");
    await fs.writeFile(path.join(stash, "untouched"), "B untouched");
    const [landedBefore, displacedBefore, untouchedBefore, baselineBefore] = await Promise.all([
      readAdoptIdentity(path.join(stash, "landed"), true),
      readAdoptIdentity(path.join(stash, "displaced"), true),
      readAdoptIdentity(path.join(stash, "untouched"), true),
      readAdoptIdentity(path.join(root, "displaced"), true),
    ]);
    // The batch's intents reached disk; the process died with one move fully
    // executed, one half-executed, and one not started — all unpersisted.
    journal.overlayMoves.push(
      { path: "landed", source: "landed", destination: "landed", disposition: "landed", sourceBefore: landedBefore, state: "intent" },
      { path: "displaced", source: "displaced", destination: "displaced", disposition: "displaced", displaced: "displaced", sourceBefore: displacedBefore, baselineBefore, state: "intent" },
      { path: "untouched", source: "untouched", destination: "untouched", disposition: "landed", sourceBefore: untouchedBefore, state: "intent" },
    );
    await secureMoveNoReplace({ sourceRoot: stash, sourceRel: "landed", destinationRoot: root, destinationRel: "landed", expectedSource: landedBefore });
    await secureMoveNoReplace({ sourceRoot: root, sourceRel: "displaced", destinationRoot: adoptDisplacedDir(root), destinationRel: "displaced", expectedSource: baselineBefore });

    await runFileOverlay(journal, persist);
    expect(journal.phase).toBe("overlay");
    expect(journal.overlayMoves).toHaveLength(3);
    expect(journal.overlayMoves.every((move) => move.state === "complete")).toBe(true);
    expect(await fs.readFile(path.join(root, "landed"), "utf8")).toBe("B landed");
    expect(await fs.readFile(path.join(root, "displaced"), "utf8")).toBe("B displaced");
    expect(await fs.readFile(path.join(root, "untouched"), "utf8")).toBe("B untouched");
    expect(await fs.readFile(path.join(adoptDisplacedDir(root), "displaced"), "utf8")).toBe("A displaced");
    expect(await fs.readdir(stash)).toEqual([]);
  });

  test("abort replays a reversal that crashed before its journal write", async () => {
    const { root, stash, journal, persist } = await fixture();
    await fs.writeFile(path.join(stash, "landed"), "B landed");
    await fs.writeFile(path.join(stash, "same"), "B same");
    await fs.writeFile(path.join(root, "same"), "A same");
    await runFileOverlay(journal, persist);

    const landed = journal.overlayMoves.find((move) => move.path === "landed")!;
    const same = journal.overlayMoves.find((move) => move.path === "same")!;
    // Reverse both of "landed"'s and one of "same"'s renames by hand, leaving every
    // move still journaled as complete — the state a batched abort crash leaves.
    await secureMoveNoReplace({ sourceRoot: root, sourceRel: "landed", destinationRoot: stash, destinationRel: "landed", expectedSource: landed.sourceAfter! });
    await secureMoveNoReplace({ sourceRoot: root, sourceRel: "same", destinationRoot: stash, destinationRel: "same", expectedSource: same.sourceAfter! });

    await abortFileOverlay(journal, persist);
    expect(journal.phase).toBe("overlay");
    expect(journal.overlayMoves.every((move) => move.state === "aborted")).toBe(true);
    expect(await fs.readFile(path.join(stash, "landed"), "utf8")).toBe("B landed");
    expect(await fs.readFile(path.join(stash, "same"), "utf8")).toBe("B same");
    expect(await fs.readFile(path.join(root, "same"), "utf8")).toBe("A same");
    expect(await fs.lstat(path.join(root, "landed")).then(() => true, () => false)).toBe(false);
  });
});
