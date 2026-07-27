import { afterEach, beforeEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MutationGateClosedError, ShutdownMutationGate } from "../../engine/mutation-gate.js";
import { formatLockMarker, observeLockMarker, publishLockMarker, releaseObservedLock, type ProcessIncarnation } from "../../engine/git/lockfile.js";
import {
  acquirePreparedStateCasLocks,
  classifyStateCasLockEvidence,
  markStateCasCommitted,
  prepareStateCasLocks,
  recoverStateCasLocks,
  stateCasJournalDir,
  type JournalEvidence,
  type MarkerEvidence,
  type OwnerEvidence,
} from "./state-cas-locks.js";

const OWNER: ProcessIncarnation = { hostId: "a".repeat(32), bootId: "b".repeat(32), pid: 41, startTime: "1" };
let root = "";

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-state-cas-locks-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function bareCommon(name = "common.git"): Promise<string> {
  const common = path.join(root, name);
  const child = Bun.spawn(["git", "init", "--bare", common], { stdout: "ignore", stderr: "pipe" });
  const exit = await child.exited;
  if (exit !== 0) throw new Error(await new Response(child.stderr).text());
  return common;
}

async function runGit(repo: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  const exit = await child.exited;
  if (exit !== 0) throw new Error(await new Response(child.stderr).text());
  return (await new Response(child.stdout).text()).trim();
}

const identity = (status: "alive" | "dead" | "unknown") => ({
  current: async () => OWNER,
  probe: async () => status === "alive"
    ? { status: "alive" as const, startTime: OWNER.startTime }
    : status === "dead"
      ? { status: "dead" as const }
      : { status: "unknown" as const },
});

for (const journal of ["valid", "absent", "corrupt"] as const satisfies readonly JournalEvidence[]) {
  for (const owner of ["alive", "dead"] as const satisfies readonly OwnerEvidence[]) {
    for (const marker of ["match", "mismatch-foreign"] as const satisfies readonly MarkerEvidence[]) {
      test(`R2 crash matrix: journal=${journal} owner=${owner} marker=${marker}`, () => {
        const actual = classifyStateCasLockEvidence(journal, owner, marker);
        const expected = journal === "corrupt" ? "indeterminate"
          : journal === "valid" && marker === "match" ? owner === "alive" ? "live" : "recoverable-rbox"
          : "stale-unattributed";
        expect(actual).toBe(expected);
      });
    }
  }
}

test("R2 unknown liveness and marker inspection errors fail closed", () => {
  expect(classifyStateCasLockEvidence("valid", "unknown", "match")).toBe("indeterminate");
  expect(classifyStateCasLockEvidence("valid", "dead", "error")).toBe("indeterminate");
  expect(classifyStateCasLockEvidence("valid", "dead", "mismatch-live")).toBe("live");
});

test("normal release removes only the exact acquired observation", async () => {
  const lock = path.join(root, "refs", "heads", "main.lock");
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const original = formatLockMarker({ ...OWNER, token: crypto.randomBytes(16).toString("hex") });
  const created = await publishLockMarker(lock, original);
  expect(created.status).toBe("created");
  if (created.status !== "created") return;
  await fs.unlink(lock);
  const successor = formatLockMarker({ ...OWNER, token: crypto.randomBytes(16).toString("hex") });
  expect((await publishLockMarker(lock, successor)).status).toBe("created");
  expect((await releaseObservedLock(lock, created.observation)).released).toBe(false);
  expect((await observeLockMarker(lock))?.raw).toBe(successor);
});

test("exact release refuses symlink and non-regular replacements", async () => {
  const target = path.join(root, "target");
  await fs.writeFile(target, "foreign");
  for (const kind of ["symlink", "directory"] as const) {
    const lock = path.join(root, `${kind}.lock`);
    const raw = formatLockMarker({ ...OWNER, token: crypto.randomBytes(16).toString("hex") });
    const created = await publishLockMarker(lock, raw);
    expect(created.status).toBe("created");
    if (created.status !== "created") continue;
    await fs.unlink(lock);
    if (kind === "symlink") await fs.symlink(target, lock);
    else await fs.mkdir(lock);
    expect((await releaseObservedLock(lock, created.observation)).released).toBe(false);
    expect(await fs.lstat(lock).then(() => true)).toBe(true);
    await fs.rm(lock, { recursive: true, force: true });
  }
});

