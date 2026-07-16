import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { artifactBinding, readRepoIdentityV1, readStateLineageV1, repositoryIdentityHash } from "../../engine/git/repo-lineage.js";
import { checkoutJournalDir } from "../../engine/git/journal.js";
import {
  commitProtocolRefTransaction,
  prepareBaseAbsentArtifact,
  prepareBasePresentArtifact,
  readBaseAbsentArtifact,
  readBasePresentArtifact,
} from "../../engine/git/base-artifacts.js";
import { gitRaw } from "../../engine/git/shared.js";
import {
  beginResetJournal,
  readResetJournal,
  recoverResetJournal,
  resetArchivePath,
  resetCandidatePath,
  resetIncarnationPath,
  resetJournalPath,
  validateResetJournalV1,
  type ResetJournalV1,
  type ResetZEntry,
} from "../reset-journal.js";
import { loadState, resetSyncState, saveState, type SyncState } from "../config.js";
import { acquireWorkspaceSyncMutex, releaseWorkspaceSyncMutex } from "../sync-mutex.js";

const exec = promisify(execFile);
let root = "";
const oldState = (): SyncState => ({
  stream: "old-stream", stateNonce: "1".repeat(32), stateRevision: 7,
  lastSyncedSequence: 9, lastSyncedManifest: { generatedAt: "old", files: [] }, repoRecords: {},
  telemetryBindingId: "a".repeat(16),
});
const stateFile = () => path.join(root, ".rbox", "state.json");
const oldBytes = () => Buffer.from(JSON.stringify(oldState(), null, 2));
const random = (size: number) => Buffer.alloc(size, 0x22);
const now = () => new Date("2026-07-16T12:34:56.789Z");

async function writeOld(): Promise<void> {
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(stateFile(), oldBytes());
}

async function begin(z: ResetZEntry[] = [], crashAt?: (point: string) => void): Promise<void> {
  await beginResetJournal(root, "new-stream", oldBytes(), oldState(), z, { randomBytes: random, now, crashAt });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reset-v1-"));
  await writeOld();
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("design 130 reset-v1 strict schema", () => {
  test("prepared journal is exact, bounded, path-derived, and preserves telemetry", async () => {
    await begin();
    const journal = (await readResetJournal(root))!;
    expect(journal.phase).toBe("prepared");
    expect(journal.next.state).toEqual({
      stream: "new-stream", stateNonce: "2".repeat(32), stateRevision: 8,
      lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] }, repoRecords: {},
      telemetryBindingId: "a".repeat(16),
    });
    expect(resetCandidatePath(root, journal.id)).toEndWith(`/reset-candidates/${"2".repeat(32)}.json`);
    expect(resetArchivePath(root, journal.old.stateNonce, journal.old.stateSha256)).toContain(`/lineages/${"1".repeat(32)}/`);
    expect(validateResetJournalV1(journal)).toEqual(journal);
  });

  test("unknown fields, unsafe derived refs, duplicate Z, bad hashes, and noncanonical time fail closed", async () => {
    await begin();
    const journal = (await readResetJournal(root))!;
    const cases: unknown[] = [
      { ...journal, extra: true },
      { ...journal, createdAt: "2026-07-16T12:34:56Z" },
      { ...journal, next: { ...journal.next, stateSha256: "0".repeat(64) } },
      { ...journal, old: { ...journal.old, stateNonce: "../bad" } },
    ];
    for (const value of cases) expect(() => validateResetJournalV1(value)).toThrow("reset-corruption");
  });

  test("journal reads refuse symlinks and oversized/non-regular files", async () => {
    await fs.rm(resetJournalPath(root), { force: true });
    await fs.mkdir(path.dirname(resetJournalPath(root)), { recursive: true });
    await fs.symlink(stateFile(), resetJournalPath(root));
    await expect(readResetJournal(root)).rejects.toThrow("unsafe or oversized");
  });
});

