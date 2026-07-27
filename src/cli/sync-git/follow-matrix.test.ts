import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  LocalBlobStore,
  buildIgnoreMatcher,
  captureGitState,
  hashBytes,
  indexIdentityV2,
  oracleFromState,
  type AppliedManifestOracle,
  type FileEntry,
  type GitSection,
  type Manifest,
} from "../../engine/index.js";
import { readOpState } from "../../engine/git/refs.js";
import { hashFile } from "../../engine/hash.js";
import { loadState, repoRecordsForState, saveStateUnsafeLegacyOrTest, syncStreamId, type SyncState, type WorkspaceConfig } from "../config.js";
import { collectRepoResidue, renderDoctor, type DoctorChecks } from "../doctor-cmd.js";
import type { SyncRemote } from "../remote.js";
import { pull } from "../sync.js";
import { orderedRepoDeferralUpdates, saveStateSource } from "../sync-state.js";
import { applyGitSections } from "./apply.js";
import { withRevalidatedGitPartialApplies } from "./received-git-transition-commit.js";
import { gitIncomingKey } from "./shared.js";

const exec = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox-test@local",
};
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args], { env: TEST_GIT_ENV }).then(({ stdout }) => stdout.toString().trim());
const KEK = Buffer.alloc(32, 116);
const STREAM = "follow-matrix";
const REL = "repo";

type Topology = "ff" | "branch-switch" | "detached";
interface Template {
  topology: Topology;
  root: string;
  c1: string;
  base: GitSection;
  incoming: Record<0 | 1, GitSection>;
  expectedBytes: Record<0 | 1, string>;
}

interface PrincipalCase {
  topology: Topology;
  syncDirt: 0 | 1;
  humanDirt: 0 | 1;
  localCommits: 0 | 1;
  localStash: 0 | 1;
}

let suiteTmp = "";
let store: LocalBlobStore;
const templates = new Map<Topology, Template>();

async function probeFsAliases(): Promise<{ caseAliases: boolean; unicodeAliases: boolean }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-follow-alias-probe-"));
  const aliases = async (a: string, b: string): Promise<boolean> => {
    const first = path.join(root, a);
    const second = path.join(root, b);
    await fs.writeFile(first, "probe", { flag: "wx" });
    try {
      const [left, right] = await Promise.all([fs.lstat(first), fs.lstat(second)]);
      return left.dev === right.dev && left.ino === right.ino;
    } catch {
      return false;
    } finally {
      await fs.rm(first, { force: true });
    }
  };
  try {
    return {
      caseAliases: await aliases("CaseProbe", "caseprobe"),
      unicodeAliases: await aliases("é-probe", "e\u0301-probe"),
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const fsAliases = await probeFsAliases();

function manifest(section: GitSection): Manifest {
  return { generatedAt: "", files: [], manifestSchema: 2, gitRepos: { [REL]: section } };
}

function stateWith(section: GitSection): SyncState {
  return {
    stream: STREAM,
    stateNonce: "b".repeat(32),
    lastSyncedSequence: 1,
    lastSyncedManifest: manifest(section),
    repoRecords: { [REL]: { repoGen: 1, sourceSeq: 1, base: section } },
  };
}

function cfgFor(root: string): WorkspaceConfig {
  return {
    remoteWorkspaceId: "ws-follow-matrix",
    projectId: "root",
    deviceId: "receiver",
    rootPath: root,
    remoteUrl: "https://example.invalid",
    token: "",
    syncGit: true,
    encrypted: true,
    kek: KEK,
    accountId: "acct",
    accountEpoch: 0,
    keyEpoch: 0,
  };
}

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "-qb", "main");
  await git(dir, "config", "user.email", "matrix@example.invalid");
  await git(dir, "config", "user.name", "matrix");
}

async function commitTracked(dir: string, bytes: string, message: string): Promise<string> {
  await fs.writeFile(path.join(dir, "tracked.txt"), bytes);
  await git(dir, "add", "tracked.txt");
  await git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD");
}

