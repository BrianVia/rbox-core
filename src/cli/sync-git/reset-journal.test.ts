import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { artifactBinding, readRepoIdentityV1, readStateLineageV1, repositoryIdentityHash } from "./repo-lineage.js";
import { checkoutJournalDir } from "./journal.js";
import {
  commitProtocolRefTransaction,
  prepareBaseAbsentArtifact,
  prepareBasePresentArtifact,
  readBaseAbsentArtifact,
  readBasePresentArtifact,
} from "./base-artifacts.js";
import { gitRaw, setGitSpawnObserver } from "../../engine/git-spawn.js";
import { errMsg } from "./shared.js";
import type { RepoIdentityV1 } from "./repo-lineage.js";
import { lastWriterWitnessPath, recordLastWriterWitness, type LastWriterWitness } from "../state-plane/last-writer-witness.js";
import {
  beginResetJournal as beginResetJournalUnderLock,
  inspectResetJournal,
  inspectResetFenceInventory,
  readResetJournal,
  recoverResetJournal,
  recoverResetJournalUnderHeldFence,
  resetArchivePath,
  resetCandidatePath,
  resetIncarnationPath,
  resetJournalPath,
  validateResetJournalV2,
  type ResetZEntry,
} from "../reset-journal.js";
import { applyStateSavePacket, loadRawState, loadState, resetSyncState, saveConfig, saveStateUnsafeLegacyOrTest, type StateSavePacket, type SyncState } from "../config.js";
import { acquireWorkspaceSyncMutex, releaseWorkspaceSyncMutex } from "../sync-mutex.js";
import { mintSetupExistingConsent } from "../reset-consent.js";
import { resetJournalDoctorCmd } from "../reset-journal-doctor.js";
import { readResetQuarantineBundle, resetQuarantineRoot } from "../reset-quarantine.js";
import { acquireLock } from "../../engine/lockfile.js";
import { stateLockPath } from "../state-plane/paths.js";
import type { ResetJournalAuthorization, ResetJournalHooks } from "../reset-journal.js";
import { writeFileAtomic } from "../../engine/fsutil.js";
import { boundedCopy } from "../reset-io.js";
import { publishWholeState } from "../state-plane/adapters/legacy-json-publication.js";
import { authorityMarkerBytes } from "../state-plane/authority-marker.js";
import { StateAuthorityCorruptError, StateWriteRefusedError } from "../state-plane/errors.js";
import { sqliteResetPaths } from "../state-plane/paths.js";
import { createResetRecoveryRefs } from "../reset-z-runtime.js";
import type { OwnedLock } from "../../engine/lockfile.js";

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

async function commitAcceptedSave(packet: StateSavePacket): Promise<Buffer> {
  const result = await applyStateSavePacket(root, packet);
  expect(result.status).toBe("accepted");
  return fs.readFile(stateFile());
}