describe("design 130 reset crash/recovery matrix", () => {
  for (const point of ["after-prepared", "after-ready", "after-state-replace", "after-installed", "after-z-retired"]) {
    test(`crash at ${point} converges without a missing-state window`, async () => {
      if (point === "after-prepared") {
        await expect(begin([], (p) => { if (p === point) throw new Error(point); })).rejects.toThrow(point);
      } else {
        await begin();
        await expect(recoverResetJournal(root, { crashAt: (p) => { if (p === point) throw new Error(point); } })).rejects.toThrow(point);
      }
      expect(await fs.lstat(stateFile()).then((s) => s.isFile())).toBe(true);
      expect(await recoverResetJournal(root)).toBe("complete");
      const installed = JSON.parse(await fs.readFile(stateFile(), "utf8"));
      expect(installed.stream).toBe("new-stream");
      expect(installed.telemetryBindingId).toBe("a".repeat(16));
      expect(JSON.parse(await fs.readFile(resetIncarnationPath(root), "utf8"))).toEqual({
        stream: "new-stream", stateNonce: "2".repeat(32), stateRevision: 8,
      });
      await expect(fs.access(resetJournalPath(root))).rejects.toThrow();
    });
  }

  test("prepared + changed active state preserves the intervening bytes and aborts", async () => {
    await begin();
    const intervening = Buffer.from('{"stream":"old-writer"}\n');
    await fs.writeFile(stateFile(), intervening);
    expect(await recoverResetJournal(root)).toBe("aborted");
    expect(await fs.readFile(stateFile())).toEqual(intervening);
    await expect(fs.access(resetJournalPath(root))).rejects.toThrow();
  });

  test("ready + candidate present + changed state quarantines candidate and aborts", async () => {
    await begin();
    await expect(recoverResetJournal(root, { crashAt: (p) => { if (p === "after-ready") throw new Error(p); } })).rejects.toThrow("after-ready");
    const journal = (await readResetJournal(root))!;
    await fs.writeFile(stateFile(), '{"stream":"old-writer"}\n');
    expect(await recoverResetJournal(root)).toBe("aborted");
    const names = await fs.readdir(path.dirname(resetCandidatePath(root, journal.id)));
    expect(names.some((name) => name.startsWith(`${journal.id}.quarantine-`))).toBe(true);
  });

  test("ready + missing candidate treats rename as committed and overwrites a later old-writer rewrite", async () => {
    await begin();
    await expect(recoverResetJournal(root, { crashAt: (p) => { if (p === "after-state-replace") throw new Error(p); } })).rejects.toThrow("after-state-replace");
    expect((await readResetJournal(root))?.phase).toBe("ready");
    await fs.writeFile(stateFile(), '{"stream":"late-old-writer"}\n');
    expect(await recoverResetJournal(root)).toBe("complete");
    expect(JSON.parse(await fs.readFile(stateFile(), "utf8")).stream).toBe("new-stream");
  });

  test("installed reinstalls bounded next state and repairs marker lag", async () => {
    await begin();
    await expect(recoverResetJournal(root, { crashAt: (p) => { if (p === "after-installed") throw new Error(p); } })).rejects.toThrow("after-installed");
    await fs.writeFile(stateFile(), '{"stream":"late-old-writer"}\n');
    await fs.rm(resetIncarnationPath(root), { force: true });
    expect(await recoverResetJournal(root)).toBe("complete");
    expect(JSON.parse(await fs.readFile(stateFile(), "utf8")).stream).toBe("new-stream");
    expect(JSON.parse(await fs.readFile(resetIncarnationPath(root), "utf8")).stream).toBe("new-stream");
  });

  test("wrong candidate and archive bytes are corruption holds", async () => {
    await begin();
    await expect(recoverResetJournal(root, { crashAt: (p) => { if (p === "after-ready") throw new Error(p); } })).rejects.toThrow("after-ready");
    const journal = (await readResetJournal(root))!;
    await fs.writeFile(resetCandidatePath(root, journal.id), "wrong");
    await expect(recoverResetJournal(root)).rejects.toThrow("wrong candidate");
    const nextBytes = Buffer.from(JSON.stringify(journal.next.state));
    await fs.writeFile(resetCandidatePath(root, journal.id), nextBytes);
    await fs.writeFile(resetArchivePath(root, journal.old.stateNonce, journal.old.stateSha256), "wrong");
    await expect(recoverResetJournal(root)).rejects.toThrow("old state archive");
  });
});

