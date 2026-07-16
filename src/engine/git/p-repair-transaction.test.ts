import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { prepareBasePresentArtifact, readBasePresentArtifact } from "./base-artifacts.js";
import { parseKeepPinOrigins, runUpdateRefTransaction } from "./keep-pins.js";
import { inspectLockedPRepairReceipt, reflogObservation, resumeLockedAcceptedPRepair, runLockedPRepairAttempt } from "./p-repair-transaction.js";
import { setProtocolLockTraceForTests, type ProtocolLockTraceEvent } from "./protocol-locks.js";

const Z = "0".repeat(40);
const L = "1".repeat(40);
const N = "2".repeat(40);
const U = "3".repeat(40);

const line = (oldOid: string, newOid: string, message: Buffer): Buffer => Buffer.concat([
  Buffer.from(`${oldOid} ${newOid} rbox <rbox@local> 0 +0000\t`), message, Buffer.from("\n"),
]);

test("§130 complete reflog Sobs includes both sides of N→U→N and ignores zero", () => {
  const bytes = Buffer.concat([
    line(Z, L, Buffer.from("create")),
    line(L, N, Buffer.from("p episode")),
    line(N, U, Buffer.from("human move")),
    line(U, N, Buffer.from("human return")),
  ]);
  const observed = reflogObservation(bytes);
  expect(observed.entries).toBe(4);
  expect(observed.oids).toEqual([L, N, U]);
  expect(observed.top?.toString()).toContain(`${U} ${N}`);
});

test("§130 reflog projection parser preserves arbitrary message bytes", () => {
  const message = Buffer.from([0, 34, 92, 128, 255]);
  const bytes = line(L, N, message);
  const observed = reflogObservation(bytes);
  expect(observed.top).toEqual(bytes.subarray(0, bytes.length - 1));
  expect(observed.oids).toEqual([L, N]);
});

test("§130 malformed complete reflog hard-fails instead of dropping evidence", () => {
  expect(() => reflogObservation(Buffer.from("not-a-reflog\n"))).toThrow("malformed complete branch reflog");
});

