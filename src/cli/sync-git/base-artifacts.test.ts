import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalize } from "../../engine/e2ee/jcs.js";
import { isSyncableRef } from "../../engine/manifest-validate.js";
import { repoCtx } from "./git-state.js";
import { gitRaw } from "../../engine/git-spawn.js";
import {
  BASE_ABSENT_PREFIX,
  BASE_PRESENT_KEEP_PREFIX,
  BASE_PRESENT_PREFIX,
  MAX_BASE_PRESENT,
  MAX_BASE_PRESENT_KEEP,
  MAX_UNSETTLED_BASE_ABSENT,
  baseAbsentArtifactRef,
  baseAbsentPayload,
  basePresentArtifactRef,
  basePresentKeepRef,
  basePresentPayload,
  branchRefHash,
  buildSettledAbsenceTree,
  commitProtocolRefTransaction,
  lookupSettledAbsence,
  prepareBaseAbsentArtifact,
  prepareBasePresentArtifact,
  prepareRetireSettledAbsence,
  readBaseAbsentArtifact,
  readBasePresentArtifact,
  readSettledAbsence,
  settleBaseAbsentArtifact,
  settledAbsenceRef,
} from "./base-artifacts.js";
import {
  artifactBinding,
  encodeRepoIdentityV1,
  encodeStateLineageV1,
  lineageHash,
  readRepoIdentityV1,
  readStateLineageV1,
  repositoryIdentityHash,
  type ArtifactBinding,
  type RepoIdentityV1,
  type StateLineageV1,
} from "./repo-lineage.js";
import { scanBaseArtifacts } from "./base-artifact-scan.js";

const exec = promisify(execFile);
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox-test@local",
};
let tmp: string;
let repo: string;
let commit: string;
let binding: ArtifactBinding;

async function runGit(...args: string[]): Promise<string> {
  return exec("git", ["-C", repo, ...args], { env: ENV }).then(({ stdout }) => stdout.toString().trim());
}

async function writeBlob(bytes: Uint8Array | string): Promise<string> {
  return (await gitRaw(repo, ["hash-object", "-w", "--stdin"], { stdin: bytes instanceof Uint8Array ? Buffer.from(bytes).toString("utf8") : bytes })).trim();
}

async function writeTree(lines: string[]): Promise<string> {
  return (await gitRaw(repo, ["mktree"], { stdin: `${lines.join("\n")}\n` })).trim();
}

function fixtureIdentity(overrides: Partial<RepoIdentityV1> = {}): RepoIdentityV1 {
  return {
    relPath: "repo/sub",
    kind: "dir",
    worktreeId: "/workspace/repo/sub",
    gitDirReal: "/workspace/repo/sub/.git",
    commonDirReal: "/workspace/repo/sub/.git",
    dev: "17",
    ino: "29",
    birthtime: "1700000000123456789",
    ...overrides,
  };
}

function fixtureLineage(overrides: Partial<StateLineageV1> = {}): StateLineageV1 {
  return {
    workspaceRootReal: "/workspace",
    stream: "account/workspace/project",
    stateNonce: "01".repeat(16),
    repositoryIdentity: fixtureIdentity(),
    ...overrides,
  };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-base-artifacts-"));
  repo = path.join(tmp, "repo");
  await fs.mkdir(repo);
  await exec("git", ["-C", repo, "init", "-qb", "main"], { env: ENV });
  await fs.writeFile(path.join(repo, "tracked.txt"), "one\n");
  await runGit("add", "tracked.txt");
  await runGit("commit", "-qm", "one");
  commit = await runGit("rev-parse", "HEAD");
  binding = artifactBinding(fixtureLineage());
});

afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe("repository and lineage identity", () => {
  test("encodes the exact domain and ordered u64-length fields", () => {
    const identity = fixtureIdentity();
    const bytes = Buffer.from(encodeRepoIdentityV1(identity));
    const domain = Buffer.from("rbox-repo-identity-v1\0", "ascii");
    expect(bytes.subarray(0, domain.length)).toEqual(domain);
    let offset = domain.length;
    for (const field of [identity.relPath, identity.kind, identity.worktreeId, identity.gitDirReal, identity.commonDirReal, identity.dev, identity.ino, identity.birthtime]) {
      const length = Number(bytes.readBigUInt64BE(offset));
      offset += 8;
      expect(bytes.subarray(offset, offset + length).toString()).toBe(field);
      offset += length;
    }
    expect(offset).toBe(bytes.length);
    expect(repositoryIdentityHash(identity)).toBe("530d6a6acc1ceadd4bf258cdebc3b67414d595377d97075c9c4b3b0ab58bc258");
  });

  test("lineage length-delimits root, stream, nonce, and complete identity bytes", () => {
    const lineage = fixtureLineage();
    const bytes = Buffer.from(encodeStateLineageV1(lineage));
    expect(bytes.subarray(0, 16).toString("ascii")).toBe("rbox-lineage-v1\0");
    expect(lineageHash(lineage)).toBe("8da2914095176fe8939d19779b32da62666d40cbd4fd6fb3915a44a2fdabff84");
    expect(lineageHash({ ...lineage, stateNonce: "02".repeat(16) })).not.toBe(lineageHash(lineage));
    expect(lineageHash({ ...lineage, repositoryIdentity: fixtureIdentity({ relPath: "other" }) })).not.toBe(lineageHash(lineage));
    expect(lineageHash({ ...lineage, repositoryIdentity: fixtureIdentity({ ino: "30" }) })).not.toBe(lineageHash(lineage));
  });

  test("rejects noncanonical identity fields and reads realpath/stat incarnation", async () => {
    expect(() => encodeRepoIdentityV1(fixtureIdentity({ relPath: "../escape" }))).toThrow();
    expect(() => encodeRepoIdentityV1(fixtureIdentity({ dev: "017" }))).toThrow();
    expect(() => encodeRepoIdentityV1(fixtureIdentity({ birthtime: "18446744073709551616" }))).toThrow();
    expect(() => encodeStateLineageV1({ ...fixtureLineage(), stateNonce: "legacy" })).toThrow();
    const ctx = await repoCtx(repo);
    if (!ctx) throw new Error("missing repo context");
    const actual = await readRepoIdentityV1(".", ctx.kind, { worktreeId: repo, gitDirReal: ctx.gitDir, commonDirReal: ctx.commonDir });
    expect(actual.worktreeId).toBe(await fs.realpath(repo));
    expect(actual.commonDirReal).toBe(await fs.realpath(ctx.commonDir));
    expect(actual.dev).toMatch(/^[0-9]+$/);
    expect(actual.ino).toMatch(/^[0-9]+$/);
    const fromDisk = await readStateLineageV1(tmp, "stream", "03".repeat(16), actual);
    expect(fromDisk.workspaceRootReal).toBe(await fs.realpath(tmp));
  });
});