async function capture(dir: string): Promise<GitSection> {
  const section = await captureGitState(dir, store, KEK);
  if (!section) throw new Error(`capture returned no section for ${dir}`);
  return section;
}

async function buildTemplate(topology: Topology): Promise<Template> {
  const root = path.join(suiteTmp, `template-${topology}`);
  const senderBase = path.join(suiteTmp, `sender-base-${topology}`);
  await initRepo(senderBase);
  const c1 = await commitTracked(senderBase, "one\n", "c1");
  const c2 = await commitTracked(senderBase, "two\n", "c2");
  await git(senderBase, "branch", "safe", c2);
  await git(senderBase, "tag", "matrix-safe", c2);
  const base = await capture(senderBase);

  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  const receiver = path.join(root, REL);
  const materialized = await applyGitSections(
    root,
    cfgFor(root),
    { stream: STREAM, stateNonce: "b".repeat(32), lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] } },
    manifest(base),
    store,
    buildIgnoreMatcher(root),
    () => {},
  );
  expect(materialized.gitRepos?.[REL]).toEqual(base);
  await saveStateUnsafeLegacyOrTest(root, stateWith(base));

  const incoming = {} as Record<0 | 1, GitSection>;
  const expectedBytes = { 0: "two\n", 1: `incoming-${topology}\n` } as Record<0 | 1, string>;
  for (const syncDirt of [0, 1] as const) {
    const sender = path.join(suiteTmp, `sender-${topology}-${syncDirt}`);
    await fs.cp(senderBase, sender, { recursive: true });
    if (topology === "branch-switch") await git(sender, "checkout", "-qb", "next");
    else if (topology === "detached") await git(sender, "checkout", "-q", "--detach");
    if (syncDirt) await commitTracked(sender, expectedBytes[syncDirt], `incoming ${topology} dirty`);
    else await git(sender, "commit", "--allow-empty", "-qm", `incoming ${topology} clean`);
    const tip = await git(sender, "rev-parse", "HEAD");
    await git(sender, "update-ref", "refs/heads/safe", tip);
    await git(sender, "update-ref", "refs/tags/matrix-safe", tip);
    incoming[syncDirt] = await capture(sender);
  }
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(c2);
  return { topology, root, c1, base, incoming, expectedBytes };
}

beforeAll(async () => {
  suiteTmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-follow-matrix-"));
  store = new LocalBlobStore(path.join(suiteTmp, "blobs"));
  for (const topology of ["ff", "branch-switch", "detached"] as const) {
    templates.set(topology, await buildTemplate(topology));
  }
}, 30_000);

afterAll(async () => {
  await fs.rm(suiteTmp, { recursive: true, force: true });
}, 20_000);

function oracleEntry(bytes: string): FileEntry {
  return {
    path: `${REL}/tracked.txt`,
    type: "file",
    sha256: hashBytes(Buffer.from(bytes)),
    size: Buffer.byteLength(bytes),
    mode: 0o644,
    mtimeMs: 0,
  };
}

function realOracle(root: string, bytes: string): AppliedManifestOracle {
  return oracleFromState({
    base: { generatedAt: "", files: [oracleEntry(bytes)] },
    matcher: buildIgnoreMatcher(root),
    root,
  });
}

async function applyIncoming(root: string, state: SyncState, incoming: GitSection, oracle: AppliedManifestOracle) {
  const logs: string[] = [];
  const outcome = await applyGitSections(root, cfgFor(root), state, manifest(incoming), store, buildIgnoreMatcher(root), (line) => logs.push(line), {
    oracle,
    sourceGlobalSeq: 2,
    capabilityProbe: async () => true,
  });
  return { outcome, logs };
}