function commitAcceptedSaveSync(packet: StateSavePacket): Buffer {
  const moduleUrl = new URL("../state-plane/adapters/whole-state-compat.ts", import.meta.url).href;
  const child = Bun.spawnSync({
    cmd: [process.execPath, "-e", `const {applyStateSavePacket}=await import(${JSON.stringify(moduleUrl)});const result=await applyStateSavePacket(process.env.RBOX_TEST_ROOT,JSON.parse(process.env.RBOX_TEST_PACKET));if(result.status!=="accepted")throw new Error("save was "+result.status);`],
    env: { ...process.env, RBOX_TEST_ROOT: root, RBOX_TEST_PACKET: JSON.stringify(packet) },
    stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return fsSync.readFileSync(stateFile());
}

const competingPacket = (expectedStream: string, expectedNonce: string, sourceGlobalSeq: number): StateSavePacket => ({
  expectedStream, expectedNonce, sourceGlobalSeq,
  global: { manifest: { generatedAt: "competing-accepted-save", files: [] } },
  repos: [],
});

async function beginResetJournal(
  targetRoot: string,
  nextStream: string,
  bytes: Uint8Array,
  state: SyncState,
  z: ResetZEntry[],
  authorization: ResetJournalAuthorization,
  hooks: ResetJournalHooks = {},
) {
  const acquired = await acquireLock(stateLockPath(targetRoot));
  if (acquired.status !== "acquired") throw new Error(`test state lock unavailable: ${acquired.status}`);
  try {
    return await beginResetJournalUnderLock(
      targetRoot, nextStream, bytes, state, z, authorization, acquired.lock, hooks,
    );
  } finally {
    await acquired.lock.release();
  }
}

async function begin(z: ResetZEntry[] = [], crashAt?: (point: string) => void): Promise<void> {
  await beginResetJournal(root, "new-stream", oldBytes(), oldState(), z, {
    version: 2, authorizedNextStream: "new-stream", consentKind: "setup-rebind", mintedAtRevision: 7,
  }, { randomBytes: random, now, crashAt });
}

async function legacyProtocolTree(z: ResetZEntry[] = []): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const collect = async (directory: string): Promise<void> => {
    const relativeDirectory = path.relative(root, directory) || ".";
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    snapshot[`${relativeDirectory}/`] = entries.map((entry) => `${entry.name}:${entry.isDirectory() ? "d" : entry.isFile() ? "f" : entry.isSymbolicLink() ? "l" : "o"}`).sort().join(",");
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute);
        const bytes = await fs.readFile(absolute);
        if (relative === path.join(".rbox", "state", "last-writer.json")) {
          type RedactedLastWriterWitness = { [K in keyof LastWriterWitness]: LastWriterWitness[K] | string };
          const witness = JSON.parse(bytes.toString("utf8")) as RedactedLastWriterWitness;
          // writerVersion is the running rbox version — it changes every
          // release and is not behavior, so redact it alongside the other
          // environment-dependent fields (else every version bump breaks this
          // legacy-invariance differential).
          for (const key of ["writtenAtMs", "stateMtimeMs", "stateDev", "stateIno", "writerVersion"]) {
            if (key in witness) witness[key] = `<volatile:${key}>`;
          }
          snapshot[relative] = Buffer.from(JSON.stringify(witness)).toString("base64");
        } else if (relative === path.join(".rbox", "state", "reset-v1.json")) {
          type RedactedRepoIdentity = { [K in keyof RepoIdentityV1]?: RepoIdentityV1[K] | string };
          type RedactedResetEntry = Partial<Omit<ResetZEntry, "repositoryIdentity">> & { repositoryIdentity?: RedactedRepoIdentity };
          const journal = JSON.parse(bytes.toString("utf8")) as { old?: { z?: RedactedResetEntry[] } };
          for (const entry of journal.old?.z ?? []) {
            entry.repositoryIdentityHash = "<fixture-derived>";
            const identity = entry.repositoryIdentity;
            if (!identity) continue;
            for (const key of ["birthtime", "dev", "ino", "commonDirReal", "gitDirReal", "worktreeId"]) {
              if (key in identity) identity[key] = `<fixture:${key}>`;
            }
          }
          snapshot[relative] = Buffer.from(JSON.stringify(journal)).toString("base64");
        } else {
          snapshot[relative] = bytes.toString("base64");
        }
      }
      else if (entry.isSymbolicLink()) snapshot[path.relative(root, absolute)] = `symlink:${await fs.readlink(absolute)}`;
    }
  };
  // Full protocol namespace: this catches unknown temps, unexpected leaves,
  // and directory-only residue rather than enumerating expected artifacts.
  await collect(path.join(root, ".rbox"));
  const commonDirectories = new Set(z.map((entry) => entry.repositoryIdentity.commonDirReal));
  for (const commonDirectory of commonDirectories) {
    for (const namespace of ["refs/rbox-local", "refs/rbox-recovery"]) {
      const namespaceRoot = path.join(commonDirectory, namespace);
      const prefix = `git-protocol:${path.relative(root, commonDirectory)}:${namespace}`;
      const collectRefs = async (directory: string): Promise<void> => {
        const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => undefined);
        if (!entries) {
          snapshot[`${prefix}${path.relative(namespaceRoot, directory) ? `/${path.relative(namespaceRoot, directory)}` : ""}/`] = "<absent>";
          return;
        }
        const relative = path.relative(namespaceRoot, directory);
        snapshot[`${prefix}${relative ? `/${relative}` : ""}/`] = entries
          .map((entry) => `${entry.name}:${entry.isDirectory() ? "d" : entry.isFile() ? "f" : entry.isSymbolicLink() ? "l" : "o"}`)
          .sort()
          .join(",");
        for (const child of entries) {
          const absolute = path.join(directory, child.name);
          if (child.isDirectory()) await collectRefs(absolute);
          else if (child.isFile()) {
            snapshot[`${prefix}/${path.relative(namespaceRoot, absolute)}`] =
              (await fs.readFile(absolute)).toString("base64");
          } else if (child.isSymbolicLink()) {
            snapshot[`${prefix}/${path.relative(namespaceRoot, absolute)}`] =
              `symlink:${await fs.readlink(absolute)}`;
          }
        }
      };
      await collectRefs(namespaceRoot);
    }
  }
  for (const entry of z) {
    for (const ref of [entry.activeRef, entry.recoveryRef]) {
      const file = path.join(entry.repositoryIdentity.commonDirReal, ref);
      const bytes = await fs.readFile(file).catch(() => undefined);
      snapshot[`git-ref:${path.relative(root, file)}`] = bytes?.toString("base64") ?? "<absent>";
    }
  }
  return Object.fromEntries(Object.entries(snapshot).sort(([left], [right]) => left.localeCompare(right)));
}

