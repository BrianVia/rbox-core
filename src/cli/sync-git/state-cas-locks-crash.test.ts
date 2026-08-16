import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serializeMarkerObservation, publishLockMarker, type ProcessIncarnation } from "../../engine/lockfile.js";
import {
  acquirePreparedStateCasLocks,
  markStateCasCommitted,
  prepareStateCasLocks,
  recoverStateCasLocks,
  stateCasJournalDir,
} from "./state-cas-locks.js";

const OWNER: ProcessIncarnation = { hostId: "a".repeat(32), bootId: "b".repeat(32), pid: 41, startTime: "1" };
const identity = (status: "alive" | "dead") => ({
  current: async () => OWNER,
  probe: async () => status === "alive"
    ? { status: "alive" as const, startTime: OWNER.startTime }
    : { status: "dead" as const },
});
let root = "";

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-state-cas-crash-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function runGit(repo: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (await child.exited !== 0) throw new Error(await new Response(child.stderr).text());
  return (await new Response(child.stdout).text()).trim();
}

test("R2 real-process crash matrix preserves end state at both design-268 seams", async () => {
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
    let appended = 0;
    await withRevalidatedGitPartialApplies(root, state, {}, async () => {
      if (point === "during-state-save") crash();
    }, {
      afterStateCasJournalPrepared: () => { if (point === "after-journal") crash(); },
      afterStateCasLockAppended: () => { appended++; if (point === "after-lock-appended" && appended === 70) crash(); },
      afterStateCasBatchDurable: () => { if (point === "after-batch-durable") crash(); },
      afterStateCasLocksAcquired: () => { if (point === "after-final-lock") crash(); },
      afterStateCasCommitted: () => { if (point === "after-state-save") crash(); },
    });
  `;
  const points = ["after-journal", "after-lock-appended", "after-batch-durable", "after-final-lock", "during-state-save", "after-state-save"];
  for (const point of points) {
    const child = Bun.spawn(["bun", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, RBOX_T3_CRASH_ROOT: root, RBOX_T3_CRASH_OID: oid, RBOX_T3_CRASH_POINT: point },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await child.exited).not.toBe(0);
    expect((await recoverStateCasLocks(root)).indeterminate).toBe(0);
    expect(await fs.readdir(stateCasJournalDir(root)).catch(() => [])).toEqual([]);
    for (const ref of refs) {
      expect(await fs.lstat(path.join(repo, ".git", `${ref}.lock`)).then(() => true, () => false)).toBe(false);
    }
  }
}, 30_000);

for (const point of ["after-journal", "after-lock-appended", "after-batch-durable", "after-final-lock", "during-state-save", "after-state-save"] as const) {
  test(`R2 crash injection: ${point} recovers every exact owned lock`, async () => {
    const common = path.join(root, "common.git");
    await runGit(root, ["init", "--bare", common]);
    const requests = ["one", "two", "three"].map((name) => ({
      commonDir: common,
      lockPath: path.join(common, "refs", "heads", `${name}.lock`),
      proofs: [{ repo: ".", ref: `refs/heads/${name}`, expectedOid: null }],
    }));
    const prepared = await prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, requests, { identity: identity("alive") });
    let expectedRecovered = 0;
    if (point === "after-lock-appended") {
      for (const [ordinal, lock] of prepared!.journal.commonDirs[0]!.locks.slice(0, 2).entries()) {
        const published = await publishLockMarker(lock.path, lock.marker);
        expect(published.status).toBe("created");
        if (published.status !== "created") continue;
        const observation = serializeMarkerObservation(published.observation);
        await prepared!.writer.append({ type: "acquisition", ordinal, observation });
        lock.acquisition = "acquired";
        lock.observation = observation;
        expectedRecovered++;
      }
      await prepared!.writer.close();
    } else if (point !== "after-journal") {
      expectedRecovered = (await acquirePreparedStateCasLocks(prepared!)).acquired;
      if (point === "after-state-save") await markStateCasCommitted(prepared);
    }
    expect((await recoverStateCasLocks(root, { identity: identity("dead") })).recovered).toBe(expectedRecovered);
    for (const request of requests) expect(await fs.lstat(request.lockPath).then(() => true, () => false)).toBe(false);
    expect(await fs.lstat(prepared!.journalPath).then(() => true, () => false)).toBe(false);
  });
}