describe("design 130 reset entry points", () => {
  test("ordinary load recovers a standing journal before exposing state", async () => {
    await begin();
    await expect(recoverResetJournal(root, { crashAt: (point) => {
      if (point === "after-ready") throw new Error(point);
    } })).rejects.toThrow("after-ready");
    const loaded = await loadState(root, "new-stream", () => {});
    expect(loaded).toMatchObject({ stream: "new-stream", stateRevision: 8, telemetryBindingId: "a".repeat(16) });
    await expect(fs.access(resetJournalPath(root))).rejects.toThrow();
  });

  test("stream mismatch freshening is the durable reset transaction, not an in-memory empty base", async () => {
    const loaded = await loadState(root, "rebound-stream", () => {});
    expect(loaded).toMatchObject({
      stream: "rebound-stream",
      stateRevision: 8,
      lastSyncedSequence: 0,
      telemetryBindingId: "a".repeat(16),
      repoRecords: {},
    });
    expect(loaded.stateNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(await fs.readFile(stateFile(), "utf8"))).toEqual(loaded);
    expect(JSON.parse(await fs.readFile(resetIncarnationPath(root), "utf8"))).toEqual({
      stream: "rebound-stream", stateNonce: loaded.stateNonce, stateRevision: 8,
    });
    await expect(fs.access(resetJournalPath(root))).rejects.toThrow();
  });
});

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } })).stdout.trim();
}

async function zFixture(repo: string, relPath: string, lineageByte: string): Promise<ResetZEntry> {
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-q");
  const commonDir = await fs.realpath(path.join(repo, ".git"));
  const identity = await readRepoIdentityV1(relPath, "dir", { worktreeId: repo, gitDirReal: commonDir, commonDirReal: commonDir });
  const lineageHash = lineageByte.repeat(64);
  const targetOid = await git(repo, "hash-object", "-w", "-t", "tree", "/dev/null");
  const activeRef = `refs/rbox-local/base-absent-settled/v1/${lineageHash}`;
  await git(repo, "update-ref", activeRef, targetOid);
  return {
    lineageHash, repositoryIdentityHash: repositoryIdentityHash(identity), repositoryIdentity: identity,
    activeRef, targetOid, recoveryRef: `refs/rbox-recovery/base-absent/v1/${lineageHash}/${targetOid}`,
  };
}

test("per-common-dir partial Z retirement resumes while forensic recovery Z remains", async () => {
  const a = await zFixture(path.join(root, "a"), "a", "a");
  const b = await zFixture(path.join(root, "b"), "b", "b");
  await begin([a, b]);
  await expect(recoverResetJournal(root, { crashAt: (p) => { if (p === "after-installed") throw new Error(p); } })).rejects.toThrow("after-installed");
  await git(path.join(root, "a"), "update-ref", "-d", a.activeRef, a.targetOid);
  expect(await recoverResetJournal(root)).toBe("complete");
  for (const [repo, entry] of [[path.join(root, "a"), a], [path.join(root, "b"), b]] as const) {
    expect(await git(repo, "rev-parse", "--verify", entry.recoveryRef)).toBe(entry.targetOid);
    await expect(git(repo, "rev-parse", "--verify", entry.activeRef)).rejects.toThrow();
  }
});

test("one-common-dir mixed Z retirement is a corruption hold", async () => {
  const repo = path.join(root, "shared");
  const a = await zFixture(repo, "a", "a");
  const b = await zFixture(repo, "b", "b");
  await begin([a, b]);
  await expect(recoverResetJournal(root, { crashAt: (point) => {
    if (point === "after-installed") throw new Error(point);
  } })).rejects.toThrow("after-installed");
  await git(repo, "update-ref", "-d", a.activeRef, a.targetOid);
  await expect(recoverResetJournal(root)).rejects.toThrow("physically impossible mixed Z retirement");
  expect(await git(repo, "rev-parse", "--verify", b.activeRef)).toBe(b.targetOid);
});

test("wrong active or recovery Z targets are corruption holds", async () => {
  const repo = path.join(root, "z-targets");
  const entry = await zFixture(repo, "z-targets", "c");
  await begin([entry]);
  await expect(recoverResetJournal(root, { crashAt: (point) => {
    if (point === "after-ready") throw new Error(point);
  } })).rejects.toThrow("after-ready");
  const file = path.join(root, "other.txt");
  await fs.writeFile(file, "other");
  const other = await git(repo, "hash-object", "-w", file);
  await git(repo, "update-ref", entry.recoveryRef, other, entry.targetOid);
  await expect(recoverResetJournal(root)).rejects.toThrow("wrong recovery Z target");
  await git(repo, "update-ref", entry.recoveryRef, entry.targetOid, other);
  await git(repo, "update-ref", entry.activeRef, other, entry.targetOid);
  await expect(recoverResetJournal(root)).rejects.toThrow("wrong active Z target");
});