async function byteLevelProtocolFixture(): Promise<Record<string, string | { bytes: number; sha256: string; bodyBase64?: string }>> {
  const tree = await legacyProtocolTree();
  return Object.fromEntries(Object.entries(tree).map(([file, value]) => {
    if (file.endsWith("/") || value.startsWith("symlink:") || value === "<absent>") return [file, value];
    const bytes = Buffer.from(value, "base64");
    const fixture = {
      bytes: bytes.byteLength,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
    return [file, bytes.byteLength <= 1_024 ? { ...fixture, bodyBase64: value } : fixture];
  }));
}

async function freshLegacyFixture(label: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
  root = await fs.mkdtemp(path.join(os.tmpdir(), `rbox-reset-differential-${label}-`));
  await writeOld();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reset-v1-"));
  await writeOld();
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const X_TIMINGS = ["stale-entry", "syscall-adjacent"] as const;

function stealStateLock(lock: OwnedLock): void {
  fsSync.writeFileSync(lock.path, "foreign lease\n");
}

async function acquireStateLock(): Promise<OwnedLock> {
  const acquired = await acquireLock(stateLockPath(root));
  if (acquired.status !== "acquired") throw new Error(`test state lock unavailable: ${acquired.status}`);
  return acquired.lock;
}

function assertTestOwner(lock: OwnedLock, target: string): void {
  if (!lock.isOwnerSync()) throw new StateWriteRefusedError("state-lock-lease-lost", target);
}

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

  for (const point of [
    "after-prepared",
    "after-candidate-create",
    "after-archive-create",
    "after-ready",
    "after-destination-parent-fsync",
    "after-source-parent-fsync",
    "after-state-replace",
    "after-installed",
    "after-marker-write",
    "after-z-retired",
  ]) {
    test(`legacy JSON byte-tree differential at ${point} covers old/next config`, async () => {
      const run = async (callerStream: "old-stream" | "new-stream") => {
        await freshLegacyFixture(`${point}-${callerStream}`);
        if (point === "after-prepared") {
          await expect(begin([], (seen) => {
            if (seen === point) throw new Error(point);
          })).rejects.toThrow(point);
        } else {
          await begin();
          await expect(recoverResetJournal(root, callerStream, { crashAt: (seen) => {
            if (seen === point) throw new Error(point);
          } })).rejects.toThrow(point);
        }
        const beforeRecovery = await legacyProtocolTree();
        expect(await recoverResetJournal(root, callerStream)).toBe("complete");
        return { beforeRecovery, afterRecovery: await legacyProtocolTree() };
      };

      const oldConfig = await run("old-stream");
      const nextConfig = await run("new-stream");
      // Config disposition selects roll-forward versus retirement policy, but
      // every admitted legacy JSON row has the same exact physical transition.
      expect(nextConfig.beforeRecovery).toEqual(oldConfig.beforeRecovery);
      expect(nextConfig.afterRecovery).toEqual(oldConfig.afterRecovery);
      expect(oldConfig).toMatchSnapshot();
    });
  }

  for (const point of [
    "after-recovery-ref-1",
    "after-recovery-ref-2",
    "after-active-group-1",
    "after-active-group-2",
  ]) {
    test(`legacy JSON byte-tree differential at ${point} covers old/next config`, async () => {
      const fixtureParent = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reset-z-differential-"));
      const fixedRoot = path.join(fixtureParent, "workspace");
      try {
        root = fixedRoot;
        await writeOld();
        const z = [
          await zFixture(path.join(root, "repo-a"), "repo-a", "a"),
          await zFixture(path.join(root, "repo-b"), "repo-b", "b"),
        ];
        await begin(z);
        const preparedJournal = await fs.readFile(resetJournalPath(root));
        const restorePreparedTree = async (): Promise<void> => {
          await fs.rm(path.join(root, ".rbox", "state"), { recursive: true, force: true });
          await fs.mkdir(path.dirname(resetJournalPath(root)), { recursive: true });
          await fs.writeFile(stateFile(), oldBytes());
          await fs.writeFile(resetJournalPath(root), preparedJournal);
          for (const entry of z) {
            const repo = entry.repositoryIdentity.worktreeId;
            await git(repo, "update-ref", entry.activeRef, entry.targetOid);
            await git(repo, "update-ref", "-d", entry.recoveryRef);
          }
        };
        const run = async (callerStream: "old-stream" | "new-stream") => {
          await restorePreparedTree();
          await expect(recoverResetJournal(root, callerStream, { crashAt: (seen) => {
            if (seen === point) throw new Error(point);
          } })).rejects.toThrow(point);
          const beforeRecovery = await legacyProtocolTree(z);
          expect(await recoverResetJournal(root, callerStream)).toBe("complete");
          return { beforeRecovery, afterRecovery: await legacyProtocolTree(z) };
        };

        const oldConfig = await run("old-stream");
        const nextConfig = await run("new-stream");
        expect(nextConfig.beforeRecovery).toEqual(oldConfig.beforeRecovery);
        expect(nextConfig.afterRecovery).toEqual(oldConfig.afterRecovery);
        expect(oldConfig).toMatchSnapshot();
      } finally {
        await fs.rm(fixtureParent, { recursive: true, force: true });
      }
    });
  }

  for (const [point, count] of [["before-recovery-ref-normalize-1", 0], ["before-recovery-ref-normalize-2", 1]] as const) {
    test(`legacy initiation normalization golden at ${point}`, async () => {
      const z = [
        await zFixture(path.join(root, "normalize-a"), "normalize-a", "a"),
        await zFixture(path.join(root, "normalize-b"), "normalize-b", "b"),
      ];
      for (const entry of z) await git(entry.repositoryIdentity.worktreeId, "update-ref", entry.recoveryRef, entry.targetOid);
      await expect(beginResetJournal(root, "new-stream", oldBytes(), oldState(), z, {
        version: 2, authorizedNextStream: "new-stream", consentKind: "setup-rebind", mintedAtRevision: 7,
      }, {
        randomBytes: random,
        now,
        crashAt(seen) { if (seen === point) throw new Error(point); },
      })).rejects.toThrow(point);
      const beforeResume = await legacyProtocolTree(z);
      expect(z.slice(0, count).every((entry) => beforeResume[`git-ref:${path.relative(root, path.join(entry.repositoryIdentity.commonDirReal, entry.recoveryRef))}`] === "<absent>")).toBe(true);
      await begin(z);
      expect({ beforeResume, afterResume: await legacyProtocolTree(z) }).toMatchSnapshot();
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

async function stagePublicStandingReset(point: string): Promise<void> {
  if (point === "after-prepared") {
    await expect(begin([], (seen) => { if (seen === point) throw new Error(point); })).rejects.toThrow(point);
    return;
  }
  await begin();
  await expect(recoverResetJournal(root, "old-stream", { crashAt(seen) {
    if (seen === point) throw new Error(point);
  } })).rejects.toThrow(point);
}

for (const point of ["after-prepared", "after-candidate-create", "after-archive-create", "after-ready", "after-installed"]) {
  test(`P public fence inventory authenticates standing JSON at ${point}`, async () => {
    await stagePublicStandingReset(point);
    const before = await fs.readFile(stateFile());
    const inventory = await inspectResetFenceInventory(root, "old-stream");
    expect(inventory.settlement).toBe("required");
    expect(inventory.observation).toBeDefined();
    expect(await fs.readFile(stateFile())).toEqual(before);
  });

  test(`P public load settlement resumes standing JSON at ${point}`, async () => {
    await stagePublicStandingReset(point);
    expect((await loadState(root, "new-stream", () => undefined)).stream).toBe("new-stream");
    expect((await inspectResetFenceInventory(root, "new-stream")).settlement).toBe("none");
  });
}

for (const residue of ["none", "unselected-db", "orphan-candidate", "orphan-archive", "inert-temp"] as const) {
  test(`P E7b JSON no-state eligibility remains neutral with ${residue}`, async () => {
    await fs.rm(root, { recursive: true, force: true });
    root = await fs.mkdtemp(path.join(os.tmpdir(), `rbox-reset-e7b-${residue}-`));
    let residuePath: string | undefined;
    if (residue !== "none") {
      residuePath = residue === "unselected-db"
        ? path.join(root, ".rbox", "state", "state.db")
        : residue === "orphan-candidate"
          ? path.join(root, ".rbox", "state", "reset-candidates", `${"3".repeat(32)}.db`)
          : residue === "orphan-archive"
            ? path.join(root, ".rbox", "state", "lineages", "4".repeat(32), `${"5".repeat(64)}.db`)
            : path.join(root, ".rbox", "state", "reset-candidates", ".rbox-tmp-1-1-inert.db");
      await fs.mkdir(path.dirname(residuePath), { recursive: true });
      await fs.writeFile(residuePath, `residue:${residue}\n`);
    }
    const before = await byteLevelProtocolFixture();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const randomBytes = spyOn(crypto, "randomBytes").mockImplementation((size) => Buffer.alloc(size, 0x66));
    const log = spyOn(console, "log").mockImplementation((...values) => { stdout.push(values.join(" ")); });
    const error = spyOn(console, "error").mockImplementation((...values) => { stderr.push(values.join(" ")); });
    try {
      await resetSyncState(root, "new-stream");
    } finally {
      randomBytes.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
    expect(await loadRawState(root)).toBeUndefined();
    if (residuePath) expect(await fs.readFile(residuePath, "utf8")).toBe(`residue:${residue}\n`);
    expect({ before, after: await byteLevelProtocolFixture(), stdout, stderr })
      .toMatchSnapshot(`E0 E7b pre-port byte differential ${residue}`);
  });
}

test("reset consent refuses a corrupt selected store with zero effects", async () => {
  const authorityId = "a".repeat(32);
  await fs.writeFile(stateFile(), authorityMarkerBytes(authorityId));
  await fs.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  await fs.writeFile(sqliteResetPaths.active(root), "not a SQLite database\n");
  const before = await legacyProtocolTree();

  await expect(resetSyncState(root, resetDestination, undefined, resetConsent()))
    .rejects.toBeInstanceOf(StateAuthorityCorruptError);

  expect(await legacyProtocolTree()).toEqual(before);
});

for (const timing of X_TIMINGS) {
  test(`X1 JSON journal/phase/marker atomic rename refuses owner loss at ${timing}`, async () => {
    const lock = await acquireStateLock();
    const target = resetJournalPath(root);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "old-row\n");
    if (timing === "stale-entry") stealStateLock(lock);
    await expect(writeFileAtomic(target, "new-row\n", {
      onStep(point) { if (timing === "syscall-adjacent" && point === "before-rename") stealStateLock(lock); },
      beforeRenameSync() { assertTestOwner(lock, target); },
    })).rejects.toMatchObject({ reason: "state-lock-lease-lost" });
    expect(await fs.readFile(target, "utf8")).toBe("old-row\n");
  });

  test(`X2 JSON candidate/archive bounded copy refuses owner loss at ${timing}`, async () => {
    const lock = await acquireStateLock();
    const source = stateFile();
    const target = path.join(root, ".rbox", "state", "lineages", "copy.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "old-copy\n");
    if (timing === "stale-entry") stealStateLock(lock);
    await expect(boundedCopy(source, target, undefined, {
      onStep(point) { if (timing === "syscall-adjacent" && point === "before-rename") stealStateLock(lock); },
      beforeRenameSync() { assertTestOwner(lock, target); },
    })).rejects.toMatchObject({ reason: "state-lock-lease-lost" });
    expect(await fs.readFile(target, "utf8")).toBe("old-copy\n");
  });

  test(`X3 JSON candidate-to-active rename preserves a competing accepted save at ${timing}`, async () => {
    await begin();
    await expect(recoverResetJournal(root, "old-stream", { crashAt(point) {
      if (point === "after-ready") throw new Error(point);
    } })).rejects.toThrow("after-ready");
    const lock = await acquireStateLock();
    let competing: Buffer;
    if (timing === "stale-entry") {
      await lock.release();
      competing = await commitAcceptedSave(competingPacket("old-stream", "1".repeat(32), 10));
    } else {
      const original = lock.isOwnerSync.bind(lock);
      let checks = 0;
      lock.isOwnerSync = () => {
        checks++;
        if (checks === 2) {
          fsSync.rmSync(lock.path, { force: true });
          competing = commitAcceptedSaveSync(competingPacket("old-stream", "1".repeat(32), 10));
        }
        return original();
      };
    }
    await expect(recoverResetJournalUnderHeldFence(root, "old-stream", {}, lock))
      .rejects.toMatchObject({ reason: "state-lock-lease-lost" });
    expect(await fs.readFile(stateFile())).toEqual(competing!);
  });

  test(`X4 JSON recovery-ref spawn preserves the preceding prefix at ${timing}`, async () => {
    const entry = await zFixture(path.join(root, `x4-${timing}`), `x4-${timing}`, "7");
    const lock = await acquireStateLock();
    if (timing === "stale-entry") stealStateLock(lock);
    if (timing === "syscall-adjacent") {
      setGitSpawnObserver((_repo, args) => {
        if (args[0] === "update-ref" && args[1] === entry.recoveryRef) stealStateLock(lock);
      });
    }
    try {
      await expect(createResetRecoveryRefs(root, [entry], 0, lock))
        .rejects.toMatchObject({ reason: "state-lock-lease-lost" });
    } finally {
      setGitSpawnObserver(undefined);
    }
    await expect(gitRaw(entry.repositoryIdentity.commonDirReal, ["rev-parse", "--verify", entry.recoveryRef]))
      .rejects.toBeDefined();
  });

  test(`X5 JSON terminal journal unlink retains Z0 at ${timing}`, async () => {
    await begin();
    await expect(recoverResetJournal(root, "old-stream", { crashAt(point) {
      if (point === "after-z-retired") throw new Error(point);
    } })).rejects.toThrow("after-z-retired");
    const lock = await acquireStateLock();
    if (timing === "stale-entry") stealStateLock(lock);
    else {
      const original = lock.isOwnerSync.bind(lock);
      let checks = 0;
      lock.isOwnerSync = () => {
        checks++;
        if (checks === 2) stealStateLock(lock);
        return original();
      };
    }
    await expect(recoverResetJournalUnderHeldFence(root, "old-stream", {}, lock))
      .rejects.toMatchObject({ reason: "state-lock-lease-lost" });
    expect((await readResetJournal(root))?.phase).toBe("z-retired");
  });

  // Two shapes of competing writer, because they are not the same evidence.
  // Raw bytes prove the lease check alone protects the file. A committed save
  // proves it against the writer the state plane actually admits — one that
  // arrives through `applyStateSavePacket` on a root seeded with explicit legacy
  // JSON (§6), which is the only way a legacy save reaches this file post-flip.
  for (const competitor of ["raw-bytes", "committed-save"] as const) {
    test(`X6 E0 publishWholeState preserves a competing ${competitor} writer at ${timing}`, async () => {
      await fs.rm(stateFile());
      if (competitor === "committed-save") {
        // Unstamped legacy JSON — the shape `"legacy"` is the CAS sentinel for.
        await saveStateUnsafeLegacyOrTest(root, {
          stream: "competing-genesis",
          lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] },
        });
      }
      const lock = await acquireStateLock();
      let competing!: Buffer;
      const compete = async (): Promise<void> => {
        if (competitor === "raw-bytes") {
          competing = Buffer.from('{"stream":"competing-legacy"}\n');
          await fs.writeFile(stateFile(), competing);
        } else {
          competing = await commitAcceptedSave(competingPacket("competing-genesis", "legacy", 1));
        }
      };
      if (timing === "stale-entry") {
        await lock.release();
        await compete();
      } else {
        const original = lock.isOwner.bind(lock);
        lock.isOwner = async () => {
          const owned = await original();
          await lock.release();
          await compete();
          return owned;
        };
      }
      await expect(publishWholeState(stateFile(), '{"stream":"stale-genesis"}\n', lock))
        .rejects.toMatchObject({ reason: "state-lock-lease-lost" });
      expect(await fs.readFile(stateFile())).toEqual(competing);
    });
  }

  test(`X7 last-writer witness preserves competing witness at ${timing}`, async () => {
    const sampled = await commitAcceptedSave(competingPacket("old-stream", "1".repeat(32), 10));
    const lock = await acquireStateLock();
    let competing: Buffer;
    let witnessBefore: Buffer;
    if (timing === "stale-entry") {
      await lock.release();
      competing = await commitAcceptedSave(competingPacket("old-stream", "1".repeat(32), 11));
      witnessBefore = await fs.readFile(lastWriterWitnessPath(root));
    } else {
      const original = lock.isOwnerSync.bind(lock);
      let checks = 0;
      lock.isOwnerSync = () => {
        checks++;
        if (checks === 2) {
          fsSync.rmSync(lock.path, { force: true });
          competing = commitAcceptedSaveSync(competingPacket("old-stream", "1".repeat(32), 11));
          witnessBefore = fsSync.readFileSync(lastWriterWitnessPath(root));
        }
        return original();
      };
    }
    expect(await recordLastWriterWitness(root, stateFile(), sampled, () => 200, lock)).toBeUndefined();
    expect(await fs.readFile(stateFile())).toEqual(competing!);
    expect(await fs.readFile(lastWriterWitnessPath(root))).toEqual(witnessBefore!);
  });
}

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

  /** A P whose episode CREATED its ref: `priorOid` is null, which is the one
   *  shape an absent BASE cannot classify as moved. */
  async function installRefCreatingP(fixture: Awaited<ReturnType<typeof protocolRepo>>, episode = "e".repeat(32)) {
    const created = "refs/heads/created";
    const prepared = await prepareBasePresentArtifact(fixture.repo, fixture.binding, created, episode, null, fixture.next);
    await gitRaw(fixture.repo, ["update-ref", "--stdin", "--create-reflog", "-m", episode], {
      stdin: ["start", ...prepared.transactionLines, `create ${created} ${fixture.next}`, "prepare", "commit", ""].join("\n"),
    });
    return created;
  }

  /** Design 271 §2.1: reset stays a refusal for a BASE-less record, and its
   *  message names the typed code so the field can tell the shapes apart. */
  test("a create-shaped standing P over a record with NO serialized BASE refuses, naming base-absent", async () => {
    const fixture = await protocolRepo();
    await installRefCreatingP(fixture);
    await saveStateUnsafeLegacyOrTest(root, {
      ...oldState(),
      lastSyncedManifest: { generatedAt: "old", files: [], gitRepos: { repo: section(fixture.prior) } },
      repoRecords: { repo: { repoGen: 1, sourceSeq: 1 } },
    });

    await expect(resetSyncState(root, resetDestination, undefined, resetConsent()))
      .rejects.toThrow("unpreservable P for repo (base-absent)");
    expect((await loadState(root, "old-stream", () => {})).stream).toBe("old-stream");
  });

  /** The base-absent hold must NOT preempt the moved/base-shape classification
   *  for an advancing P: that classification is what routes reset to bounded
   *  P-repair, and preempting it turned a repairable reset into a throw. */
  test("an advancing standing P over a BASE-less record still routes to bounded P-repair", async () => {
    const fixture = await protocolRepo();
    await installP(fixture, "f".repeat(32));
    await saveStateUnsafeLegacyOrTest(root, {
      ...oldState(),
      lastSyncedManifest: { generatedAt: "old", files: [], gitRepos: { repo: section(fixture.prior) } },
      repoRecords: { repo: { repoGen: 1, sourceSeq: 1 } },
    });

    let outcome = "completed";
    try {
      await resetSyncState(root, resetDestination, undefined, resetConsent());
    } catch (error) {
      outcome = errMsg(error);
    }

    // Whatever bounded P-repair then concludes is this shape's PRE-EXISTING
    // behaviour (this fixture reaches the repair's own lock acquisition); the
    // one thing the entry test must never do is answer for it.
    expect(outcome).not.toContain("base-absent");
    expect(outcome).not.toContain("BASE absent");
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
