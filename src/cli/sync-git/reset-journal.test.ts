import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { artifactBinding, readRepoIdentityV1, readStateLineageV1, repositoryIdentityHash } from "../../engine/git/repo-lineage.js";
import { checkoutJournalDir } from "../../engine/git/journal.js";
import {
  commitProtocolRefTransaction,
  prepareBaseAbsentArtifact,
  prepareBasePresentArtifact,
  readBaseAbsentArtifact,
  readBasePresentArtifact,
} from "../../engine/git/base-artifacts.js";
import { gitRaw, setGitSpawnObserver } from "../../engine/git/shared.js";
import {
  beginResetJournal,
  inspectResetJournal,
  readResetJournal,
  recoverResetJournal,
  resetArchivePath,
  resetCandidatePath,
  resetIncarnationPath,
  resetJournalPath,
  validateResetJournalV2,
  type ResetZEntry,
} from "../reset-journal.js";
import { loadState, resetSyncState, saveConfig, saveStateUnsafeLegacyOrTest, type SyncState } from "../config.js";
import { acquireWorkspaceSyncMutex, releaseWorkspaceSyncMutex } from "../sync-mutex.js";
import { mintSetupExistingConsent } from "../reset-consent.js";
import { resetJournalDoctorCmd } from "../reset-journal-doctor.js";
import { readResetQuarantineBundle, resetQuarantineRoot } from "../reset-quarantine.js";

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
const resetDestination = "https://example.test::workspace::root";
const resetConsent = () => mintSetupExistingConsent({
  root,
  observedOldStream: "old-stream",
  observedOldNonce: "1".repeat(32),
  mintedAtRevision: 7,
  remoteUrl: "https://example.test",
  workspaceId: "workspace",
  projectId: "root",
});

async function writeOld(): Promise<void> {
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(stateFile(), oldBytes());
}

async function begin(z: ResetZEntry[] = [], crashAt?: (point: string) => void): Promise<void> {
  await beginResetJournal(root, "new-stream", oldBytes(), oldState(), z, {
    version: 2, authorizedNextStream: "new-stream", consentKind: "setup-rebind", mintedAtRevision: 7,
  }, { randomBytes: random, now, crashAt });
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
    expect(validateResetJournalV2(journal)).toEqual(journal);
  });

  test("unknown fields, unsafe derived refs, duplicate Z, bad hashes, and noncanonical time fail closed", async () => {
    await begin();
    const journal = (await readResetJournal(root))!;
    const cases: unknown[] = [
      { ...journal, extra: true },
      { ...journal, createdAt: "2026-07-16T12:34:56Z" },
      { ...journal, next: { ...journal.next, stateSha256: "0".repeat(64) } },
      { ...journal, old: { ...journal.old, stateNonce: "../bad" } },
      { ...journal, authorization: { ...journal.authorization, authorizedNextStream: "substituted" } },
      { ...journal, authorization: { ...journal.authorization, consentKind: "track" } },
    ];
    for (const value of cases) expect(() => validateResetJournalV2(value)).toThrow("reset-corruption");
  });

  test("journal reads refuse symlinks and oversized/non-regular files", async () => {
    await fs.rm(resetJournalPath(root), { force: true });
    await fs.mkdir(path.dirname(resetJournalPath(root)), { recursive: true });
    await fs.symlink(stateFile(), resetJournalPath(root));
    await expect(readResetJournal(root)).rejects.toThrow("unsafe non-regular");
  });

  test("journal v2 authorization round-trips and legacy v1 halts", async () => {
    await begin();
    const v2 = (await readResetJournal(root))!;
    expect(v2.v).toBe(2);
    expect(v2.v === 2 && v2.authorization).toEqual({
      version: 2, authorizedNextStream: "new-stream", consentKind: "setup-rebind", mintedAtRevision: 7,
    });
    const { authorization: _authorization, ...legacyBody } = v2 as typeof v2 & { authorization: unknown };
    const { archiveBaseline: _archiveBaseline, ...legacyOld } = legacyBody.old;
    await fs.writeFile(resetJournalPath(root), JSON.stringify({ ...legacyBody, v: 1, old: legacyOld }));
    expect(await inspectResetJournal(root, "old-stream")).toMatchObject({ status: "halt", reason: expect.stringContaining("legacy") });
    await expect(recoverResetJournal(root, "old-stream")).rejects.toThrow("legacy reset journal");
  });

  test("config naming neither stream halts without touching journal or active state", async () => {
    await begin();
    const beforeJournal = await fs.readFile(resetJournalPath(root));
    const beforeState = await fs.readFile(stateFile());
    expect(await inspectResetJournal(root, "foreign-stream")).toMatchObject({ status: "halt", reason: expect.stringContaining("neither") });
    expect(await fs.readFile(resetJournalPath(root))).toEqual(beforeJournal);
    expect(await fs.readFile(stateFile())).toEqual(beforeState);
  });
});