describe("A and P/K artifacts", () => {
  test("creates and strictly reads canonical direct A", async () => {
    const prepared = await prepareBaseAbsentArtifact(repo, binding, "refs/heads/topic", commit);
    expect(Buffer.from(prepared.payloadBytes).toString()).toBe(`{"lineageHash":"${binding.lineageHash}","priorOid":"${commit}","ref":"refs/heads/topic","repositoryIdentityHash":"${binding.repositoryIdentityHash}","v":2}`);
    expect(prepared.ref).toBe(`${BASE_ABSENT_PREFIX}/${binding.lineageHash}/${branchRefHash("refs/heads/topic")}`);
    await commitProtocolRefTransaction(repo, prepared.transactionLines);
    expect(await readBaseAbsentArtifact(repo, binding, "refs/heads/topic")).toMatchObject({ status: "valid", artifact: { targetOid: prepared.targetOid, payload: prepared.payload } });
    expect(isSyncableRef(prepared.ref)).toBe(false);
  });

  test("rejects extra fields, noncanonical bytes, wrong target type, ref mismatch, and indirect refs", async () => {
    const ref = "refs/heads/topic";
    const artifactRef = baseAbsentArtifactRef(binding, ref);
    const payload = baseAbsentPayload(binding, ref, commit);
    for (const hostile of [
      JSON.stringify({ ...payload, extra: true }),
      JSON.stringify(payload, null, 2),
      JSON.stringify({ ...payload, ref: "refs/heads/other" }),
    ]) {
      const target = await writeBlob(hostile);
      await runGit("update-ref", artifactRef, target);
      expect((await readBaseAbsentArtifact(repo, binding, ref)).status).toBe("invalid");
    }
    await runGit("update-ref", artifactRef, commit);
    expect(await readBaseAbsentArtifact(repo, binding, ref)).toMatchObject({ status: "invalid", reason: "wrong-object-type" });
    await runGit("update-ref", "-d", artifactRef);
    await runGit("symbolic-ref", artifactRef, "refs/heads/main");
    expect(await readBaseAbsentArtifact(repo, binding, ref)).toMatchObject({ status: "invalid", reason: "indirect-ref" });
  });

  test("P requires exact prior/next K refs and supports absent-to-present", async () => {
    const prior = commit;
    await fs.writeFile(path.join(repo, "tracked.txt"), "two\n");
    await runGit("commit", "-qam", "two");
    const next = await runGit("rev-parse", "HEAD");
    const episode = "ab".repeat(16);
    const prepared = await prepareBasePresentArtifact(repo, binding, "refs/heads/topic", episode, prior, next);
    expect(prepared.keepRefs).toEqual([
      { ref: basePresentKeepRef(binding, "refs/heads/topic", episode, "prior"), targetOid: prior, slot: "prior" },
      { ref: basePresentKeepRef(binding, "refs/heads/topic", episode, "next"), targetOid: next, slot: "next" },
    ]);
    await commitProtocolRefTransaction(repo, prepared.transactionLines);
    expect((await readBasePresentArtifact(repo, binding, "refs/heads/topic")).status).toBe("valid");
    const malformedP = await writeBlob(canonicalize({ ...prepared.payload, extra: 1 }));
    await runGit("update-ref", prepared.ref, malformedP, prepared.targetOid);
    expect((await readBasePresentArtifact(repo, binding, "refs/heads/topic")).status).toBe("invalid");
    await runGit("update-ref", prepared.ref, prepared.targetOid, malformedP);
    await runGit("update-ref", "-d", prepared.keepRefs[0]!.ref);
    expect(await readBasePresentArtifact(repo, binding, "refs/heads/topic")).toMatchObject({ status: "invalid", reason: "missing-keep" });
    await runGit("update-ref", prepared.keepRefs[0]!.ref, next);
    expect(await readBasePresentArtifact(repo, binding, "refs/heads/topic")).toMatchObject({ status: "invalid", reason: "wrong-keep-target" });

    const created = await prepareBasePresentArtifact(repo, binding, "refs/heads/new", "cd".repeat(16), null, next);
    expect(created.keepRefs.map((entry) => entry.slot)).toEqual(["next"]);
    await expect(prepareBasePresentArtifact(repo, binding, "refs/heads/noop", "12".repeat(16), next, next)).rejects.toThrow("no-op");
  });

  test("scan detects malformed namespaces, orphan K, foreign artifacts, and valid current artifacts", async () => {
    const a = await prepareBaseAbsentArtifact(repo, binding, "refs/heads/a", commit);
    const p = await prepareBasePresentArtifact(repo, binding, "refs/heads/p", "ef".repeat(16), null, commit);
    await commitProtocolRefTransaction(repo, [...a.transactionLines, ...p.transactionLines]);
    const orphan = `${BASE_PRESENT_KEEP_PREFIX}/${binding.lineageHash}/${branchRefHash("refs/heads/orphan")}/${"12".repeat(16)}/next`;
    const malformed = `${BASE_ABSENT_PREFIX}/${binding.lineageHash}/short`;
    const foreignBinding = { lineageHash: "ff".repeat(32), repositoryIdentityHash: "ee".repeat(32) };
    const foreignPayload = baseAbsentPayload(foreignBinding, "refs/heads/foreign", commit);
    const foreignTarget = await writeBlob(canonicalize(foreignPayload));
    const foreign = `${BASE_ABSENT_PREFIX}/${foreignBinding.lineageHash}/${branchRefHash(foreignPayload.ref)}`;
    const invalidForeign = `${BASE_ABSENT_PREFIX}/${"dd".repeat(32)}/${branchRefHash("refs/heads/invalid-foreign")}`;
    const foreignPBinding = { lineageHash: "cc".repeat(32), repositoryIdentityHash: "bb".repeat(32) };
    const foreignPPayload = basePresentPayload(foreignPBinding, "refs/heads/foreign-p", "34".repeat(16), null, commit);
    const foreignPTarget = await writeBlob(canonicalize(foreignPPayload));
    const foreignP = basePresentArtifactRef(foreignPBinding, foreignPPayload.ref);
    const foreignK = basePresentKeepRef(foreignPBinding, foreignPPayload.ref, foreignPPayload.episode, "next");
    await commitProtocolRefTransaction(repo, [
      `create ${orphan} ${commit}`, `create ${malformed} ${commit}`, `create ${foreign} ${foreignTarget}`,
      `create ${invalidForeign} ${commit}`, `create ${foreignP} ${foreignPTarget}`, `create ${foreignK} ${commit}`,
    ]);
    const scan = await scanBaseArtifacts(repo, binding);
    expect(scan.absent.map((entry) => entry.status)).toEqual(["valid"]);
    expect(scan.present.map((entry) => entry.status)).toEqual(["valid"]);
    expect(scan.orphanKeep).toEqual([orphan]);
    expect(scan.invalidNamespace).toEqual([malformed]);
    expect(scan.foreign).toHaveLength(4);
    expect(scan.foreign).toContainEqual({ refname: invalidForeign, lineageHash: "dd".repeat(32), kind: "absent", status: "invalid", detail: "protocol artifact must target a blob" });
    expect(scan.foreign).toContainEqual({ refname: foreign, lineageHash: foreignBinding.lineageHash, kind: "absent", branchRef: foreignPayload.ref, status: "valid" });
    expect(scan.foreign).toContainEqual({ refname: foreignP, lineageHash: foreignPBinding.lineageHash, kind: "present", branchRef: foreignPPayload.ref, status: "valid" });
    expect(scan.foreign).toContainEqual({ refname: foreignK, lineageHash: foreignPBinding.lineageHash, kind: "keep", branchRef: foreignPPayload.ref, status: "valid" });
  });

  test("caps refuse before another proof ref is created", async () => {
    expect([MAX_UNSETTLED_BASE_ABSENT, MAX_BASE_PRESENT, MAX_BASE_PRESENT_KEEP]).toEqual([4096, 2048, 4096]);
    const settleable = await prepareBaseAbsentArtifact(repo, binding, "refs/heads/settleable", commit);
    const lines = Array.from({ length: MAX_UNSETTLED_BASE_ABSENT - 1 }, (_, index) =>
      `create ${BASE_ABSENT_PREFIX}/${binding.lineageHash}/${index.toString(16).padStart(64, "0")} ${commit}`);
    await commitProtocolRefTransaction(repo, [...lines, ...settleable.transactionLines]);
    await expect(prepareBaseAbsentArtifact(repo, binding, "refs/heads/overflow", commit)).rejects.toThrow("capacity");
    expect(await runGit("show-ref", "--verify", "--quiet", baseAbsentArtifactRef(binding, "refs/heads/overflow")).then(() => true, () => false)).toBe(false);
    await settleBaseAbsentArtifact(repo, binding, "refs/heads/settleable");
    await expect(prepareBaseAbsentArtifact(repo, binding, "refs/heads/after-settlement", commit)).resolves.toBeDefined();
  });

  test("P and K caps independently refuse without eviction", async () => {
    const pRefs = Array.from({ length: MAX_BASE_PRESENT }, (_, index) =>
      `${BASE_PRESENT_PREFIX}/${binding.lineageHash}/${index.toString(16).padStart(64, "0")}`);
    await commitProtocolRefTransaction(repo, pRefs.map((ref) => `create ${ref} ${commit}`));
    await expect(prepareBasePresentArtifact(repo, binding, "refs/heads/p-overflow", "34".repeat(16), null, commit)).rejects.toThrow("capacity");
    await commitProtocolRefTransaction(repo, pRefs.map((ref) => `delete ${ref} ${commit}`));

    const kRefs = Array.from({ length: MAX_BASE_PRESENT_KEEP }, (_, index) =>
      `${BASE_PRESENT_KEEP_PREFIX}/${binding.lineageHash}/${index.toString(16).padStart(64, "0")}/${"56".repeat(16)}/next`);
    await commitProtocolRefTransaction(repo, kRefs.map((ref) => `create ${ref} ${commit}`));
    await expect(prepareBasePresentArtifact(repo, binding, "refs/heads/k-overflow", "78".repeat(16), null, commit)).rejects.toThrow("capacity");
  // 6,144 native ref transactions take ~15s on the CI runners (0.7s locally): this is a
  // capacity test, not a latency one. Explicit budget; assertions unchanged (docs/flaky-tests.md,
  // #882 CI-validation, #900 same-SHA reruns at 15,250ms and 15,348ms).
  }, 60_000);
});