async function persist(root: string, state: SyncState, outcome: Awaited<ReturnType<typeof applyGitSections>>): Promise<SyncState> {
  return withRevalidatedGitPartialApplies(root, state, outcome, async () => saveStateSource(root, state, {
    expectedStream: STREAM,
    sourceGlobalSeq: 2,
    observedRepos: [REL],
    values: {
      bases: outcome.gitRepos,
      pending: outcome.gitPendingRemote,
      removals: outcome.gitReposRemoved,
      resolutions: outcome.gitNeedsResolution,
      configLane: outcome.configLane,
      deferrals: orderedRepoDeferralUpdates(repoRecordsForState(state), outcome.deferrals),
      partial: outcome.partial,
      idxProj: outcome.idxProj,
    },
  }));
}

async function cloneCase(c: PrincipalCase | { topology: Topology; syncDirt: 0 | 1; label: string }): Promise<{ root: string; repo: string; template: Template; incoming: GitSection }> {
  const template = templates.get(c.topology)!;
  const suffix = "label" in c ? c.label : `${c.syncDirt}${c.humanDirt}${c.localCommits}${c.localStash}`;
  const root = path.join(suiteTmp, `case-${c.topology}-${suffix}-${Math.random().toString(16).slice(2)}`);
  await fs.cp(template.root, root, { recursive: true });
  return { root, repo: path.join(root, REL), template, incoming: template.incoming[c.syncDirt] };
}

async function receiverOnlyCommit(repo: string): Promise<string> {
  await git(repo, "commit", "--allow-empty", "-qm", "receiver-only current commit");
  return git(repo, "rev-parse", "HEAD");
}

async function receiverOnlyStash(repo: string): Promise<string> {
  await fs.writeFile(path.join(repo, "stash-only.txt"), "receiver stash\n");
  await git(repo, "stash", "push", "-uqm", "receiver-only matrix stash");
  await fs.rm(path.join(repo, ".git", "ORIG_HEAD"), { force: true });
  return git(repo, "rev-parse", "refs/stash");
}

async function clearReceiverStash(repo: string): Promise<void> {
  await git(repo, "update-ref", "-d", "refs/stash");
  await fs.rm(path.join(repo, ".git", "logs", "refs", "stash"), { force: true });
}

function expectedHead(incoming: GitSection): string {
  return incoming.head.endsWith("\n") ? incoming.head : `${incoming.head}\n`;
}

function exactDeferral(record: ReturnType<typeof repoRecordsForState>[string], reason: string, incoming: GitSection): void {
  const deferrals = record?.deferrals;
  expect(Object.keys(deferrals ?? {})).toEqual(["apply"]);
  const apply = deferrals!.apply!;
  expect(Object.keys(apply).sort()).toEqual(["checkout", "deferredSince", "lane", "lastSeen", "reason", "reasonSince", "subjectKey"].sort());
  expect(apply).toMatchObject({ lane: "apply", reason, subjectKey: gitIncomingKey(incoming) });
  expect(Number.isNaN(Date.parse(apply.deferredSince))).toBe(false);
  expect(Number.isNaN(Date.parse(apply.reasonSince))).toBe(false);
  expect(Number.isNaN(Date.parse(apply.lastSeen))).toBe(false);
}

const principalCases: PrincipalCase[] = (["ff", "branch-switch", "detached"] as const).flatMap((topology) =>
  ([0, 1] as const).flatMap((syncDirt) =>
    ([0, 1] as const).flatMap((humanDirt) =>
      ([0, 1] as const).flatMap((localCommits) =>
        ([0, 1] as const).map((localStash) => ({ topology, syncDirt, humanDirt, localCommits, localStash }))))));