describe("design 130 reset preflight holds", () => {
  async function stateWithRepo(): Promise<string> {
    const repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });
    await git(repo, "init", "-q");
    await saveState(root, {
      ...oldState(),
      repoRecords: { repo: { repoGen: 1, sourceSeq: 1 } },
    });
    return repo;
  }

  test("a valid but foreign active Z is a physical-mutation veto", async () => {
    const repo = await stateWithRepo();
    const oid = await git(repo, "hash-object", "-w", "-t", "tree", "/dev/null");
    const foreign = `refs/rbox-local/base-absent-settled/v1/${"f".repeat(64)}`;
    await git(repo, "update-ref", foreign, oid);
    const mutex = await acquireWorkspaceSyncMutex(root, "cli");
    try {
      await expect(resetSyncState(root, "new-stream", mutex)).rejects.toThrow("foreign or malformed active Z");
    } finally {
      await releaseWorkspaceSyncMutex(mutex);
    }
    expect(await git(repo, "rev-parse", "--verify", foreign)).toBe(oid);
    expect((await loadState(root, "old-stream", () => {})).stateRevision).toBe(7);
  });

  test("published checkout intent refuses even before binding recovery", async () => {
    await stateWithRepo();
    const dir = checkoutJournalDir(root, "repo");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "journal.json"), '{"phase":"published"}\n');
    const mutex = await acquireWorkspaceSyncMutex(root, "cli");
    try {
      await expect(resetSyncState(root, "new-stream", mutex)).rejects.toThrow("published checkout journal");
    } finally {
      await releaseWorkspaceSyncMutex(mutex);
    }
    expect(await fs.readFile(path.join(dir, "journal.json"), "utf8")).toContain("published");
  });
});

