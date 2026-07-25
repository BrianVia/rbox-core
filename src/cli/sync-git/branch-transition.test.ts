import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { baseAbsentArtifactRef, basePresentArtifactRef, readBasePresentArtifact, type ArtifactBinding } from "../../engine/index.js";
import {
  commitAbsentBranchVerification,
  commitPlannedBranchTransition,
  planAbsentBranchVerification,
  planBranchTransition,
} from "./branch-transition.js";
import { buildTombstoneAttestations, checkTombstoneAttestation } from "./tombstone-attestation.js";

const exec = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "rbox", GIT_AUTHOR_EMAIL: "r@b", GIT_COMMITTER_NAME: "rbox", GIT_COMMITTER_EMAIL: "r@b" };
let root: string;
const binding: ArtifactBinding = { lineageHash: "1".repeat(64), repositoryIdentityHash: "2".repeat(64) };
const git = (...args: string[]) => exec("git", ["-C", root, ...args], { env }).then(({ stdout }) => stdout.toString().trim());

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-branch-transition-"));
  await git("init", "-qb", "main");
  await fs.writeFile(path.join(root, "f"), "one");
  await git("add", "f"); await git("commit", "-qm", "one");
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

test("design 200 absence proof is verify-only and races fail closed", async () => {
  const ref = "refs/heads/deleted";
  const beforeRefs = await git("for-each-ref", "--format=%(refname)%00%(objectname)");
  const plan = await planAbsentBranchVerification(root, ref);
  expect(plan.lines).toContain(`verify ${ref} ${"0".repeat(40)}`);
  expect(plan.lines.every((line) => /^(?:verify|symref-verify) /.test(line))).toBe(true);
  await commitAbsentBranchVerification(plan);
  expect(await git("for-each-ref", "--format=%(refname)%00%(objectname)")).toBe(beforeRefs);

  const raced = await planAbsentBranchVerification(root, ref);
  await git("update-ref", ref, await git("rev-parse", "HEAD"));
  await expect(commitAbsentBranchVerification(raced)).rejects.toThrow();
  expect(await git("rev-parse", ref)).toMatch(/^[0-9a-f]{40}$/);
});

test("design 200 refuses an unborn current branch in both planner and commit defense", async () => {
  const unborn = "refs/heads/unborn";
  await git("symbolic-ref", "HEAD", unborn);
  await expect(planAbsentBranchVerification(root, unborn)).rejects.toThrow("current branch");

  const forged = await planAbsentBranchVerification(root, "refs/heads/other");
  forged.headReservation.currentRef = true;
  await expect(commitAbsentBranchVerification(forged)).rejects.toThrow("current branch");
});

test("design 200 locked absence proof refuses an unreadable unrelated ref", async () => {
  const ref = "refs/heads/deleted";
  const plan = await planAbsentBranchVerification(root, ref);
  await fs.writeFile(path.join(root, ".git", "refs", "heads", "broken"), "not-an-oid\n");
  await expect(commitAbsentBranchVerification(plan)).rejects.toThrow("ref-read-unreadable");
  expect(await git("rev-parse", "--verify", "--quiet", ref).catch(() => "")).toBe("");
});

test("§130 delete creates A and removes R in one expected-old transaction", async () => {
  const old = await git("rev-parse", "refs/heads/main");
  const plan = await planBranchTransition({ repoDir: root, binding, ref: "refs/heads/topic", beforeOid: old, afterOid: null, logicalBaseOid: old });
  await git("update-ref", "refs/heads/topic", old);
  // Planning before the live ref exists is allowed; expected-old commit is the authority.
  await commitPlannedBranchTransition(plan);
  expect(await git("rev-parse", "--verify", "--quiet", "refs/heads/topic").catch(() => "")).toBe("");
  expect(await git("rev-parse", baseAbsentArtifactRef(binding, "refs/heads/topic"))).toMatch(/^[0-9a-f]{40}$/);
  expect(plan.witness.kind).toBe("absent");
});

