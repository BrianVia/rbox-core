import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LocalBlobStore } from "../blobstore.js";
import { captureGitState } from "./capture.js";
import { gitIdentity } from "./identity.js";
import { pinDisplaced, prepareDisplacedRefPins, prepareKeepPins, type KeepPinOrigins } from "./keep-pins.js";
import { isSyncableRef } from "../manifest-validate.js";

const exec = promisify(execFile);
const runGit = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args]).then(({ stdout }) => stdout.toString().trim());
const KEK = Buffer.alloc(32, 116);

let tmp: string;
let repo: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-d116-keep-pins-"));
  repo = path.join(tmp, "repo");
  await fs.mkdir(repo);
  await runGit(repo, "init", "-qb", "main");
  await runGit(repo, "config", "user.email", "test@example.com");
  await runGit(repo, "config", "user.name", "Test User");
});

afterEach(async () => {
  // All git/capture subprocesses are awaited before bounded fixture teardown.
  await fs.rm(tmp, { recursive: true, force: true });
});

async function commit(name: string, contents: string): Promise<string> {
  await fs.writeFile(path.join(repo, name), contents);
  await runGit(repo, "add", name);
  await runGit(repo, "commit", "-qm", `${name}:${contents}`);
  return runGit(repo, "rev-parse", "HEAD");
}

async function refExists(ref: string): Promise<boolean> {
  return exec("git", ["-C", repo, "show-ref", "--verify", "--quiet", ref]).then(() => true, () => false);
}

test("content-addressed pins are create-only, idempotent, and keep multi-origin human promotion", async () => {
  const oid = await commit("one.txt", "one\n");
  const tracking = { ref: "refs/remotes/origin/main", episode: "episode-1", time: "2026-07-13T10:00:00.000Z", class: "tracking" as const };
  const first = await pinDisplaced(repo, [oid, oid], tracking);
  expect(first.oids).toEqual([oid]);
  expect(first.transactionLines).toEqual([`create refs/rbox-local/keep/${oid} ${oid}`]);
  expect(await refExists(`refs/rbox-local/keep/${oid}`)).toBe(true);
  expect(await runGit(repo, "show-ref", "--hash", `refs/rbox-local/keep/${oid}`)).toBe(oid);

  const repeated = await pinDisplaced(repo, [oid], tracking);
  expect(repeated.transactionLines).toEqual([]);

  // r4 F3: prepare persists human provenance before returning any ref transaction
  // lines. At this point the second pin ref deliberately does not exist yet.
  const humanOid = await commit("two.txt", "two\n");
  const human = { ref: "refs/heads/main", episode: "episode-2", time: "2026-07-13T11:00:00.000Z", class: "human" as const };
  const prepared = await prepareKeepPins(repo, [humanOid], human);
  expect(await refExists(`refs/rbox-local/keep/${humanOid}`)).toBe(false);
  const beforeCommit = JSON.parse(await fs.readFile(prepared.sidecarPath, "utf8")) as KeepPinOrigins;
  expect(beforeCommit[humanOid]).toEqual([human]);
  expect(prepared.transactionLines).toEqual([`create refs/rbox-local/keep/${humanOid} ${humanOid}`]);

  // Promotion of an existing origin is monotonic: a later tracking observation
  // cannot demote an OID once human provenance has been durably recorded (r3 F7).
  await prepareKeepPins(repo, [oid], { ...tracking, class: "human" });
  await prepareKeepPins(repo, [oid], tracking);
  const promoted = JSON.parse(await fs.readFile(prepared.sidecarPath, "utf8")) as KeepPinOrigins;
  expect(promoted[oid]).toEqual([{ ...tracking, class: "human" }]);
});

test("reflog protection returns same-transaction create lines for reflog-only commits", async () => {
  const base = await commit("history.txt", "base\n");
  const displaced = await commit("history.txt", "displaced\n");
  await runGit(repo, "reset", "--hard", base);

  const result = await prepareDisplacedRefPins(repo, "refs/heads/main", [base], {
    ref: "refs/heads/main",
    episode: "force-replace",
    time: "2026-07-13T12:00:00.000Z",
    class: "human",
  });

  expect(result.status).toBe("prepared");
  if (result.status !== "prepared") throw new Error("unexpected indeterminate reachability proof");
  expect(result.oids).toContain(displaced);
  expect(result.oids).not.toContain(base);
  expect(result.transactionLines).toContain(`create refs/rbox-local/keep/${displaced} ${displaced}`);
  expect(await refExists(`refs/rbox-local/keep/${displaced}`)).toBe(false);
});

test("a reflog-less unique live tip is pinned before deletion (confirmation-pass finding)", async () => {
  const base = await commit("history.txt", "base\n");
  const unique = await commit("history.txt", "unique on doomed\n");
  await runGit(repo, "update-ref", "refs/heads/doomed", unique);
  await runGit(repo, "reset", "--hard", base);
  // Simulate reflogs disabled/pruned: with no reflog the enumeration alone
  // finds nothing and deletion would strand `unique` with no keep pin.
  await fs.rm(path.join(repo, ".git", "logs", "refs", "heads", "doomed"), { force: true });

  const result = await prepareDisplacedRefPins(repo, "refs/heads/doomed", [base], {
    ref: "refs/heads/doomed",
    episode: "reflogless-delete",
    time: "2026-07-13T12:30:00.000Z",
    class: "human",
  });

  expect(result.status).toBe("prepared");
  if (result.status !== "prepared") throw new Error("unexpected indeterminate reachability proof");
  expect(result.oids).toContain(unique);
  expect(result.transactionLines).toContain(`create refs/rbox-local/keep/${unique} ${unique}`);
});

test("recovery namespace is excluded from syncable refs, capture, and ordinary identity", async () => {
  const oid = await commit("tracked.txt", "tracked\n");
  await pinDisplaced(repo, [oid], {
    ref: "refs/heads/main",
    episode: "capture-exclusion",
    time: "2026-07-13T13:00:00.000Z",
    class: "human",
  });

  expect(isSyncableRef("refs/heads/main")).toBe(true);
  expect(isSyncableRef("refs/tags/v1")).toBe(true);
  expect(isSyncableRef("refs/stash")).toBe(true);
  expect(isSyncableRef(`refs/rbox-local/keep/${oid}`)).toBe(false);

  const identity = await gitIdentity(repo);
  expect(identity?.refs["refs/heads/main"]).toBe(oid);
  expect(Object.keys(identity?.refs ?? {}).some((ref) => ref.startsWith("refs/rbox-local/"))).toBe(false);

  const section = await captureGitState(repo, new LocalBlobStore(path.join(tmp, "store")), KEK, { workspaceRoot: tmp });
  expect(section).toBeDefined();
  expect(section?.refs["refs/heads/main"]).toBe(oid);
  expect(Object.keys(section?.refs ?? {}).some((ref) => ref.startsWith("refs/rbox-local/"))).toBe(false);
});