test("state-CAS acquisition refuses a symlinked lock parent", async () => {
  const common = path.join(root, "common");
  const outside = path.join(root, "outside");
  await fs.mkdir(common);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(common, "refs"));
  const prepared = await prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, [{
    commonDir: common,
    lockPath: path.join(common, "refs", "heads", "main.lock"),
    proofs: [],
  }], { identity: { current: async () => OWNER, probe: async () => ({ status: "alive", startTime: OWNER.startTime }) } });
  expect(prepared).toBeDefined();
  await expect(acquirePreparedStateCasLocks(prepared!)).rejects.toThrow("unsafe Git lock parent");
  expect(await fs.readdir(outside)).toEqual([]);
});

test("gate closure during marker staging wins before the first visible lock", async () => {
  const common = await bareCommon();
  const lockPath = path.join(common, "refs", "heads", "main.lock");
  const prepared = await prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, [{ commonDir: common, lockPath, proofs: [] }], { identity: identity("alive") });
  const gate = new ShutdownMutationGate();
  const lease = gate.enter({ phase: "state-cas" });
  await expect(acquirePreparedStateCasLocks(prepared!, {
    hooks: { afterTempFsync: () => gate.close() },
    beforeLockPublish: () => { if (lease.abortRequested) throw new MutationGateClosedError(); },
  })).rejects.toThrow(MutationGateClosedError);
  lease.finish();
  expect(await fs.lstat(lockPath).then(() => true, () => false)).toBe(false);
});

test("state-CAS refuses publication after common-directory inode replacement", async () => {
  const common = await bareCommon();
  const lockPath = path.join(common, "refs", "heads", "main.lock");
  const prepared = await prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, [{ commonDir: common, lockPath, proofs: [] }], { identity: identity("alive") });
  const displaced = `${common}.old`;
  await fs.rename(common, displaced);
  await fs.mkdir(common);
  await expect(acquirePreparedStateCasLocks(prepared!)).rejects.toThrow("identity changed");
  expect(await fs.lstat(lockPath).then(() => true, () => false)).toBe(false);
});

test("recovery recognizes a live replacement marker and leaves it untouched", async () => {
  const common = path.join(root, "common");
  await fs.mkdir(path.join(common, "refs", "heads"), { recursive: true });
  const lockPath = path.join(common, "refs", "heads", "main.lock");
  const prepared = await prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, [{
    commonDir: common,
    lockPath,
    proofs: [],
  }], { identity: { current: async () => OWNER, probe: async () => ({ status: "alive", startTime: OWNER.startTime }) } });
  const replacement = { ...OWNER, pid: OWNER.pid + 1, startTime: "2" };
  const raw = formatLockMarker({ ...replacement, token: crypto.randomBytes(16).toString("hex") });
  expect((await publishLockMarker(lockPath, raw)).status).toBe("created");
  expect((await acquirePreparedStateCasLocks(prepared!)).blocked.has(lockPath)).toBe(true);
  const recovered = await recoverStateCasLocks(root, {
    commonDir: common,
    identity: {
      current: async () => replacement,
      probe: async (pid) => pid === replacement.pid
        ? { status: "alive", startTime: replacement.startTime }
        : { status: "dead" },
    },
  });
  expect(recovered).toMatchObject({ recovered: 0, live: 1 });
  expect((await observeLockMarker(lockPath))?.raw).toBe(raw);
});

test("dead-owner recovery reaps the exact marker, validates Git, and retires its journal", async () => {
  const common = await bareCommon();
  const lockPath = path.join(common, "refs", "heads", "main.lock");
  const prepared = await prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, [{
    commonDir: common,
    lockPath,
    proofs: [{ repo: ".", ref: "refs/heads/main", expectedOid: null }],
  }], { identity: identity("alive") });
  const acquired = await acquirePreparedStateCasLocks(prepared!);
  expect(acquired.held).toHaveLength(1);

  expect(await recoverStateCasLocks(root, { commonDir: common, identity: identity("dead") })).toMatchObject({
    recovered: 1,
    indeterminate: 0,
  });
  expect(await fs.lstat(lockPath).then(() => true, () => false)).toBe(false);
  expect(await fs.lstat(prepared!.journalPath).then(() => true, () => false)).toBe(false);
});

test("dead-owner recovery preserves a replaced inode containing the copied marker", async () => {
  const common = await bareCommon();
  const lockPath = path.join(common, "refs", "heads", "main.lock");
  const prepared = await prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, [{
    commonDir: common,
    lockPath,
    proofs: [{ repo: ".", ref: "refs/heads/main", expectedOid: null }],
  }], { identity: identity("alive") });
  await acquirePreparedStateCasLocks(prepared!);
  const marker = prepared!.journal.commonDirs[0]!.locks[0]!.marker;
  await fs.unlink(lockPath);
  await fs.writeFile(lockPath, marker);

  const result = await recoverStateCasLocks(root, { commonDir: common, identity: identity("dead") });
  expect(result).toMatchObject({ recovered: 0, stale: 1 });
  expect(await fs.readFile(lockPath, "utf8")).toBe(marker);
  expect(await fs.lstat(prepared!.journalPath).then(() => true, () => false)).toBe(true);
});