describe("settled absence Z", () => {
  test("settles sequential A artifacts atomically into one validated immutable ledger", async () => {
    const a = await prepareBaseAbsentArtifact(repo, binding, "refs/heads/a", commit);
    await commitProtocolRefTransaction(repo, a.transactionLines);
    await settleBaseAbsentArtifact(repo, binding, "refs/heads/a");
    expect((await readBaseAbsentArtifact(repo, binding, "refs/heads/a")).status).toBe("absent");
    expect(await lookupSettledAbsence(repo, binding, "refs/heads/a")).toEqual(a.payload);

    const b = await prepareBaseAbsentArtifact(repo, binding, "refs/heads/b", commit);
    await commitProtocolRefTransaction(repo, b.transactionLines);
    const next = await settleBaseAbsentArtifact(repo, binding, "refs/heads/b");
    const ledger = await readSettledAbsence(repo, binding);
    expect(ledger).toMatchObject({ status: "valid", ledger: { targetOid: next.targetOid, meta: { count: 2 } } });
    expect(await lookupSettledAbsence(repo, binding, "refs/heads/b")).toEqual(b.payload);
    expect(isSyncableRef(settledAbsenceRef(binding))).toBe(false);

    const retireA = await prepareRetireSettledAbsence(repo, binding, "refs/heads/a");
    expect(retireA.priorTargetOid).toBe(next.targetOid);
    expect(retireA.nextTargetOid).toMatch(/^[0-9a-f]{40}$/);
    expect(retireA.transactionLines).toEqual([`update ${settledAbsenceRef(binding)} ${retireA.nextTargetOid} ${retireA.priorTargetOid}`]);
    await commitProtocolRefTransaction(repo, retireA.transactionLines);
    expect(await lookupSettledAbsence(repo, binding, "refs/heads/a")).toBeUndefined();
    expect(await lookupSettledAbsence(repo, binding, "refs/heads/b")).toEqual(b.payload);

    const retireLast = await prepareRetireSettledAbsence(repo, binding, "refs/heads/b");
    expect(retireLast.nextTargetOid).toBeNull();
    expect(retireLast.transactionLines).toEqual([`delete ${settledAbsenceRef(binding)} ${retireLast.priorTargetOid}`]);
    await commitProtocolRefTransaction(repo, retireLast.transactionLines);
    expect((await readSettledAbsence(repo, binding)).status).toBe("absent");
  });

  test("rejects duplicate leaves and strict tree count/hash/binding corruption", async () => {
    const payload = baseAbsentPayload(binding, "refs/heads/a", commit);
    await expect(buildSettledAbsenceTree(repo, binding, [payload, payload])).rejects.toThrow("duplicate");

    const valid = await buildSettledAbsenceTree(repo, binding, [payload]);
    const root = await gitRaw(repo, ["ls-tree", valid.targetOid]);
    const entriesOid = /040000 tree ([0-9a-f]{40})\tentries/.exec(root)?.[1];
    if (!entriesOid) throw new Error("missing entries tree");
    const badMeta = await writeBlob(canonicalize({ count: 2, lineageHash: binding.lineageHash, repositoryIdentityHash: binding.repositoryIdentityHash, v: 1 }));
    const badRoot = await writeTree([`040000 tree ${entriesOid}\tentries`, `100644 blob ${badMeta}\tmeta`]);
    await runGit("update-ref", settledAbsenceRef(binding), badRoot);
    expect(await readSettledAbsence(repo, binding)).toMatchObject({ status: "invalid", reason: "bad-tree" });

    const other = { ...binding, repositoryIdentityHash: "ee".repeat(32) };
    const otherTree = await buildSettledAbsenceTree(repo, other, [baseAbsentPayload(other, "refs/heads/a", commit)]);
    await runGit("update-ref", settledAbsenceRef(binding), otherTree.targetOid);
    expect(await readSettledAbsence(repo, binding)).toMatchObject({ status: "invalid", reason: "bad-tree" });

    const payloadOid = await writeBlob(canonicalize(payload));
    const leafTree = await writeTree([`100644 blob ${payloadOid}\t${"0".repeat(62)}`]);
    const bucketTree = await writeTree([`040000 tree ${leafTree}\t00`]);
    const meta = await writeBlob(canonicalize({ count: 1, lineageHash: binding.lineageHash, repositoryIdentityHash: binding.repositoryIdentityHash, v: 1 }));
    const collisionRoot = await writeTree([`040000 tree ${bucketTree}\tentries`, `100644 blob ${meta}\tmeta`]);
    await runGit("update-ref", settledAbsenceRef(binding), collisionRoot);
    expect(await readSettledAbsence(repo, binding)).toMatchObject({ status: "invalid", reason: "bad-tree" });
  });

  test("A and an existing matching Z leaf are a contradiction, never silently folded", async () => {
    const payload = baseAbsentPayload(binding, "refs/heads/a", commit);
    const z = await buildSettledAbsenceTree(repo, binding, [payload]);
    const aTarget = await writeBlob(canonicalize(payload));
    await commitProtocolRefTransaction(repo, [
      `create ${settledAbsenceRef(binding)} ${z.targetOid}`,
      `create ${baseAbsentArtifactRef(binding, payload.ref)} ${aTarget}`,
    ]);
    await expect(settleBaseAbsentArtifact(repo, binding, payload.ref)).rejects.toThrow("coexist");
    expect(await runGit("rev-parse", baseAbsentArtifactRef(binding, payload.ref))).toBe(aTarget);
    expect(await runGit("rev-parse", settledAbsenceRef(binding))).toBe(z.targetOid);
  });
});