describe("design 130 reset A/P lifecycle", () => {
  const branch = "refs/heads/topic";
  const section = (oid: string) => ({
    bundleEncSha: "a".repeat(64), bundleCipherSize: 1,
    head: `ref: ${branch}`, refs: { [branch]: oid }, refScope: "all" as const,
    generatedAt: "2026-07-16T12:34:56.789Z",
  });

  async function protocolRepo(): Promise<{
    repo: string;
    prior: string;
    next: string;
    binding: ReturnType<typeof artifactBinding>;
  }> {
    const repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });
    await git(repo, "init", "-qb", "topic");
    await git(repo, "config", "user.name", "rbox test");
    await git(repo, "config", "user.email", "rbox-test@local");
    await fs.writeFile(path.join(repo, "tracked"), "prior\n");
    await git(repo, "add", "tracked");
    await git(repo, "commit", "-qm", "prior");
    const prior = await git(repo, "rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, "tracked"), "next\n");
    await git(repo, "commit", "-qam", "next");
    const next = await git(repo, "rev-parse", "HEAD");
    await saveState(root, {
      ...oldState(),
      lastSyncedManifest: { generatedAt: "old", files: [], gitRepos: { repo: section(prior) } },
      repoRecords: { repo: { repoGen: 1, sourceSeq: 1, base: section(prior) } },
    });
    const commonDir = await fs.realpath(path.join(repo, ".git"));
    const identity = await readRepoIdentityV1("repo", "dir", {
      worktreeId: await fs.realpath(repo), gitDirReal: commonDir, commonDirReal: commonDir,
    });
    const lineage = await readStateLineageV1(root, "old-stream", "1".repeat(32), identity);
    return { repo, prior, next, binding: artifactBinding(lineage) };
  }

  async function installP(fixture: Awaited<ReturnType<typeof protocolRepo>>, episode = "b".repeat(32)) {
    await git(fixture.repo, "update-ref", branch, fixture.prior, fixture.next);
    const prepared = await prepareBasePresentArtifact(
      fixture.repo, fixture.binding, branch, episode, fixture.prior, fixture.next,
    );
    await gitRaw(fixture.repo, ["update-ref", "--stdin", "--create-reflog", "-m", episode], {
      stdin: ["start", ...prepared.transactionLines, `update ${branch} ${fixture.next} ${fixture.prior}`, "prepare", "commit", ""].join("\n"),
    });
    return prepared;
  }

  async function archivedOldState(): Promise<SyncState> {
    const dir = path.join(root, ".rbox", "state", "lineages", "1".repeat(32));
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    return JSON.parse(await fs.readFile(path.join(dir, files[0]!), "utf8")) as SyncState;
  }

  test("exact P is settled into positive BASE provenance before reset cutover", async () => {
    const fixture = await protocolRepo();
    const prepared = await installP(fixture);
    expect((await readBasePresentArtifact(fixture.repo, fixture.binding, branch)).status).toBe("valid");

    await resetSyncState(root, "new-stream");

    expect((await readBasePresentArtifact(fixture.repo, fixture.binding, branch)).status).toBe("absent");
    const archived = await archivedOldState();
    expect(archived.repoRecords?.repo?.base?.refs[branch]).toBe(fixture.next);
    expect(archived.repoRecords?.repo?.branchBaseOrigins?.[branch]).toEqual({
      v: 1, oid: fixture.next, lineageHash: fixture.binding.lineageHash,
      kind: "pull-p", episode: prepared.payload.episode,
    });
  });

  test("moved valid P is repaired, pinned, rescanned, and no longer vetoes reset", async () => {
    const fixture = await protocolRepo();
    const prepared = await installP(fixture, "c".repeat(32));
    await fs.writeFile(path.join(fixture.repo, "tracked"), "user move\n");
    await git(fixture.repo, "commit", "-qam", "user move");
    const moved = await git(fixture.repo, "rev-parse", "HEAD");

    await resetSyncState(root, "new-stream");

    expect((await readBasePresentArtifact(fixture.repo, fixture.binding, branch)).status).toBe("absent");
    expect(await git(fixture.repo, "rev-parse", "--verify", `refs/rbox-local/keep/${moved}`)).toBe(moved);
    expect(await git(fixture.repo, "rev-parse", "--verify", `refs/rbox-local/keep/${fixture.prior}`)).toBe(fixture.prior);
    expect(await git(fixture.repo, "rev-parse", "--verify", `refs/rbox-local/keep/${fixture.next}`)).toBe(fixture.next);
    const q = (await git(fixture.repo, "for-each-ref", "--format=%(refname)", `refs/rbox-recovery/base-present/v2/${fixture.binding.lineageHash}`)).split("\n").filter(Boolean);
    expect(q).toHaveLength(1);
    expect(q[0]).toContain(prepared.payload.episode);
    expect((await archivedOldState()).repoRecords?.repo?.base?.refs[branch]).toBe(fixture.next);
  });

  test("valid A compacts by authoritative CAS even when an old writer left stale positive BASE", async () => {
    const fixture = await protocolRepo();
    await git(fixture.repo, "update-ref", branch, fixture.prior, fixture.next);
    const a = await prepareBaseAbsentArtifact(fixture.repo, fixture.binding, branch, fixture.prior);
    await commitProtocolRefTransaction(fixture.repo, [...a.transactionLines, `delete ${branch} ${fixture.prior}`]);
    expect((await readBaseAbsentArtifact(fixture.repo, fixture.binding, branch)).status).toBe("valid");

    await resetSyncState(root, "new-stream");

    expect((await readBaseAbsentArtifact(fixture.repo, fixture.binding, branch)).status).toBe("absent");
    const recovery = (await git(fixture.repo, "for-each-ref", "--format=%(refname)", `refs/rbox-recovery/base-absent/v1/${fixture.binding.lineageHash}`)).split("\n").filter(Boolean);
    expect(recovery).toHaveLength(1);
    expect((await archivedOldState()).repoRecords?.repo?.base?.refs[branch]).toBe(fixture.prior);
  });

  test("malformed K and unpreservable moved-P reflog refuse without cutting over", async () => {
    const malformed = await protocolRepo();
    const malformedP = await installP(malformed, "d".repeat(32));
    await git(malformed.repo, "update-ref", "-d", malformedP.keepRefs[0]!.ref, malformedP.keepRefs[0]!.targetOid);
    await expect(resetSyncState(root, "new-stream")).rejects.toThrow("malformed A/P/K artifacts");
    expect((await loadState(root, "old-stream", () => {})).stream).toBe("old-stream");

    await fs.rm(root, { recursive: true, force: true });
    root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reset-v1-unpreservable-"));
    await writeOld();
    const unpreservable = await protocolRepo();
    await installP(unpreservable, "e".repeat(32));
    await fs.writeFile(path.join(unpreservable.repo, "tracked"), "moved\n");
    await git(unpreservable.repo, "commit", "-qam", "moved");
    await fs.writeFile(path.join(unpreservable.repo, ".git", "logs", "refs", "heads", "topic"), "malformed reflog bytes\n");
    await expect(resetSyncState(root, "new-stream")).rejects.toThrow("unpreservable P");
    expect((await loadState(root, "old-stream", () => {})).stream).toBe("old-stream");
  });
});