test("two concurrent recoverers serialize and reap an owned lock exactly once", async () => {
  const common = await bareCommon();
  const lockPath = path.join(common, "refs", "heads", "main.lock");
  const prepared = await prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, [{
    commonDir: common,
    lockPath,
    proofs: [{ repo: ".", ref: "refs/heads/main", expectedOid: null }],
  }], { identity: identity("alive") });
  await acquirePreparedStateCasLocks(prepared!);

  const results = await Promise.all([
    recoverStateCasLocks(root, { commonDir: common, identity: identity("dead") }),
    recoverStateCasLocks(root, { commonDir: common, identity: identity("dead") }),
  ]);
  expect(results.reduce((sum, result) => sum + result.recovered, 0)).toBe(1);
  expect(await fs.lstat(lockPath).then(() => true, () => false)).toBe(false);
});

test("mixed cohort recovers exact-owned lock beside changed foreign blocker", async () => {
  const common = await bareCommon();
  const ownedPath = path.join(common, "refs", "heads", "a-owned.lock");
  const foreignPath = path.join(common, "refs", "heads", "z-foreign.lock");
  const foreignMarker = formatLockMarker({ ...OWNER, pid: OWNER.pid + 1, startTime: "2", token: crypto.randomBytes(16).toString("hex") });
  expect((await publishLockMarker(foreignPath, foreignMarker)).status).toBe("created");
  const prepared = await prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, [
    { commonDir: common, lockPath: ownedPath, proofs: [{ repo: ".", ref: "refs/heads/a-owned", expectedOid: null }] },
    { commonDir: common, lockPath: foreignPath, proofs: [{ repo: ".", ref: "refs/heads/changed", expectedOid: null }] },
  ], { identity: identity("alive") });
  const acquired = await acquirePreparedStateCasLocks(prepared!);
  expect(acquired.held).toHaveLength(1);
  await runGit(common, ["update-ref", "refs/heads/changed", "1".repeat(40)]).catch(async () => {
    // Bare repositories reject nonexistent objects; a symbolic ref still
    // changes the proof without affecting the owned sibling.
    await fs.writeFile(path.join(common, "refs", "heads", "changed"), `${"1".repeat(40)}\n`);
  });

  const result = await recoverStateCasLocks(root, { commonDir: common, identity: identity("dead") });
  expect(result.recovered).toBe(1);
  expect(await fs.lstat(ownedPath).then(() => true, () => false)).toBe(false);
  expect(await fs.readFile(foreignPath, "utf8")).toBe(foreignMarker);
});

test("recovery retains its journal when exact unlink or directory durability fails", async () => {
  const common = await bareCommon();
  const lockPath = path.join(common, "refs", "heads", "main.lock");
  const prepared = await prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, [{
    commonDir: common,
    lockPath,
    proofs: [{ repo: ".", ref: "refs/heads/main", expectedOid: null }],
  }], { identity: identity("alive") });
  await acquirePreparedStateCasLocks(prepared!);

  const result = await recoverStateCasLocks(root, {
    commonDir: common,
    identity: identity("dead"),
    releaseObserved: async () => ({ released: false, durable: false, error: new Error("injected unlink/fsync failure") }),
  });
  expect(result.indeterminate).toBeGreaterThan(0);
  expect(await fs.lstat(lockPath).then(() => true, () => false)).toBe(true);
  expect(await fs.lstat(prepared!.journalPath).then(() => true, () => false)).toBe(true);
});

test("a live prepared-before-first-lock journal remains durable recovery authority", async () => {
  const common = await bareCommon();
  const prepared = await prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, [{
    commonDir: common,
    lockPath: path.join(common, "refs", "heads", "main.lock"),
    proofs: [{ repo: ".", ref: "refs/heads/main", expectedOid: null }],
  }], { identity: identity("alive") });

  const result = await recoverStateCasLocks(root, { identity: identity("alive") });
  expect(result.recovered).toBe(0);
  expect(await fs.lstat(prepared!.journalPath).then(() => true, () => false)).toBe(true);
});