test("§130 moved-P walk pins cumulative evidence, CASes BASE, creates Q, and retires P/K", async () => {
  const exec = promisify(execFile);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-p-repair-walk-"));
  const repo = path.join(tmp, "repo");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "rbox", GIT_AUTHOR_EMAIL: "rbox@local", GIT_COMMITTER_NAME: "rbox", GIT_COMMITTER_EMAIL: "rbox@local" };
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args], { env }).then(({ stdout }) => stdout.toString().trim());
  const commit = async (value: string) => {
    await fs.writeFile(path.join(repo, "file"), value);
    await git("add", "file"); await git("commit", "-qm", value);
    return git("rev-parse", "HEAD");
  };
  try {
    await fs.mkdir(repo); await git("init", "-qb", "main");
    const prior = await commit("prior");
    const next = await commit("next");
    const binding = { lineageHash: "7".repeat(64), repositoryIdentityHash: "8".repeat(64) };
    const episode = "9".repeat(32);
    const prepared = await prepareBasePresentArtifact(repo, binding, "refs/heads/main", episode, prior, next);
    await runUpdateRefTransaction(repo, prepared.transactionLines);
    const moved = await commit("moved");
    const read = await readBasePresentArtifact(repo, binding, "refs/heads/main");
    if (read.status !== "valid") throw new Error("fixture P invalid");
    let baseOid: string | null = prior;
    let acceptedReceipt: unknown;
    let extended: string | undefined;
    const trace: ProtocolLockTraceEvent[] = [];
    setProtocolLockTraceForTests((event) => trace.push(event));
    const attempt = await runLockedPRepairAttempt({
      repoDir: repo,
      p: read.artifact,
      repairAt: "2026-07-16T12:00:00.000Z",
      mismatches: { live: true, reflog: false, baseShape: false },
      crashAt: async (point) => {
        if (point === "after-origin-fsync" && !extended) extended = await commit("post-origin extension");
        if (point === "after-state-cas") throw new Error("injected crash after state CAS");
      },
      validateArtifacts: async () => (await readBasePresentArtifact(repo, binding, "refs/heads/main")).status === "valid",
      state: {
        stateLockIdentity: path.join(tmp, "state.lock"),
        read: async () => ({ repoGen: 0, stateRevision: 0, incomingKey: "incoming", baseOid }),
        cas: async ({ nextBaseOid, receipt }) => { baseOid = nextBaseOid; acceptedReceipt = receipt; return "accepted"; },
      },
    });
    expect(attempt.status).toBe("hold");
    expect(baseOid).toBe(next);
    expect(await git("rev-parse", "--verify", prepared.ref)).toBe(prepared.targetOid);
    const durable = acceptedReceipt as Extract<typeof attempt, { status: "restart" }>["receipt"];
    await expect(git("rev-parse", "--verify", durable.q.ref)).rejects.toThrow();
    const result = await resumeLockedAcceptedPRepair({
      repoDir: repo,
      receipt: durable,
      validateArtifacts: async () => (await readBasePresentArtifact(repo, binding, "refs/heads/main")).status === "valid",
    });
    if (result.status !== "restart") throw new Error(result.status === "hold" ? result.reason : result.status);
    expect(result.status).toBe("restart");
    expect(baseOid).toBe(next);
    expect(acceptedReceipt).toEqual(result.receipt);
    expect(await git("rev-parse", "--verify", result.receipt.q.ref)).toBe(result.receipt.q.targetOid);
    await expect(git("rev-parse", "--verify", prepared.ref)).rejects.toThrow();
    for (const keep of prepared.keepRefs) await expect(git("rev-parse", "--verify", keep.ref)).rejects.toThrow();
    if (!extended) throw new Error("stabilization extension was not injected");
    for (const oid of [prior, next, moved, extended]) expect(await git("rev-parse", "--verify", `refs/rbox-local/keep/${oid}`)).toBe(oid);
    const origins = parseKeepPinOrigins(await fs.readFile(path.join(repo, ".git", "rbox-keep-origins.json"), "utf8"));
    for (const oid of [prior, next, moved, extended]) expect(origins[oid]?.some((origin) => origin.ref === result.receipt.q.ref
      && origin.episode === episode && origin.class === "human")).toBe(true);
    expect((await inspectLockedPRepairReceipt(repo, result.receipt)).action).toBe("compact-and-restart");
    expect(trace.map((event) => `${event.action}:${event.class}`)).toEqual([
      "acquire:operation", "acquire:reflog", "acquire:origin",
      "acquire:git", "release:git",
      "acquire:git", "release:git",
      "acquire:git", "acquire:state", "release:state", "release:git",
      "release:origin", "release:reflog", "release:operation",
      "acquire:operation", "acquire:reflog", "acquire:origin",
      "acquire:git", "release:git",
      "release:origin", "release:reflog", "release:operation",
      "acquire:operation", "acquire:reflog", "acquire:origin",
      "release:origin", "release:reflog", "release:operation",
    ]);
  } finally {
    setProtocolLockTraceForTests(undefined);
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test.each([
  "after-pin-only",
  "after-origin-fsync",
  "after-q-write",
  "after-ref-prepare",
  "after-state-cas",
  "after-ref-commit",
  "before-restart",
] as const)("§130 P-repair crash matrix: %s has only the reviewed durable shape", async (crashPoint) => {
  const exec = promisify(execFile);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `rbox-p-repair-${crashPoint}-`));
  const repo = path.join(tmp, "repo");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "rbox", GIT_AUTHOR_EMAIL: "rbox@local", GIT_COMMITTER_NAME: "rbox", GIT_COMMITTER_EMAIL: "rbox@local" };
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args], { env }).then(({ stdout }) => stdout.toString().trim());
  const exists = (ref: string) => git("rev-parse", "--verify", "--quiet", ref).then((oid) => oid, () => "");
  const commit = async (value: string) => {
    await fs.writeFile(path.join(repo, "file"), value);
    await git("add", "file"); await git("commit", "-qm", value);
    return git("rev-parse", "HEAD");
  };
  try {
    await fs.mkdir(repo); await git("init", "-qb", "main");
    const prior = await commit("prior");
    const next = await commit("next");
    const binding = { lineageHash: "4".repeat(64), repositoryIdentityHash: "5".repeat(64) };
    const episode = "6".repeat(32);
    const prepared = await prepareBasePresentArtifact(repo, binding, "refs/heads/main", episode, prior, next);
    await runUpdateRefTransaction(repo, prepared.transactionLines);
    await commit("moved");
    const read = await readBasePresentArtifact(repo, binding, "refs/heads/main");
    if (read.status !== "valid") throw new Error("fixture P invalid");
    let baseOid: string | null = prior;
    let acceptedReceipt: Parameters<typeof resumeLockedAcceptedPRepair>[0]["receipt"] | undefined;
    const result = await runLockedPRepairAttempt({
      repoDir: repo,
      p: read.artifact,
      repairAt: "2026-07-16T12:00:00.000Z",
      mismatches: { live: true, reflog: false, baseShape: false },
      crashAt: (point) => { if (point === crashPoint) throw new Error(`crash:${point}`); },
      validateArtifacts: async () => (await readBasePresentArtifact(repo, binding, "refs/heads/main")).status === "valid",
      state: {
        stateLockIdentity: path.join(tmp, "state.lock"),
        read: async () => ({ repoGen: 0, stateRevision: 0, incomingKey: "incoming", baseOid }),
        cas: async ({ nextBaseOid, receipt }) => { baseOid = nextBaseOid; acceptedReceipt = receipt; return "accepted"; },
      },
    });
    expect(result.status).toBe("hold");

    const stateCommitted = ["after-state-cas", "after-ref-commit", "before-restart"].includes(crashPoint);
    const refsCommitted = ["after-ref-commit", "before-restart"].includes(crashPoint);
    expect(baseOid).toBe(stateCommitted ? next : prior);
    expect(await exists(prepared.ref)).toBe(refsCommitted ? "" : prepared.targetOid);
    for (const keep of prepared.keepRefs) expect(await exists(keep.ref)).toBe(refsCommitted ? "" : keep.targetOid);

    if (refsCommitted) {
      expect(acceptedReceipt).toBeDefined();
      expect(await exists(acceptedReceipt!.q.ref)).toBe(acceptedReceipt!.q.targetOid);
      expect((await inspectLockedPRepairReceipt(repo, acceptedReceipt!)).action).toBe("compact-and-restart");
    } else if (stateCommitted) {
      expect(acceptedReceipt).toBeDefined();
      expect(await exists(acceptedReceipt!.q.ref)).toBe("");
      expect((await inspectLockedPRepairReceipt(repo, acceptedReceipt!)).action).toBe("resume-ref-commit");
    }

    // Pin preparation is intentionally monotone: every crash after it leaves
    // reachable protection; before origin fsync it is diagnosed over-protection.
    for (const oid of [prior, next]) expect(await exists(`refs/rbox-local/keep/${oid}`)).toBe(oid);
    const origins = parseKeepPinOrigins(await fs.readFile(path.join(repo, ".git", "rbox-keep-origins.json"), "utf8").catch(() => "{}"));
    if (crashPoint === "after-pin-only") expect(Object.keys(origins)).toHaveLength(0);
    else for (const oid of [prior, next]) expect(origins[oid]?.some((origin) => origin.episode === episode && origin.class === "human")).toBe(true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}, 20_000);