describe("design 116 generated disposition matrix", () => {
  test.each(principalCases)(
    "$topology syncDirt=$syncDirt humanDirt=$humanDirt localCommits=$localCommits localStash=$localStash",
    async (c) => {
      const { root, repo, template, incoming } = await cloneCase(c);
      try {
        const expectedBytes = template.expectedBytes[c.syncDirt];
        const workingBytes = c.humanDirt ? `human-${c.topology}-${c.syncDirt}\n` : expectedBytes;
        await fs.writeFile(path.join(repo, "tracked.txt"), workingBytes);
        let localCommit: string | undefined;
        let localStash: string | undefined;
        if (c.localCommits) localCommit = await receiverOnlyCommit(repo);
        if (c.localStash) {
          localStash = await receiverOnlyStash(repo);
          // `stash push -u` restores the index version of every tracked path.
          // Put back the base semantic index and exact post-file-phase bytes
          // before exercising Git apply; stash is the only local dimension here.
          await fs.copyFile(path.join(template.root, REL, ".git", "index"), path.join(repo, ".git", "index"));
          await fs.writeFile(path.join(repo, "tracked.txt"), workingBytes);
        }

        const headBefore = await fs.readFile(path.join(repo, ".git", "HEAD"), "utf8");
        const tipBefore = await git(repo, "rev-parse", "HEAD");
        const indexBefore = await indexIdentityV2(repo, path.join(repo, ".git", "index"));
        const senderFixture = path.join(suiteTmp, `sender-${c.topology}-${c.syncDirt}`);
        const incomingIndex = await indexIdentityV2(senderFixture, path.join(senderFixture, ".git", "index"));
        const opBefore = await readOpState(path.join(repo, ".git"), hashFile);
        const shouldFollow = !c.humanDirt && !c.localCommits && !c.localStash;
        const initialState = stateWith(template.base);
        await saveStateUnsafeLegacyOrTest(root, initialState);
        const first = await applyIncoming(root, initialState, incoming, realOracle(root, expectedBytes));
        const incomingHeadRef = /^ref:\s*(refs\/\S+)/.exec(incoming.head)?.[1];
        const incomingTip = incomingHeadRef ? incoming.refs[incomingHeadRef]! : incoming.head.trim();

        expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe(workingBytes);
        if (shouldFollow) {
          expect(first.logs).toContain(`git-sync followed ${REL}`);
          expect(await fs.readFile(path.join(repo, ".git", "HEAD"), "utf8")).toBe(expectedHead(incoming));
          expect(await git(repo, "rev-parse", "HEAD")).toBe(incomingTip);
          expect(await indexIdentityV2(repo, path.join(repo, ".git", "index"))).toBe(incomingIndex);
          expect(first.outcome.idxProj?.[REL]).toBe(incomingIndex);
          expect(await readOpState(path.join(repo, ".git"), hashFile)).toEqual(
            Object.fromEntries(Object.entries(incoming.opState ?? {}).map(([rel, artifact]) => [rel, artifact.sha])),
          );
          expect(first.outcome.gitRepos?.[REL]).toEqual(incoming);
          expect(first.outcome.gitPendingRemote?.[REL]).toBeUndefined();
          expect(first.outcome.partial?.[REL]).toBeNull();
          expect(first.outcome.deferrals?.[REL]?.apply).toBeUndefined();
          expect(first.outcome.gitReposRemoved?.[REL]).toBeUndefined();
          expect(first.outcome.gitNeedsResolution?.[REL]).toBeUndefined();
        } else {
          expect(await fs.readFile(path.join(repo, ".git", "HEAD"), "utf8")).toBe(headBefore);
          expect(await git(repo, "rev-parse", "HEAD")).toBe(tipBefore);
          expect(await indexIdentityV2(repo, path.join(repo, ".git", "index"))).toBe(indexBefore);
          expect(await readOpState(path.join(repo, ".git"), hashFile)).toEqual(opBefore);
          for (const ref of ["refs/heads/safe", "refs/tags/matrix-safe"]) {
            expect(await git(repo, "rev-parse", ref)).toBe(incoming.refs[ref]);
          }
          if (localCommit) {
            expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(localCommit);
            await expect(git(repo, "cat-file", "-e", `${localCommit}^{commit}`)).resolves.toBe("");
          }
          if (localStash) {
            expect(await git(repo, "rev-parse", "refs/stash")).toBe(localStash);
            await expect(git(repo, "cat-file", "-e", `${localStash}^{commit}`)).resolves.toBe("");
          }
          const reason = c.humanDirt ? "local-edits" : c.localCommits ? "local-commits" : "local-stash";
          expect(first.outcome.gitRepos?.[REL]).toEqual(template.base);
          expect(first.outcome.gitPendingRemote?.[REL]).toEqual(incoming);
          const expectedHeldRefs = c.localStash ? { "refs/stash": "local-stash" as const } : {};
          const partial = first.outcome.partial?.[REL];
          expect(partial).toMatchObject({ incomingKey: gitIncomingKey(incoming), checkoutPending: true,
            heldRefs: expectedHeldRefs, configApplied: true });
          for (const [ref, oid] of Object.entries(incoming.refs)
            .filter(([ref]) => ref !== "refs/heads/main" && !(c.localStash && ref === "refs/stash"))) {
            const applied = partial?.appliedRefs[ref];
            if (ref.startsWith("refs/heads/")) expect(applied).toMatchObject({ kind: "present", oid });
            else expect(applied).toMatchObject({ kind: "safe-ref", afterOid: oid });
          }
          expect(first.outcome.deferrals?.[REL]?.apply?.reason).toBe(reason);
        }

        const persisted = await persist(root, initialState, first.outcome);
        const restarted = await loadState(root, STREAM);
        const record = repoRecordsForState(restarted)[REL]!;
        if (shouldFollow) {
          expect(Object.keys(record).sort()).toEqual(["base", "idxProj", "repoGen", "sourceSeq"].sort());
          expect(record.base).toEqual(incoming);
          expect(record.pending).toBeUndefined();
          expect(record.partial).toBeUndefined();
          expect(record.deferrals?.apply).toBeUndefined();
          expect(record.removedKey).toBeUndefined();
          expect(record.resolutionKey).toBeUndefined();
          expect(record.deferrals?.config).toBeUndefined();
          const retry = await applyIncoming(root, restarted, incoming, realOracle(root, expectedBytes));
          expect(retry.outcome.gitPendingRemote?.[REL]).toBeUndefined();
          expect(retry.outcome.partial?.[REL] ?? undefined).toBeUndefined();
          expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe(workingBytes);
          expect(await fs.readFile(path.join(repo, ".git", "HEAD"), "utf8")).toBe(expectedHead(incoming));
          expect(await git(repo, "rev-parse", "HEAD")).toBe(incomingTip);
        } else {
          expect(Object.keys(record).sort()).toEqual(["base", "deferrals", "idxProj", "partial", "pending", "repoGen", "sourceSeq"].sort());
          const reason = c.humanDirt ? "local-edits" : c.localCommits ? "local-commits" : "local-stash";
          expect(record.base).toEqual(template.base);
          expect(record.pending).toEqual(incoming);
          expect(record.partial).toEqual(first.outcome.partial?.[REL]);
          expect(record.removedKey).toBeUndefined();
          expect(record.resolutionKey).toBeUndefined();
          exactDeferral(record, reason, incoming);
          const deferredSince = record.deferrals!.apply!.deferredSince;

          const retry = await applyIncoming(root, restarted, incoming, realOracle(root, expectedBytes));
          expect(retry.outcome.deferrals?.[REL]?.apply?.deferredSince).toBe(deferredSince);
          expect(retry.outcome.partial?.[REL]).toMatchObject({
            incomingKey: gitIncomingKey(incoming), checkoutPending: true,
            heldRefs: first.outcome.partial?.[REL]?.heldRefs ?? {}, configApplied: true,
          });
          expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe(workingBytes);
          expect(await fs.readFile(path.join(repo, ".git", "HEAD"), "utf8")).toBe(headBefore);
          expect(await git(repo, "rev-parse", "HEAD")).toBe(tipBefore);
          expect(await indexIdentityV2(repo, path.join(repo, ".git", "index"))).toBe(indexBefore);
          expect(await readOpState(path.join(repo, ".git"), hashFile)).toEqual(opBefore);
          for (const ref of ["refs/heads/safe", "refs/tags/matrix-safe"]) expect(await git(repo, "rev-parse", ref)).toBe(incoming.refs[ref]);
          if (localStash) expect(await git(repo, "rev-parse", "refs/stash")).toBe(localStash);
          const retryPersisted = await persist(root, restarted, retry.outcome);
          const retryRestarted = await loadState(root, STREAM);
          expect(repoRecordsForState(retryRestarted)[REL]?.deferrals?.apply?.deferredSince).toBe(deferredSince);

          if (c.humanDirt) await fs.writeFile(path.join(repo, "tracked.txt"), expectedBytes);
          if (c.localCommits) await git(repo, "update-ref", "refs/heads/main", template.base.refs["refs/heads/main"]!, localCommit!);
          if (c.localStash) await clearReceiverStash(repo);
          const cleared = await applyIncoming(root, retryRestarted, incoming, realOracle(root, expectedBytes));
          expect(cleared.logs).toContain(`git-sync followed ${REL}`);
          expect(await fs.readFile(path.join(repo, ".git", "HEAD"), "utf8")).toBe(expectedHead(incoming));
          expect(await git(repo, "rev-parse", "HEAD")).toBe(incomingTip);
          expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe(expectedBytes);
          expect(cleared.outcome.gitRepos?.[REL]).toEqual(incoming);
          expect(cleared.outcome.gitPendingRemote?.[REL]).toBeUndefined();
          expect(cleared.outcome.partial?.[REL]).toBeNull();
          expect(cleared.outcome.deferrals?.[REL]?.apply).toBeNull();
          await persist(root, retryPersisted, cleared.outcome);
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

describe("production steady base-clean working-byte classification", () => {
  test.each(["ff", "branch-switch", "detached"] as const)("%s metadata-base-clean human dirt", async (topology) => {
    const { root, repo, template, incoming } = await cloneCase({ topology, syncDirt: 1, label: "clean-arm-human-dirt" });
    try {
      const humanBytes = `human-clean-arm-${topology}\n`;
      await fs.writeFile(path.join(repo, "tracked.txt"), humanBytes);
      const result = await applyIncoming(root, stateWith(template.base), incoming, realOracle(root, template.expectedBytes[1]));

      expect(result.logs.some((line) => line.startsWith(`git-sync deferred ${REL}:`))).toBe(true);
      expect(result.outcome.gitRepos?.[REL]).toEqual(template.base);
      expect(result.outcome.gitPendingRemote?.[REL]).toEqual(incoming);
      expect(result.outcome.deferrals?.[REL]?.apply?.reason).toBe("local-edits");
      expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe(humanBytes);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});

const crossingCases = (["ff", "branch-switch", "detached"] as const).flatMap((topology) => [
  { topology, label: "diverged-index-base-op", index: "diverged", op: "base", reason: "local-index" },
  { topology, label: "base-index-diverged-op", index: "base", op: "diverged", reason: "local-operation" },
  { topology, label: "diverged-index-diverged-op", index: "diverged", op: "diverged", reason: "local-index" },
  topology === "ff"
    ? { topology, label: "human-dirt-crossed-with-index", index: "diverged", op: "base", human: true, reason: "local-edits" }
    : topology === "branch-switch"
      ? { topology, label: "local-commit-crossed-with-op", index: "base", op: "diverged", commit: true, reason: "local-operation" }
      : { topology, label: "local-stash-crossed-with-index", index: "diverged", op: "base", stash: true, reason: "local-index" },
] as const);

describe("design 116 index/op-state crossed interactions", () => {
  test.each(crossingCases)("$topology $label", async (c) => {
    const { root, repo, template, incoming } = await cloneCase({ topology: c.topology, syncDirt: 1, label: c.label });
    try {
      await fs.writeFile(path.join(repo, "tracked.txt"), template.expectedBytes[1]);
      if (c.index === "diverged") {
        await fs.writeFile(path.join(repo, "index-only.txt"), "index divergence\n");
        await git(repo, "add", "index-only.txt");
        await fs.rm(path.join(repo, "index-only.txt"));
      }
      if (c.op === "diverged") {
        await fs.writeFile(path.join(repo, ".git", "MERGE_HEAD"), `${template.c1}\n`);
      }
      if ("human" in c && c.human) await fs.writeFile(path.join(repo, "tracked.txt"), "crossed human bytes\n");
      if ("commit" in c && c.commit) {
        await receiverOnlyCommit(repo);
        if (c.op === "diverged") await fs.writeFile(path.join(repo, ".git", "MERGE_HEAD"), `${template.c1}\n`);
      }
      if ("stash" in c && c.stash) {
        await receiverOnlyStash(repo);
        await fs.copyFile(path.join(template.root, REL, ".git", "index"), path.join(repo, ".git", "index"));
        await fs.writeFile(path.join(repo, "tracked.txt"), template.expectedBytes[1]);
        await fs.writeFile(path.join(repo, "index-only.txt"), "index divergence\n");
        await git(repo, "add", "index-only.txt");
        await fs.rm(path.join(repo, "index-only.txt"));
      }
      const result = await applyIncoming(root, stateWith(template.base), incoming, realOracle(root, template.expectedBytes[1]));
      expect(result.outcome.deferrals?.[REL]?.apply?.reason).toBe(c.reason);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});

test("design 116 incoming-stash row advances the receiver stash when it has no stash divergence", async () => {
  const { root, repo, template } = await cloneCase({ topology: "ff", syncDirt: 1, label: "incoming-stash" });
  try {
    const sender = path.join(suiteTmp, "incoming-stash-sender");
    await fs.cp(path.join(suiteTmp, "sender-ff-1"), sender, { recursive: true });
    await fs.writeFile(path.join(sender, "sender-stash.txt"), "incoming stash\n");
    await git(sender, "stash", "push", "-uqm", "incoming matrix stash");
    const incoming = await capture(sender);
    await fs.writeFile(path.join(repo, "tracked.txt"), template.expectedBytes[1]);
    const result = await applyIncoming(root, stateWith(template.base), incoming, realOracle(root, template.expectedBytes[1]));
    expect(result.logs).toContain(`git-sync followed ${REL}`);
    expect(await git(repo, "rev-parse", "refs/stash")).toBe(incoming.refs["refs/stash"]);
    expect(await git(repo, "stash", "list")).toContain("incoming matrix stash");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("design 116 scan-deferred row defers when the applied-manifest oracle is indeterminate", async () => {
  const { root, repo, template, incoming } = await cloneCase({ topology: "ff", syncDirt: 1, label: "scan-deferred" });
  try {
    await fs.writeFile(path.join(repo, "tracked.txt"), template.expectedBytes[1]);
    const oracle: AppliedManifestOracle = {
      proveRepo: async () => ({ kind: "indeterminate", why: "scan deferred in repo subtree" }),
      reproveRepo: async () => ({ kind: "indeterminate", why: "scan deferred in repo subtree" }),
      receiptHash: () => undefined,
    };
    const result = await applyIncoming(root, stateWith(template.base), incoming, oracle);
    expect(result.outcome.deferrals?.[REL]?.apply?.reason).toBe("unreadable");
    expect(await fs.readFile(path.join(repo, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("207.9: cloned repo removal loses its empty skeleton and doctor names the retained repository", async () => {
  const root = path.join(suiteTmp, `founder-repro-${Math.random().toString(16).slice(2)}`);
  const repo = path.join(root, REL);
  const sender = path.join(suiteTmp, `founder-sender-${Math.random().toString(16).slice(2)}`);
  try {
    await initRepo(sender);
    const tracked = new Map([
      [`${REL}/media/links/metadata/item.txt`, "metadata\n"],
      [`${REL}/packages/empty/generated/item.txt`, "generated\n"],
    ]);
    for (const [rel, bytes] of tracked) {
      const senderPath = path.join(sender, rel.slice(REL.length + 1));
      await fs.mkdir(path.dirname(senderPath), { recursive: true });
      await fs.writeFile(senderPath, bytes);
    }
    await git(sender, "add", ".");
    await git(sender, "commit", "-qm", "nested repository");
    await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
    await exec("git", ["clone", "-q", sender, repo], { env: TEST_GIT_ENV });
    const base = await capture(repo);
    const cfg = cfgFor(root);
    const files: FileEntry[] = [];
    for (const [rel, bytes] of tracked) {
      const stat = await fs.lstat(path.join(root, rel));
      files.push({
        path: rel,
        type: "file",
        sha256: hashBytes(Buffer.from(bytes)),
        size: Buffer.byteLength(bytes),
        mode: stat.mode & 0o777,
        mtimeMs: stat.mtimeMs,
      });
    }
    await saveStateUnsafeLegacyOrTest(root, {
      stream: syncStreamId(cfg),
      stateNonce: "d".repeat(32),
      lastSyncedSequence: 1,
      lastSyncedManifest: {
        generatedAt: "present",
        files,
        manifestSchema: 2,
        gitRepos: { [REL]: base },
      },
      repoRecords: { [REL]: { repoGen: 1, sourceSeq: 1, base } },
    });
    const remote: SyncRemote = {
      latest: async () => ({
        sequence: 2,
        manifest: { generatedAt: "removed", files: [], manifestSchema: 2 },
      }),
      missingBlobs: async () => [],
      putBlobFile: async () => {},
      commit: async () => ({ sequence: 3 }),
      blobStore: () => store,
    };

    await pull(root, cfg, { remote, onGitLog: () => {} });
    await expect(fs.lstat(path.join(repo, "media"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.join(repo, "packages"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.lstat(path.join(repo, ".git"))).isDirectory()).toBe(true);

    const residue = await collectRepoResidue(root, cfg);
    expect(residue.localOnly.entries).toHaveLength(1);
    expect(residue.localOnly.entries[0]).toMatchObject({
      rel: REL,
      path: repo,
      gitPresent: true,
      identity: "match",
    });
    const rendered = renderDoctor({} as DoctorChecks, {
      leftoverWorktrees: { count: 0, entries: [] },
      repoResidue: residue.localOnly,
    });
    expect(rendered).toContain(`left behind after '${REL}' was removed on another machine`);
    expect(rendered).toContain(`remove manually: rm -rf -- '${repo}'`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(sender, { recursive: true, force: true });
  }
}, 20_000);

test.skipIf(!fsAliases.caseAliases)("design 116 receiver case-equivalence alias follows on a case-aliasing filesystem", async () => {
  const { root, repo, template, incoming } = await cloneCase({ topology: "ff", syncDirt: 1, label: "case-alias" });
  try {
    await fs.writeFile(path.join(repo, "tracked.txt"), template.expectedBytes[1]);
    await fs.rename(path.join(repo, "tracked.txt"), path.join(repo, "Tracked.txt"));
    const result = await applyIncoming(root, stateWith(template.base), incoming, realOracle(root, template.expectedBytes[1]));
    expect(result.logs).toContain(`git-sync followed ${REL}`);
    expect(await fs.readFile(path.join(repo, "Tracked.txt"), "utf8")).toBe(template.expectedBytes[1]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 20_000);

test.skipIf(!fsAliases.unicodeAliases)("design 116 receiver Unicode-normalization alias follows on a normalization-aliasing filesystem", async () => {
  const { root, repo, template, incoming } = await cloneCase({ topology: "ff", syncDirt: 1, label: "unicode-alias" });
  try {
    await fs.writeFile(path.join(repo, "tracked.txt"), template.expectedBytes[1]);
    await fs.writeFile(path.join(repo, "e\u0301.txt"), "alias\n");
    const base: Manifest = {
      generatedAt: "",
      files: [oracleEntry(template.expectedBytes[1]), {
        path: `${REL}/é.txt`, type: "file", sha256: hashBytes(Buffer.from("alias\n")), size: 6, mode: 0o644, mtimeMs: 0,
      }],
    };
    const result = await applyIncoming(root, stateWith(template.base), incoming, oracleFromState({ base, matcher: buildIgnoreMatcher(root), root }));
    expect(result.logs).toContain(`git-sync followed ${REL}`);
    expect(await fs.readFile(path.join(repo, "e\u0301.txt"), "utf8")).toBe("alias\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 20_000);