test("a dead journal with absent locks is retained until post-recovery Git validation passes", async () => {
  const common = path.join(root, "not-a-git-dir");
  await fs.mkdir(common);
  const prepared = await prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, [{
    commonDir: common,
    lockPath: path.join(common, "refs", "heads", "main.lock"),
    proofs: [{ repo: ".", ref: "refs/heads/main", expectedOid: null }],
  }], { identity: identity("alive") });

  const result = await recoverStateCasLocks(root, { identity: identity("dead") });
  expect(result.indeterminate).toBeGreaterThan(0);
  expect(await fs.lstat(prepared!.journalPath).then(() => true, () => false)).toBe(true);
});

for (const corruption of ["invalid-marker", "marker-owner-mismatch", "non-lock-target"] as const) {
  test(`forged journal authority is indeterminate and never deletes its named file: ${corruption}`, async () => {
    const common = await bareCommon();
    const originalLock = path.join(common, "refs", "heads", "main.lock");
    const prepared = await prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, [{
      commonDir: common,
      lockPath: originalLock,
      proofs: [{ repo: ".", ref: "refs/heads/main", expectedOid: null }],
    }], { identity: identity("alive") });
    const journal = JSON.parse(await fs.readFile(prepared!.journalPath, "utf8"));
    let target = originalLock;
    let raw = journal.commonDirs[0].locks[0].marker as string;
    if (corruption === "invalid-marker") raw = "foreign bytes\n";
    if (corruption === "marker-owner-mismatch") {
      raw = formatLockMarker({ ...OWNER, pid: OWNER.pid + 1, token: crypto.randomBytes(16).toString("hex") });
    }
    if (corruption === "non-lock-target") target = path.join(common, "DO-NOT-DELETE");
    journal.commonDirs[0].locks[0].path = target;
    journal.commonDirs[0].locks[0].marker = raw;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, raw);
    await fs.writeFile(prepared!.journalPath, JSON.stringify(journal));

    const result = await recoverStateCasLocks(root, { identity: identity("dead") });
    expect(result.indeterminate).toBeGreaterThan(0);
    expect(await fs.readFile(target, "utf8")).toBe(raw);
    expect(await fs.lstat(prepared!.journalPath).then(() => true, () => false)).toBe(true);
  });
}

test("post-publication cleanup failure retains the journal and a replacement inode", async () => {
  const common = await bareCommon();
  const lockPath = path.join(common, "refs", "heads", "main.lock");
  const prepared = await prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, [{
    commonDir: common,
    lockPath,
    proofs: [{ repo: ".", ref: "refs/heads/main", expectedOid: null }],
  }], { identity: identity("alive") });
  let replaced = false;
  await expect(acquirePreparedStateCasLocks(prepared!, {
    hooks: {
      afterCreate: () => { throw new Error("injected finalization failure"); },
      beforeCreatedCleanup: async () => {
        const raw = prepared!.journal.commonDirs[0]!.locks[0]!.marker;
        await fs.unlink(lockPath);
        await fs.writeFile(lockPath, raw);
        replaced = true;
      },
    },
  })).rejects.toThrow();
  expect(replaced).toBe(true);
  expect(await fs.readFile(lockPath, "utf8")).toBe(prepared!.journal.commonDirs[0]!.locks[0]!.marker);
  expect(await fs.lstat(prepared!.journalPath).then(() => true, () => false)).toBe(true);
});

test("a symlinked journal directory fails closed", async () => {
  const outside = path.join(root, "outside");
  const dir = stateCasJournalDir(root);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await fs.mkdir(outside);
  await fs.symlink(outside, dir);
  expect(await recoverStateCasLocks(root)).toMatchObject({ recovered: 0, indeterminate: 1 });
});

test("targeted recovery counts a symlinked journal as indeterminate", async () => {
  const common = await bareCommon();
  const dir = stateCasJournalDir(root);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(root, "foreign.json");
  await fs.writeFile(target, "{}\n");
  await fs.symlink(target, path.join(dir, "bad.json"));
  expect(await recoverStateCasLocks(root, { commonDir: common })).toMatchObject({ indeterminate: 1 });
});