describe("design 130 reset crash/recovery matrix", () => {
  for (const point of ["after-prepared", "after-ready", "after-state-replace", "after-installed", "after-z-retired"]) {
    test(`crash at ${point} converges without a missing-state window`, async () => {
      if (point === "after-prepared") {
        await expect(begin([], (p) => { if (p === point) throw new Error(point); })).rejects.toThrow(point);
      } else {
        await begin();
        await expect(recoverResetJournal(root, "old-stream", { crashAt: (p) => { if (p === point) throw new Error(point); } })).rejects.toThrow(point);
      }
      expect(await fs.lstat(stateFile()).then((s) => s.isFile())).toBe(true);
      expect(await recoverResetJournal(root, "old-stream")).toBe("complete");
      const installed = JSON.parse(await fs.readFile(stateFile(), "utf8"));
      expect(installed.stream).toBe("new-stream");
      expect(installed.telemetryBindingId).toBe("a".repeat(16));
      expect(JSON.parse(await fs.readFile(resetIncarnationPath(root), "utf8"))).toEqual({
        stream: "new-stream", stateNonce: "2".repeat(32), stateRevision: 8,
      });
      await expect(fs.access(resetJournalPath(root))).rejects.toThrow();
    });
  }

  test("prepared + changed active state halts with zero writes", async () => {
    await begin();
    const intervening = Buffer.from('{"stream":"old-writer"}\n');
    await fs.writeFile(stateFile(), intervening);
    await expect(recoverResetJournal(root, "old-stream")).rejects.toThrow("physical reset state matches no authorized recovery row");
    expect(await fs.readFile(stateFile())).toEqual(intervening);
    expect((await readResetJournal(root))?.phase).toBe("prepared");
  });

  test("ready + candidate present + changed state halts without ad-hoc quarantine", async () => {
    await begin();
    await expect(recoverResetJournal(root, "old-stream", { crashAt: (p) => { if (p === "after-ready") throw new Error(p); } })).rejects.toThrow("after-ready");
    const journal = (await readResetJournal(root))!;
    await fs.writeFile(stateFile(), '{"stream":"old-writer"}\n');
    await expect(recoverResetJournal(root, "old-stream")).rejects.toThrow("physical reset state matches no authorized recovery row");
    const names = await fs.readdir(path.dirname(resetCandidatePath(root, journal.id)));
    expect(names).toContain(`${journal.id}.json`);
  });

  test("ready + missing candidate refuses a later active-state rewrite", async () => {
    await begin();
    await expect(recoverResetJournal(root, "old-stream", { crashAt: (p) => { if (p === "after-state-replace") throw new Error(p); } })).rejects.toThrow("after-state-replace");
    expect((await readResetJournal(root))?.phase).toBe("ready");
    await fs.writeFile(stateFile(), '{"stream":"late-old-writer"}\n');
    await expect(recoverResetJournal(root, "old-stream")).rejects.toThrow("physical reset state matches no authorized recovery row");
    expect(JSON.parse(await fs.readFile(stateFile(), "utf8")).stream).toBe("late-old-writer");
  });

  test("installed never repairs an unlisted active state", async () => {
    await begin();
    await expect(recoverResetJournal(root, "old-stream", { crashAt: (p) => { if (p === "after-installed") throw new Error(p); } })).rejects.toThrow("after-installed");
    await fs.writeFile(stateFile(), '{"stream":"late-old-writer"}\n');
    await fs.rm(resetIncarnationPath(root), { force: true });
    await expect(recoverResetJournal(root, "old-stream")).rejects.toThrow("physical reset state matches no authorized recovery row");
    expect(JSON.parse(await fs.readFile(stateFile(), "utf8")).stream).toBe("late-old-writer");
    await expect(fs.access(resetIncarnationPath(root))).rejects.toThrow();
  });

  test("wrong candidate and archive bytes are corruption holds", async () => {
    await begin();
    await expect(recoverResetJournal(root, "old-stream", { crashAt: (p) => { if (p === "after-ready") throw new Error(p); } })).rejects.toThrow("after-ready");
    const journal = (await readResetJournal(root))!;
    await fs.writeFile(resetCandidatePath(root, journal.id), "wrong");
    await expect(recoverResetJournal(root, "old-stream")).rejects.toThrow("physical reset state matches no authorized recovery row");
    const nextBytes = Buffer.from(JSON.stringify(journal.next.state));
    await fs.writeFile(resetCandidatePath(root, journal.id), nextBytes);
    await fs.writeFile(resetArchivePath(root, journal.old.stateNonce, journal.old.stateSha256), "wrong");
    await expect(recoverResetJournal(root, "old-stream")).rejects.toThrow("physical reset state matches no authorized recovery row");
  });

  test("R1/R2 make source absence durable before installed publication", async () => {
    for (const recreateCandidate of [false, true]) {
      await fs.rm(root, { recursive: true, force: true });
      root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reset-r12-"));
      await writeOld();
      await begin();
      await expect(recoverResetJournal(root, "old-stream", { crashAt: (point) => {
        if (point === "after-state-replace") throw new Error(point);
      } })).rejects.toThrow("after-state-replace");
      const journal = (await readResetJournal(root))!;
      if (recreateCandidate) await fs.copyFile(stateFile(), resetCandidatePath(root, journal.id));
      const points: string[] = [];
      expect(await recoverResetJournal(root, "old-stream", { crashAt: (point) => { points.push(point); } })).toBe("complete");
      expect(points.indexOf("after-destination-parent-fsync")).toBeLessThan(points.indexOf("after-source-parent-fsync"));
      expect(points.indexOf("after-source-parent-fsync")).toBeLessThan(points.indexOf("after-installed"));
      await expect(fs.access(resetCandidatePath(root, journal.id))).rejects.toThrow();
    }
  });
});