test("§130 update creates exact P/K and forced episode reflog", async () => {
  const old = await git("rev-parse", "HEAD");
  await git("branch", "topic", old);
  await fs.writeFile(path.join(root, "f"), "two"); await git("commit", "-qam", "two");
  const next = await git("rev-parse", "HEAD");
  const plan = await planBranchTransition({ repoDir: root, binding, ref: "refs/heads/topic", beforeOid: old, afterOid: next, logicalBaseOid: old, episode: "a".repeat(32) });
  await commitPlannedBranchTransition(plan);
  expect(await git("rev-parse", "refs/heads/topic")).toBe(next);
  expect(await git("rev-parse", basePresentArtifactRef(binding, "refs/heads/topic"))).toBe((plan.witness as { artifactOid: string }).artifactOid);
  expect((await readBasePresentArtifact(root, binding, "refs/heads/topic")).status).toBe("valid");
  expect(await git("reflog", "-1", "--format=%gs", "refs/heads/topic")).toBe("a".repeat(32));
});

test("§130 expected-old failure creates neither branch effect nor A", async () => {
  const old = await git("rev-parse", "HEAD");
  await git("branch", "topic", old);
  const plan = await planBranchTransition({ repoDir: root, binding, ref: "refs/heads/topic", beforeOid: old, afterOid: null, logicalBaseOid: old });
  await fs.writeFile(path.join(root, "f"), "third"); await git("commit", "-qam", "third");
  const third = await git("rev-parse", "HEAD");
  await git("update-ref", "refs/heads/topic", third, old);
  await expect(commitPlannedBranchTransition(plan)).rejects.toThrow();
  expect(await git("rev-parse", "refs/heads/topic")).toBe(third);
  expect(await git("rev-parse", "--verify", "--quiet", baseAbsentArtifactRef(binding, "refs/heads/topic")).catch(() => "")).toBe("");
});

test("§130 g1/g2/g3 laundering walk cannot turn recreation equality into deletion authority", async () => {
  const ref = "refs/heads/topic";
  const tip = await git("rev-parse", "HEAD");
  await git("branch", "topic", tip);

  // g1: the capable deletion publishes A and removes R in one CAS.
  const g1 = await planBranchTransition({
    repoDir: root, binding, ref, beforeOid: tip, afterOid: null, logicalBaseOid: tip,
  });
  await commitPlannedBranchTransition(g1);
  const aRef = baseAbsentArtifactRef(binding, ref);
  const aTarget = await git("rev-parse", aRef);
  expect(await git("rev-parse", "--verify", "--quiet", ref).catch(() => "")).toBe("");

  // g2: an old writer/user recreates the same value. A capable expected-absent
  // re-advertisement cannot consume A because create R must fail atomically.
  await git("update-ref", ref, tip);
  for (let generation = 2; generation <= 6; generation++) {
    const replay = await planBranchTransition({
      repoDir: root,
      binding,
      ref,
      beforeOid: null,
      afterOid: tip,
      logicalBaseOid: null,
      episode: generation.toString(16).padStart(32, "0"),
    });
    await expect(commitPlannedBranchTransition(replay)).rejects.toThrow();
    expect(await git("rev-parse", ref)).toBe(tip);
    expect(await git("rev-parse", aRef)).toBe(aTarget);
    expect(await git("rev-parse", "--verify", "--quiet", basePresentArtifactRef(binding, ref)).catch(() => "")).toBe("");
  }

  // g3..gN: even a fresh tombstone for T sees live equality but logical BASE
  // remains absent through A, so the prevalidated map hard-vetoes deletion.
  const section = {
    bundleSha: "a".repeat(64), bundleEncSha: "b".repeat(64), bundleCipherSize: 1,
    head: tip, refs: {}, refScope: "all" as const,
    generatedAt: "2026-07-16T12:00:00.000Z",
    refTombstones: { [ref]: [{ oid: tip, ts: "2026-07-16T12:00:00.000Z", generation: 3 }] },
    refTombstoneGeneration: 3,
  };
  const attestations = buildTombstoneAttestations({
    section, incomingKey: "g3", lineageHash: binding.lineageHash,
    liveRefs: { [ref]: tip }, logicalBaseRefs: {},
    origins: { [ref]: { v: 1, oid: tip, lineageHash: binding.lineageHash, kind: "publisher-ack", sourceSeq: 2, incomingKey: "g2" } },
    artifacts: { [ref]: { absence: "valid-owning", present: "absent", keeps: "clear", settledAbsence: "absent" } },
    pendingEvidence: { [ref]: { incomingKey: "g3", d2Revalidated: true } },
  });
  expect(checkTombstoneAttestation(attestations, {
    incomingKey: "g3", ref, oid: tip, liveOid: tip, logicalBaseOid: null,
  })).toEqual({ status: "hard-veto", reason: "live and positive BASE equality required" });
});