test("R2 real-process crash matrix recovers a 140-lock withRevalidated state-CAS", async () => {
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await runGit(repo, ["init", "-qb", "main"]);
  await runGit(repo, ["config", "user.email", "crash@example.invalid"]);
  await runGit(repo, ["config", "user.name", "crash test"]);
  await fs.writeFile(path.join(repo, "seed"), "seed\n");
  await runGit(repo, ["add", "seed"]);
  await runGit(repo, ["commit", "-qm", "seed"]);
  const oid = await runGit(repo, ["rev-parse", "HEAD"]);
  const refs = Array.from({ length: 140 }, (_, index) => `refs/heads/crash-${String(index).padStart(3, "0")}`);
  const updater = Bun.spawn(["git", "-C", repo, "update-ref", "--stdin"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  updater.stdin.write(refs.map((ref) => `create ${ref} ${oid}\n`).join(""));
  updater.stdin.end();
  if (await updater.exited !== 0) throw new Error(await new Response(updater.stderr).text());

  const script = `
    import { withRevalidatedGitPartialApplies } from "./src/cli/sync-git/received-git-transition-commit.ts";
    const root = process.env.RBOX_T3_CRASH_ROOT;
    const oid = process.env.RBOX_T3_CRASH_OID;
    const point = process.env.RBOX_T3_CRASH_POINT;
    if (!root || !oid || !point) throw new Error("missing crash fixture");
    const refs = Array.from({ length: 140 }, (_, index) => "refs/heads/crash-" + String(index).padStart(3, "0"));
    const state = {
      stream: "stream", stateNonce: "1".repeat(32), lastSyncedSequence: 0,
      lastSyncedManifest: { generatedAt: "", files: [] },
      repoRecords: { repo: { repoGen: 1, sourceSeq: 0, partial: {
        incomingKey: "incoming", checkoutPending: false, configApplied: true, heldRefs: {},
        appliedRefs: Object.fromEntries(refs.map((ref) => [ref, { kind: "direct", oid }]))
      } } }
    };
    const crash = () => process.kill(process.pid, "SIGKILL");
    let created = 0;
    await withRevalidatedGitPartialApplies(root, state, {}, async () => {
      if (point === "during-state-save") crash();
    }, {
      afterStateCasJournalPrepared: () => { if (point === "after-journal") crash(); },
      afterStateCasLockPersisted: () => { created++; if (point === "after-lock-N" && created === 70) crash(); },
      afterStateCasLocksAcquired: () => { if (point === "after-final-lock") crash(); },
      afterStateCasCommitted: () => { if (point === "after-state-save") crash(); },
    });
  `;
  for (const point of ["after-journal", "after-lock-N", "after-final-lock", "during-state-save", "after-state-save"]) {
    const child = Bun.spawn(["bun", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, RBOX_T3_CRASH_ROOT: root, RBOX_T3_CRASH_OID: oid, RBOX_T3_CRASH_POINT: point },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await child.exited).not.toBe(0);
    const recovery = await recoverStateCasLocks(root);
    expect(recovery.indeterminate).toBe(0);
    expect(await fs.readdir(stateCasJournalDir(root)).catch(() => [])).toEqual([]);
    for (const ref of refs) {
      expect(await fs.lstat(path.join(repo, ".git", `${ref}.lock`)).then(() => true, () => false)).toBe(false);
    }
  }
}, 30_000);

for (const point of ["after-journal", "after-lock-N", "after-final-lock", "during-state-save", "after-state-save"] as const) {
  test(`R2 crash injection: ${point} recovers every exact owned lock`, async () => {
    const common = await bareCommon();
    const requests = ["one", "two", "three"].map((name) => ({
      commonDir: common,
      lockPath: path.join(common, "refs", "heads", `${name}.lock`),
      proofs: [{ repo: ".", ref: `refs/heads/${name}`, expectedOid: null }],
    }));
    const prepared = await prepareStateCasLocks(
      root,
      { stream: "stream", stateNonce: "1".repeat(32) },
      requests,
      { identity: identity("alive") },
    );
    let expectedRecovered = 0;
    if (point === "after-lock-N") {
      for (const lock of prepared!.journal.commonDirs[0]!.locks.slice(0, 2)) {
        const published = await publishLockMarker(lock.path, lock.marker);
        expect(published.status).toBe("created");
        if (published.status === "created") {
          lock.acquisition = "acquired";
          lock.observation = {
            dev: String(published.observation.dev), inode: String(published.observation.inode),
            size: String(published.observation.size), mtimeNs: String(published.observation.mtimeNs), raw: published.observation.raw,
          };
        }
        expectedRecovered++;
      }
      await fs.writeFile(prepared!.journalPath, `${JSON.stringify(prepared!.journal, null, 2)}\n`);
    } else if (point !== "after-journal") {
      const acquired = await acquirePreparedStateCasLocks(prepared!);
      expectedRecovered = acquired.held.length;
      if (point === "after-state-save") await markStateCasCommitted(prepared);
    }

    const result = await recoverStateCasLocks(root, { identity: identity("dead") });
    expect(result.recovered).toBe(expectedRecovered);
    for (const request of requests) {
      expect(await fs.lstat(request.lockPath).then(() => true, () => false)).toBe(false);
    }
    expect(await fs.lstat(prepared!.journalPath).then(() => true, () => false)).toBe(false);
  });
}