describe("design 130 reset entry points", () => {
  test("ordinary load recovers a standing journal before exposing state", async () => {
    await begin();
    await expect(recoverResetJournal(root, "old-stream", { crashAt: (point) => {
      if (point === "after-ready") throw new Error(point);
    } })).rejects.toThrow("after-ready");
    const loaded = await loadState(root, "new-stream", () => {});
    expect(loaded).toMatchObject({ stream: "new-stream", stateRevision: 8, telemetryBindingId: "a".repeat(16) });
    await expect(fs.access(resetJournalPath(root))).rejects.toThrow();
  });

  test("ordinary load refuses a stream mismatch without starting a reset transaction", async () => {
    const before = await fs.readFile(stateFile(), "utf8");
    await expect(loadState(root, "rebound-stream", () => {})).rejects.toMatchObject({
      name: "StreamMismatchError", expectedStream: "rebound-stream", observedStream: "old-stream",
    });
    expect(await fs.readFile(stateFile(), "utf8")).toBe(before);
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

describe("design 138 normalized P0 initiation invariant", () => {
  test("a byte-exact pre-existing archive is adopted as the recorded P0A baseline", async () => {
    const hash = crypto.createHash("sha256").update(oldBytes()).digest("hex");
    const archive = resetArchivePath(root, oldState().stateNonce!, hash);
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await fs.writeFile(archive, oldBytes());
    await begin();
    expect(await inspectResetJournal(root, "old-stream")).toMatchObject({ status: "recoverable", row: { ids: ["P0A"] } });
    expect(await recoverResetJournal(root, "old-stream")).toBe("complete");
    expect(await fs.readFile(archive)).toEqual(oldBytes());
  });

  test("a stale incarnation marker is refused rather than blessed", async () => {
    await fs.mkdir(path.dirname(resetIncarnationPath(root)), { recursive: true });
    await fs.writeFile(resetIncarnationPath(root), JSON.stringify({ stream: "other", stateNonce: "f".repeat(32), stateRevision: 1 }));
    await expect(begin()).rejects.toThrow("normalized P0 initiation invariant");
    await expect(fs.access(resetJournalPath(root))).rejects.toThrow();
  });

  test("exact-target pre-existing recovery refs are normalized to R0 before publication", async () => {
    const entry = await zFixture(path.join(root, "repo-init"), "repo-init", "d");
    await git(path.join(root, "repo-init"), "update-ref", entry.recoveryRef, entry.targetOid);
    await begin([entry]);
    expect(await git(path.join(root, "repo-init"), "rev-parse", "--verify", "--quiet", entry.recoveryRef).catch(() => "absent")).toBe("absent");
    expect(await inspectResetJournal(root, "old-stream")).toMatchObject({
      status: "recoverable", row: { ids: ["P0"] }, observation: { recoveryRefs: { kind: "prefix", count: 0, total: 1 } },
    });
    expect(await recoverResetJournal(root, "old-stream")).toBe("complete");
  });

  test("ref normalization revalidates repository identity immediately before deletion", async () => {
    const repo = path.join(root, "repo-normalize-race");
    const moved = path.join(root, "repo-normalize-race-old");
    const entry = await zFixture(repo, "repo-normalize-race", "9");
    await git(repo, "update-ref", entry.recoveryRef, entry.targetOid);
    let replaced = false;
    await expect(beginResetJournal(root, "new-stream", oldBytes(), oldState(), [entry], {
      version: 2, authorizedNextStream: "new-stream", consentKind: "setup-rebind", mintedAtRevision: 7,
    }, {
      randomBytes: random,
      now,
      crashAt: async (point) => {
        if (point !== "before-recovery-ref-normalize-1") return;
        replaced = true;
        await fs.rename(repo, moved);
        await fs.mkdir(repo);
        await git(repo, "init", "-q");
        const replacementTarget = await git(repo, "hash-object", "-w", "-t", "tree", "/dev/null");
        expect(replacementTarget).toBe(entry.targetOid);
        await git(repo, "update-ref", entry.activeRef, replacementTarget);
        await git(repo, "update-ref", entry.recoveryRef, replacementTarget);
      },
    })).rejects.toThrow("repository incarnation changed");
    expect(replaced).toBe(true);
    expect(await git(repo, "rev-parse", "--verify", entry.recoveryRef)).toBe(entry.targetOid);
    await expect(fs.access(resetJournalPath(root))).rejects.toThrow();
  });

  test("wrong archive bytes and wrong recovery targets remain initiation holds", async () => {
    const hash = crypto.createHash("sha256").update(oldBytes()).digest("hex");
    const archive = resetArchivePath(root, oldState().stateNonce!, hash);
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await fs.writeFile(archive, "wrong");
    await expect(begin()).rejects.toThrow("normalized P0 initiation invariant");
    await fs.rm(archive);
    const entry = await zFixture(path.join(root, "repo-wrong-ref"), "repo-wrong-ref", "e");
    const otherFile = path.join(root, "wrong-target");
    await fs.writeFile(otherFile, "wrong target");
    const other = await git(path.join(root, "repo-wrong-ref"), "hash-object", "-w", otherFile);
    await git(path.join(root, "repo-wrong-ref"), "update-ref", entry.recoveryRef, other);
    await expect(begin([entry])).rejects.toThrow("wrong recovery Z target");
    await expect(fs.access(resetJournalPath(root))).rejects.toThrow();
  });
});

test("a transient ref-read error at quarantine is not serialized and the bundle still restores", async () => {
  const stream = "https://observe.test::ws-observe::root";
  const observedState: SyncState = { ...oldState(), stream };
  await saveConfig(root, {
    schema: "e2ee/v1", remoteUrl: "https://observe.test", remoteWorkspaceId: "ws-observe", projectId: "root",
    rootPath: root, deviceId: "dev-observe", token: "", encrypted: true,
  });
  await saveStateUnsafeLegacyOrTest(root, observedState);
  const entry = await zFixture(path.join(root, "transient-read"), "transient-read", "f");
  const observedBytes = await fs.readFile(stateFile());
  await beginResetJournal(root, "next-observe", observedBytes, observedState, [entry], {
    version: 2, authorizedNextStream: "next-observe", consentKind: "setup-rebind", mintedAtRevision: 7,
  }, { randomBytes: random, now });
  await expect(recoverResetJournal(root, stream, { crashAt: (point) => {
    if (point === "after-ready") throw new Error(point);
  } })).rejects.toThrow("after-ready");

  let injected = 0;
  setGitSpawnObserver((_repo, args) => {
    if (injected < 2 && args[0] === "rev-parse") {
      injected++;
      throw new Error("transient ref observation failure");
    }
  });
  try {
    expect(await inspectResetJournal(root, stream)).toMatchObject({
      status: "halt", reason: expect.stringContaining("transient ref observation failure"),
    });
    await resetJournalDoctorCmd(root, { quarantine: true });
  } finally {
    setGitSpawnObserver(undefined);
  }
  expect(injected).toBe(2);
  const [bundleId] = await fs.readdir(resetQuarantineRoot(root));
  expect(bundleId).toBeDefined();
  const manifest = await readResetQuarantineBundle(root, path.join(resetQuarantineRoot(root), bundleId!));
  expect(JSON.parse(manifest!.refPreconditions)).toEqual({
    recovery: { kind: "prefix", count: 1, total: 1 },
    active: { kind: "prefix", count: 0, total: 1 },
  });
  expect(manifest!.refPreconditions).not.toContain("transient ref observation failure");

  await resetJournalDoctorCmd(root, { restore: bundleId });
  expect(await inspectResetJournal(root, stream)).toMatchObject({ status: "recoverable" });
  expect(await recoverResetJournal(root, stream)).toBe("complete");
});

test("doctor refuses aggregate other ref observations instead of making them restorable", async () => {
  const stream = "https://wrong-ref.test::ws-wrong-ref::root";
  const observedState: SyncState = { ...oldState(), stream };
  await saveConfig(root, {
    schema: "e2ee/v1", remoteUrl: "https://wrong-ref.test", remoteWorkspaceId: "ws-wrong-ref", projectId: "root",
    rootPath: root, deviceId: "dev-wrong-ref", token: "", encrypted: true,
  });
  await saveStateUnsafeLegacyOrTest(root, observedState);
  const repo = path.join(root, "doctor-wrong-ref");
  const entry = await zFixture(repo, "doctor-wrong-ref", "8");
  const observedBytes = await fs.readFile(stateFile());
  await beginResetJournal(root, "next-wrong-ref", observedBytes, observedState, [entry], {
    version: 2, authorizedNextStream: "next-wrong-ref", consentKind: "setup-rebind", mintedAtRevision: 7,
  }, { randomBytes: random, now });
  await expect(recoverResetJournal(root, stream, { crashAt: (point) => {
    if (point === "after-ready") throw new Error(point);
  } })).rejects.toThrow("after-ready");
  const otherFile = path.join(root, "doctor-other-target");
  await fs.writeFile(otherFile, "other");
  const other = await git(repo, "hash-object", "-w", otherFile);
  await git(repo, "update-ref", entry.recoveryRef, other, entry.targetOid);

  await expect(resetJournalDoctorCmd(root, { quarantine: true }))
    .rejects.toThrow("reset ref preconditions could not be safely observed");
  expect(await fs.readdir(resetQuarantineRoot(root)).catch(() => [])).toEqual([]);
  expect(await fs.lstat(resetJournalPath(root)).then((stat) => stat.isFile())).toBe(true);
});

describe("design 138 physical write-boundary recovery", () => {
  for (const [point, row] of [["after-candidate-create", "P1"], ["after-archive-create", "P2"]] as const) {
    test(`${row} resumes from its exact in-table signature`, async () => {
      await begin();
      await expect(recoverResetJournal(root, "old-stream", { crashAt: (seen) => { if (seen === point) throw new Error(point); } })).rejects.toThrow(point);
      expect((await inspectResetJournal(root, "old-stream"))).toMatchObject({ status: "recoverable", row: { ids: [row] } });
      expect(await recoverResetJournal(root, "old-stream")).toBe("complete");
    });
  }

  test("P3.k resumes a global recovery-ref prefix", async () => {
    const a = await zFixture(path.join(root, "p3-a"), "p3-a", "a");
    const b = await zFixture(path.join(root, "p3-b"), "p3-b", "b");
    await begin([a, b]);
    await expect(recoverResetJournal(root, "old-stream", { crashAt: (point) => { if (point === "after-recovery-ref-1") throw new Error(point); } })).rejects.toThrow("after-recovery-ref-1");
    expect((await inspectResetJournal(root, "old-stream"))).toMatchObject({ status: "recoverable", row: { ids: ["P3.1"] } });
    expect(await recoverResetJournal(root, "old-stream")).toBe("complete");
  });

  test("I2 and I3.g resume marker and common-directory retirement boundaries", async () => {
    const a = await zFixture(path.join(root, "i3-a"), "i3-a", "a");
    const b = await zFixture(path.join(root, "i3-b"), "i3-b", "b");
    await begin([a, b]);
    await expect(recoverResetJournal(root, "old-stream", { crashAt: (point) => { if (point === "after-marker-write") throw new Error(point); } })).rejects.toThrow("after-marker-write");
    expect((await inspectResetJournal(root, "old-stream"))).toMatchObject({ status: "recoverable", row: { ids: ["I2"] } });
    await expect(recoverResetJournal(root, "old-stream", { crashAt: (point) => { if (point === "after-active-group-1") throw new Error(point); } })).rejects.toThrow("after-active-group-1");
    expect((await inspectResetJournal(root, "old-stream"))).toMatchObject({ status: "recoverable", row: { ids: ["I3.1"] } });
    expect(await recoverResetJournal(root, "old-stream")).toBe("complete");
  });
});

const constrainedMemory = process.env.RBOX_RUN_CONSTRAINED_RESET_MEMORY === "1" ? test : test.skip;

async function writeLargeState(targetBytes: number): Promise<void> {
  const prefix = Buffer.from(JSON.stringify({ ...oldState(), padding: "" }).replace(/""}$/, '"'));
  const suffix = Buffer.from('"}');
  const handle = await fs.open(stateFile(), "w");
  try {
    await handle.write(prefix);
    const block = Buffer.alloc(1024 * 1024, 0x61);
    let remaining = targetBytes - prefix.byteLength - suffix.byteLength;
    while (remaining > 0) {
      const count = Math.min(remaining, block.byteLength);
      await handle.write(block, 0, count);
      remaining -= count;
    }
    await handle.write(suffix);
  } finally { await handle.close(); }
}

constrainedMemory("design 138 constrained 65 MiB journal recovery remains bounded", async () => {
  await writeLargeState(65 * 1024 * 1024);
  let large: Buffer | undefined = await fs.readFile(stateFile());
  await beginResetJournal(root, "new-stream", large, oldState(), [], {
    version: 2, authorizedNextStream: "new-stream", consentKind: "setup-rebind", mintedAtRevision: 7,
  }, { randomBytes: random, now });
  large = undefined;
  Bun.gc(true);
  expect(await recoverResetJournal(root, "old-stream")).toBe("complete");
}, 5 * 60_000);

constrainedMemory("design 138 constrained 65 MiB reset initiation passes the dynamic admission gate", async () => {
  await writeLargeState(65 * 1024 * 1024);
  await resetSyncState(root, resetDestination, undefined, resetConsent());
  expect((await loadState(root, resetDestination)).stream).toBe(resetDestination);
}, 5 * 60_000);

test("an impossible pre-marker partial Z retirement halts", async () => {
  const a = await zFixture(path.join(root, "a"), "a", "a");
  const b = await zFixture(path.join(root, "b"), "b", "b");
  await begin([a, b]);
  await expect(recoverResetJournal(root, "old-stream", { crashAt: (p) => { if (p === "after-installed") throw new Error(p); } })).rejects.toThrow("after-installed");
  await git(path.join(root, "a"), "update-ref", "-d", a.activeRef, a.targetOid);
  await expect(recoverResetJournal(root, "old-stream")).rejects.toThrow("physical reset state matches no authorized recovery row");
  expect(await git(path.join(root, "b"), "rev-parse", "--verify", b.activeRef)).toBe(b.targetOid);
});

test("one-common-dir mixed Z retirement is a corruption hold", async () => {
  const repo = path.join(root, "shared");
  const a = await zFixture(repo, "a", "a");
  const b = await zFixture(repo, "b", "b");
  await begin([a, b]);
  await expect(recoverResetJournal(root, "old-stream", { crashAt: (point) => {
    if (point === "after-installed") throw new Error(point);
  } })).rejects.toThrow("after-installed");
  await git(repo, "update-ref", "-d", a.activeRef, a.targetOid);
  await expect(recoverResetJournal(root, "old-stream")).rejects.toThrow("physical reset state matches no authorized recovery row");
  expect(await git(repo, "rev-parse", "--verify", b.activeRef)).toBe(b.targetOid);
});

test("wrong active or recovery Z targets are corruption holds", async () => {
  const repo = path.join(root, "z-targets");
  const entry = await zFixture(repo, "z-targets", "c");
  await begin([entry]);
  await expect(recoverResetJournal(root, "old-stream", { crashAt: (point) => {
    if (point === "after-ready") throw new Error(point);
  } })).rejects.toThrow("after-ready");
  const file = path.join(root, "other.txt");
  await fs.writeFile(file, "other");
  const other = await git(repo, "hash-object", "-w", file);
  await git(repo, "update-ref", entry.recoveryRef, other, entry.targetOid);
  await expect(recoverResetJournal(root, "old-stream")).rejects.toThrow("physical reset state matches no authorized recovery row");
  await git(repo, "update-ref", entry.recoveryRef, entry.targetOid, other);
  await git(repo, "update-ref", entry.activeRef, other, entry.targetOid);
  await expect(recoverResetJournal(root, "old-stream")).rejects.toThrow("physical reset state matches no authorized recovery row");
});

describe("design 130 reset preflight holds", () => {
  async function stateWithRepo(): Promise<string> {
    const repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });
    await git(repo, "init", "-q");
    await saveStateUnsafeLegacyOrTest(root, {
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
      await expect(resetSyncState(root, resetDestination, mutex, resetConsent())).rejects.toThrow("foreign or malformed active Z");
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
      await expect(resetSyncState(root, resetDestination, mutex, resetConsent())).rejects.toThrow("published checkout journal");
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
    await saveStateUnsafeLegacyOrTest(root, {
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

    await resetSyncState(root, resetDestination, undefined, resetConsent());

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

    await resetSyncState(root, resetDestination, undefined, resetConsent());

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

    await resetSyncState(root, resetDestination, undefined, resetConsent());

    expect((await readBaseAbsentArtifact(fixture.repo, fixture.binding, branch)).status).toBe("absent");
    const recovery = (await git(fixture.repo, "for-each-ref", "--format=%(refname)", `refs/rbox-recovery/base-absent/v1/${fixture.binding.lineageHash}`)).split("\n").filter(Boolean);
    expect(recovery).toHaveLength(1);
    expect((await archivedOldState()).repoRecords?.repo?.base?.refs[branch]).toBe(fixture.prior);
  });

  test("malformed K and unpreservable moved-P reflog refuse without cutting over", async () => {
    const malformed = await protocolRepo();
    const malformedP = await installP(malformed, "d".repeat(32));
    await git(malformed.repo, "update-ref", "-d", malformedP.keepRefs[0]!.ref, malformedP.keepRefs[0]!.targetOid);
    await expect(resetSyncState(root, resetDestination, undefined, resetConsent())).rejects.toThrow("malformed A/P/K artifacts");
    expect((await loadState(root, "old-stream", () => {})).stream).toBe("old-stream");

    await fs.rm(root, { recursive: true, force: true });
    root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reset-v1-unpreservable-"));
    await writeOld();
    const unpreservable = await protocolRepo();
    await installP(unpreservable, "e".repeat(32));
    await fs.writeFile(path.join(unpreservable.repo, "tracked"), "moved\n");
    await git(unpreservable.repo, "commit", "-qam", "moved");
    await fs.writeFile(path.join(unpreservable.repo, ".git", "logs", "refs", "heads", "topic"), "malformed reflog bytes\n");
    await expect(resetSyncState(root, resetDestination, undefined, resetConsent())).rejects.toThrow("unpreservable P");
    expect((await loadState(root, "old-stream", () => {})).stream).toBe("old-stream");
  });
});
